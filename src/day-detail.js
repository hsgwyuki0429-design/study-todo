// スケジュールで日付を押したときに出る、その日の詳細。
//
// カレンダーのマスは「どれだけやったか」を見るためのもので、細かい中身は出さない。
// ここでは、その日の「やること」（まだ残っている予定）だけを見せる。
// 済んだ記録の中身は、ホームの「やったこと」や記録タブから見られる。
//
//   ・まだ残っている予定
//   ・過ぎた日にまだ残っている予定は、ここから翌日などへ繰り越せる

import * as api from './api.js';
import { MOVE_REASONS, MOVE_REASON_LABELS, todayKey } from './api.js';
import { itemsOf, splitPlanItems } from './plan-items.js';
import { state, q, qLabel, render, loadTasks } from './state.js';
import { el, fmtDate, row, emptyState } from './ui.js';
import { plannedSquare, squareRow } from './squares.js';
import { syncInBackground } from './cloud-sync.js';

// 繰り越しの理由を選んでいる最中のタスク。
let carryOverFor = null;

function detailRow({ title, sub, right, onClick }) {
  const node = el(onClick ? 'button' : 'div', 'detail-item');
  const main = el('div', 'detail-main');
  main.append(el('div', 'detail-title', title));
  if (sub) main.append(el('div', 'detail-sub', sub));
  node.append(main);
  if (right) {
    const side = el('div', 'detail-right');
    side.append(...(Array.isArray(right) ? right : [right]));
    node.append(side);
  }
  if (onClick) node.onclick = onClick;
  return node;
}

const questionSub = (questionId) => {
  const question = q(questionId);
  if (!question) return '問題マスタにありません';
  return [question.type, question.subject, question.chapter, question.section].filter(Boolean).join(' ・ ');
};

/** 「例題 90〜92」のように、その日の範囲を短く言う。 */
function rangeLabel(questionIds) {
  const questions = questionIds.map(q).filter(Boolean);
  if (!questions.length) return `${questionIds.length}問`;
  const types = [...new Set(questions.map((question) => question.type))];
  const numbers = [...new Set(questions.map((question) => question.number))].sort((a, b) => a - b);
  const head = types.length === 1 ? types[0] : types.join('・');
  const tail = numbers.length === 1 ? `${numbers[0]}` : `${numbers[0]}〜${numbers[numbers.length - 1]}`;
  return `${head} ${tail}`;
}

/* ------------------------------------------------------------------ */
/* 繰り越し                                                            */
/* ------------------------------------------------------------------ */

function carryOverPanel(dateKey, task, pending, rerender) {
  const panel = el('div', 'attempt-detail');
  panel.append(el('div', null, `未実施の${pending.length}件を移します。理由（任意）を選んでください。`));
  const actions = el('div', 'setting-actions');
  const target = dateKey < todayKey() ? todayKey() : api.todayKey(new Date(Date.parse(`${dateKey}T00:00:00`) + 86400000));
  for (const reason of MOVE_REASONS) {
    const button = el('button', 'btn', MOVE_REASON_LABELS[reason]);
    button.onclick = async () => {
      await api.carryOverPlanItems({
        fromDate: dateKey,
        taskId: task.id,
        itemIds: pending.map((item) => item.itemId),
        toDate: target,
        reason,
        kind: dateKey < todayKey() ? 'carry_over' : 'reschedule',
      });
      carryOverFor = null;
      await loadTasks();
      syncInBackground();
      rerender();
    };
    actions.append(button);
  }
  const cancel = el('button', 'link-btn', 'やめる');
  cancel.onclick = () => {
    carryOverFor = null;
    rerender();
  };
  actions.append(cancel);
  panel.append(el('div', null, `移動先: ${fmtDate(target)}`), actions);
  return panel;
}

/* ------------------------------------------------------------------ */

export async function renderDayDetail(screen, dateKey) {
  const today = todayKey();
  const rerender = () => render();

  const [tasks, attemptsByDate, challengeResults] = await Promise.all([
    api.getTasksInRange(dateKey, dateKey),
    api.getAttemptsByDate(dateKey, dateKey),
    api.getChallengeResults(200),
  ]);
  const records = attemptsByDate[dateKey] ?? [];
  // チャレンジの中身は出さないが、そのチャレンジ枠が済んだかどうかの判定には使う。
  const challenges = challengeResults
    .map((result) => ({ ...result, date: api.dayOf(result.timestamp) }))
    .filter((result) => result.date === dateKey);

  const head = el('div', 'view-head');
  head.append(el('div', 'view-title', `${fmtDate(dateKey)}${dateKey === today ? '（今日）' : ''}`));
  screen.append(head);

  const list = el('div', 'list');
  list.append(row({
    title: '← 週の一覧に戻る',
    classes: ['row-back'],
    onClick: () => {
      state.schedule.selectedDate = null;
      // 一覧に戻ったときは、押す前の位置へ帰す（今日へは寄せ直さない）。
      state.schedule.restoreScroll = state.schedule.scrollTop ?? 0;
      state.schedule.centerToday = false;
      render();
    },
  }));

  /* ---------- 残っている予定（＝やること） ---------- */
  const pendingByTask = tasks.map((task) => {
    if (task.kind === 'challenge') {
      const done = challenges.some((result) => result.taskId === task.id) || task.completed;
      return { task, pending: done ? [] : itemsOf(task), isChallenge: true };
    }
    return { task, pending: splitPlanItems(task, records, { date: dateKey }).pending, isChallenge: false };
  }).filter((entry) => entry.pending.length);

  list.append(el('div', 'section-head', `残っている予定（${pendingByTask.reduce((n, e) => n + e.pending.length, 0)}件）`));
  if (!pendingByTask.length) {
    list.append(emptyState('残っている予定はありません'));
  } else {
    if (dateKey < today) {
      list.append(row({
        title: 'この日の予定が未実施のまま残っています',
        sub: "実績には数えません。各行の「繰り越す」で別の日へ移せます。",
        classes: ['row-indent'],
      }));
    }
    for (const entry of pendingByTask) {
      const label = entry.isChallenge
        ? `${entry.task.title ?? 'チャレンジ'}（${entry.pending.length}問）`
        : rangeLabel(entry.pending.map((item) => item.questionId));
      const carried = entry.pending.filter((item) => item.originalDate && item.originalDate !== dateKey);
      const move = el('button', 'link-btn', '繰り越す');
      move.onclick = () => {
        carryOverFor = carryOverFor === entry.task.id ? null : entry.task.id;
        rerender();
      };
      const node = detailRow({
        title: label,
        sub: [
          questionSub(entry.pending[0].questionId),
          carried.length ? `${carried.length}件は ${fmtDate(carried[0].originalDate)} からの繰り越し` : null,
        ].filter(Boolean).join(' ・ '),
        right: move,
      });
      node.prepend(squareRow(entry.pending.map((item) => plannedSquare({
        label: qLabel(item.questionId),
        carriedOver: Boolean(item.originalDate && item.originalDate !== dateKey),
      }))));
      list.append(node);
      if (carryOverFor === entry.task.id) {
        list.append(carryOverPanel(dateKey, entry.task, entry.pending, rerender));
      }
    }
  }

  screen.append(list);
}
