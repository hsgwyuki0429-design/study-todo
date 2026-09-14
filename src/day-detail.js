// スケジュールで日付を押したときに出る、その日の詳細。
//
// カレンダーのマスは「どれだけやったか」を見るためのもので、細かい中身は出さない。
// ここでは逆に、1件ずつを言葉で確かめられるようにする。
//
//   ・実際に取り組んだもの（問題の種別・章・単元・評価・所要時間）
//   ・チャレンジの中身（問題ごとの結果）
//   ・まだ残っている予定
//   ・ほかの日から繰り越されてきたもの
//   ・ほかの日へ動かしたもの（いつ・誰が・なぜ）
//   ・過ぎた日にまだ残っている予定は、ここから翌日などへ繰り越せる

import * as api from './api.js';
import {
  MOVE_REASONS, MOVE_REASON_LABELS, MOVE_KIND_LABELS, RECORD_SOURCE_LABELS,
  hasDuration, hasExactTime, todayKey,
} from './api.js';
import { itemsOf, splitPlanItems } from './plan-items.js';
import { state, q, qLabel, render, loadTasks, refreshToday } from './state.js';
import { el, fmtDate, fmtMS, fmtTime, row, emptyState } from './ui.js';
import { attemptDetailCard, attemptSquare, plannedSquare, squareRow } from './squares.js';
import { syncInBackground } from './cloud-sync.js';
import { undoRecord } from './record-actions.js';

// どのマスを開いているか（押すたびに開閉する）。
let openAttemptId = null;
// 繰り越しの理由を選んでいる最中のタスク。
let carryOverFor = null;

/**
 * 記録を削除する。印をつけるのではなく、本当に消す。
 * チャレンジの中の1問でも、その1問だけを消す（回そのものは残る）。
 */
async function deleteAttempt(record, rerender) {
  const message = record.challengeId
    ? 'この1問の記録を削除します。チャレンジの回そのものは残ります。元に戻せません。よろしいですか？'
    : 'この記録を削除します。元に戻せません。よろしいですか？';
  if (!confirm(message)) return;
  await api.deleteStudyRecord(record.id);
  openAttemptId = null;
  await refreshToday();
  syncInBackground();
  rerender();
}

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

  const [tasks, attemptsByDate, challengeResults, moves] = await Promise.all([
    api.getTasksInRange(dateKey, dateKey),
    api.getAttemptsByDate(dateKey, dateKey),
    api.getChallengeResults(200),
    api.listMoves(),
  ]);
  const records = attemptsByDate[dateKey] ?? [];
  const challenges = challengeResults
    .map((result) => ({ ...result, date: api.dayOf(result.timestamp) }))
    .filter((result) => result.date === dateKey);
  const lapRecordOf = (challengeId, questionId) =>
    records.find((entry) => entry.challengeId === challengeId && entry.questionId === questionId);

  const head = el('div', 'view-head');
  head.append(el('div', 'view-title', `${fmtDate(dateKey)}${dateKey === today ? '（今日）' : ''}`));
  screen.append(head);

  // その日の時間のやりくり（過ぎた日は出さない）。
  let timeInfo = null;
  if (dateKey >= today) {
    const [availability, plannedMinutes] = await Promise.all([
      api.availabilityForDay(dateKey),
      api.plannedMinutesFor(dateKey),
    ]);
    timeInfo = { ...availability, plannedMinutes };
  }

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

  if (timeInfo) {
    const available = timeInfo.available;
    const short = available !== null && timeInfo.plannedMinutes > available;
    list.append(row({
      title: available === null
        ? `予定 ${timeInfo.plannedMinutes}分 ／ 使える時間は未設定`
        : `予定 ${timeInfo.plannedMinutes}分 ／ 使える ${available}分${short ? `（${timeInfo.plannedMinutes - available}分オーバー）` : ''}`,
      sub: timeInfo.note,
      classes: ['row-indent'],
    }));
  }

  /* ---------- 実施したもの ---------- */
  const plainRecords = records.filter((record) => !record.challengeId);
  list.append(el('div', 'section-head', `実施した問題（${plainRecords.length}件）`));
  if (!plainRecords.length) {
    list.append(emptyState(dateKey > today ? 'これからの予定です' : 'この日の記録はありません'));
  } else {
    for (const record of plainRecords) {
      const opened = openAttemptId === record.id;
      const node = detailRow({
        title: qLabel(record.questionId),
        sub: [
          questionSub(record.questionId),
          record.source && record.source !== 'timer' ? RECORD_SOURCE_LABELS[record.source] : null,
          hasExactTime(record) ? null : '時刻は未登録',
        ].filter(Boolean).join(' ・ '),
        right: hasDuration(record) ? fmtMS(record.durationSeconds) : '—',
        onClick: () => {
          openAttemptId = opened ? null : record.id;
          rerender();
        },
      });
      const square = attemptSquare(record, { label: qLabel(record.questionId) });
      node.prepend(square);
      list.append(node);
      if (opened) list.append(attemptDetailCard(record, { onDelete: (target) => deleteAttempt(target, rerender), onUndo: undoRecord }));
    }
  }

  /* ---------- チャレンジ ---------- */
  if (challenges.length) {
    list.append(el('div', 'section-head', `チャレンジ（${challenges.length}回）`));
    for (const result of challenges) {
      const deleteBtn = el('button', 'link-btn danger-link', '削除');
      deleteBtn.onclick = async (event) => {
        event.stopPropagation();
        if (!confirm('この回のチャレンジを削除します（中で解いた記録もいっしょに消えます）。元に戻せません。よろしいですか？')) return;
        await api.deleteChallengeResult(result.id);
        openAttemptId = null;
        await refreshToday();
        syncInBackground();
        rerender();
      };
      const node = detailRow({
        title: `チャレンジ ${result.laps?.length ?? 0}問`,
        sub: `${result.succeeded ? '制限時間内' : '時間超過'} ・ ${fmtMS(result.totalElapsedSeconds)} / ${fmtMS(result.timeLimitSeconds)}`,
        right: [el('span', 'row-time', fmtTime(result.timestamp)), deleteBtn],
      });
      // チャレンジも、中の1問ずつをマスで並べる（カレンダーと同じ見方）。
      node.prepend(squareRow((result.laps ?? []).map((lap) => {
        const record = lapRecordOf(result.id, lap.questionId);
        return attemptSquare(record ?? {
          questionId: lap.questionId,
          evaluation: lap.evaluation,
          durationSeconds: lap.durationSeconds,
          challengeId: result.id,
        });
      })));
      list.append(node);
      // チャレンジの中の1問ずつ。カレンダーでは1マスにまとめているが、
      // ここでは中身が分かるようにする（各問題の履歴にも1回として残っている）。
      // 1問だけ削除することもでき、そのときもチャレンジの回そのものは残る。
      for (const lap of result.laps ?? []) {
        const record = lapRecordOf(result.id, lap.questionId);
        const opened = record && openAttemptId === record.id;
        const lapNode = detailRow({
          title: qLabel(lap.questionId),
          sub: [questionSub(lap.questionId), record ? null : '記録は削除済み'].filter(Boolean).join(' ・ '),
          right: el('span', 'row-time', fmtMS(lap.durationSeconds)),
          onClick: record ? () => {
            openAttemptId = opened ? null : record.id;
            rerender();
          } : null,
        });
        lapNode.prepend(record
          ? attemptSquare(record, { label: qLabel(lap.questionId) })
          : attemptSquare({ evaluation: lap.evaluation, durationSeconds: lap.durationSeconds, questionId: lap.questionId }));
        lapNode.classList.add('row-indent');
        list.append(lapNode);
        if (opened) {
          list.append(attemptDetailCard(record, { onDelete: (target) => deleteAttempt(target, rerender) }));
        }
      }
    }
  }

  /* ---------- 残っている予定 ---------- */
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

  /* ---------- まだ予定に入っていない目標の分 ---------- */
  if (dateKey >= today) {
    const goals = await api.getGoals();
    const unplaced = [];
    for (const goal of goals) {
      if (goal.status !== 'active' || goal.needsScopeSetup) continue;
      const progress = await api.getGoalProgressLocal(goal);
      if (progress.unplanned) unplaced.push({ goal, progress });
    }
    if (unplaced.length) {
      list.append(el('div', 'section-head', 'まだ予定に入っていない分'));
      for (const entry of unplaced) {
        list.append(row({
          title: entry.goal.title,
          sub: `未配置 ${entry.progress.unplanned}問 ・ 残り${entry.progress.remainingMinutes}分`
            + `${entry.goal.deadline ? ` ・ 期限 ${fmtDate(entry.goal.deadline)}` : ''}`
            + `${entry.progress.remainingIsComplete ? '' : '（習得までの総時間は不確実）'}`,
          classes: ['row-indent'],
        }));
      }
      list.append(row({
        title: 'この分は消えずに残ります',
        sub: '入りきらないときは、期限・対象・使える時間のどれを調整するか決めてください。Claude に「今週を組み直して」と頼むこともできます。',
        classes: ['row-indent'],
      }));
    }
  }

  /* ---------- 繰り越しの履歴 ---------- */
  const movedIn = moves.filter((move) => move.toDate === dateKey);
  const movedOut = moves.filter((move) => move.fromDate === dateKey);
  if (movedIn.length || movedOut.length) {
    list.append(el('div', 'section-head', '予定の移動'));
    for (const move of [...movedOut, ...movedIn]) {
      const outgoing = move.fromDate === dateKey;
      list.append(row({
        title: `${outgoing ? '→ ' : '← '}${move.items.length}件を ${fmtDate(outgoing ? move.toDate : move.fromDate)} ${outgoing ? 'へ移動' : 'から繰り越し'}`,
        sub: [
          MOVE_KIND_LABELS[move.kind] ?? move.kind,
          MOVE_REASON_LABELS[move.reason] ?? move.reason,
          `${move.actorKind === 'ai' ? `AI（${move.actorName ?? '不明'}）` : (move.actorName ?? '本人')}`,
          new Date(move.at).toLocaleString('ja-JP'),
        ].join(' ・ '),
        classes: ['row-indent'],
      }));
      for (const item of move.items) {
        list.append(row({
          title: qLabel(item.questionId),
          sub: `当初の予定日 ${item.originalDate ? fmtDate(item.originalDate) : '不明'} ・ 繰り越し${item.carriedCount}回目`,
          classes: ['row-indent'],
        }));
      }
    }
  }

  screen.append(list);
}
