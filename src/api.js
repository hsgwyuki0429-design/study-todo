// データアクセス層。
// MCP サーバーが必要とするツール群と 1:1 に対応する関数をここに集約する。
// UI は必ずこの層を経由し、IndexedDB を直接触らない。
// 将来サーバー同期に差し替える場合も、この関数シグネチャを保てばよい。

import { idb, STORES } from './idb.js';

export const DATA_VERSION = '1.0.0';

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

export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* 問題マスタ                                                          */
/* ------------------------------------------------------------------ */

export async function importQuestions(questions) {
  const normalized = questions.map((q) => ({
    id: q.id || `${q.subject}-${q.type}-${q.number}`,
    subject: q.subject,
    chapter: q.chapter,
    section: q.section,
    type: q.type,
    number: Number(q.number),
    label: q.label || `${q.type} ${q.number}`,
    difficulty: q.difficulty ?? null,
  }));
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
  all.sort((a, b) => a.chapter.localeCompare(b.chapter) || a.number - b.number);
  return filter.limit ? all.slice(0, filter.limit) : all;
}

export async function searchQuestions(keyword, limit = 50) {
  const k = String(keyword || '').trim().toLowerCase();
  if (!k) return [];
  const all = await idb.all(STORES.questions);
  return all
    .filter((q) =>
      [q.label, q.chapter, q.section, q.subject, q.type, String(q.number)]
        .join(' ')
        .toLowerCase()
        .includes(k)
    )
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
  const structure = {};
  questions.forEach((q) => {
    structure[q.subject] ??= {};
    structure[q.subject][q.chapter] ??= new Set();
    structure[q.subject][q.chapter].add(q.section);
  });
  const subjects = Object.entries(structure).map(([subject, chapters]) => ({
    subject,
    chapters: Object.entries(chapters).map(([chapter, sections]) => ({
      chapter,
      sections: [...sections],
    })),
  }));
  return {
    dataVersion: DATA_VERSION,
    questionCount: questions.length,
    evaluations: EVALUATIONS.map(({ value, symbol, label }) => ({ value, symbol, label })),
    taskKinds: Object.keys(TASK_KINDS),
    subjects,
  };
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
  const today = records.filter((r) => r.timestamp.slice(0, 10) === date);
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

export async function updateTodayTasks(tasks, date = todayKey()) {
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
  return normalized;
}

export async function saveTask(task) {
  await idb.put(STORES.tasks, task);
  return task;
}

/* ------------------------------------------------------------------ */
/* チャレンジ結果                                                      */
/* ------------------------------------------------------------------ */

export async function saveChallengeResult(result) {
  const saved = { id: result.id || uid('chl'), timestamp: new Date().toISOString(), ...result };
  await idb.put(STORES.challenges, saved);
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

export async function getGoals() {
  const goals = await idb.all(STORES.goals);
  return goals.sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
}

export async function addGoal({ title, deadline, scope }) {
  const goal = { id: uid('goal'), title, deadline, scope: scope || '' };
  await idb.put(STORES.goals, goal);
  return goal;
}

export async function updateGoal(id, patch) {
  const goal = await idb.get(STORES.goals, id);
  if (!goal) return null;
  const next = { ...goal, ...patch, id };
  await idb.put(STORES.goals, next);
  return next;
}

export async function deleteGoal(id) {
  await idb.del(STORES.goals, id);
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
  challengeStartedAt: null,
  challengeTimeLimitSeconds: null,
  challengeCountUp: false,
  challengeOrder: null,
  completedQuestionIds: [],
};

export async function getSessionState() {
  const row = await idb.get(STORES.meta, 'session');
  return row ? { ...EMPTY_SESSION, ...row.value } : { ...EMPTY_SESSION };
}

export async function setSessionState(value) {
  await idb.put(STORES.meta, { key: 'session', value });
  return value;
}
