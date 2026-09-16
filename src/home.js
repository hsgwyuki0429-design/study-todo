// ホーム画面。上半分＝タイマー（固定）、下半分＝可変エリア。
// 学習中に画面遷移は行わず、下半分の中身だけが切り替わる。

import * as api from './api.js';
import { checkpoint, questionTiming, timingRecord, pendingSecondsForDay, forgetQuestion } from './study-timing.js';
import { undoRecord } from './record-actions.js';
import { EVALUATIONS, EVAL_MAP } from './api.js';
import { itemsOf, splitPlanItems } from './plan-items.js';
import { state, q, qLabel, render, loadTasks, refreshToday } from './state.js';
import { $, el, fmtMS, row, segmented, swipeable, emptyState } from './ui.js';
import { reportActivity, syncInBackground } from './cloud-sync.js';

const persist = () => api.setSessionState(state.session);

/* ================================================================== */
/* 実行中であることの知らせ                                            */
/* ================================================================== */

/**
 * 「いまこのタスクを解いている」ことをクラウドへ知らせる。
 *
 * AIが実行中のタスクを勝手に動かさないようにするための情報で、
 * 送れなくても学習は止めない（圏外なら保護が効かないだけ）。
 * タイマーそのものはこの端末の中だけで動いており、同期で壊れることはない。
 */
function announceActivity(questionId) {
  const task = questionId
    ? state.tasks.find((t) => (t.questionIds ?? []).includes(questionId) && !t.completed)
    : null;
  const date = api.studyDayKey();
  reportActivity(date, task?.id ?? null, questionId ?? null, state.session.sessionId, state.session.active).catch(() => {});
}

/**
 * 学習中のあいだ、ときどき同じ知らせを送り直す。
 * サーバーは期限つきで預かるので、送り直さないと実行中ではなくなる。
 */
export function heartbeatActivity() {
  const s = state.session;
  if (!s.active) return;
  announceActivity(s.currentStartedAt ? s.currentQuestionId : null);
}

/** 学習をやめた・止めたときに、実行中の知らせを取り下げる。 */
function clearActivity() {
  reportActivity(api.studyDayKey(), null, null, state.session.sessionId, state.session.active).catch(() => {});
}

/* ================================================================== */
/* タイマー（絶対時刻ベース）                                          */
/* ================================================================== */

const since = (iso) => (Date.now() - new Date(iso).getTime()) / 1000;

export function elapsedOf(questionId) {
  const s = state.session;
  const base = s.questionElapsed[questionId] || 0;
  const running = s.currentQuestionId === questionId && s.currentStartedAt;
  return running ? base + since(s.currentStartedAt) : base;
}

/** 学習セッション全体の経過時間。問題を切り替えても止まらない。 */
export function sessionElapsed() {
  const s = state.session;
  return (s.sessionElapsed || 0) + (s.sessionStartedAt ? since(s.sessionStartedAt) : 0);
}

function challengeElapsed() {
  const s = state.session;
  if (s.challengeFinishedElapsed != null) return s.challengeFinishedElapsed;
  return s.challengeStartedAt ? since(s.challengeStartedAt) : 0;
}

function commitCurrent() {
  checkpoint(state.session);
  state.session.currentStartedAt = null;
}

function commitSession() {
  checkpoint(state.session);
  state.session.sessionStartedAt = null;
}

export function dailyElapsed() {
  const date = api.studyDayKey();
  return (state.today.date === date ? state.today.seconds : 0) + pendingSecondsForDay(state.session, date);
}

function startQuestion(questionId) {
  const s = state.session;
  commitCurrent();
  s.currentQuestionId = questionId;
  const timing = questionTiming(s, questionId);
  if (!s.mode.startsWith('challenge')) s.mode = timing.phase === 'review' ? 'record_input' : 'task_list';
  s.currentStartedAt = new Date().toISOString();
  if (!s.sessionStartedAt) s.sessionStartedAt = new Date().toISOString();
  announceActivity(questionId);
}

const isPaused = () => !state.session.sessionStartedAt;

/* ================================================================== */
/* タスクの展開                                                        */
/* ================================================================== */

/**
 * 今日の記録。「どの予定に対する取り組みだったか」（planItemId）で突き合わせる。
 *
 * 以前は「今日そのquestionIdの記録があるか」で判定していたが、それだと
 * 同じ問題をもう一度解く予定を今日のうちに立てられなかった（1回目で消えてしまう）。
 */
const todayRecords = () => state.today.records;

/** 今日すでに評価を記録した問題（表示の補助に使う）。 */
function doneSet() {
  return new Set(todayRecords().map((r) => r.questionId));
}

export const isDone = (qid) => doneSet().has(qid);

export function groupLabel(questionIds) {
  const qs = questionIds.map(q).filter(Boolean);
  if (qs.length === 0) return `${questionIds.length}問`;
  if (qs.length === 1) return qs[0].label;
  const sameType = qs.every((x) => x.type === qs[0].type);
  const nums = qs.map((x) => x.number).sort((a, b) => a - b);
  const consecutive = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  if (sameType && consecutive) return `${qs[0].type} ${nums[0]}〜${nums[nums.length - 1]}`;
  return qs.map((x) => x.label).join('、');
}

/**
 * セッション中の並び：例題は「1回の取り組み」ごとに1行、チャレンジは1行のまま混在させる。
 *
 * 済んだかどうかは予定項目（itemId）ごとに見る。
 * 同じ例題を1日に2回やる予定なら、1回目を記録しても2回目は残る。
 */
function flattenTasks() {
  const records = todayRecords();
  const items = [];
  for (const task of state.tasks) {
    if (task.kind === 'challenge') {
      if (!task.completed) items.push({ type: 'challenge', task });
      continue;
    }
    const split = splitPlanItems(task, records, { date: api.studyDayKey() });
    for (const item of split.pending) {
      items.push({ type: 'question', task, questionId: item.questionId, item });
    }
  }
  return items;
}

function challengeQuestionIds(task) {
  const s = state.session;
  const order = s.challengeOrder;
  if (task && s.currentChallengeId === task.id && Array.isArray(order) && order.length) return order;
  return task?.questionIds ?? [];
}

const currentChallengeTask = () =>
  state.tasks.find((t) => t.id === state.session.currentChallengeId) ?? null;

/* ================================================================== */
/* 状態遷移                                                            */
/* ================================================================== */

async function startSession(selected = null) {
  const s = state.session;
  if (s.active || endingSession) return;
  s.sessionId = crypto.randomUUID();
  s.active = true;
  s.mode = s.resumeMode ?? 'task_list';
  s.resumeMode = null;
  s.sessionElapsed = 0;
  s.sessionStartedAt = new Date().toISOString();
  if (selected?.questionId) {
    startQuestion(selected.questionId);
    s.currentPlanItemId = selected.item?.itemId ?? null;
    s.currentPlanTaskId = selected.task?.id ?? null;
  } else if (s.currentQuestionId) {
    startQuestion(s.currentQuestionId);
  } else {
    const first = flattenTasks().find((i) => i.type === 'question');
    if (first) {
      startQuestion(first.questionId);
      s.currentPlanItemId = first.item?.itemId ?? null;
      s.currentPlanTaskId = first.task?.id ?? null;
    }
  }
  state.idleTab = 'todo';
  await persist();
  heartbeatActivity();
  render();
}

let endingSession = false;
let recording = null;
export async function endSession() {
  if (endingSession || !state.session.active) return;
  endingSession = true;
  try {
    // A preceding evaluation tap must finish its local record write first.
    await recording;
    commitCurrent();
    commitSession();
    await api.finishStudySession(state.session.sessionId, state.session);
    clearActivity();
    state.session = await api.getSessionState();
    await Promise.all([refreshToday(), loadTasks()]);
    render();
    // Session is durable and UI has ended before any network/provider work.
    syncInBackground();
  } finally { endingSession = false; }
}

async function togglePause() {
  if (recording || endingSession) return;
  const s = state.session;
  if (isPaused()) {
    s.sessionStartedAt = new Date().toISOString();
    if (s.currentQuestionId) s.currentStartedAt = new Date().toISOString();
  } else {
    commitCurrent();
    commitSession();
    clearActivity();
  }
  await persist();
  render();
}

/** いま解いている例題の時間を0秒に戻す。問題は切り替えず、計測だけやり直す。 */
async function resetCurrentQuestion() {
  if (recording || endingSession) return;
  const s = state.session;
  const qid = s.currentQuestionId;
  if (!qid) return;
  delete s.questionElapsed[qid];
  if (s.questionTiming) delete s.questionTiming[qid];
  if (s.currentStartedAt) s.currentStartedAt = new Date().toISOString();
  await persist();
  render();
}

/** タスクリスト上で問題をタップしたとき。どの予定項目に取り組むかも覚えておく。 */
async function beginReview() {
  if (recording || endingSession || !state.session.currentQuestionId) return;
  const s = state.session;
  const paused = isPaused();
  commitCurrent();
  questionTiming(s, s.currentQuestionId).phase = 'review';
  s.mode = 'record_input';
  if (!paused) s.currentStartedAt = new Date().toISOString();
  await persist(); render();
}

/**
 * 誤って採点・暗記へ進んだときに、解答中へ戻す。
 * beginReview の逆方向で、計測中だった時間はそのまま解答側の時間として残る。
 */
async function backToSolve() {
  if (recording || endingSession || !state.session.currentQuestionId) return;
  const s = state.session;
  const paused = isPaused();
  commitCurrent();
  questionTiming(s, s.currentQuestionId).phase = 'solve';
  s.mode = 'task_list';
  if (!paused) s.currentStartedAt = new Date().toISOString();
  await persist(); render();
}

async function tapTaskQuestion(questionId, item = null, task = null) {
  if (recording || endingSession) return;
  const s = state.session;
  if (s.currentQuestionId === questionId) return beginReview();
  startQuestion(questionId);
  s.currentPlanItemId = item?.itemId ?? null;
  s.currentPlanTaskId = task?.id ?? null;
  await persist(); render();
}

/** チャレンジ中に問題をタップしたとき。評価は聞かず、計測対象を切り替えるだけ。 */
async function tapChallengeQuestion(questionId) {
  const s = state.session;
  if (s.currentQuestionId === questionId) {
    // 同じ行の再タップは一時停止／再開
    if (s.currentStartedAt) commitCurrent();
    else s.currentStartedAt = new Date().toISOString();
  } else {
    startQuestion(questionId);
    const task = currentChallengeTask();
    s.currentPlanTaskId = task?.id ?? null;
    s.currentPlanItemId = itemsOf(task ?? {}).find((item) => item.questionId === questionId)?.itemId ?? null;
  }
  await persist();
  render();
}

async function openChallenge(task) {
  const s = state.session;
  if (endingSession) return;
  s.sessionId ??= crypto.randomUUID();
  commitCurrent();
  s.active = true;
  s.mode = 'challenge';
  s.currentChallengeId = task.id;
  s.challengeTimeLimitSeconds = task.timeLimitSeconds ?? 12 * 60;
  s.challengeOrder = [...task.questionIds];
  s.challengeCountUp = false;
  s.challengeStartedAt = new Date().toISOString();
  s.challengeFinishedElapsed = null;
  if (!s.sessionStartedAt) s.sessionStartedAt = new Date().toISOString();
  startQuestion(task.questionIds[0]);
  s.currentPlanTaskId = task.id;
  s.currentPlanItemId = itemsOf(task)[0]?.itemId ?? null;
  reportActivity(api.studyDayKey(), task.id, task.questionIds[0], s.sessionId, s.active).catch(() => {});
  await persist();
  render();
}

function clearChallenge() {
  const s = state.session;
  for (const qid of s.reviewQueue ?? []) {
    if (s.evaluations?.[qid]) forgetQuestion(s, qid);
  }
  s.currentChallengeId = null;
  s.challengeStartedAt = null;
  s.challengeTimeLimitSeconds = null;
  s.challengeOrder = null;
  s.challengeFinishedElapsed = null;
  s.reviewQueue = [];
  s.reviewIndex = 0;
}

async function abortChallenge() {
  commitCurrent();
  clearChallenge();
  state.session.mode = 'task_list';
  state.session.currentQuestionId = null;
  await persist();
  render();
}

/** チャレンジの「終了」。ここで初めて全問の評価入力に移る。 */
async function finishChallenge() {
  const s = state.session;
  commitCurrent();
  s.challengeFinishedElapsed = challengeElapsed();
  s.reviewQueue = challengeQuestionIds(currentChallengeTask());
  s.reviewIndex = 0;
  s.mode = 'challenge_review';
  s.currentQuestionId = null;
  await persist();
  render();
}

function recordEvaluation(evaluation) {
  if (recording || endingSession) return recording;
  recording = saveEvaluation(evaluation).finally(() => { recording = null; });
  return recording;
}

async function saveEvaluation(evaluation) {
  const s = state.session;
  if (s.mode === 'challenge_review') return recordChallengeEvaluation(evaluation);

  const questionId = s.currentQuestionId;
  if (!questionId) return;
  commitCurrent();
  const next = structuredClone(s);
  forgetQuestion(next, questionId);
  next.mode = 'task_list';
  const result = await api.completeStudyAttempt({
    questionId, evaluation, ...timingRecord(s, questionId),
    planTaskId: s.currentPlanTaskId ?? null, planItemId: s.currentPlanItemId ?? null,
  }, s, next);
  if (!result.saved) {
    state.session = await api.getSessionState();
    await refreshToday(); render(); return;
  }
  state.session = next;
  await refreshAfterRecord();
  // The next pending example starts only after the evaluation is durable.
  if (!endingSession && state.session.active) {
    const first = flattenTasks().find(item => item.type === 'question');
    if (first) {
      startQuestion(first.questionId);
      state.session.currentPlanItemId = first.item?.itemId ?? null;
      state.session.currentPlanTaskId = first.task?.id ?? null;
      await persist(); render();
    }
  }
}

async function recordChallengeEvaluation(evaluation) {
  const s = state.session;
  const task = currentChallengeTask();
  const questionId = s.reviewQueue[s.reviewIndex];
  if (!questionId) return;

  const item = itemsOf(task ?? {}).find((entry) => entry.questionId === questionId);
  await api.addStudyRecord({
    questionId,
    evaluation,
    durationSeconds: s.questionElapsed[questionId] || 0,
    challengeId: s.currentChallengeId || undefined,
    planTaskId: task?.id ?? null,
    planItemId: item?.itemId ?? null,
  });
  s.evaluations = { ...(s.evaluations ?? {}), [questionId]: evaluation };
  s.reviewIndex += 1;

  if (s.reviewIndex >= s.reviewQueue.length) {
    const limit = s.challengeTimeLimitSeconds ?? 0;
    const total = s.challengeFinishedElapsed ?? 0;
    await api.saveChallengeResult({
      taskId: task?.id ?? null,
      timeLimitSeconds: limit,
      totalElapsedSeconds: Math.round(total),
      succeeded: total <= limit,
      laps: s.reviewQueue.map((id) => ({
        questionId: id,
        durationSeconds: Math.round(s.questionElapsed[id] || 0),
        evaluation: s.evaluations?.[id] ?? null,
      })),
    });
    if (task) await api.saveTask({ ...task, completed: true });
    clearChallenge();
    s.evaluations = {};
    s.mode = 'task_list';
  }
  await refreshAfterRecord();
}

async function refreshAfterRecord() {
  // 学習記録を保存したあとにクラウドへ送る。失敗しても学習側は止めない。
  syncInBackground();
  await refreshToday();
  await markCompletedTasks();
  await persist();
  render();
}

/** 予定項目がすべて実施されたタスクを「完了」にする。 */
async function markCompletedTasks() {
  const records = todayRecords();
  let changed = false;
  for (const task of state.tasks) {
    if (task.kind === 'challenge' || task.completed) continue;
    const split = splitPlanItems(task, records, { date: api.studyDayKey() });
    if (!split.pending.length && split.items.length) {
      await api.saveTask({ ...task, completed: true });
      changed = true;
    }
  }
  if (changed) state.tasks = await api.getTodayTasks();
}

/* ================================================================== */
/* 描画：上半分                                                        */
/* ================================================================== */

/**
 * 右上のボタン置き場。時刻そのものはもう出さない（真ん中の合計と重複するため）。
 * 「ホーム」の見出しと同じ行に置くため、renderHome() 側で view-head へ差し込む。
 */
function timerHeadRight(s) {
  const right = el('div', 'view-head-right');
  if (s.mode === 'record_input') {
    // 間違って採点・暗記に進んでしまったときのために、解答中へ戻すボタンを置く。
    const back = el('button', 'finish-btn', '戻る');
    back.title = '解答中へ戻る';
    back.onclick = backToSolve;
    right.append(back);
  }
  if ((s.mode === 'task_list' || s.mode === 'record_input') && s.currentQuestionId) {
    // 今解いている例題の時間だけを0秒に戻す（学習中でも一時停止中でも押せる）。
    const reset = el('button', 'finish-btn', '🔄');
    reset.title = 'この例題の時間を0秒に戻す';
    reset.setAttribute('aria-label', 'この例題の時間を0秒に戻す');
    reset.onclick = resetCurrentQuestion;
    right.append(reset);
  }
  return right;
}

/**
 * 「続いているか、止まっているか」を表す再生スライダー。
 * やること／やったこと の切り替えバーと同じ仕組み（同じ高さ・幅）で、
 * 左が停止、右が再生。アイドル時は学習の開始、学習中は一時停止・再開を兼ねる。
 */
function playSlider(s) {
  const paused = s.mode === 'idle' ? true : isPaused();
  const current = paused ? 'stop' : 'play';
  const bar = segmented(
    [['stop', '■'], ['play', '▶']],
    current,
    (value) => {
      if (value === current) return;
      if (s.mode === 'idle') { if (value === 'play') startSession(); return; }
      togglePause();
    },
    'play-slider',
  );
  bar.classList.add('play-slider');
  return bar;
}

function timerPanel() {
  const s = state.session;
  const panel = el('div', 'timer-panel');
  const label = el('div', 'timer-label');
  const value = el('div', 'timer-value');
  value.dataset.timer = 'main';
  const actions = el('div', 'timer-actions');

  if (s.mode === 'idle') {
    // 学習していないときは「今日の学習時間」の文字を出さず、数字だけを
    // できるだけ大きく・上に詰めて見せる。「学習を開始」ボタンは廃止し、
    // 続いているか止まっているかを表すスライダーで代わりに始める。
    value.textContent = fmtMS(dailyElapsed());
    value.dataset.timer = 'today';
    panel.append(playSlider(s), value);
    return panel;
  }

  if (s.mode === 'challenge') {
    const task = currentChallengeTask();
    const limit = s.challengeTimeLimitSeconds ?? 0;
    label.textContent = `${task?.title ?? 'チャレンジ'} ・ ${s.challengeCountUp ? '経過時間' : '残り時間'}`;
    value.textContent = fmtMS(s.challengeCountUp ? challengeElapsed() : Math.max(0, limit - challengeElapsed()));
    value.classList.add('danger');
    value.dataset.timer = 'challenge';
    const toggle = el('button', 'btn', s.challengeCountUp ? 'カウントダウン表示' : 'カウントアップ表示');
    toggle.onclick = async () => {
      s.challengeCountUp = !s.challengeCountUp;
      await persist();
      render();
    };
    const abort = el('button', 'btn', '中断');
    abort.onclick = abortChallenge;
    actions.append(toggle, abort);
    panel.append(label, value, actions);
    return panel;
  }

  if (s.mode === 'challenge_review') {
    const task = currentChallengeTask();
    const qid = s.reviewQueue[s.reviewIndex];
    label.textContent = `${task?.title ?? 'チャレンジ'} ・ 記録 ${s.reviewIndex + 1}/${s.reviewQueue.length}`;
    value.textContent = fmtMS(s.questionElapsed[qid] || 0);
    panel.append(label, value);
    return panel;
  }

  // task_list / record_input
  // 一時停止・再開はスライダーで行う（数字そのものをタップする操作は廃止）。
  // 真ん中には常に「今日の合計」を出す（例題ごとの時間はタスクバー側に出る）。
  const paused = isPaused();
  value.textContent = fmtMS(dailyElapsed());
  value.dataset.timer = 'today';
  panel.append(playSlider(s), value);

  if (s.mode === 'record_input') {
    // 採点・暗記中は、どの例題を採点しているか分かるよう問題名を残す。
    const name = s.currentQuestionId ? qLabel(s.currentQuestionId) : null;
    if (name) {
      label.textContent = paused ? `${name}（一時停止中）` : `${name} 採点・暗記中`;
      panel.append(label);
    }
  }
  return panel;
}

/** 数字だけを更新する（再描画しない）。 */
export function tickHome() {
  const s = state.session;
  const set = (name, text) => {
    const n = document.querySelector(`[data-timer="${name}"]`);
    if (n) n.textContent = text;
  };
  refreshStudyDayIfNeeded();
  set('today', fmtMS(dailyElapsed()));
  if (s.mode === 'challenge') {
    const limit = s.challengeTimeLimitSeconds ?? 0;
    const e = challengeElapsed();
    set('challenge', fmtMS(s.challengeCountUp ? e : Math.max(0, limit - e)));
  }
  document.querySelectorAll('[data-elapsed-for]').forEach((node) => {
    node.textContent = fmtMS(elapsedOf(node.dataset.elapsedFor));
  });
}

let refreshingStudyDay = null;
function refreshStudyDayIfNeeded() {
  if (state.today.date === api.studyDayKey() || refreshingStudyDay) return;
  // 03:00をまたいで解答中の予定は、採点・終了まで参照できるように保つ。
  // 待機中なら新しい学習日のTo Doも同時に読み直す。
  const operations = [refreshToday()];
  if (!state.session.active) operations.push(loadTasks());
  refreshingStudyDay = Promise.all(operations)
    .then(() => render())
    .finally(() => { refreshingStudyDay = null; });
}

/* ================================================================== */
/* 描画：下半分                                                        */
/* ================================================================== */

/**
 * 行の右側は時間だけにする。「未着手／一時停止／計測中」は文字にせず、
 * どれが今解いている行かは行そのものの色（active/current）で示す。
 * 何の例題か・番号はすでにタイトル（qLabel）に出ているので重ねて出さない。
 */
function stateCells(questionId) {
  const s = state.session;
  const active = s.currentQuestionId === questionId && !!s.currentStartedAt;
  const started = (s.questionElapsed[questionId] || 0) > 0 || active;
  const time = el('span', `row-time${active ? ' active' : ''}`, '');
  if (started) {
    time.textContent = fmtMS(elapsedOf(questionId));
    time.dataset.elapsedFor = questionId;
  }
  return [time];
}

const challengeSub = (task) =>
  `${task.questionIds.length}問 / ${Math.round((task.timeLimitSeconds ?? 0) / 60)}分`;

/**
 * タスクを、今日まだやっていない分（pending）だけに絞る。
 * 一部の問題だけ今日やった複合タスクは、済んだ問題を「やること」側から外す。
 */
function pendingTodo(open) {
  return open
    .map((task) => task.kind === 'challenge'
      ? { task, pendingIds: task.questionIds, item: null }
      : (() => {
          const split = splitPlanItems(task, todayRecords(), { date: api.studyDayKey() });
          return { task, pendingIds: split.pending.map((p) => p.questionId), item: split.pending[0] ?? null };
        })())
    .filter((t) => t.task.kind === 'challenge' || t.pendingIds.length);
}

function idlePanel(panel) {
  const open = state.tasks.filter((t) => !t.completed);
  const todo = pendingTodo(open);
  const todoCount = todo.reduce((n, t) => n + (t.task.kind === 'challenge' ? 1 : t.pendingIds.length), 0);
  const tabs = [['todo', `やること ${todoCount}`], ['done', `やったこと ${state.today.records.length}`]];
  const selectTab = (v) => { state.idleTab = v; render(); };
  panel.append(segmented(tabs, state.idleTab, selectTab, 'home-tabs'));
  swipeable(panel, tabs.map(([v]) => v), state.idleTab, selectTab);

  const list = el('div', 'list');
  if (state.idleTab === 'todo') {
    if (!todo.length) list.append(emptyState('今日のタスクはありません'));
    for (const { task, pendingIds, item } of todo) {
      const first = q(pendingIds[0]);
      const node = row({
        title: task.kind === 'challenge' ? task.title ?? 'チャレンジ' : groupLabel(pendingIds),
        sub: task.kind === 'challenge' ? challengeSub(task) : first ? first.chapter + ' ・ ' + first.section : null,
      });
      const main = node.querySelector('.row-main');
      const start = el('button', 'row-main');
      start.style.textAlign = 'left';
      start.append(...main.childNodes);
      start.onclick = () => task.kind === 'challenge' ? openChallenge(task)
        : item && startSession({ questionId: item.questionId, item, task });
      main.replaceWith(start);
      list.append(node);
    }
  } else {
    if (!state.today.records.length) list.append(emptyState('まだ記録がありません'));
    appendDoneRecords(list);
  }
  panel.append(list);
}

function appendDoneRecords(list) {
  for (const r of state.today.records) {
    const ev = EVAL_MAP[r.evaluation];
    const undo = el('button', 'link-btn', '未着手に戻す');
    undo.setAttribute('aria-label', qLabel(r.questionId) + 'を未着手に戻す');
    undo.onclick = () => undoRecord(r);
    const node = row({ title: qLabel(r.questionId), right: [el('span', 'row-time', fmtMS(r.durationSeconds)), undo] });
    if (ev) node.prepend(el('span', 'eval-mark tone-' + ev.tone, ev.symbol));
    list.append(node);
  }
}

function taskListPanel(panel) {
  const tabs = [['todo', 'やること'], ['done', 'やったこと ' + state.today.records.length]];
  const selectTab = (value) => { state.idleTab = value; render(); };
  panel.append(segmented(tabs, state.idleTab, selectTab, 'home-tabs'));
  swipeable(panel, tabs.map(([v]) => v), state.idleTab, selectTab);
  if (state.idleTab === 'done') {
    const list = el('div', 'list'); appendDoneRecords(list); panel.append(list); return;
  }
  const list = el('div', 'list');
  const items = flattenTasks();
  if (!items.length) list.append(emptyState('今日のタスクは終わりました'));

  for (const item of items) {
    if (item.type === 'challenge') {
      list.append(
        row({
          title: item.task.title ?? 'チャレンジ',
          sub: challengeSub(item.task),
          onClick: () => openChallenge(item.task),
        })
      );
      continue;
    }
    const qid = item.questionId;
    const current = state.session.currentQuestionId === qid;
    const active = current && !!state.session.currentStartedAt;
    // いま解いている行は色が変わる。もう一度押すと採点へ進むので、その案内だけ残す。
    list.append(
      row({
        title: qLabel(qid),
        sub: current ? 'もう一度タップすると採点・暗記へ' : null,
        right: stateCells(qid),
        onClick: () => tapTaskQuestion(qid, item.item, item.task),
        classes: active ? ['active'] : current ? ['current'] : [],
      })
    );
  }
  panel.append(list);
}

function evalPanel(panel, heading, note) {
  if (heading) panel.append(el('div', 'panel-head', heading));
  const list = el('div', 'eval-list');
  for (const ev of EVALUATIONS) {
    const b = el('button', 'eval-btn');
    b.append(el('span', `sym tone-${ev.tone}`, ev.symbol));
    b.append(el('span', 'lbl', ev.label));
    b.onclick = () => recordEvaluation(ev.value);
    list.append(b);
  }
  panel.append(list, el('div', 'note', note));
}

function challengePanel(panel) {
  const s = state.session;
  const task = currentChallengeTask();
  panel.append(el('div', 'panel-head', task?.title ?? 'チャレンジ'));
  const list = el('div', 'list');
  const ids = challengeQuestionIds(task);

  ids.forEach((qid, index) => {
    const active = s.currentQuestionId === qid && !!s.currentStartedAt;
    const node = row({
      title: qLabel(qid),
      right: stateCells(qid),
      onClick: () => tapChallengeQuestion(qid),
      classes: active ? ['active'] : [],
    });
    node.draggable = true;
    node.prepend(el('span', 'drag-handle', '≡'));
    node.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(index));
      node.classList.add('dragging');
    });
    node.addEventListener('dragend', () => node.classList.remove('dragging'));
    node.addEventListener('dragover', (e) => e.preventDefault());
    node.addEventListener('drop', async (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/plain'));
      if (Number.isNaN(from) || from === index) return;
      const order = [...ids];
      const [moved] = order.splice(from, 1);
      order.splice(index, 0, moved);
      s.challengeOrder = order;
      await persist();
      render();
    });
    list.append(node);
  });

  // 問題行と同じ見た目の「終了」行。ここを押すと全問の評価入力に移る。
  list.append(row({ title: '終了', sub: 'まとめて評価を記録する', onClick: finishChallenge, classes: ['row-finish'] }));
  panel.append(list, el('div', 'note', '問題をタップして計測を切り替え・ドラッグで並び替え'));
}

/* ================================================================== */

export function renderHome(screen) {
  const s = state.session;
  screen.innerHTML = '';
  screen.dataset.mode = s.mode;
  const head = el('div', 'view-head view-head-row');
  head.append(el('h1', 'view-title', 'ホーム'));
  head.append(timerHeadRight(s));
  screen.append(head);
  screen.append(timerPanel());

  const panel = el('div', 'panel');
  if (s.mode === 'idle') idlePanel(panel);
  else if (s.mode === 'record_input') {
    // 「解答◯◯／ここからは採点・暗記時間として...」の説明と見出しは、
    // タイマー下の状態表示（採点・暗記中）と重複するため出さない。
    // そのぶん結果ボタンをタイマーのすぐ下へ詰める。
    evalPanel(panel, null, '結果を保存すると、次の例題を開始します');
  }
  else if (s.mode === 'challenge') challengePanel(panel);
  else if (s.mode === 'challenge_review')
    evalPanel(panel, `${qLabel(s.reviewQueue[s.reviewIndex])} はどうだった？`, '所要時間は自動で記録されます');
  else taskListPanel(panel);
  screen.append(panel);
}
