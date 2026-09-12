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
import { dateKeyOf, isDateKey, normalizeOffset, startOfDayMs, todayKeyOf } from "../../src/datetime.js";
import { EVALUATIONS, MISTAKE_EVALUATIONS, TASK_KINDS, computeStats } from "./merge.js";
import { buildOutline, compareQuestions, questionHaystack } from "../../src/question-order.js";

export const DATA_VERSION = "1.3.0";

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
      rejectUnknownKeys(raw, ["questionIds", "kind", "title", "timeLimitSeconds", "order", "completed"], `tasks[${index}]`);
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
      if (kind === "challenge" && !timeLimitSeconds && raw.timeLimitSeconds !== null) {
        // 制限時間なしのチャレンジ（カウントアップ）も許すが、意図を分かるようにしておく。
      }
      questionIds.forEach((id) => { if (!questions.has(id)) unknown.add(id); });
      return {
        id: uid("task"),
        questionIds,
        kind,
        order: readInteger(raw.order, `tasks[${index}].order`, { min: 0, max: 999, fallback: index }),
        completed: raw.completed === true,
        ...(timeLimitSeconds ? { timeLimitSeconds } : {}),
        ...(title ? { title } : {}),
      };
    });
    return { tasks, unknownQuestionIds: [...unknown] };
  }

  async function replacePlan({ date, tasks, actor, toolName, args }) {
    const questions = await questionMap();
    const { tasks: normalized, unknownQuestionIds } = readTasks(tasks, questions);
    const before = await sync.readTaskPlan(date);
    const updatedBy = actor?.clientName ? `ai:${actor.clientName}` : "ai";
    const { plan } = await sync.writeTaskPlan(date, normalized, { updatedBy });
    await sync.appendLog({
      clientName: actor?.clientName ?? actor?.tokenLabel ?? "AI",
      tool: toolName,
      summary: `${date} の予定を${normalized.length}件に変更（前は${(before?.tasks ?? []).length}件）`,
    });
    return {
      ok: true,
      date,
      replaced: true,
      taskCount: normalized.length,
      previousTaskCount: (before?.tasks ?? []).length,
      revision: plan.revision,
      updatedAt: plan.updatedAt,
      plan,
      unknownQuestionIds,
      note: unknownQuestionIds.length
        ? "問題マスタに無いIDが含まれています。listQuestions で正しいIDを確かめてください（予定自体は保存しました）。"
        : null,
      ...(args?.timezoneOffsetMinutes !== undefined
        ? { timezoneOffsetMinutes: normalizeOffset(args.timezoneOffsetMinutes) }
        : {}),
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
        attempts: records.length,
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
      const [plan, questions] = await Promise.all([sync.readTaskPlan(date), questionMap()]);
      const tasks = (plan?.tasks ?? []).map((task) => ({
        ...task,
        labels: task.questionIds.map((id) => questions.get(id)?.label ?? id),
      }));
      return {
        date,
        isToday: date === today(args),
        taskCount: tasks.length,
        tasks,
        revision: plan?.revision ?? 0,
        updatedAt: plan?.updatedAt ?? null,
        updatedBy: plan?.updatedBy ?? null,
        note: tasks.length ? null : `${date} の予定はまだありません。`,
      };
    },

    async getTasksInRange(args = {}) {
      const from = readDateArg(args.from, "from", args);
      const to = readDateArg(args.to, "to", args);
      if (to < from) fail("to は from 以降の日付にしてください。", "to");
      const [plans, questions] = await Promise.all([sync.readTaskPlansInRange(from, to), questionMap()]);
      return {
        from,
        to,
        days: plans.map((plan) => ({
          date: plan.date,
          taskCount: (plan.tasks ?? []).length,
          revision: plan.revision,
          updatedAt: plan.updatedAt,
          updatedBy: plan.updatedBy,
          tasks: (plan.tasks ?? []).map((task) => ({
            ...task,
            labels: task.questionIds.map((id) => questions.get(id)?.label ?? id),
          })),
        })),
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
