// スケジュールタブ。
//
// 日付がずっと続く1本の並びで、上へスクロールすれば過去、下へ行けば先の予定が出てくる。
// タブを押したときは、今日がちょうど画面の真ん中に来るようにする。
//
// 1日は「例題」と「エクササイズ」の2段で、中身は正方形のマスだけで表す。
//
//   過ぎた日 … その日に実際に取り組んだ記録（予定に無かったものも出す）
//   今日     … 今日の実績 ＋ まだ残っている予定
//   これから … その日にやる予定
//
// マスには文字を入れない。色の意味は右上の ⓘ と、設定タブのいちばん下のヘルプで見られる。
// 数や中身を詳しく見たいときは、日付を押して詳細へ移る。

import * as api from './api.js';
import { todayKey } from './api.js';
import { ROW_LABELS, buildDay, dateRange } from './day-model.js';
import { shiftDateKey } from './datetime.js';
import { state, q, qLabel, render } from './state.js';
import { el } from './ui.js';
import { attemptSquare, helpPanel, plannedSquare, squareRow } from './squares.js';
import { renderDayDetail } from './day-detail.js';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

/** 最初に出す範囲と、端に近づいたときに足す日数。 */
const WINDOW = Object.freeze({ before: 45, after: 60, step: 30, nearEdge: 600 });

const shortDate = (dateKey) => `${Number(dateKey.slice(5, 7))}/${Number(dateKey.slice(8, 10))}`;
const weekdayOf = (dateKey) => new Date(Date.parse(`${dateKey}T00:00:00Z`)).getUTCDay();

/** 実際に画面へ入っている要素（組み立て中の入れ物ではないほう）。 */
const screenEl = () => document.querySelector('#screen-schedule');

/* ------------------------------------------------------------------ */
/* 1日ぶんの行                                                         */
/* ------------------------------------------------------------------ */

function squaresFor(day, rowKey) {
  return [
    ...day.attempts[rowKey].map((record) => attemptSquare(record)),
    ...day.planned[rowKey].map(({ item }) => plannedSquare({
      label: qLabel(item.questionId),
      carriedOver: Boolean(item.originalDate && item.originalDate !== day.date),
    })),
  ];
}

/** 「45/60分」のような、その日の時間のやりくり。今日とこれからの日だけ。 */
function timeBadge(planner, dateKey, tasks, records) {
  const capacity = planner.capacity(dateKey);
  const planned = planner.plannedMinutes(dateKey, tasks, records);
  if (!planned && capacity.available === null) return null;
  const badge = el('span', 'day-minutes');
  if (capacity.available === null) {
    badge.textContent = `${planned}分`;
    badge.title = 'この日の使える時間は未設定です';
    return badge;
  }
  if (planned > capacity.available) badge.classList.add('short');
  badge.textContent = `${planned}/${capacity.available}分`;
  badge.title = `予定 ${planned}分 ／ 使える ${capacity.available}分`;
  return badge;
}

function dayRow(dateKey, { planner, tasks, records, today, questionType }) {
  const day = buildDay(dateKey, { tasks, records, today, questionType });
  const weekday = weekdayOf(dateKey);
  const node = el('button', 'day-row');
  node.dataset.date = dateKey;
  if (day.isToday) node.classList.add('is-today');
  if (day.isPast) node.classList.add('is-past');
  // 週の区切り（月曜）に薄い線を入れて、続きの中でも週が読み取れるようにする。
  if (weekday === 1) node.classList.add('week-start');
  node.onclick = () => {
    const screen = screenEl();
    state.schedule.scrollTop = screen ? screen.scrollTop : 0;
    state.schedule.selectedDate = dateKey;
    render();
  };

  const column = el('div', 'day-col');
  const label = el('div', 'day-label');
  label.append(el('span', 'day-date', shortDate(dateKey)));
  label.append(el('span', `day-weekday${weekday === 0 ? ' sun' : weekday === 6 ? ' sat' : ''}`, WEEKDAYS[weekday]));
  column.append(label);
  if (!day.isPast) {
    const badge = timeBadge(planner, dateKey, tasks, records);
    if (badge) column.append(badge);
  }
  node.append(column);

  const bars = el('div', 'day-bars');
  for (const rowKey of ['example', 'exercise']) {
    bars.append(squareRow(squaresFor(day, rowKey), { label: ROW_LABELS[rowKey] }));
  }
  node.append(bars);

  node.setAttribute('aria-label', `${shortDate(dateKey)}（${WEEKDAYS[weekday]}）`
    + ` 例題 実績${day.attempts.example.length}・予定${day.planned.example.length}`
    + ` エクササイズ 実績${day.attempts.exercise.length}・予定${day.planned.exercise.length}`);
  return node;
}

/** 月が変わるところに入れる見出し。長く続く並びの中で、いまどのあたりかが分かる。 */
function monthHeading(dateKey) {
  const heading = el('div', 'month-heading');
  heading.textContent = `${dateKey.slice(0, 4)}年 ${MONTHS[Number(dateKey.slice(5, 7)) - 1]}`;
  return heading;
}

/** 期間ぶんの行（月の見出しつき）を組み立てる。 */
async function buildRows(from, to, { today, questionType, planner }) {
  const [tasksByDate, attemptsByDate] = await Promise.all([
    api.getTasksByDate(from, to),
    api.getAttemptsByDate(from, to),
  ]);
  const nodes = [];
  let month = null;
  for (const dateKey of dateRange(from, to)) {
    const nextMonth = dateKey.slice(0, 7);
    if (nextMonth !== month) {
      month = nextMonth;
      nodes.push(monthHeading(dateKey));
    }
    nodes.push(dayRow(dateKey, {
      planner,
      tasks: tasksByDate[dateKey] ?? [],
      records: attemptsByDate[dateKey] ?? [],
      today,
      questionType,
    }));
  }
  return nodes;
}

/* ------------------------------------------------------------------ */
/* スクロール（端に近づいたら日を足す）                                */
/* ------------------------------------------------------------------ */

let context = null;     // いま描いてある範囲と、行を作るための道具
let extending = false;

async function extend(direction) {
  if (extending || !context) return;
  const screen = screenEl();
  const list = screen?.querySelector('.day-list');
  if (!list) return;
  extending = true;
  try {
    const from = direction < 0 ? shiftDateKey(context.from, -WINDOW.step) : shiftDateKey(context.to, 1);
    const to = direction < 0 ? shiftDateKey(context.from, -1) : shiftDateKey(context.to, WINDOW.step);
    const nodes = await buildRows(from, to, context);
    if (direction < 0) {
      const before = list.scrollHeight;
      list.prepend(...nodes);
      // 上へ足したぶんだけ、見えている位置がずれないように戻す。
      screen.scrollTop += list.scrollHeight - before;
      context.from = from;
    } else {
      list.append(...nodes);
      context.to = to;
    }
    state.schedule.from = context.from;
    state.schedule.to = context.to;
  } finally {
    extending = false;
  }
}

function onScroll(event) {
  const screen = event.currentTarget;
  if (state.tab !== 'schedule' || state.schedule.selectedDate) return;
  state.schedule.scrollTop = screen.scrollTop;
  if (screen.scrollTop < WINDOW.nearEdge) extend(-1);
  else if (screen.scrollHeight - screen.scrollTop - screen.clientHeight < WINDOW.nearEdge) extend(1);
}

function bindScroll() {
  const screen = screenEl();
  if (!screen || screen.dataset.scrollBound) return;
  screen.addEventListener('scroll', onScroll, { passive: true });
  screen.dataset.scrollBound = 'yes';
}

/** 今日の行が画面のまん中に来るようにする。 */
function centerToday() {
  const screen = screenEl();
  const row = screen?.querySelector('.day-row.is-today');
  if (!screen || !row) return false;
  screen.scrollTop = Math.max(0, row.offsetTop - (screen.clientHeight - row.offsetHeight) / 2);
  state.schedule.scrollTop = screen.scrollTop;
  return true;
}

/* ------------------------------------------------------------------ */

export async function renderSchedule(holder) {
  // 日付を押したときは、別の画面として詳細を出す。
  // 戻ったときに同じ位置へ帰れるよう、スクロール位置はそのまま持っておく。
  if (state.schedule.selectedDate) {
    await renderDayDetail(holder, state.schedule.selectedDate);
    return;
  }

  const today = todayKey();
  const head = el('div', 'view-head view-head-row');
  head.append(el('div', 'view-title', 'スケジュール'));
  const actions = el('div', 'head-actions');
  const jump = el('button', 'link-btn', '今日');
  jump.onclick = () => {
    if (!centerToday()) {
      // 今日が読み込み範囲から外れていたら、読み直して真ん中に置く。
      state.schedule.from = null;
      state.schedule.centerToday = true;
      render();
    }
  };
  const help = el('button', 'icon-btn', 'ⓘ');
  help.setAttribute('aria-label', 'マスの見方');
  help.title = 'マスの見方';
  help.onclick = () => {
    state.schedule.helpOpen = !state.schedule.helpOpen;
    render();
  };
  actions.append(jump, help);
  head.append(actions);
  holder.append(head);

  if (state.schedule.helpOpen) holder.append(helpPanel());

  // 出す範囲。初めて開いたときと「今日」を押したときは、今日を中心に取り直す。
  const from = state.schedule.from ?? shiftDateKey(today, -WINDOW.before);
  const to = state.schedule.to ?? shiftDateKey(today, WINDOW.after);
  const planner = await api.createDayPlanner();
  context = { from, to, today, planner, questionType: (questionId) => q(questionId)?.type ?? null };

  const list = el('div', 'day-list');
  list.append(...await buildRows(from, to, context));
  holder.append(list);

  const centering = state.schedule.centerToday || state.schedule.from === null;
  state.schedule.from = from;
  state.schedule.to = to;
  state.schedule.centerToday = false;

  // 画面へ入ったあとでないと位置を決められないので、次の描画の機会に行う。
  requestAnimationFrame(() => {
    bindScroll();
    const screen = screenEl();
    if (!screen) return;
    if (centering) centerToday();
    else if (state.schedule.restoreScroll != null) {
      screen.scrollTop = state.schedule.restoreScroll;
      state.schedule.restoreScroll = null;
    }
  });
}
