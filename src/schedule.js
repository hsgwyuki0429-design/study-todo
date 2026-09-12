// スケジュールタブ。上半分＝カレンダー、下半分＝その期間に終わらせるべきことの進捗バー。

import * as api from './api.js';
import { EVAL_MAP, todayKey } from './api.js';
import { state, q, qLabel, render } from './state.js';
import { el, fmtDate, row, segmented, emptyState } from './ui.js';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

/* ------------------------------------------------------------------ */
/* 日付ユーティリティ                                                  */
/* ------------------------------------------------------------------ */

const parse = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const key = (date) => todayKey(date);
const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
const startOfWeek = (date) => addDays(date, -date.getDay());
const startOfMonth = (date) => new Date(date.getFullYear(), date.getMonth(), 1);
const endOfMonth = (date) => new Date(date.getFullYear(), date.getMonth() + 1, 0);

function periodRange() {
  const anchor = parse(state.schedule.anchor);
  if (state.schedule.unit === 'week') {
    const from = startOfWeek(anchor);
    return { from: key(from), to: key(addDays(from, 6)) };
  }
  if (state.schedule.unit === 'year') {
    return { from: `${anchor.getFullYear()}-01-01`, to: `${anchor.getFullYear()}-12-31` };
  }
  return { from: key(startOfMonth(anchor)), to: key(endOfMonth(anchor)) };
}

function periodLabel() {
  const anchor = parse(state.schedule.anchor);
  if (state.schedule.unit === 'week') {
    const from = startOfWeek(anchor);
    const to = addDays(from, 6);
    return `${from.getMonth() + 1}/${from.getDate()} 〜 ${to.getMonth() + 1}/${to.getDate()}`;
  }
  if (state.schedule.unit === 'year') return `${anchor.getFullYear()}年`;
  return `${anchor.getFullYear()}年 ${anchor.getMonth() + 1}月`;
}

function shiftPeriod(direction) {
  const anchor = parse(state.schedule.anchor);
  const unit = state.schedule.unit;
  const next =
    unit === 'week'
      ? addDays(anchor, 7 * direction)
      : unit === 'year'
        ? new Date(anchor.getFullYear() + direction, anchor.getMonth(), 1)
        : new Date(anchor.getFullYear(), anchor.getMonth() + direction, 1);
  state.schedule.anchor = key(next);
  state.schedule.selectedDate = null;
  render();
}

/* ------------------------------------------------------------------ */
/* 達成率                                                              */
/* ------------------------------------------------------------------ */

/** 日付 -> { total, done, rate }。タスクが無い日は null を返す。 */
function buildRates(tasks, recorded) {
  const byDate = {};
  for (const task of tasks) {
    const bucket = (byDate[task.date] ??= { total: 0, done: 0 });
    const doneSet = recorded[task.date] ?? new Set();
    for (const qid of task.questionIds) {
      bucket.total += 1;
      if (doneSet.has(qid)) bucket.done += 1;
    }
  }
  Object.values(byDate).forEach((b) => {
    b.rate = b.total ? b.done / b.total : 0;
  });
  return byDate;
}

const rateTone = (rate) => (rate >= 0.8 ? 'success' : rate >= 0.4 ? 'warning' : 'danger');

// 塗り型の色相。設定のカラーバリエーションで決まり方が変わる。
function dayHue(dateKey) {
  const d = parse(dateKey);
  switch (state.settings.fillVariation) {
    case 'month':
      return (d.getMonth() * 30 + 200) % 360;
    case 'week': {
      const week = Math.floor((d - new Date(d.getFullYear(), 0, 1)) / (7 * 86400000));
      return (week * 14 + 200) % 360;
    }
    default: {
      // 黄金角ずつ回すと、連続する日でも色相がよく散る
      const dayIndex = Math.floor(d.getTime() / 86400000);
      return Math.round(((dayIndex * 137.508) % 360 + 360) % 360);
    }
  }
}

/** 日付マス（リング型 / 塗り型）。 */
function dayCell(dateKey, label, info, { muted = false } = {}) {
  const today = todayKey();
  const isToday = dateKey === today;
  const isFuture = dateKey > today;
  const cell = el('button', 'cal-cell');
  if (muted) cell.classList.add('muted');
  if (isToday) cell.classList.add('today');
  if (state.schedule.selectedDate === dateKey) cell.classList.add('selected');

  if (state.settings.calendarStyle === 'fill') {
    if (info && !isFuture) {
      const alpha = (0.15 + 0.6 * info.rate).toFixed(2);
      cell.style.background = `hsl(${dayHue(dateKey)} 60% 50% / ${alpha})`;
    } else if (info) {
      cell.classList.add('planned');
    }
    cell.append(el('span', 'cal-num', label));
  } else {
    if (info) {
      const rate = isFuture ? 0 : info.rate;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 40 40');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svg.setAttribute('class', `ring rtone-${isFuture ? 'idle' : rateTone(rate)}`);
      const circle = (cls, dash) => {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('cx', '20');
        c.setAttribute('cy', '20');
        c.setAttribute('r', '15.9155');
        c.setAttribute('class', cls);
        if (dash) c.setAttribute('stroke-dasharray', dash);
        return c;
      };
      const track = circle('ring-track');
      // 過去の0%は未来（手つかず）と見分けがつくよう、枠線自体に色を残す
      if (!isFuture && !isToday && rate === 0) track.classList.add('ring-track-miss');
      svg.append(track);
      if (!isFuture && rate > 0) svg.append(circle('ring-value', `${(rate * 100).toFixed(1)} 100`));
      cell.append(svg);
    }
    cell.append(el('span', 'cal-num', label));
  }

  cell.onclick = () => {
    state.schedule.selectedDate = state.schedule.selectedDate === dateKey ? null : dateKey;
    render();
  };
  return cell;
}

/* ------------------------------------------------------------------ */
/* カレンダー本体                                                      */
/* ------------------------------------------------------------------ */

function monthGrid(rates) {
  const anchor = parse(state.schedule.anchor);
  const grid = el('div', 'cal-grid');
  WEEKDAYS.forEach((w) => grid.append(el('div', 'cal-weekday', w)));
  const first = startOfMonth(anchor);
  const start = startOfWeek(first);
  const last = endOfMonth(anchor);
  for (let d = start; d <= last || d.getDay() !== 0; d = addDays(d, 1)) {
    const k = key(d);
    grid.append(dayCell(k, String(d.getDate()), rates[k], { muted: d.getMonth() !== anchor.getMonth() }));
  }
  return grid;
}

function weekGrid(rates) {
  const start = startOfWeek(parse(state.schedule.anchor));
  const grid = el('div', 'cal-grid week');
  WEEKDAYS.forEach((w) => grid.append(el('div', 'cal-weekday', w)));
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i);
    const k = key(d);
    grid.append(dayCell(k, String(d.getDate()), rates[k]));
  }
  return grid;
}

function yearGrid(rates) {
  const year = parse(state.schedule.anchor).getFullYear();
  const grid = el('div', 'cal-grid year');
  for (let m = 0; m < 12; m++) {
    const prefix = `${year}-${String(m + 1).padStart(2, '0')}`;
    const days = Object.entries(rates).filter(([k]) => k.startsWith(prefix));
    const total = days.reduce((n, [, v]) => n + v.total, 0);
    const done = days.reduce((n, [, v]) => n + v.done, 0);
    const info = total ? { total, done, rate: done / total } : null;
    const cell = dayCell(`${prefix}-01`, MONTHS[m], info);
    cell.onclick = () => {
      state.schedule.anchor = `${prefix}-01`;
      state.schedule.unit = 'month';
      state.schedule.selectedDate = null;
      render();
    };
    grid.append(cell);
  }
  return grid;
}

/* ------------------------------------------------------------------ */
/* 下半分：進捗バー                                                    */
/* ------------------------------------------------------------------ */

/** 問題を1目盛りとするバー。目盛りの色は最新の評価で決まる。 */
function progressBar(questionIds, latest) {
  const bar = el('div', 'bar');
  for (const qid of questionIds) {
    const ev = latest[qid] ? EVAL_MAP[latest[qid]] : null;
    const seg = el('i', `seg${ev ? ` tone-${ev.tone}` : ''}`);
    seg.title = `${qLabel(qid)}${ev ? ` ${ev.symbol}` : ' 未着手'}`;
    bar.append(seg);
  }
  return bar;
}

function barItem(dateText, title, questionIds, latest) {
  const item = el('div', 'bar-item');
  const head = el('div', 'bar-head');
  if (dateText) head.append(el('span', 'bar-date', dateText));
  head.append(el('span', 'bar-title', title));
  const done = questionIds.filter((id) => latest[id]).length;
  head.append(el('span', 'bar-count', `${done}/${questionIds.length}`));
  item.append(head, progressBar(questionIds, latest));
  return item;
}

// 連続する番号は「30〜38」のようにまとめ、飛んでいる箇所だけ区切る
function compressRuns(nums) {
  const parts = [];
  let start = nums[0];
  let prev = nums[0];
  for (let i = 1; i <= nums.length; i++) {
    const n = nums[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}〜${prev}`);
    start = prev = n;
  }
  return parts;
}

function rangeLabel(questionIds) {
  const qs = questionIds.map(q).filter(Boolean);
  if (!qs.length) return `${questionIds.length}問`;
  if (qs.length === 1) return qs[0].label;
  const nums = [...new Set(qs.map((x) => x.number))].sort((a, b) => a - b);
  const types = new Set(qs.map((x) => x.type));
  // 例題 / 基本例題 が混ざる場合は共通する「例題」でまとめる
  const prefix =
    types.size === 1 ? [...types][0] : qs.every((x) => x.type.endsWith('例題')) ? '例題' : '';
  const list = compressRuns(nums).join('、');
  return prefix ? `${prefix} ${list}` : list;
}

function uniqueIds(taskList) {
  return [...new Set(taskList.flatMap((t) => t.questionIds))];
}

function progressList(tasks, latest) {
  const list = el('div', 'list');
  if (!tasks.length) {
    list.append(emptyState('この期間のタスクはありません'));
    return list;
  }

  if (state.schedule.unit === 'year') {
    // 年表示では月ごとに1本のバーへまとめる
    const byMonth = {};
    tasks.forEach((t) => ((byMonth[t.date.slice(0, 7)] ??= []).push(t)));
    for (const [month, monthTasks] of Object.entries(byMonth).sort()) {
      const ids = monthTasks.flatMap((t) => t.questionIds);
      list.append(barItem(`${Number(month.slice(5))}月`, rangeLabel(ids), ids, latest));
    }
    return list;
  }

  // 週/月表示では、例題とチャレンジをそれぞれ1本のバーにまとめる
  const sorted = [...tasks].sort((a, b) => a.date.localeCompare(b.date));
  const plainTasks = sorted.filter((t) => t.kind !== 'challenge');
  const challengeTasks = sorted.filter((t) => t.kind === 'challenge');

  if (plainTasks.length) {
    const ids = uniqueIds(plainTasks);
    list.append(barItem(null, rangeLabel(ids), ids, latest));
  }
  if (challengeTasks.length) {
    const titles = new Set(challengeTasks.map((t) => t.title ?? 'チャレンジ'));
    const title = titles.size === 1 ? [...titles][0] : 'チャレンジ';
    const ids = uniqueIds(challengeTasks);
    list.append(barItem(null, title, ids, latest));
  }
  return list;
}

/* ------------------------------------------------------------------ */
/* 下半分：日付をタップしたときの表示                                  */
/* ------------------------------------------------------------------ */

function dayDetail(dateKey, tasks, latest, recorded) {
  const list = el('div', 'list');
  const past = dateKey < todayKey();
  list.append(
    row({
      title: '← 期間の一覧に戻る',
      onClick: () => {
        state.schedule.selectedDate = null;
        render();
      },
      classes: ['row-back'],
    })
  );
  list.append(el('div', 'section-head', `${fmtDate(dateKey)} のTODO`));

  const dayTasks = tasks.filter((t) => t.date === dateKey);
  if (!dayTasks.length) {
    list.append(emptyState('この日のタスクはありません'));
    return list;
  }

  const doneToday = recorded[dateKey] ?? new Set();
  for (const task of dayTasks) {
    if (task.kind === 'challenge') list.append(el('div', 'section-head', task.title ?? 'チャレンジ'));
    for (const qid of task.questionIds) {
      const finished = doneToday.has(qid);
      const ev = finished && latest[qid] ? EVAL_MAP[latest[qid]] : null;
      const node = row({
        title: qLabel(qid),
        sub: q(qid) ? `${q(qid).chapter} ・ ${q(qid).section}` : null,
        right: el('span', 'state-pill', finished ? '完了' : past ? '未達成' : '未着手'),
      });
      node.prepend(ev ? el('span', `eval-mark tone-${ev.tone}`, ev.symbol) : el('span', 'eval-mark', '・'));
      list.append(node);
    }
  }
  return list;
}

/* ------------------------------------------------------------------ */

export async function renderSchedule(screen) {
  screen.innerHTML = '';

  const head = el('div', 'view-head');
  head.append(el('div', 'view-title', 'スケジュール'));
  screen.append(head);

  if (state.schedule.selectedDate) {
    const { from, to } = periodRange();
    const [tasks, recorded, latest] = await Promise.all([
      api.getTasksInRange(from, to),
      api.getRecordedByDate(),
      api.getLatestEvaluations(),
    ]);
    const bottom = el('div', 'panel');
    bottom.append(dayDetail(state.schedule.selectedDate, tasks, latest, recorded));
    screen.append(bottom);
    return;
  }

  const { from, to } = periodRange();
  const [tasks, recorded, latest] = await Promise.all([
    api.getTasksInRange(from, to),
    api.getRecordedByDate(),
    api.getLatestEvaluations(),
  ]);
  const rates = buildRates(tasks, recorded);

  screen.append(
    segmented([['week', '週'], ['month', '月'], ['year', '年']], state.schedule.unit, (v) => {
      state.schedule.unit = v;
      state.schedule.selectedDate = null;
      render();
    })
  );

  const nav = el('div', 'cal-nav');
  const prev = el('button', 'cal-arrow', '◀');
  prev.onclick = () => shiftPeriod(-1);
  const next = el('button', 'cal-arrow', '▶');
  next.onclick = () => shiftPeriod(1);
  const today = el('button', 'link-btn', '今日');
  today.onclick = () => {
    state.schedule.anchor = todayKey();
    state.schedule.selectedDate = null;
    render();
  };
  nav.append(prev, el('div', 'cal-period', periodLabel()), next, today);
  screen.append(nav);

  const cal = el('div', 'cal-wrap');
  cal.append(
    state.schedule.unit === 'week' ? weekGrid(rates)
      : state.schedule.unit === 'year' ? yearGrid(rates)
        : monthGrid(rates)
  );
  screen.append(cal);

  const bottom = el('div', 'panel');
  bottom.append(progressList(tasks, latest));
  screen.append(bottom);
}
