// スケジュールタブ。
//
// 1週間（月〜日）を1ページにして、左右のスワイプで週を送る。左が過去、右が先の予定。
// ページの中は7日を横に並べ、マスは上へ積み上げ、日付は下に置く。タブを押したときは、今日を含む週を出す。
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
import { buildDay, dateRange } from './day-model.js';
import { shiftDateKey } from './datetime.js';
import { state, q, qLabel, render } from './state.js';
import { el } from './ui.js';
import { attemptSquare, helpPanel, plannedSquare } from './squares.js';
import { renderDayDetail } from './day-detail.js';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

/** 最初に出す週の数（今日の前後）と、端に近づいたときに足す週の数。nearEdge は画面何枚ぶん手前で足すか。 */
const WINDOW = Object.freeze({ before: 8, after: 8, step: 4, nearEdge: 1.5 });

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
    const list = listEl();
    state.schedule.scrollTop = list ? list.scrollLeft : 0;
    state.schedule.selectedDate = dateKey;
    render();
  };

  // 上に予定・実績のマスが積み重なり、いちばん下に日付が横並びで揃う。
  const stacks = el('div', 'day-stacks');
  for (const rowKey of ['example', 'exercise']) {
    const stack = el('div', `day-stack stack-${rowKey}`);
    stack.append(...squaresFor(day, rowKey));
    stacks.append(stack);
  }
  node.append(stacks);

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

  node.setAttribute('aria-label', `${shortDate(dateKey)}（${WEEKDAYS[weekday]}）`
    + ` 例題 実績${day.attempts.example.length}・予定${day.planned.example.length}`
    + ` エクササイズ 実績${day.attempts.exercise.length}・予定${day.planned.exercise.length}`);
  return node;
}

/** 週の見出し（例: 2026年10月 19日〜25日）。 */
function weekHeading(monday) {
  const sunday = shiftDateKey(monday, 6);
  const heading = el('div', 'month-heading');
  const month = MONTHS[Number(monday.slice(5, 7)) - 1];
  const endText = sunday.slice(5, 7) === monday.slice(5, 7)
    ? `${Number(sunday.slice(8, 10))}日`
    : `${MONTHS[Number(sunday.slice(5, 7)) - 1]}${Number(sunday.slice(8, 10))}日`;
  heading.textContent = `${monday.slice(0, 4)}年${month} ${Number(monday.slice(8, 10))}日〜${endText}`;
  return heading;
}

/** その日を含む週の月曜。 */
const mondayOf = (dateKey) => shiftDateKey(dateKey, -((weekdayOf(dateKey) + 6) % 7));

/** 期間ぶんの週ページを組み立てる。from は月曜、to は日曜にそろえて渡す。 */
async function buildRows(from, to, { today, questionType, planner }) {
  const [tasksByDate, attemptsByDate] = await Promise.all([
    api.getTasksByDate(from, to),
    api.getAttemptsByDate(from, to),
  ]);
  const pages = [];
  let page = null;
  for (const dateKey of dateRange(from, to)) {
    if (!page || weekdayOf(dateKey) === 1) {
      page = el('div', 'week-page');
      page.dataset.week = dateKey;
      page.append(weekHeading(dateKey));
      pages.push(page);
    }
    page.append(dayRow(dateKey, {
      planner,
      tasks: tasksByDate[dateKey] ?? [],
      records: attemptsByDate[dateKey] ?? [],
      today,
      questionType,
    }));
  }
  return pages;
}

/* ------------------------------------------------------------------ */
/* 横スワイプ（端の週に近づいたら週を足す）                            */
/* ------------------------------------------------------------------ */

let context = null;     // いま描いてある範囲と、行を作るための道具
let extending = false;

const listEl = () => screenEl()?.querySelector('.day-list');

async function extend(direction) {
  if (extending || !context) return;
  const list = listEl();
  if (!list) return;
  extending = true;
  try {
    const days = WINDOW.step * 7;
    const from = direction < 0 ? shiftDateKey(context.from, -days) : shiftDateKey(context.to, 1);
    const to = direction < 0 ? shiftDateKey(context.from, -1) : shiftDateKey(context.to, days);
    const nodes = await buildRows(from, to, context);
    if (direction < 0) {
      const before = list.scrollWidth;
      list.prepend(...nodes);
      // 左へ足したぶんだけ、見えている位置がずれないように戻す。
      list.scrollLeft += list.scrollWidth - before;
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
  const list = event.currentTarget;
  if (state.tab !== 'schedule' || state.schedule.selectedDate) return;
  state.schedule.scrollTop = list.scrollLeft;
  const edge = list.clientWidth * WINDOW.nearEdge;
  if (list.scrollLeft < edge) extend(-1);
  else if (list.scrollWidth - list.scrollLeft - list.clientWidth < edge) extend(1);
}

/** 今日を含む週のページを表示する。 */
function centerToday() {
  const list = listEl();
  const page = list?.querySelector('.day-row.is-today')?.closest('.week-page');
  if (!list || !page) return false;
  list.scrollLeft = page.offsetLeft;
  state.schedule.scrollTop = list.scrollLeft;
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
  const thisMonday = mondayOf(today);
  const from = state.schedule.from ?? shiftDateKey(thisMonday, -WINDOW.before * 7);
  const to = state.schedule.to ?? shiftDateKey(thisMonday, WINDOW.after * 7 + 6);
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
  list.addEventListener('scroll', onScroll, { passive: true });
  requestAnimationFrame(() => {
    if (!list.isConnected) return;
    if (centering) centerToday();
    else if (state.schedule.restoreScroll != null) {
      list.scrollLeft = state.schedule.restoreScroll;
      state.schedule.restoreScroll = null;
    }
  });
}
