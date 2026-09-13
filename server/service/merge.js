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
import { itemsOf, normalizeMove } from "../../src/plan-items.js";
import { normalizeGoal } from "../../src/goals.js";
import {
  isCountedRecord,
  mergeStudyRecord,
  normalizeStudyRecord,
  recordDateOf,
  sumDurations,
} from "../../src/records-model.js";
import { normalizeAvailability } from "../../src/availability.js";

export const EVALUATIONS = Object.freeze([
  "perfect", "better_solution", "weak_writing", "calc_error", "wrong_approach",
]);

export const MISTAKE_EVALUATIONS = Object.freeze(["calc_error", "wrong_approach"]);

export const TASK_KINDS = Object.freeze(["new", "review", "challenge", "priority"]);

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 端末から届いた学習記録を、保存してよい形へ整える（src/records-model.js）。
 *
 * 学習記録は「追加専用」ではなくなった。本人の申告にもとづいて後から足したり、
 * 訂正したり、取り消したりできる。どれが新しいかは revision で見分ける。
 */
export { normalizeStudyRecord as normalizeRecord };

/** 学習記録を重ね合わせる。訂正された内容（revision が大きいほう）を残す。 */
export function mergeRecords(stored = {}, incoming = []) {
  const merged = { ...stored };
  let added = 0;
  let updated = 0;
  let ignored = 0;
  for (const record of incoming) {
    if (!record) continue;
    const current = merged[record.id];
    if (!current) {
      merged[record.id] = record;
      added += 1;
      continue;
    }
    const winner = mergeStudyRecord(current, record);
    if (winner === record && winner !== current) {
      merged[record.id] = record;
      updated += 1;
    } else {
      // 届いた内容のほうが古い（訂正前）。サーバーの内容を残す。
      ignored += 1;
    }
  }
  return { merged, added, updated, ignored };
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
  const at = new Date(now).toISOString();
  return {
    date: planDate,
    tasks: tasks.slice(0, 100).map((task, index) => normalizeTask(task, index, { now: at, date: planDate })).filter(Boolean),
    updatedAt: typeof source.updatedAt === "string" && Number.isFinite(Date.parse(source.updatedAt))
      ? source.updatedAt
      : at,
    revision: Number.isFinite(Number(source.revision)) ? Math.max(0, Math.floor(Number(source.revision))) : 0,
    updatedBy: typeof source.updatedBy === "string" ? source.updatedBy.slice(0, 60) : updatedBy,
    ...(isObject(source.active) ? { active: normalizeActive(source.active) } : {}),
  };
}

/** 端末が知らせてきた「いま解いている」状態。期限つきで預かる。 */
export function normalizeActive(raw) {
  if (!isObject(raw) || typeof raw.taskId !== "string" || !raw.taskId) return null;
  return {
    taskId: raw.taskId.slice(0, 80),
    ...(typeof raw.questionId === "string" && raw.questionId ? { questionId: raw.questionId.slice(0, 120) } : {}),
    ...(typeof raw.deviceId === "string" && raw.deviceId ? { deviceId: raw.deviceId.slice(0, 80) } : {}),
    startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
  };
}

/**
 * タスク1件を整える。
 *
 * ID は渡されたものを必ず残す。渡されていないときだけ新しく作る。
 * （毎回作り直すと、同じタスクを指し示せなくなり、部分更新も履歴もできなくなる。）
 * pinned（利用者が固定した印）は、無ければ false として補う。古いデータもそのまま読める。
 */
export function normalizeTask(raw, index = 0, { now = null, date = null } = {}) {
  if (!isObject(raw)) return null;
  const questionIds = Array.isArray(raw.questionIds)
    ? raw.questionIds.filter((value) => typeof value === "string" && value).slice(0, 100)
    : [];
  const kind = TASK_KINDS.includes(raw.kind) ? raw.kind : "new";
  if (!questionIds.length && !raw.title) return null;
  const at = now ?? new Date().toISOString();
  const taskId = typeof raw.id === "string" && raw.id ? raw.id.slice(0, 80) : `task_${index}_${Math.random().toString(36).slice(2, 8)}`;
  const planDate = date;
  return {
    id: taskId,
    questionIds,
    kind,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
    completed: raw.completed === true,
    pinned: raw.pinned === true,
    ...(Number.isFinite(Number(raw.timeLimitSeconds)) && Number(raw.timeLimitSeconds) > 0
      ? { timeLimitSeconds: Math.round(Number(raw.timeLimitSeconds)) }
      : {}),
    ...(typeof raw.title === "string" && raw.title ? { title: raw.title.slice(0, 120) } : {}),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : at,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : at,
    ...(typeof raw.source === "string" ? { source: raw.source.slice(0, 20) } : {}),
    ...(typeof raw.goalId === "string" && raw.goalId ? { goalId: raw.goalId.slice(0, 80) } : {}),
    // 予定項目（この予定の中の「1回の取り組み」1件ずつ）。
    // 古いデータには無いので questionIds の並びから組み立てる。
    items: itemsOf({ ...raw, id: taskId, questionIds, date: planDate }),
  };
}

/**
 * 端末から届いた予定を、サーバーに預かっているものへ重ねる。
 *
 *   ・サーバーに無ければ、そのまま受け入れる
 *   ・端末が見ていた版（revision）がサーバーと同じなら、受け入れて版を1つ進める
 *   ・食い違っていたら、更新時刻が新しいほうを残す（古い内容で新しい内容を消さない）
 *
 * 受け入れるときも、次のものは端末の内容で上書きしない。
 * 旧い端末や旧いAPIから、保護と競合制御を回り込めないようにするため。
 *
 *   ・固定（pinned） … サーバーに固定の印があるタスクは固定のまま
 *   ・作った時刻     … 端末が知らない場合に消えないように引き継ぐ
 *   ・別の日へ移したタスク … placements（配置の記録）で弾く。
 *     移動を知らない端末が、移動前の日の予定を送ってきても復活させない。
 */
export function mergeTaskPlan(stored, incoming, { placements = null, now = Date.now() } = {}) {
  if (!incoming) return { plan: stored, outcome: "ignored" };
  // 端末がサーバーと同じ版を見ていれば、移動を知ったうえでの内容として扱う。
  // 版が食い違う端末（圏外だった端末など）は、移したタスクを戻せない。
  const upToDate = Number(incoming.revision ?? 0) === Number(stored?.revision ?? 0);
  const filtered = upToDate ? incoming : applyPlacements(incoming, placements);
  const revived = (incoming.tasks ?? []).length - (filtered.tasks ?? []).length;
  if (!stored) {
    return {
      plan: { ...filtered, revision: Math.max(1, filtered.revision || 1) },
      outcome: "created",
      droppedTasks: revived,
    };
  }
  const carry = (plan) => carryProtections(stored, plan, now);
  if (upToDate) {
    return {
      plan: { ...carry(filtered), revision: Number(stored.revision ?? 0) + 1 },
      outcome: "applied",
      droppedTasks: revived,
    };
  }
  const incomingAt = Date.parse(filtered.updatedAt ?? "") || 0;
  const storedAt = Date.parse(stored.updatedAt ?? "") || 0;
  if (incomingAt > storedAt) {
    return {
      plan: { ...carry(filtered), revision: Number(stored.revision ?? 0) + 1 },
      outcome: "applied-newer",
      droppedTasks: revived,
    };
  }
  // 端末側が古い。サーバーの内容を残し、そのまま返して端末に取り込ませる。
  return { plan: stored, outcome: "kept-server", droppedTasks: revived };
}

/**
 * 「このタスクは今どの日にあるか」の記録で、届いた予定をふるいにかける。
 * 別の日へ移したタスクを、移動を知らない端末が元の日へ戻すのを防ぐ。
 * 最新の版を見ている端末（upToDate）には、このふるいをかけない。
 */
export function applyPlacements(plan, placements) {
  if (!placements || !plan) return plan;
  const tasks = (plan.tasks ?? []).filter((task) => {
    const placement = placements[task.id];
    return !placement || placement.date === plan.date;
  });
  return { ...plan, tasks };
}

/** 保護に関わる項目は、端末の内容で消させない。 */
function carryProtections(stored, incoming, now) {
  const storedById = new Map((stored.tasks ?? []).map((task) => [task.id, task]));
  const tasks = (incoming.tasks ?? []).map((task) => {
    const before = storedById.get(task.id);
    if (!before) return task;
    return {
      ...task,
      // 固定はサーバー側を正とする。外せるのは専用の操作（/api/sync/pin）だけ。
      pinned: before.pinned === true ? true : task.pinned === true,
      createdAt: before.createdAt ?? task.createdAt,
      // 予定項目のIDは、端末が知らなくても消さない（実績との対応が切れるため）。
      items: carryItems(before, task),
    };
  });
  const active = stored.active && Date.parse(stored.active.expiresAt ?? "") > now ? stored.active : undefined;
  return { ...incoming, tasks, ...(active ? { active } : {}) };
}

/**
 * 目標は「何を・いつまでに・どの状態まで」を持つ構造として扱う（src/goals.js）。
 * 古い目標（文章の scope だけ）も、そのまま読めるようにしてある。
 */
export { normalizeGoal };

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

/**
 * 予定項目のIDを引き継ぐ。
 * items を知らない古い端末から届いた予定でも、サーバー側のIDを保つ。
 */
function carryItems(before, incoming) {
  const storedItems = itemsOf(before);
  const pool = new Map();
  for (const item of storedItems) {
    if (!pool.has(item.questionId)) pool.set(item.questionId, []);
    pool.get(item.questionId).push(item);
  }
  return (incoming.items ?? []).map((item) => {
    const known = storedItems.find((entry) => entry.itemId === item.itemId);
    if (known) return { ...known, ...item, itemId: known.itemId, originalDate: known.originalDate ?? item.originalDate };
    const reused = pool.get(item.questionId)?.shift();
    return reused ? { ...reused, questionId: item.questionId } : item;
  });
}

/**
 * 学習可能時間は1つの文書として持つ。端末どうしでぶつかったら、
 * 更新時刻が新しいほうを採る（予定と同じ考え方）。消すことはしない。
 */
export function mergeAvailability(stored, incoming) {
  const left = stored ? normalizeAvailability(stored) : null;
  const right = incoming ? normalizeAvailability(incoming) : null;
  if (!right) return { availability: left, outcome: "ignored" };
  if (!left) return { availability: { ...right, revision: Math.max(1, right.revision || 1) }, outcome: "created" };
  const leftAt = Date.parse(left.updatedAt ?? "") || 0;
  const rightAt = Date.parse(right.updatedAt ?? "") || 0;
  if (rightAt > leftAt) {
    return { availability: { ...right, revision: Number(left.revision ?? 0) + 1 }, outcome: "applied" };
  }
  return { availability: left, outcome: "kept-server" };
}

/**
 * 問題別の見積もり指定。
 * 本人の指定（manualSeconds）とAIの仮見積もり（aiSeconds）は別々に持ち、
 * どちらも「新しいほうを採る」。本人の指定をAIの値で黙って置き換えない。
 */
export function mergeEstimateEntries(stored = {}, incoming = {}) {
  const merged = { ...stored };
  for (const [questionId, entry] of Object.entries(incoming)) {
    if (!entry || typeof entry !== "object") continue;
    const current = merged[questionId] ?? {};
    const pick = (key, atKey) => {
      const currentAt = Date.parse(current[atKey] ?? "") || 0;
      const incomingAt = Date.parse(entry[atKey] ?? "") || 0;
      return incomingAt >= currentAt && entry[key] !== undefined ? entry[key] : current[key];
    };
    merged[questionId] = {
      ...current,
      manualSeconds: pick("manualSeconds", "manualUpdatedAt"),
      manualUpdatedAt: (Date.parse(entry.manualUpdatedAt ?? "") || 0) >= (Date.parse(current.manualUpdatedAt ?? "") || 0)
        ? (entry.manualUpdatedAt ?? current.manualUpdatedAt ?? null)
        : current.manualUpdatedAt ?? null,
      aiSeconds: pick("aiSeconds", "aiUpdatedAt"),
      aiSource: pick("aiSource", "aiUpdatedAt"),
      aiNote: pick("aiNote", "aiUpdatedAt"),
      aiUpdatedAt: (Date.parse(entry.aiUpdatedAt ?? "") || 0) >= (Date.parse(current.aiUpdatedAt ?? "") || 0)
        ? (entry.aiUpdatedAt ?? current.aiUpdatedAt ?? null)
        : current.aiUpdatedAt ?? null,
    };
  }
  return merged;
}

/** 移動（繰り越し）イベントは追加専用。id が同じものは1件として扱う。 */
export { normalizeMove };

/**
 * 学習記録から統計を数え直す。合計値そのものは同期しない。
 *
 *   ・取り消した記録は数えない
 *   ・時間が分からない記録は 0秒として足さず、件数だけ数える
 *   ・日付は実施日（date）で見る。あとから足した記録も、実施した日に入る
 */
export function computeStats(records, questions = [], { timezoneOffsetMinutes } = {}) {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const byEvaluation = {};
  const byChapter = {};
  const byDate = {};
  const counted = records.filter(isCountedRecord);
  const totals = sumDurations(counted);
  let unknownEvaluations = 0;
  for (const record of counted) {
    const seconds = typeof record.durationSeconds === "number" ? record.durationSeconds : 0;
    if (record.evaluation) byEvaluation[record.evaluation] = (byEvaluation[record.evaluation] || 0) + 1;
    else unknownEvaluations += 1;
    const chapter = byId.get(record.questionId)?.chapter ?? "不明";
    byChapter[chapter] ??= { count: 0, seconds: 0, byEvaluation: {} };
    byChapter[chapter].count += 1;
    byChapter[chapter].seconds += seconds;
    if (record.evaluation) {
      byChapter[chapter].byEvaluation[record.evaluation] =
        (byChapter[chapter].byEvaluation[record.evaluation] || 0) + 1;
    }
    const day = recordDateOf(record, timezoneOffsetMinutes);
    byDate[day] ??= { count: 0, seconds: 0 };
    byDate[day].count += 1;
    byDate[day].seconds += seconds;
  }
  return {
    totalRecords: counted.length,
    totalSeconds: totals.seconds,
    // 時間が登録されていない取り組みの数。平均を出すときはこれを除いて考える。
    durationUnknownCount: totals.unknownCount,
    evaluationUnknownCount: unknownEvaluations,
    uniqueQuestions: new Set(counted.map((record) => record.questionId)).size,
    byEvaluation,
    byChapter,
    byDate,
  };
}

/** 問題マスタの指紋。PWA側と同じ計算を使う（src/hash.js）。 */
export { hashQuestions };

// 問題マスタの整え方は PWA と共有する（経路の途中で項目が落ちないように）。
export { normalizeQuestion } from "../../src/question-order.js";
