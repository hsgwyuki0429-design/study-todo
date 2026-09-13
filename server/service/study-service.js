// study-todo の中身を扱う層。MCPからも管理APIからも、ここを通して読み書きする。
//
// 決めごと:
//   ・学習記録とチャレンジ結果は、ここからは書けない。実際に学習した端末（PWA）だけが
//     作れるようにして、AIが実績を作り出せないようにしている。
//   ・「今日」は時間帯（既定は日本時間 UTC+9）で判断する。
//   ・合計や正答率は保存せず、学習記録から数え直す。

import {
  fail,
  readArray,
  readEnum,
  readInteger,
  readString,
  rejectUnknownKeys,
} from "../core/validate.js";
import { dateKeyOf, isDateKey, normalizeOffset, shiftDateKey, startOfDayMs, todayKeyOf } from "../../src/datetime.js";
import { EVALUATIONS, MISTAKE_EVALUATIONS, TASK_KINDS, computeStats } from "./merge.js";
import {
  CHANGE_LIMITS,
  activeStateOf,
  emptyPlan,
  parseChangeRequest,
  planRevisionOf,
  protectionOf,
} from "./task-changes.js";
import { StorageCapabilityError } from "../storage/driver.js";
import { MOVE_REASONS, itemsOf, splitPlanItems } from "../../src/plan-items.js";
import { buildOutline, compareQuestions, questionHaystack } from "../../src/question-order.js";

export const DATA_VERSION = "1.4.0";

export const SERVICE_LIMITS = Object.freeze({
  listLimitDefault: 50,
  listLimitMax: 200,
  historyLimitDefault: 50,
  historyLimitMax: 200,
  tasksPerDay: 50,
  questionIdsPerTask: 100,
  goals: 100,
});

const EVALUATION_LABELS = Object.freeze({
  perfect: "◯ 完璧にできた",
  better_solution: "解 正解だが、もっと簡単な解法があった",
  weak_writing: "記 正解だが、記述が甘い",
  calc_error: "△ 計算ミス",
  wrong_approach: "✕ 方針が違った",
});

const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function createStudyService({ sync, now = () => Date.now() }) {
  /** 「今日」を決める。引数の time zone を尊重し、既定は日本時間。 */
  function today(args = {}) {
    return todayKeyOf(args.timezoneOffsetMinutes, now());
  }

  function readDateArg(value, field, args) {
    if (value === undefined || value === null || value === "") return today(args);
    const text = readString(value, field, { max: 10, required: true });
    if (!isDateKey(text)) fail(`${field} は 2026-09-12 のような日付で渡してください。`, field);
    return text;
  }

  async function questionMap() {
    const document = await sync.readQuestions();
    return new Map((document.questions ?? []).map((question) => [question.id, question]));
  }

  function decorate(record, questions) {
    const question = questions.get(record.questionId);
    return {
      ...record,
      syncedAt: undefined,
      label: question?.label ?? record.questionId,
      chapter: question?.chapter ?? null,
      section: question?.section ?? null,
      evaluationLabel: EVALUATION_LABELS[record.evaluation] ?? record.evaluation,
      date: dateKeyOf(record.timestamp),
    };
  }

  /** AIが予定として渡してきたものを確かめる。分からない問題IDは知らせる。 */
  function readTasks(value, questions) {
    const list = readArray(value, "tasks", { min: 0, max: SERVICE_LIMITS.tasksPerDay });
    const unknown = new Set();
    const tasks = list.map((raw, index) => {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        fail(`tasks[${index}] はオブジェクトで渡してください。`, "tasks");
      }
      rejectUnknownKeys(raw, ["id", "questionIds", "kind", "title", "timeLimitSeconds", "order", "completed"], `tasks[${index}]`);
      const questionIds = raw.questionIds === undefined
        ? []
        : readArray(raw.questionIds, `tasks[${index}].questionIds`, { max: SERVICE_LIMITS.questionIdsPerTask })
          .map((id, position) => readString(id, `tasks[${index}].questionIds[${position}]`, { required: true, max: 120 }));
      const kind = readEnum(raw.kind, `tasks[${index}].kind`, [...TASK_KINDS], { fallback: "new" });
      const title = readString(raw.title, `tasks[${index}].title`, { max: 120 });
      if (!questionIds.length && !title) {
        fail(`tasks[${index}] には questionIds か title のどちらかが必要です。`, "tasks");
      }
      const timeLimitSeconds = readInteger(raw.timeLimitSeconds, `tasks[${index}].timeLimitSeconds`, { min: 60, max: 6 * 3600 });
      // 「終わったことにする」のは実際に学習した端末だけの仕事。
      if (raw.completed === true) {
        fail(`tasks[${index}].completed は指定できません。完了になるのは、study-todo で実際に学習したときだけです。`, "tasks");
      }
      questionIds.forEach((id) => { if (!questions.has(id)) unknown.add(id); });
      return {
        // ID を渡してもらえたら、そのタスクとして扱う（IDは作り直さない）。
        id: readString(raw.id, `tasks[${index}].id`, { max: 80 }),
        questionIds,
        kind,
        title: title ?? "",
        timeLimitSeconds: timeLimitSeconds ?? null,
      };
    });
    return { tasks, unknownQuestionIds: [...unknown] };
  }

  const signatureOf = (task) => JSON.stringify([
    task.kind,
    task.title ?? "",
    [...(task.questionIds ?? [])],
    task.timeLimitSeconds ?? null,
  ]);

  const sameContent = (stored, incoming) => signatureOf({
    kind: stored.kind,
    title: stored.title ?? "",
    questionIds: stored.questionIds ?? [],
    timeLimitSeconds: stored.timeLimitSeconds ?? null,
  }) === signatureOf(incoming);

  /**
   * 「その日の予定をまるごと置き換える」という古い形の要求を、
   * タスク単位の変更（追加・変更・削除）へ翻訳する。
   *
   * こうする理由は3つある。
   *   ・同じ内容のタスクはIDを保てる（毎回作り直さない）
   *   ・完了済み・実行中・固定のタスクを、置き換えでは消せないようにする
   *   ・新しい経路と同じ競合の確認と履歴の記録を、必ず通す
   */
  function planReplacementChanges(stored, incoming, { now: at }) {
    const storedTasks = [...(stored.tasks ?? [])];
    const used = new Set();
    const pairs = new Map();

    incoming.forEach((task, index) => {
      if (!task.id) return;
      const match = storedTasks.find((entry) => entry.id === task.id);
      if (match && !used.has(match.id)) {
        used.add(match.id);
        pairs.set(index, match);
      }
    });
    incoming.forEach((task, index) => {
      if (pairs.has(index)) return;
      const match = storedTasks.find((entry) => !used.has(entry.id) && sameContent(entry, task));
      if (match) {
        used.add(match.id);
        pairs.set(index, match);
      }
    });

    const changes = [];
    const keptProtected = [];
    const ignored = [];
    for (const task of storedTasks) {
      if (used.has(task.id)) continue;
      const protection = protectionOf(task, stored, at);
      if (protection) {
        keptProtected.push({ taskId: task.id, protection });
        continue;
      }
      changes.push({ op: "remove", taskId: task.id, date: stored.date });
    }

    incoming.forEach((task, index) => {
      const match = pairs.get(index);
      if (!match) {
        changes.push({
          op: "add",
          date: stored.date,
          task: {
            questionIds: task.questionIds,
            kind: task.kind,
            ...(task.title ? { title: task.title } : {}),
            ...(task.timeLimitSeconds ? { timeLimitSeconds: task.timeLimitSeconds } : {}),
            position: index,
          },
        });
        return;
      }
      const protection = protectionOf(match, stored, at);
      if (protection) {
        if (!sameContent(match, task)) ignored.push({ taskId: match.id, protection });
        return;
      }
      const patch = { position: index };
      if (!sameContent(match, task)) {
        patch.questionIds = task.questionIds;
        patch.kind = task.kind;
        patch.title = task.title ?? "";
        patch.timeLimitSeconds = task.timeLimitSeconds ?? null;
      }
      if (match.order !== index || Object.keys(patch).length > 1) {
        changes.push({ op: "update", taskId: match.id, date: stored.date, patch });
      }
    });

    return { changes, keptProtected, ignored };
  }

  async function replacePlan({ date, tasks, actor, toolName, args }) {
    const questions = await questionMap();
    const { tasks: incoming, unknownQuestionIds } = readTasks(tasks, questions);
    if (unknownQuestionIds.length) {
      return {
        ok: false,
        error: "unknown_question",
        unknownQuestionIds,
        message: "問題マスタに無い問題IDが含まれています。予定は変更していません。",
        nextAction: "listQuestions / searchQuestions で正しい question.id を確かめてください。",
      };
    }
    const stored = (await sync.readTaskPlan(date)) ?? emptyPlan(date);
    const expectedRevision = args?.expectedRevision === undefined || args?.expectedRevision === null
      ? planRevisionOf(stored)
      : readInteger(args.expectedRevision, "expectedRevision", { min: 0, required: true });
    if (expectedRevision !== planRevisionOf(stored)) {
      return {
        ok: false,
        error: "revision_conflict",
        conflicts: [{ date, expectedRevision, currentRevision: planRevisionOf(stored) }],
        message: "渡された expectedRevision が、保存されている予定と食い違っています。",
        nextAction: "getTodayTasks / getTasksInRange で今の revision を取り直してください。",
      };
    }

    const { changes, keptProtected, ignored } = planReplacementChanges(stored, incoming, { now: now() });
    const protectedNote = keptProtected.length || ignored.length
      ? "完了済み・実行中・固定のタスクは置き換えでは変えられないため、そのまま残しました。"
      : null;

    if (!changes.length) {
      return {
        ok: true,
        date,
        changed: false,
        revision: planRevisionOf(stored),
        taskCount: (stored.tasks ?? []).length,
        keptProtectedTasks: keptProtected,
        ignoredTasks: ignored,
        note: protectedNote ?? "変更はありませんでした（渡された内容が今の予定と同じです）。",
      };
    }

    const request = {
      operationId: readString(args?.operationId, "operationId", { max: CHANGE_LIMITS.operationIdLength })
        ?? uid("op"),
      reason: readString(args?.reason, "reason", { max: CHANGE_LIMITS.reasonLength }) ?? "",
      expectedRevisions: new Map([[date, expectedRevision]]),
      changes,
    };
    const result = await runChanges({
      request,
      actor,
      toolName,
      knownQuestionIds: new Set(questions.keys()),
    });
    if (!result.ok) return result;
    const plan = result.days.find((day) => day.date === date);
    return {
      ...result,
      date,
      changed: true,
      replaced: true,
      taskCount: plan?.taskCount ?? 0,
      previousTaskCount: (stored.tasks ?? []).length,
      revision: result.revisions[date],
      keptProtectedTasks: keptProtected,
      ignoredTasks: ignored,
      note: protectedNote,
    };
  }

  /** すでに取り組まれた予定項目（学習記録が結び付いているもの）。 */
  async function doneItemIds() {
    const records = await sync.readAllRecords();
    return new Set(records.filter((record) => record.planItemId).map((record) => record.planItemId));
  }

  /** 保存先が保証できないときは、黙って書かずに理由を返す。 */
  async function runChanges({ request, actor, toolName, knownQuestionIds, actorKind = "ai" }) {
    const actorName = actor?.clientName ?? actor?.tokenLabel ?? "AI";
    try {
      return await sync.applyTaskChanges({
        request,
        actorKind,
        actorName,
        updatedBy: actorKind === "ai" ? `ai:${actorName}` : "app",
        tool: toolName,
        knownQuestionIds,
        doneItemIds: await doneItemIds(),
      });
    } catch (error) {
      if (error instanceof StorageCapabilityError) {
        return {
          ok: false,
          error: "storage_not_atomic",
          message: error.message,
          nextAction: "利用者に、Durable Object を有効にしてサーバーをデプロイしなおすよう伝えてください（docs/mcp.md の「保存先の移行」）。予定は変更していません。",
        };
      }
      throw error;
    }
  }

  /**
   * 予定1件を、AIが読める形（保護の状態・予定項目つき）にする。
   *
   * items は「この予定の中の1回の取り組み」1件ずつで、itemId が安定した識別子。
   * done / pending は、学習記録の planItemId と突き合わせた結果。
   */
  function decorateTask(task, plan, questions, records = []) {
    const protection = protectionOf(task, plan, now());
    const split = splitPlanItems(task, records, { date: plan.date, allowLegacyMatch: false });
    const describe = (item) => ({
      ...item,
      label: questions.get(item.questionId)?.label ?? item.questionId,
      type: questions.get(item.questionId)?.type ?? null,
      carriedOver: Boolean(item.originalDate && item.originalDate !== plan.date),
    });
    return {
      ...task,
      pinned: task.pinned === true,
      completed: task.completed === true,
      running: activeStateOf(plan, now())?.taskId === task.id,
      locked: Boolean(protection),
      lockedReason: protection,
      labels: (task.questionIds ?? []).map((id) => questions.get(id)?.label ?? id),
      items: split.items.map(describe),
      doneItemIds: split.done.map((item) => item.itemId),
      pendingItemIds: split.pending.map((item) => item.itemId),
      ...(task.carriedFrom ? { carriedFrom: task.carriedFrom } : {}),
    };
  }

  /** その日の学習記録を、AIが読める形にする（1件＝1回の取り組み）。 */
  function describeAttempt(record, questions) {
    const question = questions.get(record.questionId);
    return {
      recordId: record.id,
      questionId: record.questionId,
      label: question?.label ?? record.questionId,
      type: question?.type ?? null,
      subject: question?.subject ?? null,
      chapter: question?.chapter ?? null,
      section: question?.section ?? null,
      timestamp: record.timestamp,
      date: dateKeyOf(record.timestamp),
      evaluation: record.evaluation,
      evaluationLabel: EVALUATION_LABELS[record.evaluation] ?? record.evaluation,
      durationSeconds: record.durationSeconds,
      inChallenge: Boolean(record.challengeId),
      challengeId: record.challengeId ?? null,
      planTaskId: record.planTaskId ?? null,
      planItemId: record.planItemId ?? null,
      // 予定との対応が分からない、この仕組みより前の記録。
      legacy: !record.planItemId,
    };
  }

  return {
    limits: SERVICE_LIMITS,

    async getAppInfo(args = {}) {
      const [questionsDoc, records, status] = await Promise.all([
        sync.readQuestions(),
        sync.readAllRecords(),
        sync.status(),
      ]);
      const questions = questionsDoc.questions ?? [];
      const byType = {};
      const books = new Set();
      for (const question of questions) {
        byType[question.type] = (byType[question.type] ?? 0) + 1;
        if (question.book) books.add(question.book);
      }
      return {
        app: "study-todo（青チャート学習管理）",
        dataVersion: DATA_VERSION,
        timezone: { name: "Asia/Tokyo", offsetMinutes: normalizeOffset(args.timezoneOffsetMinutes) },
        today: today(args),
        questionCount: questions.length,
        questionsVersion: questionsDoc.version,
        books: [...books],
        questionTypes: Object.entries(byType)
          .map(([type, count]) => ({ type, count }))
          .sort((left, right) => right.count - left.count),
        courses: [...new Set(questions.flatMap((question) => question.courses ?? []))],
        coursesNote: "SELECT STUDY の3コース。基本定着＝教科書の基本事項を確認したいとき / 精選速習＝入試の基礎を短期間で / 実力錬成＝入試に向け実力を高めたいとき。listQuestions の course で絞れる。",
        difficultyScale: "1〜5（青チャートのコンパスの数）。小さいほどやさしい。",
        // needsReview が付いた問題は、誌面からの読み取りが確定していない項目を含む。
        needsReviewCount: questions.filter((question) => question.needsReview === true).length,
        needsReviewNote: "needsReview が true の問題は、難易度など一部の項目が未確認。番号・章・単元・掲載ページは確認済みなので、予定づくりには使える。",
        studyRecords: records.length,
        devices: status.devices,
        lastSyncedAt: status.lastSyncedAt,
        evaluations: EVALUATIONS.map((value) => ({ value, label: EVALUATION_LABELS[value] })),
        taskKinds: [...TASK_KINDS],
        storage: sync.storageCapabilities(),
        taskProtection: {
          reasons: ["completed", "running", "pinned"],
          note: "完了済み・実行中・固定のタスクはAIからは変更できません。固定の付け外しは study-todo の画面からだけ行えます。"
            + " 実行中はアプリが知らせてきた範囲でしか分からないため、圏外の端末で解いているタスクは守れません。",
        },
        // 教科 → 章 → 節 を、教科書の掲載順のまま返す（名前の文字列順ではない）。
        subjects: buildOutline(questions),
        note: questions.length
          ? null
          : "問題マスタがまだ同期されていません。study-todo の設定画面から問題をインポートして同期してください。",
      };
    },

    async listQuestions(args = {}) {
      const document = await sync.readQuestions();
      let list = document.questions ?? [];
      const subject = readString(args.subject, "subject", { max: 60 });
      const chapter = readString(args.chapter, "chapter", { max: 80 });
      const section = readString(args.section, "section", { max: 80 });
      const type = readString(args.type, "type", { max: 40 });
      const book = readString(args.book, "book", { max: 80 });
      if (subject) list = list.filter((question) => question.subject === subject);
      if (chapter) list = list.filter((question) => question.chapter === chapter);
      if (section) list = list.filter((question) => question.section === section);
      if (type) list = list.filter((question) => question.type === type);
      if (book) list = list.filter((question) => question.book === book);

      // 「基本例題だけ」のように複数の種類をまとめて選べるようにする。
      if (args.types !== undefined && args.types !== null) {
        const types = readArray(args.types, "types", { max: 20 })
          .map((value, index) => readString(value, `types[${index}]`, { required: true, max: 40 }));
        if (types.length) list = list.filter((question) => types.includes(question.type));
      }

      const numberFrom = readInteger(args.numberFrom, "numberFrom", { min: 0 });
      const numberTo = readInteger(args.numberTo, "numberTo", { min: 0 });
      if (numberFrom !== null) list = list.filter((question) => question.number >= numberFrom);
      if (numberTo !== null) list = list.filter((question) => question.number <= numberTo);

      // 「難しい問題を除く」を difficultyTo で表せるようにする。
      const difficultyFrom = readInteger(args.difficultyFrom, "difficultyFrom", { min: 1, max: 5 });
      const difficultyTo = readInteger(args.difficultyTo, "difficultyTo", { min: 1, max: 5 });
      if (difficultyFrom !== null) {
        list = list.filter((question) => Number.isInteger(question.difficulty) && question.difficulty >= difficultyFrom);
      }
      if (difficultyTo !== null) {
        list = list.filter((question) => Number.isInteger(question.difficulty) && question.difficulty <= difficultyTo);
      }

      // ページで絞る。例題は掲載ページを持たないので、その節の開始ページで見る。
      const pageOf = (question) => (Number.isInteger(question.page) ? question.page : question.sectionPage ?? null);
      const pageFrom = readInteger(args.pageFrom, "pageFrom", { min: 0 });
      const pageTo = readInteger(args.pageTo, "pageTo", { min: 0 });
      if (pageFrom !== null) list = list.filter((question) => pageOf(question) !== null && pageOf(question) >= pageFrom);
      if (pageTo !== null) list = list.filter((question) => pageOf(question) !== null && pageOf(question) <= pageTo);

      // SELECT STUDY のコースで絞る。
      const course = readString(args.course, "course", { max: 20 });
      if (course) list = list.filter((question) => (question.courses ?? []).includes(course));

      if (args.needsReview === true) list = list.filter((question) => question.needsReview === true);
      if (args.needsReview === false) list = list.filter((question) => question.needsReview !== true);

      // 並びは教科書の掲載順（教科→章→節→種類→番号）。章名の文字列順にはしない。
      list = [...list].sort(compareQuestions);
      const offset = readInteger(args.offset, "offset", { min: 0, fallback: 0 });
      const limit = readInteger(args.limit, "limit", {
        min: 1, max: SERVICE_LIMITS.listLimitMax, fallback: SERVICE_LIMITS.listLimitDefault,
      });
      const page = list.slice(offset, offset + limit);
      return {
        total: list.length,
        offset,
        count: page.length,
        nextOffset: offset + page.length < list.length ? offset + page.length : null,
        questions: page,
      };
    },

    async searchQuestions(args = {}) {
      const query = readString(args.query, "query", { required: true, max: 200 }).toLowerCase();
      const document = await sync.readQuestions();
      const terms = query.split(/\s+/).filter(Boolean);
      const matched = (document.questions ?? [])
        .filter((question) => {
          const haystack = questionHaystack(question);
          return terms.every((term) => haystack.includes(term));
        })
        .sort(compareQuestions);
      const limit = readInteger(args.limit, "limit", {
        min: 1, max: SERVICE_LIMITS.listLimitMax, fallback: SERVICE_LIMITS.listLimitDefault,
      });
      const offset = readInteger(args.offset, "offset", { min: 0, fallback: 0 });
      const page = matched.slice(offset, offset + limit);
      return {
        total: matched.length,
        offset,
        count: page.length,
        nextOffset: offset + page.length < matched.length ? offset + page.length : null,
        questions: page,
      };
    },

    async getQuestion(args = {}) {
      const id = readString(args.id, "id", { required: true, max: 120 });
      const questions = await questionMap();
      const question = questions.get(id) ?? null;
      const records = (await sync.readAllRecords()).filter((record) => record.questionId === id);
      if (!question && !records.length) {
        return { ok: false, error: "not_found", message: `問題 ${id} は見つかりませんでした。searchQuestions で探してください。` };
      }
      const counts = {};
      records.forEach((record) => { counts[record.evaluation] = (counts[record.evaluation] || 0) + 1; });
      return {
        question,
        // 「この問題に何回取り組んだか」。同じ日に2回解けば2回と数える。
        attempts: records.length,
        totalAttempts: records.length,
        attemptsNote: "1回の取り組み＝1件の記録です。全部を見るときは getQuestionAttempts（区切って取れる）を使ってください。",
        evaluationCounts: counts,
        lastEvaluation: records[0]?.evaluation ?? null,
        averageSeconds: records.length
          ? Math.round(records.reduce((sum, record) => sum + record.durationSeconds, 0) / records.length)
          : null,
        history: records.slice(0, 50).map((record) => decorate(record, questions)),
      };
    },

    async getStudyHistory(args = {}) {
      const questions = await questionMap();
      let records = await sync.readAllRecords();
      const days = readInteger(args.days, "days", { min: 1, max: 365 });
      const offset = normalizeOffset(args.timezoneOffsetMinutes);
      if (days !== null) {
        const fromMs = startOfDayMs(today(args), offset) - (days - 1) * 86400000;
        records = records.filter((record) => Date.parse(record.timestamp) >= fromMs);
      }
      const from = readString(args.from, "from", { max: 10 });
      const to = readString(args.to, "to", { max: 10 });
      if (from) records = records.filter((record) => dateKeyOf(record.timestamp, offset) >= from);
      if (to) records = records.filter((record) => dateKeyOf(record.timestamp, offset) <= to);
      const evaluation = readEnum(args.evaluation, "evaluation", [...EVALUATIONS]);
      if (evaluation) records = records.filter((record) => record.evaluation === evaluation);
      const chapter = readString(args.chapter, "chapter", { max: 80 });
      if (chapter) records = records.filter((record) => questions.get(record.questionId)?.chapter === chapter);
      const limit = readInteger(args.limit, "limit", {
        min: 1, max: SERVICE_LIMITS.historyLimitMax, fallback: SERVICE_LIMITS.historyLimitDefault,
      });
      return {
        total: records.length,
        count: Math.min(records.length, limit),
        records: records.slice(0, limit).map((record) => decorate(record, questions)),
      };
    },

    async getRecentMistakes(args = {}) {
      const days = readInteger(args.days, "days", { min: 1, max: 365, fallback: 7 });
      const kinds = args.evaluation
        ? [readEnum(args.evaluation, "evaluation", [...MISTAKE_EVALUATIONS], { required: true })]
        : [...MISTAKE_EVALUATIONS];
      const history = await this.getStudyHistory({ ...args, days, limit: SERVICE_LIMITS.historyLimitMax, evaluation: undefined });
      const mistakes = history.records.filter((record) => kinds.includes(record.evaluation));
      const limit = readInteger(args.limit, "limit", { min: 1, max: SERVICE_LIMITS.historyLimitMax, fallback: 50 });
      const byEvaluation = {};
      mistakes.forEach((record) => { byEvaluation[record.evaluation] = (byEvaluation[record.evaluation] || 0) + 1; });
      return {
        days,
        total: mistakes.length,
        byEvaluation,
        calcErrors: byEvaluation.calc_error ?? 0,
        wrongApproaches: byEvaluation.wrong_approach ?? 0,
        records: mistakes.slice(0, limit),
      };
    },

    async getStudyStats(args = {}) {
      const offset = normalizeOffset(args.timezoneOffsetMinutes);
      const [records, questionsDoc] = await Promise.all([sync.readAllRecords(), sync.readQuestions()]);
      const stats = computeStats(records, questionsDoc.questions ?? [], { timezoneOffsetMinutes: offset });
      const recentDays = readInteger(args.recentDays, "recentDays", { min: 1, max: 90, fallback: 14 });
      const todayKey = today(args);
      const recent = [];
      for (let index = recentDays - 1; index >= 0; index -= 1) {
        const key = dateKeyOf(startOfDayMs(todayKey, offset) - index * 86400000, offset);
        recent.push({ date: key, ...(stats.byDate[key] ?? { count: 0, seconds: 0 }) });
      }
      const weakChapters = Object.entries(stats.byChapter)
        .map(([chapter, value]) => {
          const mistakes = MISTAKE_EVALUATIONS.reduce((sum, kind) => sum + (value.byEvaluation[kind] ?? 0), 0);
          return { chapter, count: value.count, seconds: value.seconds, mistakes, mistakeRate: value.count ? mistakes / value.count : 0 };
        })
        .filter((entry) => entry.count >= 3)
        .sort((left, right) => right.mistakeRate - left.mistakeRate)
        .slice(0, 5);
      return {
        timezoneOffsetMinutes: offset,
        today: todayKey,
        totalRecords: stats.totalRecords,
        totalSeconds: stats.totalSeconds,
        uniqueQuestions: stats.uniqueQuestions,
        byEvaluation: stats.byEvaluation,
        byChapter: stats.byChapter,
        recentDays: recent,
        weakChapters,
      };
    },

    async getRecentChallengeResult() {
      const results = await sync.readChallenges();
      return { result: results[0] ?? null, total: results.length };
    },

    async getChallengeResults(args = {}) {
      const limit = readInteger(args.limit, "limit", { min: 1, max: 100, fallback: 20 });
      const results = await sync.readChallenges();
      return { total: results.length, results: results.slice(0, limit) };
    },

    async getTodayTasks(args = {}) {
      return this.getTasksForDate({ ...args, date: readDateArg(args.date, "date", args) });
    },

    async getTasksForDate(args = {}) {
      const date = readDateArg(args.date, "date", args);
      const [stored, questions, allRecords] = await Promise.all([
        sync.readTaskPlan(date), questionMap(), sync.readAllRecords(),
      ]);
      const plan = stored ?? emptyPlan(date);
      const offset = normalizeOffset(args.timezoneOffsetMinutes);
      const dayRecords = allRecords.filter((record) => dateKeyOf(record.timestamp, offset) === date);
      const tasks = (plan.tasks ?? []).map((task) => decorateTask(task, plan, questions, allRecords));
      const active = activeStateOf(plan, now());
      return {
        date,
        isToday: date === today(args),
        taskCount: tasks.length,
        tasks,
        // その日に実際に取り組んだ記録（予定に無かったものも入る）。
        attempts: dayRecords.map((record) => describeAttempt(record, questions)),
        attemptCount: dayRecords.length,
        pendingItemCount: tasks.reduce((sum, task) => sum + task.pendingItemIds.length, 0),
        // 予定を変えるときは、この revision をそのまま expectedRevisions へ渡す。
        revision: planRevisionOf(plan),
        updatedAt: plan.updatedAt ?? null,
        updatedBy: plan.updatedBy ?? null,
        active: active ? { taskId: active.taskId, questionId: active.questionId ?? null, startedAt: active.startedAt } : null,
        lockedTaskIds: tasks.filter((task) => task.locked).map((task) => task.id),
        note: tasks.length || dayRecords.length ? null : `${date} の予定も記録もまだありません。`,
        protectionNote: "locked が true のタスク（完了済み・実行中・固定）は、AIからは変更・削除・移動できません。",
        attemptNote: "attempts は「実際に取り組んだ1回」ごとの記録です。同じ問題を2回解けば2件になります。"
          + " planItemId が入っていない記録は、この仕組みより前のもので、予定との対応は分かりません。",
      };
    },

    async getTasksInRange(args = {}) {
      const from = readDateArg(args.from, "from", args);
      const to = readDateArg(args.to, "to", args);
      if (to < from) fail("to は from 以降の日付にしてください。", "to");
      const includeAttempts = args.includeAttempts !== false;
      const offset = normalizeOffset(args.timezoneOffsetMinutes);
      const [plans, questions, allRecords] = await Promise.all([
        sync.readTaskPlansInRange(from, to), questionMap(), sync.readAllRecords(),
      ]);
      const byDate = new Map(plans.map((plan) => [plan.date, plan]));
      // 予定が無くても、その日に取り組んだ記録があれば日として返す。
      const dates = new Set(plans.map((plan) => plan.date));
      const attemptsByDate = new Map();
      for (const record of allRecords) {
        const date = dateKeyOf(record.timestamp, offset);
        if (date < from || date > to) continue;
        if (!attemptsByDate.has(date)) attemptsByDate.set(date, []);
        attemptsByDate.get(date).push(record);
        dates.add(date);
      }
      return {
        from,
        to,
        days: [...dates].sort().map((date) => {
          const plan = byDate.get(date) ?? emptyPlan(date);
          const active = activeStateOf(plan, now());
          const tasks = (plan.tasks ?? []).map((task) => decorateTask(task, plan, questions, allRecords));
          const dayRecords = attemptsByDate.get(date) ?? [];
          return {
            date,
            taskCount: tasks.length,
            revision: planRevisionOf(plan),
            updatedAt: plan.updatedAt ?? null,
            updatedBy: plan.updatedBy ?? null,
            active: active ? { taskId: active.taskId, questionId: active.questionId ?? null } : null,
            tasks,
            attemptCount: dayRecords.length,
            pendingItemCount: tasks.reduce((sum, task) => sum + task.pendingItemIds.length, 0),
            ...(includeAttempts ? { attempts: dayRecords.map((record) => describeAttempt(record, questions)) } : {}),
          };
        }),
        protectionNote: "locked が true のタスク（完了済み・実行中・固定）は、AIからは変更・削除・移動できません。",
        changeNote: "予定を変えるときは、変える日すべての date と revision を expectedRevisions に入れて applyTaskChanges を呼んでください。",
      };
    },

    /** まだ取り組まれていない予定項目。繰り越しの相談に使う。 */
    async getUnfinishedPlanItems(args = {}) {
      const to = readDateArg(args.to, "to", args);
      const from = args.from === undefined || args.from === null || args.from === ""
        ? shiftDateKey(to, -30)
        : readDateArg(args.from, "from", args);
      if (to < from) fail("to は from 以降の日付にしてください。", "to");
      const [plans, questions, records] = await Promise.all([
        sync.readTaskPlansInRange(from, to), questionMap(), sync.readAllRecords(),
      ]);
      const todayKey = today(args);
      const days = plans.map((plan) => {
        const tasks = (plan.tasks ?? [])
          .map((task) => {
            const split = splitPlanItems(task, records, { date: plan.date, allowLegacyMatch: false });
            if (!split.pending.length) return null;
            return {
              taskId: task.id,
              kind: task.kind,
              ...(task.title ? { title: task.title } : {}),
              locked: Boolean(protectionOf(task, plan, now())),
              doneItemCount: split.done.length,
              pendingItems: split.pending.map((item) => ({
                ...item,
                label: questions.get(item.questionId)?.label ?? item.questionId,
                carriedOver: Boolean(item.originalDate && item.originalDate !== plan.date),
              })),
            };
          })
          .filter(Boolean);
        return { date: plan.date, overdue: plan.date < todayKey, revision: planRevisionOf(plan), tasks };
      }).filter((day) => day.tasks.length);
      return {
        from,
        to,
        today: todayKey,
        total: days.reduce((sum, day) => sum + day.tasks.reduce((n, task) => n + task.pendingItems.length, 0), 0),
        days,
        note: "繰り越すときは applyTaskChanges の carryOver に、この itemId を渡してください。"
          + " 理由（reason）は利用者が言ったときだけ入れ、推測で埋めないでください。",
      };
    },

    /** 1つの問題の、すべての取り組み（古い順）。件数が多いので必ず区切って返す。 */
    async getQuestionAttempts(args = {}) {
      const questionId = readString(args.id, "id", { required: true, max: 120 });
      const questions = await questionMap();
      const records = (await sync.readAllRecords())
        .filter((record) => record.questionId === questionId)
        .sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
      const limit = readInteger(args.limit, "limit", { min: 1, max: SERVICE_LIMITS.historyLimitMax, fallback: 50 });
      const offset = readInteger(args.offset, "offset", { min: 0, fallback: 0 });
      const page = records.slice(offset, offset + limit);
      return {
        questionId,
        question: questions.get(questionId) ?? null,
        // 「その問題に何回取り組んだか」。教材全体の周回数とは別のもの。
        totalAttempts: records.length,
        offset,
        count: page.length,
        nextOffset: offset + page.length < records.length ? offset + page.length : null,
        attempts: page.map((record) => describeAttempt(record, questions)),
        note: "古い順です。チャレンジの中で解いた分も1回として入り、二重には数えません。",
      };
    },

    /** 予定を別の日へ動かした記録（繰り越し・予定変更）。 */
    async getPlanMoves(args = {}) {
      const limit = readInteger(args.limit, "limit", { min: 1, max: 200, fallback: 50 });
      const offset = readInteger(args.offset, "offset", { min: 0, fallback: 0 });
      const from = args.from ? readDateArg(args.from, "from", args) : null;
      const to = args.to ? readDateArg(args.to, "to", args) : null;
      const questionId = readString(args.questionId, "questionId", { max: 120 });
      const result = await sync.readMoves({ limit, offset, from, to, questionId });
      const questions = await questionMap();
      return {
        ...result,
        moves: result.moves.map((move) => ({
          ...move,
          items: move.items.map((item) => ({
            ...item,
            label: questions.get(item.questionId)?.label ?? item.questionId,
          })),
        })),
        reasons: [...MOVE_REASONS],
        note: "1件＝1回の移動です。繰り越しても取り組み回数は増えません（実績は実施した日にだけ残ります）。",
      };
    },

    async getGoals() {
      const goals = await sync.readGoals();
      return { total: goals.length, goals: goals.sort((left, right) => String(left.deadline).localeCompare(String(right.deadline))) };
    },

    // ----------------------------------------------------------------
    // 書き込み（AIに許すのは予定と目標だけ）
    // ----------------------------------------------------------------

    async updateTodayTasks(args = {}, actor = {}) {
      const date = readDateArg(args.date, "date", args);
      return replacePlan({ date, tasks: args.tasks, actor, toolName: "updateTodayTasks", args });
    },

    async updateTasksForDate(args = {}, actor = {}) {
      const date = readDateArg(args.date, "date", args);
      return replacePlan({ date, tasks: args.tasks, actor, toolName: "updateTasksForDate", args });
    },

    /**
     * タスク単位の一括変更。予定を変えるときの本来の入口。
     * 全部成功か、全部未反映かのどちらかにしかならない。
     */
    async applyTaskChanges(args = {}, actor = {}) {
      const request = parseChangeRequest(args);
      const questions = await questionMap();
      return runChanges({
        request,
        actor,
        toolName: "applyTaskChanges",
        knownQuestionIds: new Set(questions.keys()),
      });
    },

    /** 予定の変更履歴（変更前後・対象・実行者・理由）。 */
    async getPlanChanges(args = {}) {
      const limit = readInteger(args.limit, "limit", { min: 1, max: 50, fallback: 10 });
      const includeDetail = args.includeDetail === true;
      const { total, entries } = await sync.readChanges({ limit });
      return {
        total,
        count: entries.length,
        changes: entries.map((entry) => ({
          changeId: entry.id,
          at: entry.at,
          by: entry.actorKind === "ai" ? `AI（${entry.actorName}）` : entry.actorName,
          actorKind: entry.actorKind,
          tool: entry.tool,
          reason: entry.reason,
          dates: entry.dates,
          summary: entry.summary,
          revisions: entry.revisions,
          undoOf: entry.undoOf ?? null,
          undoneBy: entry.undoneBy ?? null,
          ...(includeDetail ? { before: entry.before, after: entry.after } : {}),
        })),
        note: "学習記録とチャレンジ結果は、この履歴の対象ではありません（取り消しても実績は変わりません）。",
      };
    },

    /** 記録してある変更を取り消す。取り消しも新しい変更として記録する。 */
    async undoTaskChanges(args = {}, actor = {}) {
      const changeId = readString(args.changeId, "changeId", { max: 80 });
      const operationId = readString(args.operationId, "operationId", { max: CHANGE_LIMITS.operationIdLength });
      const reason = readString(args.reason, "reason", { max: CHANGE_LIMITS.reasonLength });
      try {
        return await sync.undoTaskChange({
          changeId,
          operationId,
          actorKind: "ai",
          actorName: actor?.clientName ?? actor?.tokenLabel ?? "AI",
          reason,
        });
      } catch (error) {
        if (error instanceof StorageCapabilityError) {
          return {
            ok: false,
            error: "storage_not_atomic",
            message: error.message,
            nextAction: "利用者に、Durable Object を有効にしてサーバーをデプロイしなおすよう伝えてください。予定は変更していません。",
          };
        }
        throw error;
      }
    },

    async addGoal(args = {}, actor = {}) {
      const title = readString(args.title, "title", { required: true, max: 200 });
      const deadline = readString(args.deadline, "deadline", { max: 40 }) ?? "";
      if (deadline && !isDateKey(deadline)) fail("deadline は 2026-12-31 のような日付で渡してください。", "deadline");
      const scope = readString(args.scope, "scope", { max: 400 }) ?? "";
      const goals = await sync.readGoals();
      if (goals.length >= SERVICE_LIMITS.goals) fail(`目標は${SERVICE_LIMITS.goals}件までです。`, "title");
      const goal = { id: uid("goal"), title, deadline, scope, updatedAt: new Date(now()).toISOString() };
      await sync.writeGoals([goal]);
      await sync.appendLog({
        clientName: actor?.clientName ?? actor?.tokenLabel ?? "AI",
        tool: "addGoal",
        summary: `目標を追加「${title}」${deadline ? `（期限 ${deadline}）` : ""}`,
      });
      return { ok: true, goal };
    },

    async updateGoal(args = {}, actor = {}) {
      const id = readString(args.id, "id", { required: true, max: 80 });
      const goals = await sync.readGoals();
      const current = goals.find((goal) => goal.id === id);
      if (!current) {
        return { ok: false, error: "not_found", message: `目標 ${id} は見つかりませんでした。getGoals で確かめてください。` };
      }
      const patch = {};
      if (args.title !== undefined) patch.title = readString(args.title, "title", { required: true, max: 200 });
      if (args.deadline !== undefined) {
        const deadline = readString(args.deadline, "deadline", { max: 40 }) ?? "";
        if (deadline && !isDateKey(deadline)) fail("deadline は 2026-12-31 のような日付で渡してください。", "deadline");
        patch.deadline = deadline;
      }
      if (args.scope !== undefined) patch.scope = readString(args.scope, "scope", { max: 400 }) ?? "";
      if (!Object.keys(patch).length) fail("変更する項目（title / deadline / scope）を1つ以上渡してください。", "title");
      const next = { ...current, ...patch, updatedAt: new Date(now()).toISOString() };
      await sync.writeGoals([next]);
      await sync.appendLog({
        clientName: actor?.clientName ?? actor?.tokenLabel ?? "AI",
        tool: "updateGoal",
        summary: `目標を変更「${next.title}」`,
      });
      return { ok: true, goal: next };
    },

    getOperationLog(args = {}) {
      return sync.readLog({ limit: readInteger(args.limit, "limit", { min: 1, max: 100, fallback: 20 }) });
    },
  };
}
