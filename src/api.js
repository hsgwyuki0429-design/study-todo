// データアクセス層。
// MCP サーバーが必要とするツール群と 1:1 に対応する関数をここに集約する。
// UI は必ずこの層を経由し、IndexedDB を直接触らない。
// 将来サーバー同期に差し替える場合も、この関数シグネチャを保てばよい。

import { idb, STORES } from './idb.js';
import { dateKeyOf, todayKeyOf } from './datetime.js';
import { buildOutline, compareQuestions, normalizeQuestion, questionHaystack } from './question-order.js';

// 1.2.0 で問題マスタに book / chapterOrder / sectionOrder / title / page / sectionPage を足した。
export const DATA_VERSION = '1.2.0';

export const EVALUATIONS = [
  { value: 'perfect', symbol: '◯', label: '完璧にできた', tone: 'success' },
  { value: 'better_solution', symbol: '解', label: '正解だが、もっと簡単な解法があった', tone: 'accent' },
  { value: 'weak_writing', symbol: '記', label: '正解だが、記述が甘い', tone: 'accent' },
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

export const uid = (prefix = 'id') =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/**
 * 「今日」の日付キー。日本時間（UTC+9）で判断する。
 * ISO文字列の先頭10文字（UTC日付）を使うと、深夜〜朝に前日扱いになってしまうため、
 * 日付の判定はすべて src/datetime.js を通す。
 */
export function todayKey(d = new Date()) {
  return dateKeyOf(d);
}

/** 学習記録の時刻から、その記録が属する日（日本時間）を求める。 */
export const dayOf = (timestamp) => dateKeyOf(timestamp);

/* ------------------------------------------------------------------ */
/* 問題マスタ                                                          */
/* ------------------------------------------------------------------ */

export async function importQuestions(questions, { replace = false } = {}) {
  const normalized = questions.map(normalizeQuestion).filter(Boolean);
  // 問題マスタを丸ごと差し替えるときだけ、古い問題を消す。
  // 学習記録・予定・目標には手を触れない（questionId は残るので履歴は失われない）。
  if (replace) await idb.clear(STORES.questions);
  await idb.putAll(STORES.questions, normalized);
  return normalized.length;
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
  questions.forEach((q) => {
    byType[q.type] = (byType[q.type] ?? 0) + 1;
    if (q.book) books.add(q.book);
  });
  return {
    dataVersion: DATA_VERSION,
    questionCount: questions.length,
    books: [...books],
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
    await idb.put(STORES.outbox, { key: `${type}:${id}`, type, id, queuedAt: Date.now() });
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

export async function addStudyRecord({ questionId, evaluation, durationSeconds, challengeId }) {
  const record = {
    id: uid('rec'),
    questionId,
    timestamp: new Date().toISOString(),
    evaluation,
    durationSeconds: Math.max(0, Math.round(durationSeconds)),
    ...(challengeId ? { challengeId } : {}),
  };
  await idb.put(STORES.records, record);
  await enqueueOutbox('record', record.id);
  return record;
}

export async function getStudyHistory({ limit = 100, from, to, evaluation, chapter } = {}) {
  let records = await idb.all(STORES.records);
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
    idb.all(STORES.records),
    idb.all(STORES.questions),
  ]);
  const qById = Object.fromEntries(questions.map((q) => [q.id, q]));
  const byEvaluation = {};
  const byChapter = {};
  let totalSeconds = 0;
  records.forEach((r) => {
    totalSeconds += r.durationSeconds;
    byEvaluation[r.evaluation] = (byEvaluation[r.evaluation] || 0) + 1;
    const ch = qById[r.questionId]?.chapter ?? '不明';
    byChapter[ch] ??= { count: 0, seconds: 0, byEvaluation: {} };
    byChapter[ch].count += 1;
    byChapter[ch].seconds += r.durationSeconds;
    byChapter[ch].byEvaluation[r.evaluation] =
      (byChapter[ch].byEvaluation[r.evaluation] || 0) + 1;
  });
  return {
    totalRecords: records.length,
    totalSeconds,
    uniqueQuestions: new Set(records.map((r) => r.questionId)).size,
    byEvaluation,
    byChapter,
  };
}

export async function getTodayStats(date = todayKey()) {
  const records = await idb.all(STORES.records);
  const today = records.filter((r) => dayOf(r.timestamp) === date);
  return {
    seconds: today.reduce((s, r) => s + r.durationSeconds, 0),
    count: today.length,
    records: today.sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
  };
}

/* ------------------------------------------------------------------ */
/* タスク                                                              */
/* ------------------------------------------------------------------ */

export async function getTodayTasks(date = todayKey()) {
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

export async function updateTodayTasks(tasks, date = todayKey(), { markDirty = true, updatedBy = 'app' } = {}) {
  const existing = await idb.byIndex(STORES.tasks, 'date', date);
  await Promise.all(existing.map((t) => idb.del(STORES.tasks, t.id)));
  const normalized = tasks.map((t, i) => ({
    id: t.id || uid('task'),
    date,
    questionIds: t.questionIds || [],
    kind: t.kind || 'new',
    order: t.order ?? i,
    ...(t.timeLimitSeconds ? { timeLimitSeconds: t.timeLimitSeconds } : {}),
    completed: !!t.completed,
    ...(t.title ? { title: t.title } : {}),
  }));
  await idb.putAll(STORES.tasks, normalized);
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
  const records = await idb.all(STORES.records);
  records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const map = {};
  records.forEach((r) => {
    map[r.questionId] = r.evaluation;
  });
  return map;
}

/** 日付 -> その日に記録された問題IDの集合。達成率の算出に使う。 */
export async function getRecordedByDate() {
  const records = await idb.all(STORES.records);
  const map = {};
  records.forEach((r) => {
    const day = dayOf(r.timestamp);
    (map[day] ??= new Set()).add(r.questionId);
  });
  return map;
}

export async function saveTask(task) {
  await idb.put(STORES.tasks, task);
  // 完了の付け外しもその日の予定の変更なので、次の同期で送る。
  await setPlanMeta(task.date, { updatedAt: new Date().toISOString(), dirty: true, updatedBy: 'app' });
  return task;
}

/* ------------------------------------------------------------------ */
/* チャレンジ結果                                                      */
/* ------------------------------------------------------------------ */

export async function saveChallengeResult(result) {
  const saved = { id: result.id || uid('chl'), timestamp: new Date().toISOString(), ...result };
  await idb.put(STORES.challenges, saved);
  await enqueueOutbox('challenge', saved.id);
  return saved;
}

export async function getRecentChallengeResult() {
  const all = await idb.all(STORES.challenges);
  all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return all[0] ?? null;
}

export async function getChallengeResults(limit = 20) {
  const all = await idb.all(STORES.challenges);
  return all.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* 目標                                                                */
/* ------------------------------------------------------------------ */

export async function getGoals({ includeDeleted = false } = {}) {
  const all = await idb.all(STORES.goals);
  const goals = includeDeleted ? all : all.filter((g) => !g.deletedAt);
  return goals.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
}

export async function addGoal({ title, deadline, scope }) {
  const goal = {
    id: uid('goal'),
    title,
    deadline,
    scope: scope || '',
    updatedAt: new Date().toISOString(),
  };
  await idb.put(STORES.goals, goal);
  return goal;
}

export async function updateGoal(id, patch) {
  const goal = await idb.get(STORES.goals, id);
  if (!goal) return null;
  const next = { ...goal, ...patch, id, updatedAt: new Date().toISOString() };
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

/* ------------------------------------------------------------------ */
/* セッション状態（永続化）                                            */
/* ------------------------------------------------------------------ */

export const EMPTY_SESSION = {
  active: false,
  mode: 'idle',
  currentQuestionId: null,
  currentChallengeId: null,
  questionElapsed: {},
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
  const row = await idb.get(STORES.meta, 'session');
  return row ? { ...EMPTY_SESSION, ...row.value } : { ...EMPTY_SESSION };
}

export async function setSessionState(value) {
  await idb.put(STORES.meta, { key: 'session', value });
  return value;
}

/* ------------------------------------------------------------------ */
/* バックアップ                                                        */
/* ------------------------------------------------------------------ */

export async function exportAll() {
  const [questions, records, tasks, challenges, goals, settings] = await Promise.all([
    idb.all(STORES.questions),
    idb.all(STORES.records),
    idb.all(STORES.tasks),
    idb.all(STORES.challenges),
    idb.all(STORES.goals),
    getSettings(),
  ]);
  return {
    dataVersion: DATA_VERSION,
    exportedAt: new Date().toISOString(),
    questions,
    records,
    tasks,
    challenges,
    goals,
    settings,
  };
}
