// スケジュールタブ。
//
// 主役は「週間カレンダー」。月曜から日曜までの7日を、1画面に収まる高さで縦に並べる。
// 1日は「例題」と「エクササイズ」の2段で、中身は正方形のマスだけで表す。
//
// マスの意味は日付で変わる。
//
//   過ぎた日 … その日に実際に取り組んだ記録（予定に無かったものも出す）
//   今日     … 今日の実績 ＋ まだ残っている予定
//   これから … その日にやる予定
//
// マスには文字を入れない。色の意味は右上の ℹ️ と、設定タブのいちばん下のヘルプで見られる。
// 数や中身を詳しく見たいときは、日付を押して詳細へ移る。

import * as api from './api.js';
import { todayKey } from './api.js';
import { ROW_LABELS, buildDay } from './day-model.js';
import { startOfWeekKey } from './datetime.js';
import { state, q, qLabel, render } from './state.js';
import { el } from './ui.js';
import { attemptSquare, helpPanel, plannedSquare, squareRow } from './squares.js';
import { renderDayDetail } from './day-detail.js';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/* ------------------------------------------------------------------ */
/* 日付の道具                                                          */
/* ------------------------------------------------------------------ */

const parse = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const key = (date) => todayKey(date);
const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);

export { startOfWeekKey as startOfWeek } from './datetime.js';

export const weekDays = (weekStart) => {
  const start = parse(weekStart);
  return Array.from({ length: 7 }, (_, index) => key(addDays(start, index)));
};

const shortDate = (dateKey) => {
  const date = parse(dateKey);
  return `${date.getMonth() + 1}/${date.getDate()}`;
};

/* ------------------------------------------------------------------ */
/* 1日ぶんの行                                                         */
/* ------------------------------------------------------------------ */

/** その段のマスを作る（実績が先、残りの予定があとに並ぶ）。 */
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
function timeBadge(time) {
  if (!time) return null;
  const badge = el('span', 'day-minutes');
  if (time.available === null) {
    badge.textContent = `${time.plannedMinutes}分`;
    badge.title = '使える時間は未設定です';
    return badge;
  }
  if (time.plannedMinutes > time.available) badge.classList.add('short');
  badge.textContent = `${time.plannedMinutes}/${time.available}分`;
  badge.title = `予定 ${time.plannedMinutes}分 ／ 使える ${time.available}分`;
  return badge;
}

function dayRow(day, onOpen, time) {
  const date = parse(day.date);
  const node = el('button', 'day-row');
  if (day.isToday) node.classList.add('is-today');
  if (day.isPast) node.classList.add('is-past');
  node.onclick = onOpen;

  const column = el('div', 'day-col');
  const label = el('div', 'day-label');
  label.append(el('span', 'day-date', shortDate(day.date)));
  label.append(el('span', `day-weekday${date.getDay() === 0 ? ' sun' : date.getDay() === 6 ? ' sat' : ''}`,
    WEEKDAYS[date.getDay()]));
  column.append(label);
  if (!day.isPast) {
    const badge = timeBadge(time);
    if (badge) column.append(badge);
  }
  node.append(column);

  const bars = el('div', 'day-bars');
  for (const rowKey of ['example', 'exercise']) {
    bars.append(squareRow(squaresFor(day, rowKey), { label: ROW_LABELS[rowKey] }));
  }
  node.append(bars);

  const aria = `${shortDate(day.date)}（${WEEKDAYS[date.getDay()]}）`
    + ` 例題 実績${day.attempts.example.length}・予定${day.planned.example.length}`
    + ` エクササイズ 実績${day.attempts.exercise.length}・予定${day.planned.exercise.length}`;
  node.setAttribute('aria-label', aria);
  return node;
}

/* ------------------------------------------------------------------ */

function shiftWeek(direction) {
  const start = parse(state.schedule.weekStart);
  state.schedule.weekStart = key(addDays(start, 7 * direction));
  render();
}

export async function renderSchedule(screen) {
  screen.innerHTML = '';

  // 日付を押したときは、別の画面として詳細を出す。
  // 戻ったときに同じ週・同じ位置へ帰れるよう、週とスクロール位置はそのまま持っておく。
  if (state.schedule.selectedDate) {
    await renderDayDetail(screen, state.schedule.selectedDate);
    return;
  }

  const head = el('div', 'view-head view-head-row');
  head.append(el('div', 'view-title', 'スケジュール'));
  const help = el('button', 'icon-btn', 'ⓘ');
  help.setAttribute('aria-label', 'マスの見方');
  help.title = 'マスの見方';
  help.onclick = () => {
    state.schedule.helpOpen = !state.schedule.helpOpen;
    render();
  };
  head.append(help);
  screen.append(head);

  const weekStart = state.schedule.weekStart;
  const days = weekDays(weekStart);
  const from = days[0];
  const to = days[6];
  const today = todayKey();

  const [tasksByDate, attemptsByDate] = await Promise.all([
    api.getTasksByDate(from, to),
    api.getAttemptsByDate(from, to),
  ]);
  // 各日の「使える時間」と「予定の見積もり」。過ぎた日には出さないので今日から先だけ。
  const timeByDate = {};
  for (const dateKey of days) {
    if (dateKey < today) continue;
    const info = await api.availabilityForDay(dateKey);
    timeByDate[dateKey] = { available: info.available, plannedMinutes: await api.plannedMinutesFor(dateKey) };
  }

  const nav = el('div', 'week-nav');
  const prev = el('button', 'cal-arrow', '◀');
  prev.setAttribute('aria-label', '前の週');
  prev.onclick = () => shiftWeek(-1);
  const next = el('button', 'cal-arrow', '▶');
  next.setAttribute('aria-label', '次の週');
  next.onclick = () => shiftWeek(1);
  const now = el('button', 'link-btn', '今週');
  now.onclick = () => {
    state.schedule.weekStart = startOfWeekKey(today);
    render();
  };
  nav.append(prev, el('div', 'week-period', `${shortDate(from)} 〜 ${shortDate(to)}`), next, now);
  screen.append(nav);

  if (state.schedule.helpOpen) screen.append(helpPanel());

  // 問題の種類（例題かエクササイズか）は、読み込んである問題マスタから引く。
  const questionType = (questionId) => q(questionId)?.type ?? null;

  const list = el('div', 'week-list');
  for (const dateKey of days) {
    const day = buildDay(dateKey, {
      tasks: tasksByDate[dateKey] ?? [],
      records: attemptsByDate[dateKey] ?? [],
      today,
      questionType,
    });
    list.append(dayRow(day, () => {
      // 戻ったときのために、いまのスクロール位置を覚えておく。
      state.schedule.scrollY = screen.scrollTop;
      state.schedule.selectedDate = dateKey;
      render();
    }, timeByDate[dateKey]));
  }
  screen.append(list);

  // 週を移った直後でなければ、元の位置へ戻す。
  if (state.schedule.restoreScroll != null) {
    const y = state.schedule.restoreScroll;
    state.schedule.restoreScroll = null;
    requestAnimationFrame(() => { screen.scrollTop = y; });
  }
}

// 記録タブなどから使えるように、日付の道具を出しておく。
export { parse as parseDateKey, shortDate };
