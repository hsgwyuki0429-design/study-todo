import * as api from './api.js';
import { EVALUATIONS, EVAL_MAP, TASK_KINDS } from './api.js';
import { seedIfEmpty } from './seed.js';

/* ================================================================== */
/* ユーティリティ                                                      */
/* ================================================================== */

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const pad = (n) => String(Math.floor(n)).padStart(2, '0');

function fmtMS(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function fmtShort(seconds) {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60}分`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ================================================================== */
/* アプリ状態                                                          */
/* ================================================================== */

const state = {
  tab: 'home',
  idleTab: 'todo',          // 'todo' | 'done'
  session: { ...api.EMPTY_SESSION },
  tasks: [],
  questions: new Map(),
  today: { seconds: 0, count: 0, records: [] },
  filters: { chapter: '', evaluation: '' },
};

const q = (id) => state.questions.get(id);
const qLabel = (id) => q(id)?.label ?? id;

async function persist() {
  await api.setSessionState(state.session);
}

/* ---- タイマー計算（絶対時刻ベース） ---- */

function elapsedOf(questionId) {
  const s = state.session;
  const base = s.questionElapsed[questionId] || 0;
  if (s.active && s.currentQuestionId === questionId && s.currentStartedAt) {
    return base + (Date.now() - new Date(s.currentStartedAt).getTime()) / 1000;
  }
  return base;
}

function commitCurrent() {
  const s = state.session;
  if (s.currentQuestionId && s.currentStartedAt) {
    s.questionElapsed[s.currentQuestionId] =
      (s.questionElapsed[s.currentQuestionId] || 0) +
      (Date.now() - new Date(s.currentStartedAt).getTime()) / 1000;
  }
  s.currentStartedAt = null;
}

function startQuestion(questionId) {
  const s = state.session;
  commitCurrent();
  s.currentQuestionId = questionId;
  s.currentStartedAt = new Date().toISOString();
}

function challengeElapsed() {
  const s = state.session;
  if (!s.challengeStartedAt) return 0;
  return (Date.now() - new Date(s.challengeStartedAt).getTime()) / 1000;
}

/* ================================================================== */
/* タスクの展開                                                        */
/* ================================================================== */

// 待機状態用：まとめた単位（例題 42〜44）
function groupLabel(questionIds) {
  const qs = questionIds.map(q).filter(Boolean);
  if (qs.length === 0) return `${questionIds.length}問`;
  if (qs.length === 1) return qs[0].label;
  const sameType = qs.every((x) => x.type === qs[0].type);
  const nums = qs.map((x) => x.number).sort((a, b) => a - b);
  const consecutive = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  if (sameType && consecutive) return `${qs[0].type} ${nums[0]}〜${nums[nums.length - 1]}`;
  return qs.map((x) => x.label).join('、');
}

// セッション中用：1問ずつ展開（チャレンジは1行のまま）
function flattenTasks() {
  const items = [];
  for (const task of state.tasks) {
    if (task.kind === 'challenge') {
      items.push({ type: 'challenge', task });
    } else {
      for (const qid of task.questionIds) items.push({ type: 'question', task, questionId: qid });
    }
  }
  return items;
}

const isDone = (qid) => state.session.completedQuestionIds.includes(qid);

function challengeQuestionIds(task) {
  const order = state.session.challengeOrder;
  if (state.session.currentChallengeId === task.id && Array.isArray(order) && order.length) {
    return order;
  }
  return task.questionIds;
}

function nextUnfinishedQuestion() {
  for (const item of flattenTasks()) {
    if (item.type === 'question' && !isDone(item.questionId)) return item.questionId;
  }
  return null;
}

/* ================================================================== */
/* 状態遷移                                                            */
/* ================================================================== */

async function startSession() {
  const first = nextUnfinishedQuestion();
  const s = state.session;
  s.active = true;
  s.mode = 'task_list';
  if (first) startQuestion(first);
  await persist();
  render();
}

async function endSession() {
  commitCurrent();
  Object.assign(state.session, api.EMPTY_SESSION, { questionElapsed: {}, completedQuestionIds: [] });
  await persist();
  await refreshToday();
  render();
}

async function togglePause() {
  const s = state.session;
  if (s.currentStartedAt) commitCurrent();
  else if (s.currentQuestionId) s.currentStartedAt = new Date().toISOString();
  await persist();
  render();
}

async function tapQuestionRow(questionId) {
  const s = state.session;
  if (isDone(questionId)) return;
  if (s.currentQuestionId === questionId && s.currentStartedAt) {
    // 計測中の行をもう一度タップ → 記録入力
    s.mode = 'record_input';
  } else {
    startQuestion(questionId);
    if (s.mode === 'record_input') s.mode = s.currentChallengeId ? 'challenge' : 'task_list';
  }
  await persist();
  render();
}

async function openChallenge(task) {
  const s = state.session;
  commitCurrent();
  s.mode = 'challenge';
  s.currentChallengeId = task.id;
  s.challengeTimeLimitSeconds = task.timeLimitSeconds ?? 12 * 60;
  s.challengeOrder = [...task.questionIds];
  s.challengeCountUp = false;
  if (!s.challengeStartedAt) s.challengeStartedAt = new Date().toISOString();
  const first = task.questionIds.find((id) => !isDone(id));
  if (first) startQuestion(first);
  s.active = true;
  await persist();
  render();
}

async function leaveChallenge() {
  const s = state.session;
  commitCurrent();
  s.mode = 'task_list';
  s.currentChallengeId = null;
  s.challengeStartedAt = null;
  s.challengeTimeLimitSeconds = null;
  s.challengeOrder = null;
  const next = nextUnfinishedQuestion();
  if (next) startQuestion(next);
  await persist();
  render();
}

async function recordEvaluation(evaluation) {
  const s = state.session;
  const questionId = s.currentQuestionId;
  if (!questionId) return;
  commitCurrent();
  const duration = s.questionElapsed[questionId] || 0;

  await api.addStudyRecord({
    questionId,
    evaluation,
    durationSeconds: duration,
    challengeId: s.currentChallengeId || undefined,
  });
  if (!s.completedQuestionIds.includes(questionId)) s.completedQuestionIds.push(questionId);

  if (s.currentChallengeId) {
    const task = state.tasks.find((t) => t.id === s.currentChallengeId);
    const ids = task ? challengeQuestionIds(task) : [];
    const remaining = ids.filter((id) => !isDone(id));
    if (remaining.length === 0) {
      await finishChallenge(task);
    } else {
      s.mode = 'challenge';
      startQuestion(remaining[0]);
    }
  } else {
    s.mode = 'task_list';
    const next = nextUnfinishedQuestion();
    if (next) startQuestion(next);
    else s.currentQuestionId = null;
    await markCompletedTasks();
  }

  await persist();
  await refreshToday();
  render();
}

async function finishChallenge(task) {
  const s = state.session;
  const ids = task ? challengeQuestionIds(task) : [];
  const total = challengeElapsed();
  const limit = s.challengeTimeLimitSeconds ?? 0;
  await api.saveChallengeResult({
    taskId: task?.id ?? null,
    timeLimitSeconds: limit,
    totalElapsedSeconds: Math.round(total),
    succeeded: total <= limit,
    laps: ids.map((id) => ({
      questionId: id,
      durationSeconds: Math.round(s.questionElapsed[id] || 0),
    })),
  });
  if (task) await api.saveTask({ ...task, completed: true });
  s.currentChallengeId = null;
  s.challengeStartedAt = null;
  s.challengeTimeLimitSeconds = null;
  s.challengeOrder = null;
  s.mode = 'task_list';
  await loadTasks();
  const next = nextUnfinishedQuestion();
  if (next) startQuestion(next);
  else s.currentQuestionId = null;
}

async function markCompletedTasks() {
  for (const task of state.tasks) {
    if (task.kind === 'challenge' || task.completed) continue;
    if (task.questionIds.every(isDone)) await api.saveTask({ ...task, completed: true });
  }
  await loadTasks();
}

/* ================================================================== */
/* 描画：ホーム上半分                                                  */
/* ================================================================== */

function renderTimer() {
  const s = state.session;
  const label = $('#timer-label');
  const value = $('#timer-value');
  const actions = $('#timer-actions');
  actions.innerHTML = '';
  value.classList.remove('danger');

  if (s.mode === 'idle') {
    label.textContent = '今日の学習時間';
    value.textContent = fmtMS(state.today.seconds);
    const b = el('button', 'btn btn-primary', '学習を開始');
    b.onclick = startSession;
    actions.append(b);
    $('#mini-cards').hidden = false;
    return;
  }

  $('#mini-cards').hidden = true;

  if (s.mode === 'challenge') {
    const task = state.tasks.find((t) => t.id === s.currentChallengeId);
    const limit = s.challengeTimeLimitSeconds ?? 0;
    const elapsed = challengeElapsed();
    label.textContent = `${task?.title ?? 'チャレンジ'} ・ ${s.challengeCountUp ? '経過時間' : '残り時間'}`;
    value.textContent = fmtMS(s.challengeCountUp ? elapsed : Math.max(0, limit - elapsed));
    value.classList.add('danger');
    const toggle = el(
      'button',
      'btn',
      s.challengeCountUp ? 'カウントダウン表示' : 'カウントアップ表示'
    );
    toggle.onclick = async () => {
      s.challengeCountUp = !s.challengeCountUp;
      await persist();
      render();
    };
    const back = el('button', 'btn', '中断');
    back.onclick = leaveChallenge;
    actions.append(toggle, back);
    return;
  }

  const name = s.currentQuestionId ? qLabel(s.currentQuestionId) : null;
  label.textContent = name
    ? s.currentStartedAt
      ? `${name} を解いています`
      : `${name}（一時停止中）`
    : '今日のタスクは完了しました';
  value.textContent = fmtMS(s.currentQuestionId ? elapsedOf(s.currentQuestionId) : 0);

  const pause = el('button', 'btn', s.currentStartedAt ? '一時停止' : '再開');
  pause.disabled = !s.currentQuestionId;
  pause.onclick = togglePause;
  const stop = el('button', 'btn btn-danger', '終了');
  stop.onclick = endSession;
  actions.append(pause, stop);
}

// 1秒未満の間隔で数字だけを更新する（再描画しない）
function tick() {
  const s = state.session;
  const value = $('#timer-value');
  if (!value) return;
  if (s.mode === 'idle') {
    value.textContent = fmtMS(state.today.seconds);
  } else if (s.mode === 'challenge') {
    const limit = s.challengeTimeLimitSeconds ?? 0;
    const e = challengeElapsed();
    value.textContent = fmtMS(s.challengeCountUp ? e : Math.max(0, limit - e));
  } else if (s.currentQuestionId) {
    value.textContent = fmtMS(elapsedOf(s.currentQuestionId));
  }
  document.querySelectorAll('[data-elapsed-for]').forEach((node) => {
    node.textContent = fmtMS(elapsedOf(node.dataset.elapsedFor));
  });
}

/* ================================================================== */
/* 描画：ホーム下半分                                                  */
/* ================================================================== */

function stateCell(questionId) {
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

function renderIdlePanel(panel) {
  const seg = el('div', 'segmented');
  const todoCount = state.tasks
    .filter((t) => !t.completed)
    .reduce((n, t) => n + (t.kind === 'challenge' ? 1 : t.questionIds.length), 0);
  const done = state.today.records.length;

  for (const [key, text] of [['todo', `やること ${todoCount}`], ['done', `やったこと ${done}`]]) {
    const b = el('button', null, text);
    b.setAttribute('aria-selected', String(state.idleTab === key));
    b.onclick = () => {
      state.idleTab = key;
      render();
    };
    seg.append(b);
  }
  panel.append(seg);

  const list = el('div', 'list');
  if (state.idleTab === 'todo') {
    const open = state.tasks.filter((t) => !t.completed);
    if (!open.length) list.append(el('div', 'empty', '今日のタスクはありません'));
    for (const task of open) {
      const row = el('div', 'row');
      const main = el('div', 'row-main');
      const kind = TASK_KINDS[task.kind] ?? TASK_KINDS.new;
      if (task.kind === 'challenge') {
        main.append(el('div', 'row-title', task.title ?? 'チャレンジ'));
        main.append(
          el('div', 'row-sub',
            `${task.questionIds.length}問 / ${Math.round((task.timeLimitSeconds ?? 0) / 60)}分`)
        );
      } else {
        main.append(el('div', 'row-title', groupLabel(task.questionIds)));
        const first = q(task.questionIds[0]);
        if (first) main.append(el('div', 'row-sub', `${first.chapter} ・ ${first.section}`));
      }
      row.append(main, el('span', `badge tone-${kind.tone}`, kind.label));
      list.append(row);
    }
  } else {
    if (!state.today.records.length) list.append(el('div', 'empty', 'まだ記録がありません'));
    for (const r of state.today.records) {
      const row = el('div', 'row');
      const ev = EVAL_MAP[r.evaluation];
      row.append(el('span', `eval-mark tone-${ev.tone}`, ev.symbol));
      row.append(el('div', 'row-main', qLabel(r.questionId)));
      row.append(el('span', 'row-time', fmtMS(r.durationSeconds)));
      list.append(row);
    }
  }
  panel.append(list);
}

function renderTaskListPanel(panel) {
  panel.append(el('div', 'panel-head', '今日やること（優先順）'));
  const list = el('div', 'list');
  const items = flattenTasks();
  if (!items.length) list.append(el('div', 'empty', 'タスクがありません'));

  for (const item of items) {
    if (item.type === 'challenge') {
      const row = el('button', 'row');
      const done = item.task.completed;
      if (done) row.classList.add('done');
      const main = el('div', 'row-main');
      main.append(el('div', 'row-title', item.task.title ?? 'チャレンジ'));
      main.append(
        el('div', 'row-sub',
          `${item.task.questionIds.length}問 / ${Math.round((item.task.timeLimitSeconds ?? 0) / 60)}分`)
      );
      row.append(main, el('span', 'badge tone-violet', '挑戦'));
      row.onclick = () => (done ? null : openChallenge(item.task));
      list.append(row);
      continue;
    }
    const qid = item.questionId;
    const row = el('button', 'row');
    const active = state.session.currentQuestionId === qid && !!state.session.currentStartedAt;
    if (active) row.classList.add('active');
    if (isDone(qid)) row.classList.add('done');
    const main = el('div', 'row-main');
    main.append(el('div', 'row-title', qLabel(qid)));
    const qq = q(qid);
    if (qq) main.append(el('div', 'row-sub', `${qq.chapter} ・ ${qq.section}`));
    row.append(main);
    if (isDone(qid)) {
      row.append(el('span', 'state-pill', '完了'));
      row.append(el('span', 'row-time', fmtMS(state.session.questionElapsed[qid] || 0)));
    } else {
      row.append(...stateCell(qid));
    }
    row.onclick = () => tapQuestionRow(qid);
    list.append(row);
  }
  panel.append(list);
}

function renderRecordInputPanel(panel) {
  const name = qLabel(state.session.currentQuestionId);
  panel.append(el('div', 'panel-head', `${name} はどうだった？`));
  const list = el('div', 'eval-list');
  for (const ev of EVALUATIONS) {
    const b = el('button', 'eval-btn');
    b.append(el('span', `sym tone-${ev.tone}`, ev.symbol));
    b.append(el('span', 'lbl', ev.label));
    b.onclick = () => recordEvaluation(ev.value);
    list.append(b);
  }
  panel.append(list);
  panel.append(el('div', 'note', '所要時間は自動で記録されます'));
}

function renderChallengePanel(panel) {
  const s = state.session;
  const task = state.tasks.find((t) => t.id === s.currentChallengeId);
  panel.append(el('div', 'panel-head', task?.title ?? 'チャレンジ'));
  const list = el('div', 'list');
  const ids = task ? challengeQuestionIds(task) : [];

  ids.forEach((qid, index) => {
    const row = el('div', 'row');
    row.draggable = true;
    const active = s.currentQuestionId === qid && !!s.currentStartedAt;
    if (active) row.classList.add('active');
    if (isDone(qid)) row.classList.add('done');

    const handle = el('span', 'drag-handle', '≡');
    const main = el('div', 'row-main');
    main.append(el('div', 'row-title', qLabel(qid)));
    row.append(handle, main);
    if (isDone(qid)) {
      row.append(el('span', 'state-pill', '完了'));
      row.append(el('span', 'row-time', fmtMS(s.questionElapsed[qid] || 0)));
    } else {
      row.append(...stateCell(qid));
    }
    row.onclick = () => tapQuestionRow(qid);

    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(index));
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', async (e) => {
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
    list.append(row);
  });

  panel.append(list);
  panel.append(el('div', 'note', '問題をタップして計測を切り替え・ドラッグで並び替え'));
}

function renderHome() {
  renderTimer();
  $('#stat-total').textContent = fmtShort(state.today.seconds);
  $('#stat-count').textContent = String(state.today.count);
  const panel = $('#home-panel');
  panel.innerHTML = '';
  const mode = state.session.mode;
  if (mode === 'idle') renderIdlePanel(panel);
  else if (mode === 'record_input') renderRecordInputPanel(panel);
  else if (mode === 'challenge') renderChallengePanel(panel);
  else renderTaskListPanel(panel);
}

/* ================================================================== */
/* 描画：記録タブ                                                      */
/* ================================================================== */

async function renderRecords() {
  const list = $('#records-list');
  const records = await api.getStudyHistory({
    limit: 300,
    evaluation: state.filters.evaluation || undefined,
    chapter: state.filters.chapter || undefined,
  });
  list.innerHTML = '';
  if (!records.length) {
    list.append(el('div', 'empty', '記録がありません'));
    return;
  }
  let currentDay = null;
  for (const r of records) {
    const day = r.timestamp.slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      list.append(el('div', 'section-head', day.replace(/-/g, '/')));
    }
    const ev = EVAL_MAP[r.evaluation];
    const row = el('button', 'row');
    row.append(el('span', `eval-mark tone-${ev.tone}`, ev.symbol));
    const main = el('div', 'row-main');
    main.append(el('div', 'row-title', qLabel(r.questionId)));
    const qq = q(r.questionId);
    main.append(el('div', 'row-sub', `${fmtTime(r.timestamp)}${qq ? ` ・ ${qq.chapter}` : ''}`));
    row.append(main, el('span', 'row-time', fmtMS(r.durationSeconds)));
    row.onclick = () => showQuestionDetail(r.questionId);
    list.append(row);
  }
}

async function showQuestionDetail(questionId) {
  const detail = await api.getQuestion(questionId);
  if (!detail) return;
  const dlg = $('#dialog-question');
  dlg.innerHTML = '';
  dlg.append(el('div', 'view-title', detail.question.label));
  dlg.append(
    el('div', 'row-sub', `${detail.question.chapter} ・ ${detail.question.section}`)
  );
  dlg.append(
    el('div', 'panel-head',
      `解答回数 ${detail.attempts}回${detail.averageSeconds != null ? ` ・ 平均 ${fmtMS(detail.averageSeconds)}` : ''}`)
  );
  const list = el('div', 'list');
  for (const r of detail.history) {
    const ev = EVAL_MAP[r.evaluation];
    const row = el('div', 'row');
    row.append(el('span', `eval-mark tone-${ev.tone}`, ev.symbol));
    row.append(el('div', 'row-main', r.timestamp.slice(0, 10).replace(/-/g, '/')));
    row.append(el('span', 'row-time', fmtMS(r.durationSeconds)));
    list.append(row);
  }
  dlg.append(list);
  const close = el('button', 'btn', '閉じる');
  close.onclick = () => dlg.close();
  dlg.append(close);
  dlg.showModal();
}

/* ================================================================== */
/* 描画：スケジュールタブ                                              */
/* ================================================================== */

async function renderSchedule() {
  const list = $('#schedule-list');
  list.innerHTML = '';

  const goals = await api.getGoals();
  list.append(el('div', 'section-head', '目標'));
  if (!goals.length) list.append(el('div', 'empty', '目標がありません'));
  for (const g of goals) {
    const row = el('div', 'row');
    const main = el('div', 'row-main');
    main.append(el('div', 'row-title', g.title));
    main.append(el('div', 'row-sub', g.scope || '—'));
    const del = el('button', 'link-btn', '削除');
    del.onclick = async () => {
      await api.deleteGoal(g.id);
      renderSchedule();
    };
    row.append(main, el('span', 'row-time', g.deadline.replace(/-/g, '/')), del);
    list.append(row);
  }

  const dates = [...new Set(state.tasks.map((t) => t.date))];
  const date = dates[0] ?? api.todayKey();
  list.append(el('div', 'section-head', `${date.replace(/-/g, '/')} のタスク`));
  if (!state.tasks.length) list.append(el('div', 'empty', 'タスクがありません'));
  for (const task of state.tasks) {
    const kind = TASK_KINDS[task.kind] ?? TASK_KINDS.new;
    const row = el('div', 'row');
    if (task.completed) row.classList.add('done');
    const main = el('div', 'row-main');
    main.append(
      el('div', 'row-title', task.kind === 'challenge' ? task.title ?? 'チャレンジ' : groupLabel(task.questionIds))
    );
    main.append(el('div', 'row-sub', task.completed ? '完了' : '未完了'));
    row.append(main, el('span', `badge tone-${kind.tone}`, kind.label));
    list.append(row);
  }
}

/* ================================================================== */
/* データ読み込み・全体描画                                            */
/* ================================================================== */

async function loadQuestions() {
  const qs = await api.listQuestions();
  state.questions = new Map(qs.map((x) => [x.id, x]));
  const sel = $('#filter-chapter');
  const chapters = [...new Set(qs.map((x) => x.chapter))];
  sel.innerHTML = '<option value="">すべての章</option>';
  chapters.forEach((c) => sel.append(new Option(c, c)));
  sel.value = state.filters.chapter;
}

async function loadTasks() {
  state.tasks = await api.getTodayTasks();
}

async function refreshToday() {
  state.today = await api.getTodayStats();
}

function render() {
  $('#screen-home').hidden = state.tab !== 'home';
  $('#screen-records').hidden = state.tab !== 'records';
  $('#screen-schedule').hidden = state.tab !== 'schedule';
  document.querySelectorAll('.tabbar button').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.tab === state.tab))
  );
  if (state.tab === 'home') renderHome();
  else if (state.tab === 'records') renderRecords();
  else renderSchedule();
}

/* ================================================================== */
/* 起動                                                                */
/* ================================================================== */

function bindChrome() {
  document.querySelectorAll('.tabbar button').forEach((b) => {
    b.onclick = () => {
      state.tab = b.dataset.tab;
      render();
    };
  });

  const evalSel = $('#filter-eval');
  EVALUATIONS.forEach((e) => evalSel.append(new Option(`${e.symbol} ${e.label}`, e.value)));
  evalSel.onchange = () => {
    state.filters.evaluation = evalSel.value;
    renderRecords();
  };
  $('#filter-chapter').onchange = (e) => {
    state.filters.chapter = e.target.value;
    renderRecords();
  };

  const form = $('#goal-form');
  $('#btn-add-goal').onclick = () => {
    form.hidden = !form.hidden;
  };
  $('#goal-cancel').onclick = () => {
    form.hidden = true;
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    await api.addGoal({
      title: $('#goal-title').value.trim(),
      deadline: $('#goal-deadline').value,
      scope: $('#goal-scope').value.trim(),
    });
    form.reset();
    form.hidden = true;
    renderSchedule();
  };

  const importDlg = $('#dialog-import');
  $('#btn-import').onclick = () => importDlg.showModal();
  $('#import-run').onclick = async () => {
    try {
      const parsed = JSON.parse($('#import-text').value);
      const n = await api.importQuestions(parsed);
      await loadQuestions();
      importDlg.close();
      alert(`${n}問を取り込みました`);
      render();
    } catch (err) {
      alert(`読み込めませんでした: ${err.message}`);
    }
  };

  // タブ復帰時に絶対時刻から再計算する
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });
}

async function boot() {
  await seedIfEmpty();
  await loadQuestions();
  await loadTasks();
  await refreshToday();
  state.session = await api.getSessionState();
  bindChrome();
  render();
  setInterval(tick, 250);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
