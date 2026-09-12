// 端末をまたいでデータを1つに合わせるための、純粋な処理だけを集めたところ。
//
// いちばん大事な約束は「消さないこと」。
// 件数の多い少ないを理由に、片方をまるごと置き換えることは決してしない。
//
//   学習記録・チャレンジ結果 … 追加専用のイベント。record.id で重複を除くだけ。
//                               合計や正答率は同期せず、イベントから数え直す。
//   その日の予定（TaskPlan） … 日付ごとに1つ。revision と updatedAt で新しいほうを採る。
//   目標（Goal）             … id ごとに updatedAt が新しいほうを採る。
//   問題マスタ               … version と hash が変わったときだけ入れ替える。

import { dateKeyOf, isDateKey } from "../../src/datetime.js";
import { hashQuestions } from "../../src/hash.js";

export const EVALUATIONS = Object.freeze([
  "perfect", "better_solution", "weak_writing", "calc_error", "wrong_approach",
]);

export const MISTAKE_EVALUATIONS = Object.freeze(["calc_error", "wrong_approach"]);

export const TASK_KINDS = Object.freeze(["new", "review", "challenge", "priority"]);

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** 端末から届いた学習記録を、保存してよい形へ整える。壊れているものは落とす。 */
export function normalizeRecord(raw, { receivedAt = Date.now() } = {}) {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const questionId = typeof raw.questionId === "string" ? raw.questionId.trim() : "";
  const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : "";
  if (!id || !questionId || !Number.isFinite(Date.parse(timestamp))) return null;
  if (!EVALUATIONS.includes(raw.evaluation)) return null;
  return {
    id: id.slice(0, 80),
    questionId: questionId.slice(0, 120),
    timestamp,
    evaluation: raw.evaluation,
    durationSeconds: Math.max(0, Math.round(Number(raw.durationSeconds) || 0)),
    ...(typeof raw.challengeId === "string" && raw.challengeId ? { challengeId: raw.challengeId.slice(0, 80) } : {}),
    // どの同期で届いたか。次回の差分取得（since）に使う。
    syncedAt: receivedAt,
  };
}

/**
 * チャレンジ結果も追加専用のイベントとして扱う。
 * 形は study-todo のPWAが保存しているものに合わせる。
 */
export function normalizeChallengeResult(raw, { receivedAt = Date.now() } = {}) {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : "";
  if (!id || !Number.isFinite(Date.parse(timestamp))) return null;
  const laps = Array.isArray(raw.laps) ? raw.laps : [];
  return {
    id: id.slice(0, 80),
    timestamp,
    ...(typeof raw.taskId === "string" && raw.taskId ? { taskId: raw.taskId.slice(0, 80) } : {}),
    timeLimitSeconds: Math.max(0, Math.round(Number(raw.timeLimitSeconds) || 0)),
    totalElapsedSeconds: Math.max(0, Math.round(Number(raw.totalElapsedSeconds) || 0)),
    succeeded: raw.succeeded === true,
    laps: laps.slice(0, 200).map((lap) => ({
      questionId: typeof lap?.questionId === "string" ? lap.questionId.slice(0, 120) : "",
      durationSeconds: Math.max(0, Math.round(Number(lap?.durationSeconds) || 0)),
      evaluation: EVALUATIONS.includes(lap?.evaluation) ? lap.evaluation : null,
    })).filter((lap) => lap.questionId),
    syncedAt: receivedAt,
  };
}

/**
 * イベントを id で重ね合わせる。すでにあるものは残したまま、無いものだけ足す。
 * 何回同じものが届いても結果は変わらない（idempotent）。
 */
export function mergeEvents(stored = {}, incoming = []) {
  const merged = { ...stored };
  let added = 0;
  for (const event of incoming) {
    if (!event) continue;
    if (merged[event.id]) continue;
    merged[event.id] = event;
    added += 1;
  }
  return { merged, added, skipped: incoming.length - added };
}

/** その日の予定を、渡された形へ整える。 */
export function normalizeTaskPlan(raw, { date = null, updatedBy = "app", now = Date.now() } = {}) {
  const source = isObject(raw) ? raw : {};
  const planDate = date ?? source.date;
  if (!isDateKey(planDate)) return null;
  const tasks = Array.isArray(source.tasks) ? source.tasks : [];
  return {
    date: planDate,
    tasks: tasks.slice(0, 100).map((task, index) => normalizeTask(task, index)).filter(Boolean),
    updatedAt: typeof source.updatedAt === "string" && Number.isFinite(Date.parse(source.updatedAt))
      ? source.updatedAt
      : new Date(now).toISOString(),
    revision: Number.isFinite(Number(source.revision)) ? Math.max(0, Math.floor(Number(source.revision))) : 0,
    updatedBy: typeof source.updatedBy === "string" ? source.updatedBy.slice(0, 60) : updatedBy,
  };
}

export function normalizeTask(raw, index = 0) {
  if (!isObject(raw)) return null;
  const questionIds = Array.isArray(raw.questionIds)
    ? raw.questionIds.filter((value) => typeof value === "string" && value).slice(0, 100)
    : [];
  const kind = TASK_KINDS.includes(raw.kind) ? raw.kind : "new";
  if (!questionIds.length && !raw.title) return null;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id.slice(0, 80) : `task_${index}_${Math.random().toString(36).slice(2, 8)}`,
    questionIds,
    kind,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
    completed: raw.completed === true,
    ...(Number.isFinite(Number(raw.timeLimitSeconds)) && Number(raw.timeLimitSeconds) > 0
      ? { timeLimitSeconds: Math.round(Number(raw.timeLimitSeconds)) }
      : {}),
    ...(typeof raw.title === "string" && raw.title ? { title: raw.title.slice(0, 120) } : {}),
  };
}

/**
 * その日の予定を重ね合わせる。
 *
 *   ・サーバーに無ければ、そのまま受け入れる
 *   ・端末が見ていた版（revision）がサーバーと同じなら、受け入れて版を1つ進める
 *   ・食い違っていたら、更新時刻が新しいほうを残す（古い内容で新しい内容を消さない）
 */
export function mergeTaskPlan(stored, incoming) {
  if (!incoming) return { plan: stored, outcome: "ignored" };
  if (!stored) {
    return { plan: { ...incoming, revision: Math.max(1, incoming.revision || 1) }, outcome: "created" };
  }
  const sameRevision = Number(incoming.revision ?? 0) === Number(stored.revision ?? 0);
  if (sameRevision) {
    return { plan: { ...incoming, revision: Number(stored.revision ?? 0) + 1 }, outcome: "applied" };
  }
  const incomingAt = Date.parse(incoming.updatedAt ?? "") || 0;
  const storedAt = Date.parse(stored.updatedAt ?? "") || 0;
  if (incomingAt > storedAt) {
    return { plan: { ...incoming, revision: Number(stored.revision ?? 0) + 1 }, outcome: "applied-newer" };
  }
  // 端末側が古い。サーバーの内容を残し、そのまま返して端末に取り込ませる。
  return { plan: stored, outcome: "kept-server" };
}

/** 目標は id ごとに、更新時刻が新しいほうを採る。消した印（deletedAt）も引き継ぐ。 */
export function normalizeGoal(raw, { now = Date.now() } = {}) {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  return {
    id: id.slice(0, 80),
    title: typeof raw.title === "string" ? raw.title.slice(0, 200) : "",
    deadline: typeof raw.deadline === "string" ? raw.deadline.slice(0, 40) : "",
    scope: typeof raw.scope === "string" ? raw.scope.slice(0, 400) : "",
    updatedAt: typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt))
      ? raw.updatedAt
      : new Date(now).toISOString(),
    ...(typeof raw.deletedAt === "string" ? { deletedAt: raw.deletedAt } : {}),
  };
}

export function mergeGoals(stored = [], incoming = []) {
  const byId = new Map(stored.map((goal) => [goal.id, goal]));
  for (const goal of incoming) {
    if (!goal) continue;
    const current = byId.get(goal.id);
    if (!current) {
      byId.set(goal.id, goal);
      continue;
    }
    const incomingAt = Date.parse(goal.updatedAt ?? "") || 0;
    const currentAt = Date.parse(current.updatedAt ?? "") || 0;
    if (incomingAt >= currentAt) byId.set(goal.id, goal);
  }
  return [...byId.values()];
}

/** 学習記録から統計を数え直す。合計値そのものは同期しない。 */
export function computeStats(records, questions = [], { timezoneOffsetMinutes } = {}) {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const byEvaluation = {};
  const byChapter = {};
  const byDate = {};
  let totalSeconds = 0;
  for (const record of records) {
    totalSeconds += record.durationSeconds;
    byEvaluation[record.evaluation] = (byEvaluation[record.evaluation] || 0) + 1;
    const chapter = byId.get(record.questionId)?.chapter ?? "不明";
    byChapter[chapter] ??= { count: 0, seconds: 0, byEvaluation: {} };
    byChapter[chapter].count += 1;
    byChapter[chapter].seconds += record.durationSeconds;
    byChapter[chapter].byEvaluation[record.evaluation] =
      (byChapter[chapter].byEvaluation[record.evaluation] || 0) + 1;
    const day = dateKeyOf(record.timestamp, timezoneOffsetMinutes);
    byDate[day] ??= { count: 0, seconds: 0 };
    byDate[day].count += 1;
    byDate[day].seconds += record.durationSeconds;
  }
  return {
    totalRecords: records.length,
    totalSeconds,
    uniqueQuestions: new Set(records.map((record) => record.questionId)).size,
    byEvaluation,
    byChapter,
    byDate,
  };
}

/** 問題マスタの指紋。PWA側と同じ計算を使う（src/hash.js）。 */
export { hashQuestions };

export function normalizeQuestion(raw) {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  return {
    id: id.slice(0, 120),
    subject: String(raw.subject ?? "").slice(0, 60),
    chapter: String(raw.chapter ?? "").slice(0, 80),
    section: String(raw.section ?? "").slice(0, 80),
    type: String(raw.type ?? "").slice(0, 40),
    number: Number(raw.number) || 0,
    label: String(raw.label ?? "").slice(0, 120),
    difficulty: raw.difficulty ?? null,
  };
}
