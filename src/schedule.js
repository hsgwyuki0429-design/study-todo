// スケジュールタブ。
//
// 主役は「週間カレンダー」。月曜から日曜までの7日ぶんのカードを縦に並べ、
// それぞれのカードに、その日の「例題」と「チャレンジ」を正方形のマスで出す。
//
// マスの意味は日付で変わる。
//
//   過ぎた日 … その日に実際に取り組んだ記録（予定に無かったものも出す）
//   今日     … 今日の実績 ＋ まだ残っている予定
//   これから … その日にやる予定
//
// 数字や長い題名を並べず、マスの数で「どれだけやったか・やる予定か」が分かるようにする。
// マスが多い日はカードが縦に伸びる（件数を黙って省かない）。

import * as api from './api.js';
import { todayKey } from './api.js';
import { buildDay } from './day-model.js';
import { startOfWeekKey } from './datetime.js';
import { state, q, qLabel, render } from './state.js';
import { el, fmtDate, fmtMS, fmtTime, row, emptyState } from './ui.js';
import {
  attemptSquare,
  challengeSquare,
  legend,
  plannedChallengeSquare,
  plannedSquare,
  squareRow,
} from './squares.js';
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
/* その日の中身を組み立てる                                            */
/* ------------------------------------------------------------------ */

function daySection(title, count, nodes, emptyText) {
  const section = el('div', 'day-section');
  const head = el('div', 'day-section-head');
  head.append(el('span', null, title), el('span', null, count));
  section.append(head);
  if (nodes.length) section.append(squareRow(nodes));
  else section.append(el('div', 'day-empty', emptyText));
  return section;
}

function dayCard(day, onOpen) {
  const date = parse(day.date);
  const card = el('button', 'day-card');
  if (day.isToday) card.classList.add('is-today');
  if (day.isPast) card.classList.add('is-past');
  card.onclick = onOpen;

  const head = el('div', 'day-head');
  head.append(el('span', 'day-date', shortDate(day.date)));
  const weekday = el('span', `day-weekday${date.getDay() === 0 ? ' sun' : date.getDay() === 6 ? ' sat' : ''}`,
    `(${WEEKDAYS[date.getDay()]})`);
  head.append(weekday);
  if (day.isToday) head.append(el('span', 'day-today-pill', '今日'));
  head.append(el('span', 'day-open', '詳細 ›'));
  card.append(head);

  // 何もない日は、2段を並べずに1行で済ませる（1週間ぶんが読みやすいように）。
  const nothing = !day.attempts.length && !day.plannedItems.length
    && !day.challenges.length && !day.plannedChallenges.length;
  if (nothing) {
    card.append(el('div', 'day-empty', day.isFuture ? '予定なし' : day.isToday ? '記録も予定もなし' : '記録なし'));
    return card;
  }

  // 例題の段（EXERCISES など、チャレンジ以外の取り組みはすべてここに入る）。
  const questionSquares = [
    ...day.attempts.map((record) => attemptSquare(record, { label: qLabel(record.questionId) })),
    ...day.plannedItems.map(({ item }) => plannedSquare({
      label: qLabel(item.questionId),
      carriedOver: Boolean(item.originalDate && item.originalDate !== day.date),
    })),
  ];
  const doneCount = day.attempts.length;
  const planCount = day.plannedItems.length;
  card.append(daySection(
    '例題',
    day.isFuture ? `予定 ${planCount}` : planCount ? `実施 ${doneCount} ・ 予定 ${planCount}` : `実施 ${doneCount}`,
    questionSquares,
    day.isFuture ? '予定なし' : day.isToday ? 'なし' : '記録なし',
  ));

  // チャレンジの段。1回で1マス。合計の問題数も添える。
  const challengeSquares = [
    ...day.challenges.map((result) => challengeSquare(result, { title: 'チャレンジ' })),
    ...day.plannedChallenges.map((task) => plannedChallengeSquare(task)),
  ];
  const challengeQuestions = day.challenges.reduce((sum, result) => sum + (result.laps?.length ?? 0), 0)
    + day.plannedChallenges.reduce((sum, task) => sum + (task.questionIds?.length ?? 0), 0);
  card.append(daySection(
    'チャレンジ',
    challengeSquares.length ? `${challengeSquares.length}回 ・ 計${challengeQuestions}問` : '0回',
    challengeSquares,
    day.isFuture ? '予定なし' : day.isToday ? 'なし' : '記録なし',
  ));

  return card;
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

  const head = el('div', 'view-head');
  head.append(el('div', 'view-title', 'スケジュール'));
  screen.append(head);

  const weekStart = state.schedule.weekStart;
  const days = weekDays(weekStart);
  const from = days[0];
  const to = days[6];
  const today = todayKey();

  const [tasksByDate, attemptsByDate, challenges] = await Promise.all([
    api.getTasksByDate(from, to),
    api.getAttemptsByDate(from, to),
    api.getChallengeResults(200),
  ]);
  const challengesWithDate = challenges.map((result) => ({ ...result, date: api.dayOf(result.timestamp) }));

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

  const list = el('div', 'week-list');
  for (const dateKey of days) {
    const day = buildDay(dateKey, {
      tasks: tasksByDate[dateKey] ?? [],
      records: attemptsByDate[dateKey] ?? [],
      challenges: challengesWithDate,
      today,
    });
    list.append(dayCard(day, () => {
      // 戻ったときのために、いまのスクロール位置を覚えておく。
      state.schedule.scrollY = window.scrollY;
      state.schedule.selectedDate = dateKey;
      render();
    }));
  }
  screen.append(list);
  screen.append(legend());

  // 週を移った直後でなければ、元の位置へ戻す。
  if (state.schedule.restoreScroll != null) {
    const y = state.schedule.restoreScroll;
    state.schedule.restoreScroll = null;
    requestAnimationFrame(() => window.scrollTo(0, y));
  }
}

// 記録タブなどから使えるように、日付の道具を出しておく。
export { parse as parseDateKey, shortDate };
