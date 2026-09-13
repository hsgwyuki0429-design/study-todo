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
  applyChanges,
  emptyPlan,
  fingerprintOf,
  parseChangeRequest,
  planRevisionOf,
  protectionOf,
} from "./task-changes.js";
import { StorageCapabilityError } from "../storage/driver.js";
import { MOVE_REASONS, itemsOf, splitPlanItems } from "../../src/plan-items.js";
import {
  EVALUATION_VALUES,
  describeRecord,
  hasDuration,
  hasExactTime,
  recordDateOf,
  sumDurations,
} from "../../src/records-model.js";
import {
  GOAL_COMPLETION_TYPES,
  GOAL_STATUSES,
  normalizeGoal,
  selectQuestions,
} from "../../src/goals.js";
import { WEEKDAY_KEYS, availabilityForDate, normalizeAvailability } from "../../src/availability.js";
import { CONFIDENCE_LABELS, ESTIMATE_METHOD_VERSION } from "../../src/estimates.js";
import {
  buildDays,
  buildItemGoalMap,
  buildQuestionGroups,
  dateRange,
  estimateFor,
  goalProgress,
  truncatedChallengeIds,
} from "./planning.js";
import { buildOutline, compareQuestions, questionHaystack } from "../../src/question-order.js";

export const DATA_VERSION = "1.5.0";

export const SERVICE_LIMITS = Object.freeze({
  listLimitDefault: 50,
  listLimitMax: 200,
  historyLimitDefault: 50,
  historyLimitMax: 200,
  tasksPerDay: 50,
  questionIdsPerTask: 100,
  goals: 100,
  // 1回の操作で扱える学習記録の数。
  recordsPerOperation: 50,
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
      // 評価が未登録の記録は、正解にも不正解にもしない。
      evaluationLabel: record.evaluation ? (EVALUATION_LABELS[record.evaluation] ?? record.evaluation) : "未登録",
      evaluationKnown: Boolean(record.evaluation),
      durationKnown: hasDuration(record),
      recordId: record.id,
      revision: Number(record.revision ?? 0),
      source: record.source ?? "timer",
      // 実施日（登録した日ではない）。
      date: recordDateOf(record),
      // 時刻まで分かっている記録だけ、時刻を出す。
      timestamp: hasExactTime(record) ? record.timestamp : null,
      datePrecision: record.datePrecision ?? "datetime",
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
    const described = describeRecord(record);
    return {
      ...described,
      // 訂正・取り消しのときに使う識別子と版。
      recordId: record.id,
      label: question?.label ?? record.questionId,
      type: question?.type ?? null,
      subject: question?.subject ?? null,
      chapter: question?.chapter ?? null,
      section: question?.section ?? null,
      timestamp: hasExactTime(record) ? record.timestamp : null,
      evaluationLabel: record.evaluation ? (EVALUATION_LABELS[record.evaluation] ?? record.evaluation) : "未登録",
      inChallenge: Boolean(record.challengeId),
      // 予定との対応が分からない、この仕組みより前の記録。
      legacy: !record.planItemId,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 本人の申告による学習実績の記録・訂正                                 */
  /* ------------------------------------------------------------------ */

  /** 予定項目（itemId）を探す。実績を予定へ結び付けるときに使う。 */
  async function findPlanItem(itemId) {
    const todayKey = todayKeyOf(undefined, now());
    const plans = await sync.readTaskPlansInRange(shiftDateKey(todayKey, -400), shiftDateKey(todayKey, 400));
    for (const plan of plans) {
      for (const task of plan.tasks ?? []) {
        const item = itemsOf(task).find((entry) => entry.itemId === itemId);
        if (item) return { plan, task, item };
      }
    }
    return null;
  }

  /**
   * 「いつやったか」を読む。
   *
   * 日付は必ず本人の申告から決める。「昨日」のような言い方は、AIがサーバーの今日
   * （getAppInfo / getPlanningContext が返す today）を基準に、日本時間で年月日へ直してから渡す。
   * 時刻は分かるときだけ。分からなければ日付だけの記録として保存する。
   */
  function readWhen(raw, field, args) {
    const date = readDateArg(raw.date, `${field}.date`, args);
    const todayKey = today(args);
    if (date > todayKey) {
      fail(`${field}.date が未来の日付です（${date}）。まだやっていない学習は実績にできません。`, `${field}.date`);
    }
    const time = readString(raw.time, `${field}.time`, { max: 5 });
    if (!time) return { date, datePrecision: "date", timestamp: null };
    if (!/^\d{2}:\d{2}$/.test(time)) fail(`${field}.time は 14:30 のような形で渡してください。`, `${field}.time`);
    const offset = normalizeOffset(args.timezoneOffsetMinutes);
    const ms = Date.parse(`${date}T${time}:00Z`) - offset * 60000;
    return { date, datePrecision: "datetime", timestamp: new Date(ms).toISOString() };
  }

  /** 評価。渡されなければ「未登録」（正解にも不正解にも数えない）。 */
  function readEvaluation(raw, field) {
    if (raw === undefined || raw === null || raw === "" || raw === "unknown") return null;
    return readEnum(raw, field, [...EVALUATION_VALUES], { required: true });
  }

  /** 所要時間。渡されなければ null（0秒で埋めない）。 */
  function readDurationSeconds(raw, field) {
    if (raw === undefined || raw === null || raw === "") return null;
    return readInteger(raw, field, { min: 0, max: 6 * 3600, required: true });
  }

  /** 同じ問題・同じ日の記録。二重登録になっていないかを本人に確かめてもらうために返す。 */
  function similarRecords(records, questionId, date) {
    return records
      .filter((record) => record.questionId === questionId && recordDateOf(record) === date)
      .map(describeRecord);
  }

  const recordFingerprint = (payload) => JSON.stringify(payload);

  /** 保存先がまとめ書きを保証できないときは、黙って書かずに理由を返す。 */
  async function runRecordOperations(input) {
    try {
      return await sync.applyRecordOperations(input);
    } catch (error) {
      if (error instanceof StorageCapabilityError) {
        return {
          ok: false,
          error: "storage_not_atomic",
          message: error.message,
          nextAction: "利用者に、Durable Object を有効にしてサーバーをデプロイしなおすよう伝えてください。記録は変更していません。",
        };
      }
      throw error;
    }
  }


  /* ------------------------------------------------------------------ */
  /* 計画づくりのための下ごしらえ                                         */
  /* ------------------------------------------------------------------ */

  /**
   * 計画に必要なものを、一度にまとめて読む。
   * 期間を絞って読むので、全問題・全履歴を毎回並べ直すことはしない。
   */
  async function planningBundle({ from, to, timezoneOffsetMinutes } = {}) {
    const [questionsDoc, records, plans, challenges, goals, availability, estimates] = await Promise.all([
      sync.readQuestions(),
      sync.readAllRecords(),
      sync.readTaskPlansInRange(from, to),
      sync.readChallenges(),
      sync.readGoals(),
      sync.readAvailability(),
      sync.readEstimateEntries(),
    ]);
    const questions = new Map((questionsDoc.questions ?? []).map((question) => [question.id, question]));
    const recordsByQuestion = new Map();
    for (const record of [...records].sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)))) {
      if (!recordsByQuestion.has(record.questionId)) recordsByQuestion.set(record.questionId, []);
      recordsByQuestion.get(record.questionId).push(record);
    }
    const questionsByGroup = buildQuestionGroups(questions);
    const truncated = truncatedChallengeIds(challenges);
    const cache = new Map();
    const estimateOf = (questionId, { inChallenge = false } = {}) => {
      const key = `${questionId}|${inChallenge ? "c" : "n"}`;
      if (!cache.has(key)) {
        cache.set(key, estimateFor(questionId, {
          questions, recordsByQuestion, questionsByGroup, estimates, availability,
          truncated, inChallenge, now: now(),
        }));
      }
      return cache.get(key);
    };
    // 目標に結び付いた予定項目は、期間の外にもありうるので広めに読む。
    const wholePlans = await sync.readTaskPlansInRange(
      shiftDateKey(from, -400) ?? from,
      shiftDateKey(to, 400) ?? to,
    );
    return {
      questions, records, recordsByQuestion, plans, wholePlans, challenges, goals,
      availability, estimates, estimateOf,
      itemGoalMap: buildItemGoalMap(wholePlans),
      timezoneOffsetMinutes: normalizeOffset(timezoneOffsetMinutes),
    };
  }

  function progressOf(goal, bundle, todayKey) {
    return goalProgress(goal, {
      records: bundle.records,
      itemGoalMap: bundle.itemGoalMap,
      plans: bundle.wholePlans,
      questions: bundle.questions,
      estimateOf: (questionId) => bundle.estimateOf(questionId),
      today: todayKey,
    });
  }

  /**
   * 配分案を、保存する前に確かめる。
   *
   * 確かめること:
   *   ・問題ID・目標ID・タスクID・予定項目IDが正しいか
   *   ・同じ取り組みを二重に置いていないか（すでに予定がある分をもう一度足していないか）
   *   ・その日の枠（学習可能時間）に収まるか。未設定の日に置いていないか
   *   ・完了済み・実行中・固定の予定に触っていないか（変更エンジンが見る）
   *   ・目標の期限を過ぎた日に、その目標の予定を置いていないか
   *   ・すでに実施済みの分を動かそうとしていないか（変更エンジンが見る）
   *   ・対象日の revision が今のものか
   *   ・下見のときに見た目標・学習可能時間から変わっていないか（expectedContext）
   *
   * dryRun のときは、変更エンジンを写しの上で走らせるだけで、保存はしない。
   */
  async function validatePlan(args = {}, actor = {}, { dryRun = true } = {}) {
    const request = parseChangeRequest(args);
    const todayKey = today(args);
    const dates = [...request.expectedRevisions.keys()].sort();
    const from = dates[0] ?? todayKey;
    const to = dates[dates.length - 1] ?? todayKey;

    const bundle = await planningBundle({
      from: from < todayKey ? from : todayKey,
      to: to > todayKey ? to : todayKey,
      timezoneOffsetMinutes: args.timezoneOffsetMinutes,
    });

    // 1. 下見のときから、目標や学習可能時間が変わっていないか。
    const expectedContext = args.expectedContext ?? null;
    if (expectedContext) {
      rejectUnknownKeys(expectedContext, ["goalsRevision", "availabilityRevision"], "expectedContext");
      const currentContext = {
        goalsRevision: await sync.goalsRevision(),
        availabilityRevision: bundle.availability.revision,
      };
      const stale = Object.entries(currentContext)
        .filter(([key, value]) => expectedContext[key] !== undefined && Number(expectedContext[key]) !== Number(value))
        .map(([key, value]) => ({ field: key, expected: Number(expectedContext[key]), current: value }));
      if (stale.length) {
        return {
          ok: false,
          error: "context_stale",
          stale,
          message: "計画のもとにした目標か学習可能時間が、その後で変わっています。予定は変更していません。",
          nextAction: "getPlanningContext を取り直し、配分をやり直してください。",
        };
      }
    }

    // 2. 変更そのものを、写しの上で試す（保護・revision・存在確認はここで見る）。
    const plans = {};
    for (const date of dates) plans[date] = (await sync.readTaskPlan(date)) ?? null;
    const done = new Set(bundle.records.filter((record) => record.planItemId).map((record) => record.planItemId));
    const trial = applyChanges({
      plans,
      request,
      now: now(),
      actorKind: "ai",
      updatedBy: "ai",
      knownQuestionIds: new Set(bundle.questions.keys()),
      doneItemIds: done,
      newId: () => `preview_${Math.random().toString(36).slice(2, 10)}`,
    });
    if (!trial.ok) return { ...trial, phase: dryRun ? "validate" : "apply" };

    // 3. 目標IDの確認。
    const goalsById = new Map(bundle.goals.map((goal) => [goal.id, normalizeGoal(goal, { now: now() })]));
    const warnings = [];
    const unknownGoalIds = new Set();
    for (const change of request.changes) {
      const goalId = change.task?.goalId ?? change.patch?.goalId;
      if (goalId && !goalsById.has(goalId)) unknownGoalIds.add(goalId);
    }
    if (unknownGoalIds.size) {
      return {
        ok: false,
        error: "unknown_goal",
        unknownGoalIds: [...unknownGoalIds],
        message: "その目標IDは見つかりません。予定は変更していません。",
        nextAction: "getGoals で目標IDを確かめてください。",
      };
    }

    // 4. 二重に置いていないか。
    //
    //    同じ目標のために同じ問題を、別々の日へ二重に置いてしまうのは取りこぼしなので断る。
    //    目標に結び付いていない予定は、同じ問題を2回やる計画もありうるので、
    //    知らせる（warning）だけにして止めない。
    const pendingKeys = new Map();
    const duplicates = [];
    const allPlans = [...bundle.wholePlans.filter((plan) => !trial.plans[plan.date]), ...Object.values(trial.plans)];
    for (const plan of allPlans) {
      for (const task of plan.tasks ?? []) {
        for (const item of itemsOf(task)) {
          if (done.has(item.itemId)) continue;
          const key = `${item.goalId ?? "-"}|${item.questionId}`;
          if (pendingKeys.has(key)) {
            const entry = { questionId: item.questionId, goalId: item.goalId ?? null, dates: [pendingKeys.get(key), plan.date] };
            if (item.goalId) duplicates.push(entry);
            else {
              warnings.push({
                type: "same_question_twice", ...entry,
                message: `${item.questionId} の予定が ${entry.dates.join(" と ")} の両方にあります（意図した2回ならそのままで構いません）。`,
              });
            }
          } else {
            pendingKeys.set(key, plan.date);
          }
        }
      }
    }
    if (duplicates.length) {
      return {
        ok: false,
        error: "duplicate_plan_item",
        duplicates: duplicates.slice(0, 20),
        message: "同じ目標のための同じ問題が、複数の日に残ってしまいます（すでに置いてある予定を見落としています）。予定は変更していません。",
        nextAction: "getPlanningContext の days[].pendingItems を見て、すでにある予定は move / carryOver で動かしてください。",
      };
    }

    // 5. 日ごとの時間と期限。
    const spentByDate = new Map();
    for (const record of bundle.records) {
      if (typeof record.durationSeconds !== "number") continue;
      const date = recordDateOf(record, bundle.timezoneOffsetMinutes);
      spentByDate.set(date, (spentByDate.get(date) ?? 0) + record.durationSeconds);
    }
    const days = [];
    let overCapacity = false;
    for (const date of Object.keys(trial.plans).sort()) {
      const plan = trial.plans[date];
      const capacity = availabilityForDate(bundle.availability, date, {
        spentSeconds: spentByDate.get(date) ?? 0,
        isToday: date === todayKey,
      });
      let seconds = 0;
      const items = [];
      for (const task of plan.tasks ?? []) {
        for (const item of itemsOf(task)) {
          if (done.has(item.itemId)) continue;
          const estimate = bundle.estimateOf(item.questionId, { inChallenge: task.kind === "challenge" });
          seconds += estimate.seconds;
          items.push({ itemId: item.itemId, questionId: item.questionId, goalId: item.goalId ?? null, estimateSeconds: estimate.seconds, confidence: estimate.confidence });
          // 目標の期限より後ろに置いていないか。
          const goal = item.goalId ? goalsById.get(item.goalId) : null;
          if (goal?.deadline && date > goal.deadline) {
            warnings.push({
              type: "after_deadline", date, goalId: goal.id, questionId: item.questionId,
              message: `${date} は目標「${goal.title}」の期限（${goal.deadline}）より後です。`,
            });
          }
        }
      }
      const plannedMinutes = Math.round(seconds / 60);
      if (capacity.available === null) {
        warnings.push({
          type: "capacity_not_configured", date,
          message: `${date} の学習可能時間が未設定です。0分とは違うので、時間があるとは決められません。`,
        });
      } else if (plannedMinutes > capacity.available) {
        overCapacity = true;
        warnings.push({
          type: "over_capacity", date,
          plannedMinutes, availableMinutes: capacity.available,
          shortageMinutes: plannedMinutes - capacity.available,
          message: `${date} は見積もり${plannedMinutes}分に対して使える時間が${capacity.available}分です（${plannedMinutes - capacity.available}分足りません）。`,
        });
      }
      // 1問だけで1日の枠を超える場合は、分ける仕組みが無いことを知らせる。
      if (capacity.available !== null) {
        for (const item of items) {
          if (Math.round(item.estimateSeconds / 60) > capacity.available) {
            warnings.push({
              type: "single_item_too_long", date, questionId: item.questionId,
              message: `${item.questionId} の見積もり（${Math.round(item.estimateSeconds / 60)}分）だけで ${date} の枠（${capacity.available}分）を超えます。1問を分ける仕組みはありません。`,
            });
          }
        }
      }
      days.push({
        date, revision: plan.revision, plannedMinutes, plannedSeconds: seconds,
        availableMinutes: capacity.available, capacitySource: capacity.source,
        remainingMinutes: capacity.available === null ? null : capacity.available - plannedMinutes,
        items,
      });
    }

    // 6. 置ききれなかった分（目標の未配置）。消さずに理由とともに残す。
    const unplaced = [];
    for (const goal of goalsById.values()) {
      if (goal.status !== "active") continue;
      const progress = progressOf(goal, bundle, todayKey);
      for (const questionId of progress.unplannedQuestionIds) {
        const estimate = bundle.estimateOf(questionId);
        unplaced.push({
          goalId: goal.id, questionId,
          label: bundle.questions.get(questionId)?.label ?? questionId,
          estimateSeconds: estimate.seconds,
          confidence: estimate.confidence,
          reason: overCapacity ? "time_shortage" : "not_scheduled",
        });
      }
    }

    return {
      ok: true,
      phase: dryRun ? "validate" : "apply",
      applied: false,
      days,
      warnings,
      overCapacity,
      unplaced: unplaced.slice(0, 200),
      unplacedTruncated: unplaced.length > 200,
      unplacedNote: "未配置の分は、目標の対象として残ります（消えません）。時間が足りないときは、"
        + "無理に詰め込まず、期限・学習可能時間・対象のどれを調整するかを利用者に相談してください。",
      contextNote: "この確認は今の状態に対するものです。反映のときにもう一度確かめます。",
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
        const from = dateKeyOf(startOfDayMs(today(args), offset) - (days - 1) * 86400000, offset);
        records = records.filter((record) => recordDateOf(record, offset) >= from);
      }
      const from = readString(args.from, "from", { max: 10 });
      const to = readString(args.to, "to", { max: 10 });
      if (from) records = records.filter((record) => recordDateOf(record, offset) >= from);
      if (to) records = records.filter((record) => recordDateOf(record, offset) <= to);
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
        // 時間や評価が「未登録」の取り組みの数。平均を出すときはこれを除いて考える。
        durationUnknownCount: stats.durationUnknownCount,
        evaluationUnknownCount: stats.evaluationUnknownCount,
        totalsNote: "totalSeconds には、時間が未登録の取り組み（durationUnknownCount 件）は入っていません。"
          + "まとまりで申告された時間は、そのまとまりにつき1回だけ足しています。",
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
      const dayRecords = allRecords.filter((record) => recordDateOf(record, offset) === date);
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
        const date = recordDateOf(record, offset);
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

    /** 目標の一覧。計算に使える形（対象の問題ID・達成条件・優先順位）で返す。 */
    async getGoals(args = {}) {
      const includeInactive = args.includeInactive === true;
      const goals = (await sync.readGoals())
        .map((goal) => normalizeGoal(goal, { now: now() }))
        .filter((goal) => includeInactive || goal.status === "active" || goal.status === "achieved")
        .sort((left, right) => (left.priority - right.priority)
          || String(left.deadline || "9999").localeCompare(String(right.deadline || "9999")));
      return {
        total: goals.length,
        goals,
        completionTypes: [...GOAL_COMPLETION_TYPES],
        statuses: [...GOAL_STATUSES],
        masteryNote: "習得する目標（mastery）は、その目標に結び付いた **最新** の取り組みが条件を満たしていれば達成とします。",
        scopeNote: "対象は questionIds（確定した問題IDの一覧）で持ちます。needsScopeSetup が true の目標は、"
          + "文章の範囲しか無い古い目標です。対象を推測して確定させず、利用者に選んでもらってください。",
      };
    },

    /** 目標ごとの進み具合・残量・未配置分。達成数はここで数え直す（AIからは書けない）。 */
    async getGoalProgress(args = {}) {
      const todayKey = today(args);
      const ids = args.goalIds === undefined || args.goalIds === null
        ? null
        : readArray(args.goalIds, "goalIds", { max: 50 }).map((id, index) => readString(id, `goalIds[${index}]`, { required: true, max: 80 }));
      const bundle = await planningBundle({
        from: shiftDateKey(todayKey, -30),
        to: shiftDateKey(todayKey, 120),
        timezoneOffsetMinutes: args.timezoneOffsetMinutes,
      });
      const goals = bundle.goals
        .map((goal) => normalizeGoal(goal, { now: now() }))
        .filter((goal) => (ids ? ids.includes(goal.id) : goal.status === "active"));
      return {
        today: todayKey,
        goals: goals.map((goal) => progressOf(goal, bundle, todayKey)),
        note: "satisfiedCount は学習記録から数え直した値です。AIからは書き換えられません。",
      };
    },

    /** 1日に使える学習時間の設定。未設定の曜日は null（0分とは違う）。 */
    async getStudyAvailability(args = {}) {
      const availability = await sync.readAvailability();
      const todayKey = today(args);
      const from = args.from ? readDateArg(args.from, "from", args) : todayKey;
      const to = args.to ? readDateArg(args.to, "to", args) : shiftDateKey(todayKey, 13);
      const records = await sync.readAllRecords();
      const offset = normalizeOffset(args.timezoneOffsetMinutes);
      const spent = new Map();
      for (const record of records) {
        // 時間が未登録の記録は 0秒として足さない（学習していないのと同じにはしない）。
        if (typeof record.durationSeconds !== "number") continue;
        const date = recordDateOf(record, offset);
        spent.set(date, (spent.get(date) ?? 0) + record.durationSeconds);
      }
      return {
        availability,
        weekdayKeys: [...WEEKDAY_KEYS],
        days: dateRange(from, to).map((date) => availabilityForDate(availability, date, {
          spentSeconds: spent.get(date) ?? 0,
          isToday: date === todayKey,
        })),
        note: "ここでいう時間は study-todo で管理する学習に使える枠です。学校や他教科を含む生活全体の空き時間ではありません。"
          + " available が null の日は未設定で、0分とは違います。勝手に時間があると決めないでください。",
      };
    },

    /** 学習可能時間を変える。渡した項目だけが変わる。 */
    async updateStudyAvailability(args = {}, actor = {}) {
      const patch = {};
      if (args.weekly !== undefined) {
        const weekly = {};
        rejectUnknownKeys(args.weekly ?? {}, [...WEEKDAY_KEYS], "weekly");
        for (const key of WEEKDAY_KEYS) {
          if (args.weekly[key] === undefined) continue;
          weekly[key] = args.weekly[key] === null ? null : readInteger(args.weekly[key], `weekly.${key}`, { min: 0, max: 1440 });
        }
        patch.weekly = weekly;
      }
      if (args.overrides !== undefined) {
        const overrides = {};
        for (const [date, value] of Object.entries(args.overrides ?? {})) {
          if (!isDateKey(date)) fail(`overrides のキーは 2026-09-12 のような日付にしてください（受け取った値: ${date}）。`, "overrides");
          overrides[date] = value === null ? null : readInteger(value, `overrides.${date}`, { min: 0, max: 1440 });
        }
        patch.overrides = overrides;
      }
      if (args.todayRemainingMinutes !== undefined) {
        patch.todayRemaining = args.todayRemainingMinutes === null ? null : {
          date: readDateArg(args.todayRemainingDate, "todayRemainingDate", args),
          minutes: readInteger(args.todayRemainingMinutes, "todayRemainingMinutes", { min: 0, max: 1440, required: true }),
          setAt: new Date(now()).toISOString(),
        };
      }
      if (args.reserveMinutes !== undefined) {
        patch.reserveMinutes = readInteger(args.reserveMinutes, "reserveMinutes", { min: 0, max: 240, required: true });
      }
      if (args.reviewOverheadSeconds !== undefined) {
        patch.reviewOverheadSeconds = readInteger(args.reviewOverheadSeconds, "reviewOverheadSeconds", { min: 0, max: 1800, required: true });
      }
      if (args.timerIncludesReview !== undefined) patch.timerIncludesReview = args.timerIncludesReview === true;
      if (!Object.keys(patch).length) fail("変える項目を1つ以上渡してください。", "weekly");
      const availability = await sync.writeAvailability(patch, { updatedBy: actor?.clientName ?? "ai" });
      await sync.appendLog({
        clientName: actor?.clientName ?? actor?.tokenLabel ?? "AI",
        tool: "updateStudyAvailability",
        summary: "学習可能時間の設定を変更",
      });
      return { ok: true, availability };
    },

    /** 問題別の見積もりをまとめて取る。根拠と確からしさも返す。 */
    async getQuestionEstimates(args = {}) {
      const ids = readArray(args.questionIds, "questionIds", { min: 1, max: 200 })
        .map((id, index) => readString(id, `questionIds[${index}]`, { required: true, max: 120 }));
      const todayKey = today(args);
      const bundle = await planningBundle({
        from: shiftDateKey(todayKey, -30),
        to: shiftDateKey(todayKey, 30),
        timezoneOffsetMinutes: args.timezoneOffsetMinutes,
      });
      const inChallenge = args.inChallenge === true;
      return {
        count: ids.length,
        method: ESTIMATE_METHOD_VERSION,
        confidenceLabels: CONFIDENCE_LABELS,
        estimates: ids.map((questionId) => ({
          ...bundle.estimateOf(questionId, { inChallenge }),
          label: bundle.questions.get(questionId)?.label ?? questionId,
          known: bundle.questions.has(questionId),
        })),
        note: "source が history なら本人の実績、similar なら似た問題の実績、ai_estimate は教材をもとにした仮の値、"
          + "default は種類と難易度から決めた仮の値です。manual は利用者が指定した時間です。",
      };
    },

    /**
     * 教材を見て作った仮の見積もりを保存する（AIから入れられるのはここだけ）。
     * 実績としては保存されないし、利用者が指定した時間を上書きすることもない。
     */
    async saveQuestionEstimates(args = {}, actor = {}) {
      const list = readArray(args.estimates, "estimates", { min: 1, max: 200 });
      const entries = {};
      list.forEach((raw, index) => {
        const field = `estimates[${index}]`;
        rejectUnknownKeys(raw ?? {}, ["questionId", "seconds", "note"], field);
        const questionId = readString(raw.questionId, `${field}.questionId`, { required: true, max: 120 });
        const seconds = readInteger(raw.seconds, `${field}.seconds`, { required: true, min: 30, max: 7200 });
        entries[questionId] = {
          aiSeconds: seconds,
          aiSource: `ai:${actor?.clientName ?? "AI"}`,
          aiNote: readString(raw.note, `${field}.note`, { max: 200 }),
        };
      });
      await sync.writeEstimateEntries(entries);
      await sync.appendLog({
        clientName: actor?.clientName ?? actor?.tokenLabel ?? "AI",
        tool: "saveQuestionEstimates",
        summary: `問題${Object.keys(entries).length}件の仮見積もりを保存`,
      });
      return {
        ok: true,
        saved: Object.keys(entries).length,
        note: "仮の見積もりとして保存しました。学習の実績にはなりません。利用者が自分で指定した時間は上書きしません。",
      };
    },

    /**
     * 計画を組むために必要なものを、期間を絞ってまとめて返す。
     * これ1回で「今どうなっているか」が分かるようにする。
     */
    async getPlanningContext(args = {}) {
      const todayKey = today(args);
      const from = args.from ? readDateArg(args.from, "from", args) : todayKey;
      const to = args.to ? readDateArg(args.to, "to", args) : shiftDateKey(todayKey, 13);
      if (to < from) fail("to は from 以降の日付にしてください。", "to");
      const dates = dateRange(from, to, { max: 60 });
      const goalIds = args.goalIds === undefined || args.goalIds === null
        ? null
        : readArray(args.goalIds, "goalIds", { max: 50 }).map((id, index) => readString(id, `goalIds[${index}]`, { required: true, max: 80 }));

      const bundle = await planningBundle({ from, to, timezoneOffsetMinutes: args.timezoneOffsetMinutes });
      const status = await sync.status();
      const goals = bundle.goals
        .map((goal) => normalizeGoal(goal, { now: now() }))
        .filter((goal) => (goalIds ? goalIds.includes(goal.id) : goal.status === "active"));
      const progress = goals.map((goal) => progressOf(goal, bundle, todayKey));

      const days = buildDays({
        dates,
        plans: bundle.plans,
        records: bundle.records,
        availability: bundle.availability,
        estimateOf: bundle.estimateOf,
        today: todayKey,
        timezoneOffsetMinutes: bundle.timezoneOffsetMinutes,
      });

      // まだ予定に入っていない取り組み（目標の未配置分）。
      const unplanned = [];
      for (const entry of progress) {
        for (const questionId of entry.unplannedQuestionIds) {
          const estimate = bundle.estimateOf(questionId);
          unplanned.push({
            goalId: entry.goalId,
            questionId,
            label: bundle.questions.get(questionId)?.label ?? questionId,
            estimateSeconds: estimate.seconds,
            estimateSource: estimate.source,
            confidence: estimate.confidence,
          });
        }
      }

      // 過ぎた日に残っている、まだやっていない予定。
      const overdue = [];
      for (const plan of bundle.wholePlans) {
        if (plan.date >= todayKey) continue;
        for (const task of plan.tasks ?? []) {
          const split = splitPlanItems(task, bundle.records, { date: plan.date, allowLegacyMatch: false });
          for (const item of split.pending) {
            overdue.push({
              date: plan.date, taskId: task.id, itemId: item.itemId, questionId: item.questionId,
              goalId: item.goalId ?? null, carriedCount: item.carriedCount,
              estimateSeconds: bundle.estimateOf(item.questionId).seconds,
              revision: Number(plan.revision ?? 0),
            });
          }
        }
      }

      const moves = await sync.readMoves({ limit: 30, from: shiftDateKey(todayKey, -30), to });
      const unconfigured = days.filter((day) => day.capacity.available === null).map((day) => day.date);

      return {
        // 日本時間での「いま」。
        now: new Date(now()).toISOString(),
        today: todayKey,
        timezone: { name: "Asia/Tokyo", offsetMinutes: bundle.timezoneOffsetMinutes },
        lastSyncedAt: status.lastSyncedAt,
        from,
        to,
        goals: progress,
        days,
        unplanned: unplanned.slice(0, 200),
        unplannedTruncated: unplanned.length > 200,
        overdue: overdue.slice(0, 200),
        overdueTruncated: overdue.length > 200,
        moves: moves.moves,
        movesTotal: moves.total,
        availability: bundle.availability,
        unconfiguredDates: unconfigured,
        storage: sync.storageCapabilities(),
        // 反映のときに「読んだときから変わっていないか」を確かめるための版。
        expectedContext: {
          goalsRevision: await sync.goalsRevision(),
          availabilityRevision: bundle.availability.revision,
        },
        estimateNote: "estimateSeconds は保存された実績と設定から計算した値です。confidence が low のものは仮の値です。",
        limits: {
          days: dates.length,
          maxDays: 60,
          unplannedLimit: 200,
          overdueLimit: 200,
          movesLimit: 30,
        },
        howTo: "1) ここで今の状態を受け取る 2) 配分案を changes にまとめる 3) validatePlanChanges で確かめる"
          + " 4) applyTaskChanges（expectedRevisions と expectedContext つき）で反映する。",
      };
    },

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
      // 同じ operationId の送り直しは、確かめる前に前回の結果を返す。
      // ここで確かめてしまうと「すでに足した分」を二重の予定と見なしてしまう。
      const replay = await sync.findChangeByOperation(args.operationId);
      if (replay) {
        const request = parseChangeRequest(args);
        if (replay.fingerprint !== fingerprintOf(request)) {
          return {
            ok: false,
            error: "operation_conflict",
            changeId: replay.id,
            message: "同じ operationId で、内容の違う変更がすでに実行されています。別の operationId を使ってください。",
            nextAction: "やり直すなら新しい operationId を付け直し、getTasksInRange で今の revision を取り直してください。",
          };
        }
        return { ...replay.result, replayed: true };
      }
      // 反映の直前にもう一度確かめる。
      // 下見（validatePlanChanges）から時間が経って、目標・学習可能時間・予定が
      // 変わっていることがあるため、ここで見た結果だけを信用する。
      const checked = await validatePlan(args, actor, { dryRun: false });
      if (!checked.ok) return checked;
      const request = parseChangeRequest(args);
      const questions = await questionMap();
      const result = await runChanges({
        request,
        actor,
        toolName: "applyTaskChanges",
        knownQuestionIds: new Set(questions.keys()),
      });
      if (!result.ok) return result;
      return { ...result, capacity: checked.days, warnings: checked.warnings, unplaced: checked.unplaced };
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
    /**
     * 目標を1件足す。対象は問題IDの一覧として確定させる。
     * 条件（教科・章・単元・種類・番号・難易度・コース）で選ぶこともできるが、
     * 保存するのは選んだ結果のID一覧である（問題マスタが変わっても対象は動かない）。
     */
    async addGoal(args = {}, actor = {}) {
      const title = readString(args.title, "title", { required: true, max: 200 });
      const deadline = readString(args.deadline, "deadline", { max: 40 }) ?? "";
      if (deadline && !isDateKey(deadline)) fail("deadline は 2026-12-31 のような日付で渡してください。", "deadline");
      const startDate = args.startDate ? readDateArg(args.startDate, "startDate", args) : today(args);
      const goals = await sync.readGoals();
      if (goals.length >= SERVICE_LIMITS.goals) fail(`目標は${SERVICE_LIMITS.goals}件までです。`, "title");

      const document = await sync.readQuestions();
      const all = document.questions ?? [];
      let questionIds = [];
      let scopeFilter = null;
      if (args.questionIds !== undefined && args.questionIds !== null) {
        questionIds = readArray(args.questionIds, "questionIds", { max: 2000 })
          .map((id, index) => readString(id, `questionIds[${index}]`, { required: true, max: 120 }));
        const known = new Set(all.map((question) => question.id));
        const unknown = questionIds.filter((id) => !known.has(id));
        if (unknown.length) {
          return {
            ok: false, error: "unknown_question", unknownQuestionIds: unknown.slice(0, 20),
            message: "問題マスタに無い問題IDが含まれています。目標は作っていません。",
            nextAction: "listQuestions で正しい question.id を確かめてください。",
          };
        }
      } else if (args.scopeFilter !== undefined && args.scopeFilter !== null) {
        rejectUnknownKeys(args.scopeFilter, [
          "subject", "chapter", "section", "course", "types", "numberFrom", "numberTo", "difficultyFrom", "difficultyTo",
        ], "scopeFilter");
        scopeFilter = args.scopeFilter;
        questionIds = selectQuestions(all, scopeFilter).map((question) => question.id);
        if (!questionIds.length) {
          return {
            ok: false, error: "empty_scope",
            message: "その条件に当てはまる問題がありませんでした。目標は作っていません。",
            nextAction: "listQuestions で条件を確かめてください。",
          };
        }
      } else {
        fail("対象を questionIds か scopeFilter で指定してください（文章だけの範囲では計算できません）。", "questionIds");
      }

      const completion = args.completion === undefined || args.completion === null
        ? { type: "attempt" }
        : (() => {
          rejectUnknownKeys(args.completion, ["type", "evaluations", "mode"], "completion");
          const type = readEnum(args.completion.type, "completion.type", [...GOAL_COMPLETION_TYPES], { required: true });
          if (type === "attempt") return { type };
          return {
            type,
            evaluations: args.completion.evaluations
              ? readArray(args.completion.evaluations, "completion.evaluations", { min: 1, max: 5 })
                .map((value, index) => readEnum(value, `completion.evaluations[${index}]`, [...EVALUATIONS], { required: true }))
              : undefined,
            mode: readEnum(args.completion.mode, "completion.mode", ["latest", "ever"], { fallback: "latest" }),
          };
        })();

      const goal = normalizeGoal({
        id: uid("goal"),
        title,
        startDate,
        deadline,
        questionIds,
        scopeFilter,
        scope: readString(args.scope, "scope", { max: 400 }) ?? "",
        completion,
        priority: args.priority === undefined ? 3 : readInteger(args.priority, "priority", { min: 1, max: 5 }),
        status: "active",
        updatedAt: new Date(now()).toISOString(),
      }, { now: now() });

      await sync.writeGoals([goal], { bumpRevision: true });
      await sync.appendLog({
        clientName: actor?.clientName ?? actor?.tokenLabel ?? "AI",
        tool: "addGoal",
        summary: `目標を追加「${title}」対象${questionIds.length}問${deadline ? `（期限 ${deadline}）` : ""}`,
      });
      const saved = (await sync.readGoals()).find((entry) => entry.id === goal.id);
      return { ok: true, goal: normalizeGoal(saved, { now: now() }) };
    },

    /**
     * 目標を書き換える。渡した項目だけが変わる。
     * 達成数は学習記録から数えるものなので、ここからは書き換えられない。
     */
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
      if (args.startDate !== undefined) patch.startDate = readDateArg(args.startDate, "startDate", args);
      if (args.scope !== undefined) patch.scope = readString(args.scope, "scope", { max: 400 }) ?? "";
      if (args.priority !== undefined) patch.priority = readInteger(args.priority, "priority", { min: 1, max: 5, required: true });
      if (args.status !== undefined) patch.status = readEnum(args.status, "status", [...GOAL_STATUSES], { required: true });
      if (args.questionIds !== undefined) {
        const document = await sync.readQuestions();
        const known = new Set((document.questions ?? []).map((question) => question.id));
        const questionIds = readArray(args.questionIds, "questionIds", { max: 2000 })
          .map((value, index) => readString(value, `questionIds[${index}]`, { required: true, max: 120 }));
        const unknown = questionIds.filter((value) => !known.has(value));
        if (unknown.length) {
          return {
            ok: false, error: "unknown_question", unknownQuestionIds: unknown.slice(0, 20),
            message: "問題マスタに無い問題IDが含まれています。目標は変えていません。",
          };
        }
        patch.questionIds = questionIds;
      }
      if (args.completion !== undefined) {
        rejectUnknownKeys(args.completion, ["type", "evaluations", "mode"], "completion");
        patch.completion = {
          type: readEnum(args.completion.type, "completion.type", [...GOAL_COMPLETION_TYPES], { required: true }),
          evaluations: args.completion.evaluations
            ? readArray(args.completion.evaluations, "completion.evaluations", { min: 1, max: 5 })
              .map((value, index) => readEnum(value, `completion.evaluations[${index}]`, [...EVALUATIONS], { required: true }))
            : undefined,
          mode: readEnum(args.completion.mode, "completion.mode", ["latest", "ever"], { fallback: "latest" }),
        };
      }
      if (!Object.keys(patch).length) fail("変更する項目を1つ以上渡してください。", "title");

      const next = normalizeGoal({ ...current, ...patch, id, updatedAt: new Date(now()).toISOString() }, { now: now() });
      await sync.writeGoals([next], { bumpRevision: true });
      await sync.appendLog({
        clientName: actor?.clientName ?? actor?.tokenLabel ?? "AI",
        tool: "updateGoal",
        summary: `目標を変更「${next.title}」`,
      });
      const saved = (await sync.readGoals()).find((entry) => entry.id === id);
      return { ok: true, goal: normalizeGoal(saved, { now: now() }) };
    },

    /**
     * 本人が「やった」と言った学習を、実績としてまとめて記録する。
     *
     * 作ってよいのは、本人が実際に取り組んだと言ったものだけ。
     * 予定が入っていることや、時間の見積もりは根拠にならない。
     * 分からない評価・時間は、埋めずに「未登録」として保存する。
     */
    async addStudyRecords(args = {}, actor = {}) {
      const operationId = readString(args.operationId, "operationId", { required: true, max: 120 });
      const claimSummary = readString(args.claimSummary, "claimSummary", { max: 200 });
      const list = readArray(args.records, "records", { min: 1, max: SERVICE_LIMITS.recordsPerOperation });
      const questions = await questionMap();
      const existing = await sync.readAllRecords();

      const unknownQuestionIds = [];
      const drafts = [];
      const duplicates = [];
      // まとまりで申告された合計時間（「4問で40分」）。1問ずつに割り振らない。
      const groupSeconds = readDurationSeconds(args.totalDurationSeconds, "totalDurationSeconds");
      const groupId = groupSeconds === null ? null : uid("dg");

      list.forEach((raw, index) => {
        const field = `records[${index}]`;
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          fail(`${field} はオブジェクトで渡してください。`, field);
        }
        rejectUnknownKeys(raw, ["questionId", "date", "time", "evaluation", "durationSeconds", "planItemId", "note"], field);
        const questionId = readString(raw.questionId, `${field}.questionId`, { required: true, max: 120 });
        if (!questions.has(questionId)) unknownQuestionIds.push(questionId);
        const when = readWhen(raw, field, args);
        const duplicateOf = similarRecords(existing, questionId, when.date);
        if (duplicateOf.length) duplicates.push({ questionId, date: when.date, existing: duplicateOf });
        drafts.push({
          id: uid("rec"),
          questionId,
          ...when,
          evaluation: readEvaluation(raw.evaluation, `${field}.evaluation`),
          durationSeconds: readDurationSeconds(raw.durationSeconds, `${field}.durationSeconds`),
          ...(groupId ? { durationGroup: { id: groupId, totalSeconds: groupSeconds, count: list.length } } : {}),
          ...(raw.planItemId ? { planItemId: readString(raw.planItemId, `${field}.planItemId`, { max: 120 }) } : {}),
          ...(raw.note ? { claimSummary: readString(raw.note, `${field}.note`, { max: 200 }) } : {}),
          source: "self_report_ai",
        });
      });

      if (unknownQuestionIds.length) {
        return {
          ok: false,
          error: "unknown_question",
          unknownQuestionIds: [...new Set(unknownQuestionIds)],
          message: "問題マスタに無い問題IDが含まれています。記録は1件も保存していません。",
          nextAction: "searchQuestions / listQuestions で正しい question.id を確かめてください"
            + "（数学Iと数学Aで同じ番号の例題があるので、教科も合わせて確かめること）。",
        };
      }

      // 予定との結び付きは、本人が「この予定を終えた」と示したときだけ。
      const plans = new Map();
      for (const draft of drafts) {
        if (!draft.planItemId) continue;
        const plan = await findPlanItem(draft.planItemId);
        if (!plan) {
          return {
            ok: false,
            error: "plan_item_not_found",
            planItemId: draft.planItemId,
            message: `予定項目 ${draft.planItemId} が見つかりません。記録は1件も保存していません。`,
            nextAction: "getTasksInRange で itemId を確かめるか、予定と結び付けずに保存してください。",
          };
        }
        if (plan.item.questionId !== draft.questionId) {
          return {
            ok: false,
            error: "plan_item_mismatch",
            planItemId: draft.planItemId,
            message: "その予定項目は別の問題のものです。記録は1件も保存していません。",
          };
        }
        const alreadyDone = existing.some((record) => record.planItemId === draft.planItemId);
        if (alreadyDone) {
          return {
            ok: false,
            error: "plan_item_already_done",
            planItemId: draft.planItemId,
            message: "その予定には、すでに取り組みの記録があります。同じ予定を二重に完了にはできません。",
            nextAction: "解き直しなら、予定と結び付けずに（planItemId なしで）保存してください。",
          };
        }
        plans.set(draft.planItemId, plan);
      }

      const result = await runRecordOperations({
        operationId,
        fingerprint: recordFingerprint({ adds: drafts.map(({ id, ...rest }) => rest), claimSummary }),
        adds: drafts,
        actorKind: "ai",
        actorName: actor?.clientName ?? actor?.tokenLabel ?? "AI",
        tool: "addStudyRecords",
        claimSummary,
      });
      if (!result.ok) return result;
      return {
        ...result,
        today: today(args),
        // 同じ問題・同じ日の記録がすでにあった場合は知らせる（勝手に消さない）。
        possibleDuplicates: duplicates,
        note: duplicates.length
          ? "同じ問題・同じ日の記録がすでにあります。同じ取り組みを二重に入れていないか、利用者に確かめてください"
            + "（同じ日に2回解くこと自体はふつうにあるので、勝手に消さないこと）。"
          : null,
        unknownNote: "evaluation が null の記録は「評価が未登録」です。正解にも不正解にも数えません。"
          + " durationSeconds が null の記録は「時間が未登録」で、平均や見積もりには入りません。",
      };
    },

    /**
     * すでにある実績を、本人の申告にもとづいて部分的に直す。
     * 渡さなかった項目はそのまま。記録IDは変わらない。
     */
    async updateStudyRecords(args = {}, actor = {}) {
      const operationId = readString(args.operationId, "operationId", { required: true, max: 120 });
      const reason = readString(args.reason, "reason", { max: 200 });
      const list = readArray(args.updates, "updates", { min: 1, max: SERVICE_LIMITS.recordsPerOperation });
      const questions = await questionMap();

      const updates = [];
      for (const [index, raw] of list.entries()) {
        const field = `updates[${index}]`;
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          fail(`${field} はオブジェクトで渡してください。`, field);
        }
        rejectUnknownKeys(raw, ["recordId", "expectedRevision", "date", "time", "evaluation", "durationSeconds", "questionId", "planItemId", "reason"], field);
        const recordId = readString(raw.recordId, `${field}.recordId`, { required: true, max: 80 });
        const patch = {};
        const afterSummary = {};
        if (raw.date !== undefined || raw.time !== undefined) {
          const found = await sync.findRecord(recordId);
          const current = found?.record;
          const when = readWhen({
            date: raw.date ?? (current ? recordDateOf(current) : undefined),
            time: raw.time,
          }, field, args);
          Object.assign(patch, when);
          // 時刻を渡していないのに日付だけ直した場合、もとの時刻は当てにならないので落とす。
          if (raw.time === undefined && current && hasExactTime(current) && raw.date !== undefined) {
            patch.timestamp = null;
            patch.datePrecision = "date";
          }
          afterSummary.date = when.date;
        }
        if (raw.evaluation !== undefined) {
          patch.evaluation = readEvaluation(raw.evaluation, `${field}.evaluation`);
          afterSummary.evaluation = patch.evaluation;
        }
        if (raw.durationSeconds !== undefined) {
          patch.durationSeconds = readDurationSeconds(raw.durationSeconds, `${field}.durationSeconds`);
          afterSummary.durationSeconds = patch.durationSeconds;
        }
        if (raw.questionId !== undefined) {
          const questionId = readString(raw.questionId, `${field}.questionId`, { required: true, max: 120 });
          if (!questions.has(questionId)) {
            return {
              ok: false,
              error: "unknown_question",
              unknownQuestionIds: [questionId],
              message: "問題マスタに無い問題IDです。1件も変更していません。",
            };
          }
          patch.questionId = questionId;
          afterSummary.questionId = questionId;
        }
        if (raw.planItemId !== undefined) {
          patch.planItemId = raw.planItemId === null ? undefined : readString(raw.planItemId, `${field}.planItemId`, { max: 120 });
          afterSummary.planItemId = patch.planItemId ?? null;
        }
        if (!Object.keys(patch).length) fail(`${field} には直したい項目を1つ以上入れてください。`, field);
        // 訂正された記録は「本人の申告で直したもの」になる。
        patch.source = "self_report_ai";
        updates.push({
          recordId,
          expectedRevision: raw.expectedRevision,
          patch,
          reason: readString(raw.reason, `${field}.reason`, { max: 200 }) ?? reason,
          afterSummary,
        });
      }

      // 変更前の内容を履歴へ残すため、いまの値を読んでおく。
      for (const update of updates) {
        const found = await sync.findRecord(update.recordId);
        if (found) {
          update.beforeSummary = {
            date: recordDateOf(found.record),
            evaluation: found.record.evaluation ?? null,
            durationSeconds: hasDuration(found.record) ? found.record.durationSeconds : null,
            questionId: found.record.questionId,
            planItemId: found.record.planItemId ?? null,
          };
        }
      }

      return runRecordOperations({
        operationId,
        fingerprint: recordFingerprint({ updates: updates.map(({ recordId, patch }) => ({ recordId, patch })), reason }),
        updates,
        actorKind: "ai",
        actorName: actor?.clientName ?? actor?.tokenLabel ?? "AI",
        tool: "updateStudyRecords",
        reason,
      });
    },

    /** 誤って入れた実績を取り消す。消さずに印をつけ、ふだんの集計から外す。 */
    async voidStudyRecords(args = {}, actor = {}) {
      const operationId = readString(args.operationId, "operationId", { required: true, max: 120 });
      const reason = readString(args.reason, "reason", { max: 200 });
      const list = readArray(args.records, "records", { min: 1, max: SERVICE_LIMITS.recordsPerOperation });
      const voids = list.map((raw, index) => {
        const field = `records[${index}]`;
        if (typeof raw === "string") return { recordId: raw };
        if (typeof raw !== "object" || raw === null) fail(`${field} は recordId か { recordId, expectedRevision } で渡してください。`, field);
        rejectUnknownKeys(raw, ["recordId", "expectedRevision", "reason"], field);
        return {
          recordId: readString(raw.recordId, `${field}.recordId`, { required: true, max: 80 }),
          expectedRevision: raw.expectedRevision,
          reason: readString(raw.reason, `${field}.reason`, { max: 200 }) ?? reason,
        };
      });
      return runRecordOperations({
        operationId,
        fingerprint: recordFingerprint({ voids: voids.map(({ recordId }) => recordId), reason }),
        voids,
        actorKind: "ai",
        actorName: actor?.clientName ?? actor?.tokenLabel ?? "AI",
        tool: "voidStudyRecords",
        reason,
      });
    },

    /**
     * 取り消した記録・チャレンジを、取り消す前の状態へ戻す。
     *
     * 取り消しは消さずに印をつけるだけなので、戻すことができる。
     * チャレンジを1回ぶん戻すと、そのとき道連れで取り消した記録も戻る
     *（1問だけ個別に取り消してあった分は、取り消したままにする）。
     */
    async restoreStudyRecords(args = {}, actor = {}) {
      const operationId = readString(args.operationId, "operationId", { required: true, max: 120 });
      const reason = readString(args.reason, "reason", { max: 200 });
      const readTargets = (list, key, idKey) => (list ?? []).map((raw, index) => {
        const field = `${key}[${index}]`;
        if (typeof raw === "string") return { [idKey]: raw, reason };
        if (typeof raw !== "object" || raw === null) fail(`${field} は ${idKey} か { ${idKey}, expectedRevision } で渡してください。`, field);
        rejectUnknownKeys(raw, [idKey, "expectedRevision", "reason"], field);
        return {
          [idKey]: readString(raw[idKey], `${field}.${idKey}`, { required: true, max: 80 }),
          expectedRevision: raw.expectedRevision,
          reason: readString(raw.reason, `${field}.reason`, { max: 200 }) ?? reason,
        };
      });
      const restores = readTargets(
        args.records === undefined ? [] : readArray(args.records, "records", { max: SERVICE_LIMITS.recordsPerOperation }),
        "records", "recordId",
      );
      const restoreChallenges = readTargets(
        args.challenges === undefined ? [] : readArray(args.challenges, "challenges", { max: SERVICE_LIMITS.recordsPerOperation }),
        "challenges", "challengeId",
      );
      if (!restores.length && !restoreChallenges.length) {
        fail("戻したい記録（records）かチャレンジ（challenges）を1件以上渡してください。", "records");
      }
      return runRecordOperations({
        operationId,
        fingerprint: recordFingerprint({
          restores: restores.map(({ recordId }) => recordId),
          restoreChallenges: restoreChallenges.map(({ challengeId }) => challengeId),
          reason,
        }),
        restores,
        restoreChallenges,
        actorKind: "ai",
        actorName: actor?.clientName ?? actor?.tokenLabel ?? "AI",
        tool: "restoreStudyRecords",
        reason,
      });
    },

    /**
     * チャレンジの履歴を取り消す。
     *
     * チャレンジは「1回ぶんの通し」なので、1問だけ抜くと合計時間と食い違う。
     * そのため取り消しは1回まるごとで、中の学習記録もいっしょに取り消す。
     */
    async voidChallengeResults(args = {}, actor = {}) {
      const operationId = readString(args.operationId, "operationId", { required: true, max: 120 });
      const reason = readString(args.reason, "reason", { max: 200 });
      const list = readArray(args.challenges, "challenges", { min: 1, max: SERVICE_LIMITS.recordsPerOperation });
      const voidChallenges = list.map((raw, index) => {
        const field = `challenges[${index}]`;
        if (typeof raw === "string") return { challengeId: raw, reason };
        if (typeof raw !== "object" || raw === null) fail(`${field} は challengeId か { challengeId, expectedRevision } で渡してください。`, field);
        rejectUnknownKeys(raw, ["challengeId", "expectedRevision", "reason"], field);
        return {
          challengeId: readString(raw.challengeId, `${field}.challengeId`, { required: true, max: 80 }),
          expectedRevision: raw.expectedRevision,
          reason: readString(raw.reason, `${field}.reason`, { max: 200 }) ?? reason,
        };
      });
      return runRecordOperations({
        operationId,
        fingerprint: recordFingerprint({ voidChallenges: voidChallenges.map(({ challengeId }) => challengeId), reason }),
        voidChallenges,
        actorKind: "ai",
        actorName: actor?.clientName ?? actor?.tokenLabel ?? "AI",
        tool: "voidChallengeResults",
        reason,
      });
    },

    /** 学習記録の追加・訂正・取り消しの履歴。 */
    async getRecordChanges(args = {}) {
      const limit = readInteger(args.limit, "limit", { min: 1, max: 100, fallback: 20 });
      const { total, entries } = await sync.readRecordOperations({ limit });
      return {
        total,
        count: entries.length,
        operations: entries.map((entry) => ({
          operationId: entry.operationId,
          at: entry.at,
          by: entry.actorKind === "ai" ? `AI（${entry.actorName}）` : entry.actorName,
          tool: entry.tool,
          reason: entry.reason,
          claimSummary: entry.claimSummary,
          counts: entry.result?.counts ?? null,
          changes: entry.changes ?? [],
        })),
      };
    },

    /** 配分案を、保存する前に確かめる。実際には何も変えない。 */
    async validatePlanChanges(args = {}, actor = {}) {
      return validatePlan(args, actor, { dryRun: true });
    },

    getOperationLog(args = {}) {
      return sync.readLog({ limit: readInteger(args.limit, "limit", { min: 1, max: 100, fallback: 20 }) });
    },
  };
}
