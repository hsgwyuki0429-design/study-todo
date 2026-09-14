// ホーム画面。上半分＝タイマー（固定）、下半分＝可変エリア。
// 学習中に画面遷移は行わず、下半分の中身だけが切り替わる。

import * as api from './api.js';
import { EVALUATIONS, EVAL_MAP } from './api.js';
import { itemsOf, splitPlanItems } from './plan-items.js';
import { state, q, qLabel, render, refreshToday } from './state.js';
import { $, el, fmtMS, fmtShort, row, segmented, emptyState } from './ui.js';
import { pushPin, reportActivity, syncInBackground } from './cloud-sync.js';

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
  const date = api.todayKey();
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
  reportActivity(api.todayKey(), null, null, state.session.sessionId, state.session.active).catch(() => {});
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
  const s = state.session;
  if (s.currentQuestionId && s.currentStartedAt) {
    s.questionElapsed[s.currentQuestionId] =
      (s.questionElapsed[s.currentQuestionId] || 0) + since(s.currentStartedAt);
  }
  s.currentStartedAt = null;
}

function commitSession() {
  const s = state.session;
  if (s.sessionStartedAt) {
    s.sessionElapsed = (s.sessionElapsed || 0) + since(s.sessionStartedAt);
    s.sessionStartedAt = null;
  }
}

function startQuestion(questionId) {
  const s = state.session;
  commitCurrent();
  s.currentQuestionId = questionId;
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
    const split = splitPlanItems(task, records, { date: api.todayKey() });
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

async function startSession() {
  const s = state.session;
  if (s.active || endingSession) return;
  s.sessionId = crypto.randomUUID();
  s.active = true;
  s.mode = 'task_list';
  s.sessionElapsed = 0;
  s.sessionStartedAt = new Date().toISOString();
  const first = flattenTasks().find((i) => i.type === 'question');
  if (first) {
    startQuestion(first.questionId);
    s.currentPlanItemId = first.item?.itemId ?? null;
    s.currentPlanTaskId = first.task?.id ?? null;
  }
  await persist();
  heartbeatActivity();
  render();
}

let endingSession = false;
let recording = null;
async function endSession() {
  if (endingSession || !state.session.active) return;
  endingSession = true;
  try {
    // A preceding evaluation tap must finish its local record write first.
    await recording;
    commitCurrent();
    commitSession();
    await api.finishStudySession(state.session.sessionId);
    clearActivity();
    state.session = await api.getSessionState();
    render();
    // Session is durable and UI has ended before any network/provider work.
    syncInBackground();
  } finally { endingSession = false; }
}

async function togglePause() {
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

/** タスクリスト上で問題をタップしたとき。どの予定項目に取り組むかも覚えておく。 */
async function tapTaskQuestion(questionId, item = null, task = null) {
  const s = state.session;
  if (s.currentQuestionId === questionId && s.currentStartedAt) {
    s.mode = 'record_input';   // 計測中の行を再タップ → 記録入力
  } else {
    startQuestion(questionId);
    s.currentPlanItemId = item?.itemId ?? null;
    s.currentPlanTaskId = task?.id ?? null;
    s.mode = 'task_list';
  }
  await persist();
  render();
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
  reportActivity(api.todayKey(), task.id, task.questionIds[0], s.sessionId, s.active).catch(() => {});
  await persist();
  render();
}

function clearChallenge() {
  const s = state.session;
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
  await api.addStudyRecord({
    questionId,
    evaluation,
    durationSeconds: s.questionElapsed[questionId] || 0,
    // どの予定に対する取り組みだったかを残す。予定外に解いたときは入らない。
    planTaskId: s.currentPlanTaskId ?? null,
    planItemId: s.currentPlanItemId ?? null,
  });

  // 記録したら計測を止め、次の問題は自分でタップして選ぶ
  s.currentQuestionId = null;
  s.currentPlanItemId = null;
  s.currentPlanTaskId = null;
  delete s.questionElapsed[questionId];
  s.mode = 'task_list';
  await refreshAfterRecord();
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
    const split = splitPlanItems(task, records, { date: api.todayKey() });
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

function timerPanel() {
  const s = state.session;
  const panel = el('div', 'timer-panel');
  const label = el('div', 'timer-label');
  const value = el('div', 'timer-value');
  value.dataset.timer = 'main';
  const actions = el('div', 'timer-actions');

  if (s.mode === 'idle') {
    label.textContent = '今日の学習時間';
    value.textContent = fmtMS(state.today.seconds);
    value.dataset.timer = 'today';
    const b = el('button', 'btn btn-primary', '学習を開始');
    b.onclick = startSession;
    actions.append(b);
    panel.append(label, value, actions);
    return panel;
  }

  // 全体の学習時間（左上に小さく）
  const total = el('div', 'timer-total');
  total.append(el('span', 'timer-total-k', '学習時間'));
  const totalValue = el('span', 'timer-total-v', fmtMS(sessionElapsed()));
  totalValue.dataset.timer = 'session';
  total.append(totalValue);
  panel.append(total);

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
  const name = s.currentQuestionId ? qLabel(s.currentQuestionId) : null;
  label.textContent = name
    ? s.currentStartedAt
      ? `${name} を解いています`
      : `${name}（一時停止中）`
    : '問題をタップして開始';
  value.textContent = fmtMS(s.currentQuestionId ? elapsedOf(s.currentQuestionId) : 0);

  const pause = el('button', 'btn', isPaused() ? '再開' : '一時停止');
  pause.onclick = togglePause;
  const stop = el('button', 'btn btn-danger', '終了');
  stop.onclick = endSession;
  actions.append(pause, stop);
  panel.append(label, value, actions);
  return panel;
}

/** 数字だけを更新する（再描画しない）。 */
export function tickHome() {
  const s = state.session;
  const set = (name, text) => {
    const n = document.querySelector(`[data-timer="${name}"]`);
    if (n) n.textContent = text;
  };
  set('today', fmtMS(state.today.seconds));
  set('session', fmtMS(sessionElapsed()));
  if (s.mode === 'challenge') {
    const limit = s.challengeTimeLimitSeconds ?? 0;
    const e = challengeElapsed();
    set('challenge', fmtMS(s.challengeCountUp ? e : Math.max(0, limit - e)));
  } else if (s.currentQuestionId) {
    set('main', fmtMS(elapsedOf(s.currentQuestionId)));
  }
  document.querySelectorAll('[data-elapsed-for]').forEach((node) => {
    node.textContent = fmtMS(elapsedOf(node.dataset.elapsedFor));
  });
}

/* ================================================================== */
/* 描画：下半分                                                        */
/* ================================================================== */

function stateCells(questionId) {
  const s = state.session;
  const active = s.currentQuestionId === questionId && !!s.currentStartedAt;
  const started = (s.questionElapsed[questionId] || 0) > 0 || active;
  const pill = el('span', `state-pill${active ? ' active' : ''}`,
    active ? '計測中' : started ? '一時停止' : '未着手');
  const time = el('span', `row-time${active ? ' active' : ''}`, '');
  if (started) {
    time.textContent = fmtMS(elapsedOf(questionId));
    time.dataset.elapsedFor = questionId;
  }
  return [pill, time];
}

/**
 * 固定（ピン留め）の切り替えボタン。
 * 固定したタスクはAIから変更・削除・移動されない。外せるのはここからだけで、
 * AI側には固定を外す手段がない。
 */
function pinButton(task) {
  const pinned = task.pinned === true;
  const node = el('button', `pin-btn${pinned ? ' pinned' : ''}`, pinned ? '固定中' : '固定');
  node.title = pinned
    ? 'AIが動かさないように固定しています。押すと解除します。'
    : '押すと固定します。固定したタスクはAIが変更・削除・移動できません。';
  node.onclick = async (event) => {
    event.stopPropagation();
    await api.setTaskPinned(task.id, !pinned);
    // クラウドにも伝える（届かなくても、次の同期で送られる）。
    pushPin(task.date, task.id, !pinned).catch(() => {});
    state.tasks = await api.getTodayTasks();
    render();
  };
  return node;
}

const challengeSub = (task) =>
  `${task.questionIds.length}問 / ${Math.round((task.timeLimitSeconds ?? 0) / 60)}分`;

function idlePanel(panel) {
  const open = state.tasks.filter((t) => !t.completed);
  const todoCount = open.reduce((n, t) => n + (t.kind === 'challenge' ? 1 : t.questionIds.length), 0);
  panel.append(
    segmented(
      [['todo', `やること ${todoCount}`], ['done', `やったこと ${state.today.records.length}`]],
      state.idleTab,
      (v) => {
        state.idleTab = v;
        render();
      }
    )
  );

  const list = el('div', 'list');
  if (state.idleTab === 'todo') {
    if (!open.length) list.append(emptyState('今日のタスクはありません'));
    for (const task of open) {
      const first = q(task.questionIds[0]);
      list.append(
        row({
          title: task.kind === 'challenge' ? task.title ?? 'チャレンジ' : groupLabel(task.questionIds),
          sub: task.kind === 'challenge' ? challengeSub(task) : first ? `${first.chapter} ・ ${first.section}` : null,
          right: pinButton(task),
        })
      );
    }
  } else {
    if (!state.today.records.length) list.append(emptyState('まだ記録がありません'));
    for (const r of state.today.records) {
      const ev = EVAL_MAP[r.evaluation];
      const node = row({ title: qLabel(r.questionId), right: el('span', 'row-time', fmtMS(r.durationSeconds)) });
      node.prepend(el('span', `eval-mark tone-${ev.tone}`, ev.symbol));
      list.append(node);
    }
  }
  panel.append(list);
}

function taskListPanel(panel) {
  panel.append(el('div', 'panel-head', '今日やること（優先順）'));
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
    const qq = q(qid);
    const active = state.session.currentQuestionId === qid && !!state.session.currentStartedAt;
    const carried = item.item?.originalDate && item.item.originalDate !== api.todayKey();
    list.append(
      row({
        title: qLabel(qid),
        sub: [qq ? `${qq.chapter} ・ ${qq.section}` : null, carried ? '繰り越し' : null].filter(Boolean).join(' ・ ') || null,
        right: stateCells(qid),
        onClick: () => tapTaskQuestion(qid, item.item, item.task),
        classes: active ? ['active'] : [],
      })
    );
  }
  panel.append(list);
}

function evalPanel(panel, heading, note) {
  panel.append(el('div', 'panel-head', heading));
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
  const head = el('div', 'view-head');
  head.append(el('h1', 'view-title', 'ホーム'));
  screen.append(head);
  screen.append(timerPanel());

  if (s.mode === 'idle') {
    const cards = el('div', 'mini-cards');
    const card = (k, v) => {
      const c = el('div', 'mini-card');
      c.append(el('div', 'k', k), el('div', 'v', v));
      return c;
    };
    cards.append(card('累計時間', fmtShort(state.today.seconds)), card('解いた問題数', String(state.today.count)));
    screen.append(cards);
  }

  const panel = el('div', 'panel');
  if (s.mode === 'idle') idlePanel(panel);
  else if (s.mode === 'record_input') evalPanel(panel, `${qLabel(s.currentQuestionId)} はどうだった？`, '所要時間は自動で記録されます');
  else if (s.mode === 'challenge') challengePanel(panel);
  else if (s.mode === 'challenge_review')
    evalPanel(panel, `${qLabel(s.reviewQueue[s.reviewIndex])} はどうだった？`, '所要時間は自動で記録されます');
  else taskListPanel(panel);
  screen.append(panel);
}
