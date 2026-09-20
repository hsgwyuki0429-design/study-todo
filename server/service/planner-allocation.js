// 「いつ置くか」を決める層。ここには通信も保存も出てこない。
//
// Jev が返すのは「何日後が望ましいか」までで、何月何日に入れるかはここが決める。
// たとえば「3日後」が選ばれても、その日の枠が埋まっていれば、期限・固定予定・容量を
// 守れる最も近い日へ置く。置けなければ、詰め込まずに「不足」として残す。
//
// 守ること:
//   ・秒で数える。分に丸めた値で枠を判断しない（丸めの分だけ超過する）。
//   ・使える時間が未設定の日には置かない（0分とは違う）。
//   ・目標の期限より後ろには置かない。
//   ・完了・実行中・固定の予定には触らない。その分の時間は先に引いておく。
//   ・1問だけで1日の枠を超える問題は置かない（1問を分ける仕組みは無い）。

import { shiftDateKey } from '../../src/datetime.js';

/**
 * 日ごとの空き（秒）を作る。
 * 保護されている予定と、動かさない予定の見積もりは先に引く。
 */
export function buildSlots(days, { keepItemIds = new Set() } = {}) {
  return days.map((day) => {
    const available = day.capacity?.available ?? null;
    const reserved = (day.pendingItems ?? [])
      .filter((item) => item.locked || keepItemIds.has(item.itemId))
      .reduce((sum, item) => sum + item.estimateSeconds, 0);
    return {
      date: day.date,
      // 未設定の日は「時間があるとは決められない」ので、置ける秒数も null のまま。
      capacitySeconds: available === null ? null : available * 60,
      remainingSeconds: available === null ? null : Math.max(0, available * 60 - reserved),
      reservedSeconds: reserved,
      revision: day.revision,
    };
  });
}

/**
 * 並んだ候補を、順に日付へ置く。
 *
 *   candidates … compareCandidates で並べ終えたもの。desiredDate（最短で置きたい日）付き。
 *   slots      … buildSlots の結果（日付順）。
 */
export function allocate(candidates, slots, { today, maxPerDay = 50 } = {}) {
  const byDate = new Map(slots.map((slot) => [slot.date, slot]));
  const dates = slots.map((slot) => slot.date);
  const counts = new Map();
  const placements = [];
  const unplaced = [];

  for (const candidate of candidates) {
    const earliest = candidate.desiredDate && candidate.desiredDate > today ? candidate.desiredDate : today;
    const deadline = candidate.goalDeadline || null;
    let placed = null;
    let sawRoomlessDay = false;
    for (const date of dates) {
      if (date < earliest) continue;
      if (deadline && date > deadline) break;
      const slot = byDate.get(date);
      // 使える時間が未設定の日は飛ばす。時間があるとは決められない。
      if (!slot || slot.remainingSeconds === null) continue;
      if ((counts.get(date) ?? 0) >= maxPerDay) continue;
      // 1問だけで1日の枠を超えるなら、その日は諦める（分ける仕組みが無い）。
      if (candidate.estimateSeconds > slot.capacitySeconds) continue;
      if (candidate.estimateSeconds > slot.remainingSeconds) { sawRoomlessDay = true; continue; }
      slot.remainingSeconds -= candidate.estimateSeconds;
      counts.set(date, (counts.get(date) ?? 0) + 1);
      placed = date;
      break;
    }
    if (placed) placements.push({ ...candidate, date: placed });
    else unplaced.push({ ...candidate, reason: reasonFor(candidate, { deadline, earliest, dates, byDate, sawRoomlessDay }) });
  }
  return { placements, unplaced, slots };
}

function reasonFor(candidate, { deadline, earliest, dates, byDate, sawRoomlessDay }) {
  const inWindow = dates.filter((date) => date >= earliest && (!deadline || date <= deadline));
  if (!inWindow.length) return deadline ? 'after_deadline' : 'outside_window';
  const configured = inWindow.filter((date) => byDate.get(date)?.remainingSeconds !== null);
  if (!configured.length) return 'capacity_not_configured';
  const fits = configured.some((date) => candidate.estimateSeconds <= byDate.get(date).capacitySeconds);
  if (!fits) return 'single_item_too_long';
  // 枠そのものには入る大きさだが、空きが残っていなかった。
  return sawRoomlessDay ? 'time_shortage' : 'day_full';
}

/**
 * 置いた結果を、applyTaskChanges の changes へ直す。
 *
 *   ・すでにある予定項目は、動かすときだけ触る（同じ日ならそのまま）。
 *     過去に残っている分は carryOver、これからの分は move を使う。
 *   ・新しく置く分だけ add する。全日を置き換えるような作り方はしない。
 *   ・1タスク1問で足す。既存の複数問題タスクとチャレンジは分割しない。
 */
export function buildChanges(placements, { today, limits }) {
  const changes = [];
  const touchedDates = new Set();
  const skipped = [];

  for (const placement of placements) {
    if (placement.itemId) {
      if (placement.fromDate === placement.date) continue; // 動かす必要がない
      const change = placement.fromDate < today
        ? {
          op: 'carryOver', taskId: placement.taskId, fromDate: placement.fromDate, toDate: placement.date,
          itemIds: [placement.itemId], kind: 'carry_over',
        }
        : {
          op: 'move', taskId: placement.taskId, fromDate: placement.fromDate, toDate: placement.date,
          kind: 'reschedule',
        };
      // 動かす理由は、利用者が言ったことではないので unspecified のまま残す。
      changes.push({ change, dates: [placement.fromDate, placement.date] });
    } else {
      changes.push({
        change: {
          op: 'add', date: placement.date,
          task: {
            // 初めて置く問題は new、一度でも解いている問題は review。
            questionIds: [placement.questionId], kind: placement.taskKind ?? 'new',
            ...(placement.goalId ? { goalId: placement.goalId } : {}),
          },
        },
        dates: [placement.date],
      });
    }
  }

  // 1回で扱える数には上限がある。優先順位の高いものから入れ、あふれた分は次回へ回す。
  const accepted = [];
  for (const entry of changes) {
    const nextDates = new Set([...touchedDates, ...entry.dates]);
    if (accepted.length >= limits.changesPerRequest || nextDates.size > limits.datesPerRequest) {
      skipped.push(entry.change);
      continue;
    }
    accepted.push(entry.change);
    for (const date of entry.dates) touchedDates.add(date);
  }
  return { changes: accepted, dates: [...touchedDates].sort(), skipped };
}

/** 動かしていない予定を数えるための、候補の識別子。 */
export const placementKey = (placement) => placement.itemId ?? `new:${placement.goalId ?? '-'}:${placement.questionId}`;

export { shiftDateKey };
