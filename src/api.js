// データアクセス層。
// MCP サーバーが必要とするツール群と 1:1 に対応する関数をここに集約する。
// UI は必ずこの層を経由し、IndexedDB を直接触らない。
// 将来サーバー同期に差し替える場合も、この関数シグネチャを保てばよい。

import { idb, STORES } from './idb.js';
import { studyDateKeyOf } from './datetime.js';
import { buildOutline, compareQuestions, normalizeQuestion, questionHaystack } from './question-order.js';
import { itemsOf, splitPlanItems, withItems } from './plan-items.js';
import { normalizeGoal, goalAttempts as goalAttemptsOf, questionSatisfied as questionSatisfiedFor } from './goals.js';
import { normalizeAvailability, availabilityForDate } from './availability.js';
import { estimateForQuestion } from './estimates.js';
import { checkpoint } from './study-timing.js';
import {
  RECORD_SOURCE_LABELS, describeRecord, durationEntriesByStudyDate, durationOnStudyDate, hasDuration, hasExactTime,
  isCountedRecord, mergeStudyRecord, normalizeStudyRecord, recordDateOf, sumDurations,
} from './records-model.js';

// 1.2.0 で問題マスタに book / chapterOrder / sectionOrder / title / page / sectionPage を、
// 1.3.0 で courses（SELECT STUDY の3コース）と needsReview を足した。
// 1.4.0 で予定に items（1回の取り組みごとの予定項目）、学習記録に planItemId、
// 繰り越しの記録（moves）を足した。
// 1.5.0 で学習記録に date（実施日）・datePrecision・source（どうやって入った記録か）・
// revision（訂正の版）・corrections（訂正の履歴）を足し、
// 評価と所要時間に「未登録（null）」を入れられるようにした。
// どれも足すだけで、古いデータはそのまま読める（古い記録は timestamp から実施日を出す）。
export const DATA_VERSION = '1.5.0';

export const EVALUATIONS = [
  { value: 'perfect', symbol: '◯', label: '完璧にできた', tone: 'success' },
  { value: 'better_solution', symbol: '解', label: '正解だが、もっと簡単な解法があった', tone: 'accent' },
  // 「解」と色がかぶらないようにする（マスは色だけで意味を表すため）。
  { value: 'weak_writing', symbol: '記', label: '正解だが、記述が甘い', tone: 'teal' },
  { value: 'calc_error', symbol: '△', label: '計算ミス', tone: 'warning' },
  { value: 'wrong_approach', symbol: '✕', label: '方針が違った', tone: 'danger' },
];

export const EVAL_MAP = Object.fromEntries(EVALUATIONS.map((e) => [e.value, e]));

export const TASK_KINDS = {
  new: { label: '新規', tone: 'accent' },
  review: { label: '復習', tone: 'success' },
  challenge: { label: '挑戦', tone: 'violet' },
  priority: { label: '優先', tone: 'danger' },
};

export { itemsOf, splitPlanItems, MOVE_REASONS, MOVE_REASON_LABELS, MOVE_KIND_LABELS } from './plan-items.js';
export {
  GOAL_COMPLETION_LABELS, GOAL_COMPLETION_TYPES, GOAL_STATUSES, GOAL_STATUS_LABELS,
  selectQuestions, goalAttempts, questionSatisfied,
} from './goals.js';
export { WEEKDAY_KEYS, WEEKDAY_LABELS, availabilityForDate } from './availability.js';
export { CONFIDENCE_LABELS } from './estimates.js';
export {
  RECORD_SOURCE_LABELS, describeRecord, durationEntriesByStudyDate, durationOnStudyDate, hasDuration, hasExactTime, isCountedRecord,
  mergeStudyRecord, recordDateOf, sumDurations,
} from './records-model.js';

export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * Study To Doでいう「今日」。03:00 JSTまでは前日の学習日として扱う。
 * To Do・実績・累計時間・現在日の表示は、すべてこの境界を共有する。
 */
export function todayKey(d = new Date()) {
  return studyDateKeyOf(d);
}

/** 意味を明示した別名。既存の todayKey 利用箇所とも同じ学習日を返す。 */
export function studyDayKey(d = new Date()) {
  return todayKey(d);
}

/** 学習記録の時刻から、その記録が属する日（日本時間）を求める。 */
export const dayOf = (timestamp) => studyDateKeyOf(timestamp);

/* ------------------------------------------------------------------ */
/* 問題マスタ                                                          */
/* ------------------------------------------------------------------ */

/** 問題マスタの版を覚えておく meta の行。 */
export const QUESTION_MASTER_KEY = 'questionMaster';

export async function importQuestions(questions, { replace = false, masterVersion = null } = {}) {
  const normalized = questions.map(normalizeQuestion).filter(Boolean);
  // 問題マスタを丸ごと差し替えるときだけ、古い問題を消す。
  // 学習記録・予定・目標には手を触れない（questionId は残るので履歴は失われない）。
  if (replace) await idb.clear(STORES.questions);
  await idb.putAll(STORES.questions, normalized);
  if (masterVersion !== null) await setQuestionMasterVersion(masterVersion);
  return normalized.length;
}

/**
 * この端末が持っている問題マスタの版。
 *
 * ハッシュは「同じか違うか」しか言えないので、古いマスタを持ったままの端末が
 * 新しいマスタを巻き戻さないよう、どちらが新しいかを表す数を別に持っている。
 * 版を知らない（この仕組みより前の）マスタは 0 として扱う。
 */
export async function getQuestionMasterVersion() {
  const row = await idb.get(STORES.meta, QUESTION_MASTER_KEY);
  return Math.max(0, Math.floor(Number(row?.value?.masterVersion) || 0));
}

/** 版を上げる。下げることはしない（古い内容で新しい内容を上書きしないため）。 */
export async function setQuestionMasterVersion(masterVersion) {
  const next = Math.max(0, Math.floor(Number(masterVersion) || 0));
  const current = await getQuestionMasterVersion();
  if (next <= current) return current;
  await idb.put(STORES.meta, {
    key: QUESTION_MASTER_KEY,
    value: { masterVersion: next, updatedAt: new Date().toISOString() },
  });
  return next;
}

export async function listQuestions(filter = {}) {
  let all = await idb.all(STORES.questions);
  if (filter.subject) all = all.filter((q) => q.subject === filter.subject);
  if (filter.chapter) all = all.filter((q) => q.chapter === filter.chapter);
  if (filter.section) all = all.filter((q) => q.section === filter.section);
  if (filter.type) all = all.filter((q) => q.type === filter.type);
  if (filter.evaluation) {
    const records = await idb.all(STORES.records);
    const ids = new Set(
      records.filter((r) => r.evaluation === filter.evaluation).map((r) => r.questionId)
    );
    all = all.filter((q) => ids.has(q.id));
  }
  all.sort(compareQuestions);
  return filter.limit ? all.slice(0, filter.limit) : all;
}

export async function searchQuestions(keyword, limit = 50) {
  const k = String(keyword || '').trim().toLowerCase();
  if (!k) return [];
  const terms = k.split(/\s+/).filter(Boolean);
  const all = await idb.all(STORES.questions);
  return all
    .filter((q) => {
      const haystack = questionHaystack(q);
      return terms.every((term) => haystack.includes(term));
    })
    .sort(compareQuestions)
    .slice(0, limit);
}

export async function getQuestion(questionId) {
  const question = await idb.get(STORES.questions, questionId);
  if (!question) return null;
  const history = (await idb.byIndex(STORES.records, 'questionId', questionId)).sort(
    (a, b) => b.timestamp.localeCompare(a.timestamp)
  );
  const counts = {};
  history.forEach((r) => {
    counts[r.evaluation] = (counts[r.evaluation] || 0) + 1;
  });
  return {
    question,
    history,
    attempts: history.length,
    evaluationCounts: counts,
    lastEvaluation: history[0]?.evaluation ?? null,
    averageSeconds: history.length
      ? Math.round(history.reduce((s, r) => s + r.durationSeconds, 0) / history.length)
      : null,
  };
}

export async function getAppInfo() {
  const questions = await idb.all(STORES.questions);
  const byType = {};
  const books = new Set();
  const courses = new Set();
  questions.forEach((q) => {
    byType[q.type] = (byType[q.type] ?? 0) + 1;
    if (q.book) books.add(q.book);
    (q.courses ?? []).forEach((c) => courses.add(c));
  });
  return {
    dataVersion: DATA_VERSION,
    questionCount: questions.length,
    books: [...books],
    courses: [...courses],
    needsReviewCount: questions.filter((q) => q.needsReview === true).length,
    questionTypes: Object.entries(byType)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    evaluations: EVALUATIONS.map(({ value, symbol, label }) => ({ value, symbol, label })),
    taskKinds: Object.keys(TASK_KINDS),
    subjects: buildOutline(questions),
  };
}

/* ------------------------------------------------------------------ */
/* 送信待ちの控え（オフラインでも学習を止めないための仕組み）          */
/* ------------------------------------------------------------------ */

/**
 * クラウドへ送る予定の変更を控えておく。
 * 送信できたかどうかに関わらず、ここへ積むだけで学習側の処理は止めない。
 * 同じものを何度送ってもサーバー側で重複しないので、失敗しても消さずに残す。
 */
export async function enqueueOutbox(type, id) {
  try {
    await idb.put(STORES.outbox, { key: `${type}:${id}`, type, id, queuedAt: Date.now(), version: crypto.randomUUID() });
  } catch {
    // 控えに失敗しても学習の記録自体は成功させる（次回の全体同期で拾える）。
  }
}

export async function listOutbox() {
  try {
    return await idb.all(STORES.outbox);
  } catch {
    return [];
  }
}

export async function clearOutboxEntries(keys) {
  await Promise.all(keys.map((key) => idb.del(STORES.outbox, key).catch(() => {})));
}

/* ------------------------------------------------------------------ */
/* 学習記録                                                            */
/* ------------------------------------------------------------------ */

/**
 * ふだんの集計に使う学習記録。
 * 消した記録は本当に消えている。古い版で「取り消し」にした記録がまだ残っていることが
 * あるので、それはここでは返さない。
 */
export async function listRecords({ includeVoided = false } = {}) {
  const records = await idb.all(STORES.records);
  return includeVoided ? records : records.filter(isCountedRecord);
}

/**
 * 学習記録を1件足す。
 *
 * 「1回の取り組み＝1件の記録」なので、同じ問題を何度解いても上書きせずに増やす。
 * planItemId は「どの予定に対する取り組みだったか」。予定に無い問題を解いたときは入らない。
 */
function makeStudyRecord({ questionId, evaluation, durationSeconds, challengeId, planTaskId, planItemId, solveSeconds, reviewSeconds, unclassifiedSeconds, studySecondsByDate }) {
  const now = new Date().toISOString();
  const record = {
    id: uid('rec'),
    questionId,
    // 実施日（日本時間）。カレンダーや日別の集計はこれを使う。
    date: dayOf(now),
    timestamp: now,
    datePrecision: 'datetime',
    evaluation,
    durationSeconds: Math.max(0, Math.round(durationSeconds)),
    ...(Number.isFinite(solveSeconds) && Number.isFinite(reviewSeconds)
      ? { solveSeconds, reviewSeconds, ...(unclassifiedSeconds ? { unclassifiedSeconds } : {}), studySecondsByDate } : {}),
    // アプリのタイマーで測った記録。あとから本人の申告で足した記録とは区別する。
    source: 'timer',
    enteredAt: now,
    revision: 0,
    ...(challengeId ? { challengeId } : {}),
    ...(planTaskId ? { planTaskId } : {}),
    ...(planItemId ? { planItemId } : {}),
  };
  return record;
}

export async function addStudyRecord(input) {
  const record = makeStudyRecord(input);
  await idb.put(STORES.records, record);
  await enqueueOutbox('record', record.id);
  return record;
}

export async function completeStudyAttempt(input, session, nextSession) {
  const record = makeStudyRecord(input);
  return idb.commitAttempt(record, session, nextSession);
}

export async function getStudyHistory({ limit = 100, from, to, evaluation, chapter } = {}) {
  let records = await listRecords();
  records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  if (from) records = records.filter((r) => r.timestamp >= from);
  if (to) records = records.filter((r) => r.timestamp <= to);
  if (evaluation) records = records.filter((r) => r.evaluation === evaluation);
  if (chapter) {
    const qs = await listQuestions({ chapter });
    const ids = new Set(qs.map((q) => q.id));
    records = records.filter((r) => ids.has(r.questionId));
  }
  return records.slice(0, limit);
}

export async function getRecentMistakes({ days = 7, limit = 50 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const records = await getStudyHistory({ limit: 1000, from: since });
  const bad = new Set(['calc_error', 'wrong_approach']);
  return records.filter((r) => bad.has(r.evaluation)).slice(0, limit);
}

export async function getStudyStats() {
  const [records, questions] = await Promise.all([
    listRecords(),
    idb.all(STORES.questions),
  ]);
  const qById = Object.fromEntries(questions.map((q) => [q.id, q]));
  const byEvaluation = {};
  const byChapter = {};
  let totalSeconds = 0;
  records.forEach((r) => {
    // 時間が未登録の記録は 0秒として足さない。
    if (hasDuration(r)) totalSeconds += r.durationSeconds;
    if (r.evaluation) byEvaluation[r.evaluation] = (byEvaluation[r.evaluation] || 0) + 1;
    const ch = qById[r.questionId]?.chapter ?? '不明';
    byChapter[ch] ??= { count: 0, seconds: 0, byEvaluation: {} };
    byChapter[ch].count += 1;
    if (hasDuration(r)) byChapter[ch].seconds += r.durationSeconds;
    if (r.evaluation) {
      byChapter[ch].byEvaluation[r.evaluation] =
        (byChapter[ch].byEvaluation[r.evaluation] || 0) + 1;
    }
  });
  return {
    totalRecords: records.length,
    totalSeconds,
    uniqueQuestions: new Set(records.map((r) => r.questionId)).size,
    byEvaluation,
    byChapter,
  };
}

export async function getTodayStats(date = studyDayKey()) {
  const records = await listRecords();
  const today = records.filter((r) => recordDateOf(r) === date);
  const totals = sumDurations(today);
  return {
    date,
    seconds: records.reduce((sum, record) => sum + durationOnStudyDate(record, date), 0),
    // 時間が未登録の取り組みの数。合計に足さずに、件数だけ知らせる。
    unknownDurationCount: totals.unknownCount,
    count: today.length,
    records: today.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))),
  };
}

/* ------------------------------------------------------------------ */
/* タスク                                                              */
/* ------------------------------------------------------------------ */

export async function getTodayTasks(date = studyDayKey()) {
  const tasks = await idb.byIndex(STORES.tasks, 'date', date);
  return tasks.sort((a, b) => a.order - b.order);
}

/**
 * その日の予定の版（revision）。クラウドと突き合わせるときに使う。
 * サーバーが持っている版の番号と、この端末で変更したかどうかを覚えておく。
 */
export async function getPlanMeta() {
  const row = await idb.get(STORES.meta, 'planMeta');
  return row?.value ?? {};
}

export async function setPlanMeta(date, patch) {
  const all = await getPlanMeta();
  const next = { ...all, [date]: { ...(all[date] ?? { revision: 0 }), ...patch } };
  await idb.put(STORES.meta, { key: 'planMeta', value: next });
  return next;
}

export async function updateTodayTasks(tasks, date = studyDayKey(), { markDirty = true, updatedBy = 'app' } = {}) {
  const now = new Date().toISOString();
  const normalized = tasks.map((t, i) => withItems({
    // IDは渡されたものを必ず残す。作り直すと、クラウド側の同じタスクと結び付かなくなる。
    id: t.id || uid('task'),
    date,
    questionIds: t.questionIds || [],
    kind: t.kind || 'new',
    order: t.order ?? i,
    ...(t.timeLimitSeconds ? { timeLimitSeconds: t.timeLimitSeconds } : {}),
    completed: !!t.completed,
    // 利用者が固定した印。古いデータには無いので false として補う。
    pinned: t.pinned === true,
    createdAt: t.createdAt ?? now,
    updatedAt: t.updatedAt ?? now,
    ...(t.source ? { source: t.source } : {}),
    ...(t.carriedFrom ? { carriedFrom: t.carriedFrom } : {}),
    ...(t.title ? { title: t.title } : {}),
    // 予定項目（この予定の中の「1回の取り組み」1件ずつ）。
    // 古いデータには無いので questionIds から組み立てる（IDは決め打ちなので毎回同じ）。
    items: t.items,
  }));
  // その日の予定は「置き換え」なので、古いものを消すのと新しいものを入れるのを
  // 1つのトランザクションでまとめて行う。途中で落ちても、その日の予定だけが
  // 消えた状態にはならない（全部通るか、1つも通らないか）。
  await idb.replaceByIndex(STORES.tasks, 'date', date, normalized);
  if (markDirty) {
    // この端末で変えた予定は、次の同期でクラウドへ送る。
    await setPlanMeta(date, { updatedAt: new Date().toISOString(), dirty: true, updatedBy });
  }
  return normalized;
}

export async function getTasksInRange(fromDate, toDate) {
  const all = await idb.all(STORES.tasks);
  return all
    .filter((t) => t.date >= fromDate && t.date <= toDate)
    .sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
}

/** 問題ID -> 最新の評価。カレンダーの目盛りの色分けに使う。 */
export async function getLatestEvaluations() {
  const records = await listRecords();
  records.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  const map = {};
  records.forEach((r) => {
    // 評価が未登録の記録では、前の評価を消さない（未登録は「不正解」ではない）。
    if (r.evaluation) map[r.questionId] = r.evaluation;
  });
  return map;
}

/** 日付 -> その日に記録された問題IDの集合。達成率の算出に使う。 */
export async function getRecordedByDate() {
  const records = await listRecords();
  const map = {};
  records.forEach((r) => {
    const day = recordDateOf(r);
    (map[day] ??= new Set()).add(r.questionId);
  });
  return map;
}

/** 固定（ピン留め）の付け外し。利用者だけが行える操作。 */
export async function setTaskPinned(taskId, pinned) {
  const task = await idb.get(STORES.tasks, taskId);
  if (!task) return null;
  const next = { ...task, pinned: pinned === true, updatedAt: new Date().toISOString() };
  await idb.put(STORES.tasks, next);
  await setPlanMeta(task.date, { updatedAt: next.updatedAt, dirty: true, updatedBy: 'app' });
  return next;
}

export async function saveTask(task) {
  await idb.put(STORES.tasks, task);
  // 完了の付け外しもその日の予定の変更なので、次の同期で送る。
  await setPlanMeta(task.date, { updatedAt: new Date().toISOString(), dirty: true, updatedBy: 'app' });
  return task;
}

/* ------------------------------------------------------------------ */
/* 予定と実績の対応                                                    */
/* ------------------------------------------------------------------ */

/** すでに取り組まれた予定項目（学習記録が結び付いているもの）のID。 */
export async function getDoneItemIds() {
  const records = await listRecords();
  return new Set(records.filter((r) => r.planItemId).map((r) => r.planItemId));
}

/** 1つの問題への取り組みを、古い順に全部返す（1回＝1件）。 */
export async function getQuestionAttempts(questionId, { includeVoided = false } = {}) {
  const records = await idb.byIndex(STORES.records, 'questionId', questionId);
  return records
    .filter((record) => includeVoided || isCountedRecord(record))
    // 実施日の順。日付だけの記録も混ざるので、日付 → 時刻で見る。
    .sort((a, b) => String(recordDateOf(a)).localeCompare(String(recordDateOf(b)))
      || String(a.timestamp).localeCompare(String(b.timestamp)));
}

/** 問題ID -> これまでの取り組み回数。「何周目か」を出すのに使う。 */
export async function getAttemptCounts() {
  const records = await listRecords();
  const counts = {};
  for (const record of records) counts[record.questionId] = (counts[record.questionId] ?? 0) + 1;
  return counts;
}

/** 期間の学習記録を、日付ごとにまとめる（カレンダーの実績マスに使う）。 */
export async function getAttemptsByDate(fromDate, toDate) {
  const records = await listRecords();
  const byDate = {};
  for (const record of records) {
    const day = recordDateOf(record);
    if (day < fromDate || day > toDate) continue;
    (byDate[day] ??= []).push(record);
  }
  Object.values(byDate).forEach((list) => list.sort((a, b) => a.timestamp.localeCompare(b.timestamp)));
  return byDate;
}

/** 期間の予定を、日付ごとにまとめる。 */
export async function getTasksByDate(fromDate, toDate) {
  const tasks = await getTasksInRange(fromDate, toDate);
  const byDate = {};
  for (const task of tasks) (byDate[task.date] ??= []).push(task);
  return byDate;
}

/* ------------------------------------------------------------------ */
/* 繰り越し（予定を別の日へ動かす）                                    */
/* ------------------------------------------------------------------ */

/**
 * 予定を別の日へ動かした記録。学習記録と同じく「追加専用のイベント」で、
 * id で重ね合わせるだけなので、同期を何度やり直しても増えない。
 */
export async function listMoves({ from = null, to = null } = {}) {
  const moves = await idb.all(STORES.moves);
  return moves
    .filter((move) => (!from || move.toDate >= from || move.fromDate >= from))
    .filter((move) => (!to || move.toDate <= to || move.fromDate <= to))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export async function addMove(move) {
  await idb.put(STORES.moves, move);
  await enqueueOutbox('move', move.id);
  return move;
}

/**
 * まだ取り組んでいない予定項目だけを、別の日へ繰り越す。
 *
 * ・実施済みの分は動かさない（実績は実施した日に残る）
 * ・予定項目のID（itemId）は変えない。動かしても「同じ予定」であり続ける
 * ・繰り越しても取り組み回数は増えない（学習記録には手を触れない）
 * ・動かしたことは移動イベントとして残り、あとから履歴を追える
 *
 * ここで変えるのは、この端末の予定だけである。変えた日は dirty として印を付け、
 * ふだんの同期でクラウドへ送られる（サーバー側で版を見て重ね合わせる）。
 */
export async function carryOverPlanItems({
  fromDate, taskId, itemIds = null, toDate,
  reason = 'unspecified', kind = 'carry_over', actorName = null,
}) {
  const dayTasks = await idb.byIndex(STORES.tasks, 'date', fromDate);
  const task = dayTasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, error: 'not_found' };
  const done = await getDoneItemIds();
  const all = itemsOf(task);
  const pending = all.filter((item) => !done.has(item.itemId));
  const wanted = itemIds ? pending.filter((item) => itemIds.includes(item.itemId)) : pending;
  if (!wanted.length) return { ok: false, error: 'nothing_to_carry_over' };

  const carriedIds = new Set(wanted.map((item) => item.itemId));
  const carried = wanted.map((item) => ({ ...item, carriedCount: (item.carriedCount ?? 0) + 1 }));
  const keep = all.filter((item) => !carriedIds.has(item.itemId));

  // 移動元。全部動かすならタスクごと消え、一部なら残った分だけになる。
  const remaining = dayTasks
    .filter((t) => t.id !== taskId)
    .concat(keep.length ? [{ ...task, items: keep, questionIds: keep.map((i) => i.questionId) }] : []);
  await updateTodayTasks(remaining, fromDate);

  // 移動先。繰り越した分を、新しいタスクとして足す。
  const target = await idb.byIndex(STORES.tasks, 'date', toDate);
  const carriedTask = {
    id: uid('task'),
    kind: task.kind,
    ...(task.timeLimitSeconds ? { timeLimitSeconds: task.timeLimitSeconds } : {}),
    ...(task.title ? { title: task.title } : {}),
    items: carried,
    questionIds: carried.map((item) => item.questionId),
    completed: false,
    pinned: false,
    source: 'app',
    carriedFrom: { taskId: task.id, date: fromDate },
  };
  await updateTodayTasks([...target, carriedTask], toDate);

  const move = {
    id: uid('mv'),
    fromDate,
    toDate,
    at: new Date().toISOString(),
    actorKind: 'user',
    actorName: actorName ?? 'この端末',
    kind,
    reason,
    taskId: task.id,
    toTaskId: carriedTask.id,
    items: carried,
  };
  await addMove(move);
  return { ok: true, move, carried, task: carriedTask };
}

/* ------------------------------------------------------------------ */
/* チャレンジ結果                                                      */
/* ------------------------------------------------------------------ */

/**
 * 学習記録を削除する。
 *
 * 印をつけるのではなく、この端末から本当に消す。
 * 消したIDだけは outbox に残し、同期でクラウドと他の端末からも消す
 *（これが無いと、次の同期でクラウドから戻ってきてしまう）。
 */
export async function deleteStudyRecord(recordId) {
  const record = await idb.get(STORES.records, recordId);
  if (!record) return { ok: false, error: 'not_found' };
  await idb.del(STORES.records, recordId);
  await enqueueOutbox('record_deleted', recordId);
  return { ok: true, record };
}

/** Undo a mistaken result and reopen only its associated plan; other attempts remain. */
export async function undoStudyRecord(recordId) {
  return idb.undoAttempt(recordId, (record, records, tasks, planMeta) => {
    const changed = [];
    for (const task of tasks) {
      const matches = record.planItemId ? itemsOf(task).some(i => i.itemId === record.planItemId)
        : task.date === recordDateOf(record) && task.questionIds?.includes(record.questionId);
      if (matches && task.kind !== 'challenge' && task.completed
        && splitPlanItems(task, records.filter(isCountedRecord), { date: task.date }).pending.length) {
        changed.push({ ...task, completed: false });
        planMeta[task.date] = { ...(planMeta[task.date] ?? { revision: 0 }),
          updatedAt: new Date().toISOString(), dirty: true, updatedBy: 'app' };
      }
    }
    return { tasks: changed, planMeta };
  });
}

export async function saveChallengeResult(result) {
  const saved = { id: result.id || uid('chl'), timestamp: new Date().toISOString(), ...result };
  await idb.put(STORES.challenges, saved);
  await enqueueOutbox('challenge', saved.id);
  return saved;
}

const countedChallenges = (all) => all.filter((result) => result.voided !== true);

export async function getRecentChallengeResult() {
  const all = countedChallenges(await idb.all(STORES.challenges));
  all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return all[0] ?? null;
}

export async function getChallengeResults(limit = 20, { includeVoided = false } = {}) {
  const all = await idb.all(STORES.challenges);
  return (includeVoided ? all : countedChallenges(all))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
}

/**
 * チャレンジの履歴を1回ぶん削除する。
 *
 * チャレンジは「制限時間つきの通し」なので、中の1問だけを抜くと合計時間と食い違う。
 * そのため結果と、その中で解いた学習記録をまとめて消す。
 */
export async function deleteChallengeResult(challengeId) {
  const result = await idb.get(STORES.challenges, challengeId);
  if (!result) return { ok: false, error: 'not_found' };
  await idb.del(STORES.challenges, challengeId);
  await enqueueOutbox('challenge_deleted', challengeId);

  const records = (await idb.all(STORES.records)).filter((record) => record.challengeId === challengeId);
  for (const record of records) await deleteStudyRecord(record.id);
  return { ok: true, result, deletedRecords: records.length };
}

/**
 * 学習データをすべて消す。設定画面から、本人がはっきり選んだときだけ呼ぶ。
 *
 * 消すのは学習記録・チャレンジ・予定・目標・繰り越し。
 * 問題マスタと、この端末の設定（同期の鍵など）は残す。
 * クラウドを使っているときは、クラウド側も消さないと次の同期で戻ってくる。
 */
export async function purgeStudyData() {
  const removed = {
    records: (await idb.all(STORES.records)).length,
    challenges: (await idb.all(STORES.challenges)).length,
    tasks: (await idb.all(STORES.tasks)).length,
    goals: (await idb.all(STORES.goals)).length,
    moves: (await idb.all(STORES.moves)).length,
  };
  for (const store of [STORES.records, STORES.challenges, STORES.tasks, STORES.goals, STORES.moves, STORES.outbox]) {
    await idb.clear(store);
  }
  // 予定の版・学習可能時間・見積もりの指定も、いっしょに初期状態へ戻す。
  // 同期の鍵（cloud）と表示の設定は消さない。消すと使えなくなってしまうため。
  for (const key of ['planMeta', AVAILABILITY_KEY, ESTIMATES_KEY]) {
    await idb.del(STORES.meta, key).catch(() => {});
  }
  return removed;
}

/* ------------------------------------------------------------------ */
/* 目標                                                                */
/* ------------------------------------------------------------------ */

export async function getGoals({ includeDeleted = false } = {}) {
  const all = await idb.all(STORES.goals);
  const goals = includeDeleted ? all : all.filter((g) => !g.deletedAt);
  // 古い目標（文章の範囲しか無いもの）も、そのまま読めるように整えて返す。
  return goals
    .map((goal) => normalizeGoal(goal))
    .sort((a, b) => (a.priority - b.priority)
      || String(a.deadline || '9999').localeCompare(String(b.deadline || '9999')));
}

export async function addGoal({ title, deadline, scope, questionIds = [], completion, priority, startDate }) {
  const goal = normalizeGoal({
    id: uid('goal'),
    title,
    startDate: startDate ?? todayKey(),
    deadline,
    scope: scope || '',
    questionIds,
    completion,
    priority,
    status: 'active',
    updatedAt: new Date().toISOString(),
    revision: 1,
  });
  await idb.put(STORES.goals, goal);
  return goal;
}

export async function updateGoal(id, patch) {
  const goal = await idb.get(STORES.goals, id);
  if (!goal) return null;
  const next = normalizeGoal({
    ...goal,
    ...patch,
    id,
    updatedAt: new Date().toISOString(),
    revision: Number(goal.revision ?? 0) + 1,
  });
  await idb.put(STORES.goals, next);
  return next;
}

/**
 * 目標を消す。消したことを他の端末へも伝える必要があるので、
 * すぐ消さずに「消した印」を残す（同期が済んだ端末では表示されなくなる）。
 */
export async function deleteGoal(id) {
  const goal = await idb.get(STORES.goals, id);
  if (!goal) return;
  await idb.put(STORES.goals, { ...goal, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}

/**
 * 目標の進み具合を、この端末のデータだけで数える（サーバーと同じ考え方）。
 *
 * 実績として数えるのは「その目標に結び付いた予定から実施された取り組み」だけ。
 * 同じ問題を別の目的で解いた記録は流用しない。
 */
export async function getGoalProgressLocal(goal) {
  const [records, tasks] = await Promise.all([listRecords(), idb.all(STORES.tasks)]);
  const itemGoalMap = new Map();
  for (const task of tasks) {
    for (const item of itemsOf(task)) {
      if (item.goalId) itemGoalMap.set(item.itemId, item.goalId);
    }
  }
  const attempts = goalAttemptsOf(goal, { records, itemGoalMap });
  const plannedQuestionIds = new Set();
  for (const task of tasks) {
    const split = splitPlanItems(task, records, { date: task.date, allowLegacyMatch: false });
    for (const item of split.pending) {
      if (item.goalId === goal.id) plannedQuestionIds.add(item.questionId);
    }
  }
  const satisfied = [];
  const unsatisfied = [];
  for (const questionId of goal.questionIds ?? []) {
    if (questionSatisfiedFor(goal, attempts.get(questionId) ?? [])) satisfied.push(questionId);
    else unsatisfied.push(questionId);
  }
  const unplanned = unsatisfied.filter((id) => !plannedQuestionIds.has(id));
  let remainingSeconds = 0;
  for (const questionId of unsatisfied) {
    remainingSeconds += (await estimateForQuestionId(questionId)).seconds;
  }
  return {
    goalId: goal.id,
    total: (goal.questionIds ?? []).length,
    satisfied: satisfied.length,
    unsatisfied: unsatisfied.length,
    planned: unsatisfied.length - unplanned.length,
    unplanned: unplanned.length,
    unplannedQuestionIds: unplanned,
    remainingMinutes: Math.round(remainingSeconds / 60),
    // 「習得する目標」は、何回で習得できるか分からないので総時間は不確実。
    remainingIsComplete: goal.completion?.type !== 'mastery',
  };
}

/* ------------------------------------------------------------------ */
/* 学習可能時間と見積もり                                              */
/* ------------------------------------------------------------------ */

export const AVAILABILITY_KEY = 'availability';
export const ESTIMATES_KEY = 'estimates';

/** 1日に使える学習時間の設定。未設定の曜日は null（0分とは違う）。 */
export async function getAvailability() {
  const row = await idb.get(STORES.meta, AVAILABILITY_KEY);
  return normalizeAvailability(row?.value ?? {});
}

export async function saveAvailability(patch) {
  const current = await getAvailability();
  const next = normalizeAvailability({
    ...current,
    ...patch,
    weekly: { ...current.weekly, ...(patch.weekly ?? {}) },
    overrides: { ...current.overrides, ...(patch.overrides ?? {}) },
    updatedAt: new Date().toISOString(),
    revision: Number(current.revision ?? 0) + 1,
  });
  if (patch.overrides) {
    for (const [date, value] of Object.entries(patch.overrides)) {
      if (value === null) delete next.overrides[date];
    }
  }
  if (patch.todayRemaining === null) next.todayRemaining = null;
  await idb.put(STORES.meta, { key: AVAILABILITY_KEY, value: next });
  return next;
}

/**
 * 問題別の見積もり指定（本人が決めた時間と、AIが入れた仮の値）。
 * 実績から計算できる分は保存しない（記録が増えれば計算し直せるため）。
 */
export async function getEstimateEntries() {
  const row = await idb.get(STORES.meta, ESTIMATES_KEY);
  return row?.value ?? {};
}

export async function setManualEstimate(questionId, seconds) {
  const entries = await getEstimateEntries();
  const next = {
    ...entries,
    [questionId]: {
      ...(entries[questionId] ?? {}),
      manualSeconds: seconds === null ? undefined : Math.max(30, Math.round(seconds)),
      manualUpdatedAt: new Date().toISOString(),
    },
  };
  await idb.put(STORES.meta, { key: ESTIMATES_KEY, value: next });
  return next;
}

/** その日に使える時間（画面に「予定○分／使える○分」を出すために使う）。 */
export async function availabilityForDay(dateKey) {
  const [availability, records] = await Promise.all([getAvailability(), listRecords()]);
  const spentSeconds = records.reduce((sum, record) => sum + durationOnStudyDate(record, dateKey), 0);
  return availabilityForDate(availability, dateKey, { spentSeconds, isToday: dateKey === studyDayKey() });
}

/**
 * 1問の見積もり（画面用）。
 * サーバーと同じ考え方で計算する（共有モジュール src/estimates.js）。
 */
export async function estimateForQuestionId(questionId, { inChallenge = false } = {}) {
  const [question, history, entries, availability, challenges] = await Promise.all([
    idb.get(STORES.questions, questionId),
    getQuestionAttempts(questionId),
    getEstimateEntries(),
    getAvailability(),
    idb.all(STORES.challenges),
  ]);
  const truncated = new Set(challenges.filter((c) => c.succeeded === false).map((c) => c.id));
  return estimateForQuestion({
    question,
    history,
    stored: entries[questionId] ?? null,
    condition: { firstTry: history.length === 0, inChallenge },
    review: {
      timerIncludesReview: availability.timerIncludesReview,
      reviewOverheadSeconds: availability.reviewOverheadSeconds,
    },
    truncatedChallengeIds: truncated,
  });
}

/**
 * カレンダーのように「たくさんの日」を一度に描くための下ごしらえ。
 *
 * 1日ずつ IndexedDB を読み直すと、日数ぶんだけ読み込みが増えて重くなる。
 * ここで必要なものを一度だけ読み、あとは同期的に計算できるようにしておく。
 */
export async function createDayPlanner() {
  const [records, challenges, entries, availability, questions] = await Promise.all([
    listRecords(),
    idb.all(STORES.challenges),
    getEstimateEntries(),
    getAvailability(),
    idb.all(STORES.questions),
  ]);
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const historyByQuestion = new Map();
  for (const record of [...records].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))) {
    if (!historyByQuestion.has(record.questionId)) historyByQuestion.set(record.questionId, []);
    historyByQuestion.get(record.questionId).push(record);
  }
  const spentByDate = new Map();
  for (const record of records) {
    for (const [day, seconds] of durationEntriesByStudyDate(record)) {
      spentByDate.set(day, (spentByDate.get(day) ?? 0) + seconds);
    }
  }
  const truncated = new Set(challenges.filter((c) => c.succeeded === false).map((c) => c.id));
  const today = studyDayKey();
  const cache = new Map();

  const estimate = (questionId, { inChallenge = false } = {}) => {
    const key = `${questionId}|${inChallenge ? 'c' : 'n'}`;
    if (!cache.has(key)) {
      const history = historyByQuestion.get(questionId) ?? [];
      cache.set(key, estimateForQuestion({
        question: questionById.get(questionId) ?? null,
        history,
        stored: entries[questionId] ?? null,
        condition: { firstTry: history.length === 0, inChallenge },
        review: {
          timerIncludesReview: availability.timerIncludesReview,
          reviewOverheadSeconds: availability.reviewOverheadSeconds,
        },
        truncatedChallengeIds: truncated,
      }));
    }
    return cache.get(key);
  };

  return {
    availability,
    estimate,
    /** その日に使える時間（未設定なら available は null）。 */
    capacity: (dateKey) => availabilityForDate(availability, dateKey, {
      spentSeconds: spentByDate.get(dateKey) ?? 0,
      isToday: dateKey === today,
    }),
    /** その日の未実施の予定にかかる見積もり（分）。 */
    plannedMinutes: (dateKey, tasks = [], dayRecords = []) => {
      let seconds = 0;
      for (const task of tasks) {
        if (task.completed) continue;
        const split = splitPlanItems(task, dayRecords, { date: dateKey });
        for (const item of split.pending) {
          seconds += estimate(item.questionId, { inChallenge: task.kind === 'challenge' }).seconds;
        }
      }
      return Math.round(seconds / 60);
    },
  };
}

/** その日の未実施の予定にかかる見積もり（分）。 */
export async function plannedMinutesFor(dateKey) {
  const [tasks, records] = await Promise.all([
    idb.byIndex(STORES.tasks, 'date', dateKey),
    listRecords(),
  ]);
  let seconds = 0;
  for (const task of tasks) {
    const split = splitPlanItems(task, records, { date: dateKey });
    for (const item of split.pending) {
      const estimate = await estimateForQuestionId(item.questionId, { inChallenge: task.kind === 'challenge' });
      seconds += estimate.seconds;
    }
  }
  return Math.round(seconds / 60);
}

/* ------------------------------------------------------------------ */
/* セッション状態（永続化）                                            */
/* ------------------------------------------------------------------ */

export const EMPTY_SESSION = {
  active: false,
  sessionId: null,
  mode: 'idle',
  currentQuestionId: null,
  // いま解いているのが「どの予定の、どの1回ぶん」か。予定外に解いたときは null。
  currentPlanItemId: null,
  currentPlanTaskId: null,
  currentChallengeId: null,
  questionElapsed: {},
  questionTiming: {},
  idleSecondsByDate: {},
  resumeMode: null,
  currentStartedAt: null,

  // 学習セッション全体のタイマー（問題を切り替えても止まらない）
  sessionElapsed: 0,
  sessionStartedAt: null,

  challengeStartedAt: null,
  challengeTimeLimitSeconds: null,
  challengeCountUp: false,
  challengeOrder: null,
  challengeFinishedElapsed: null,  // 「終了」を押した時点の全体経過秒
  reviewQueue: [],                 // チャレンジ終了後にまとめて評価する問題
  reviewIndex: 0,
  evaluations: {},   // チャレンジ評価入力の途中経過
};

/* ------------------------------------------------------------------ */
/* 設定                                                                */
/* ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = {
  calendarStyle: 'ring',      // 'ring' | 'fill'
  fillVariation: 'random',    // 'random' | 'month' | 'week'
  theme: 'auto',              // 'auto' | 'light' | 'dark'
};

export async function getSettings() {
  const row = await idb.get(STORES.meta, 'settings');
  return { ...DEFAULT_SETTINGS, ...(row?.value ?? {}) };
}

export async function saveSettings(settings) {
  const next = { ...DEFAULT_SETTINGS, ...settings };
  await idb.put(STORES.meta, { key: 'settings', value: next });
  return next;
}

export async function getSessionState() {
  const result = await idb.updateSession((stored) => {
    const session = { ...EMPTY_SESSION, ...stored };
    // Upgrade a running legacy session once, under the same cross-tab transaction.
    if (session.active && !session.sessionId) session.sessionId = crypto.randomUUID();
    return { session };
  });
  return result.session;
}

/** No evaluations/times are invented: existing records have already been saved. */
export async function finishStudySession(sessionId, snapshot = null) {
  const endedAt = new Date().toISOString();
  return idb.updateSession((stored) => {
    if (!stored?.active || stored.sessionId !== sessionId) return { ended: false };
    const session = checkpoint(structuredClone(snapshot?.sessionId === sessionId ? snapshot : stored), Date.parse(endedAt));
    const resumeMode = session.mode;
    return {
      ended: true,
      session: { ...session, active: false, sessionId: null, mode: 'idle', resumeMode,
        currentStartedAt: null, sessionStartedAt: null },
      event: { key: `session_end:${sessionId}`, type: 'session_end', id: sessionId, queuedAt: Date.now(),
        event: { sessionId, date: studyDateKeyOf(endedAt), endedAt } },
    };
  });
}

export async function setSessionState(value) {
  await idb.put(STORES.meta, { key: 'session', value });
  return value;
}

/* ------------------------------------------------------------------ */
/* バックアップ                                                        */
/* ------------------------------------------------------------------ */

export async function exportAll() {
  const [questions, records, tasks, challenges, goals, moves, settings] = await Promise.all([
    idb.all(STORES.questions),
    idb.all(STORES.records),
    idb.all(STORES.tasks),
    idb.all(STORES.challenges),
    idb.all(STORES.goals),
    idb.all(STORES.moves),
    getSettings(),
  ]);
  const [availability, estimateEntries] = await Promise.all([getAvailability(), getEstimateEntries()]);
  return {
    dataVersion: DATA_VERSION,
    exportedAt: new Date().toISOString(),
    questions,
    records,
    tasks,
    challenges,
    goals,
    // 繰り越し・予定変更の記録。予定と実績の食い違いを後から追うために残す。
    moves,
    // 学習可能時間と、見積もりの「指定」（本人の指定・AIの仮値）。
    // 実績から計算できる見積もりは、書き出さない（記録から作り直せる）。
    availability,
    estimates: estimateEntries,
    settings,
  };
}
