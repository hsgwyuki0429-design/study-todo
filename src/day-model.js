// 「その日のカレンダーに何を出すか」を決める、画面に依らない処理。
//
// 画面から切り離してあるのは、ここが仕様のかなめだからである。
// 予定と実績の二重表示や、チャレンジの数え方を、テストで確かめられるようにしている。

import { splitPlanItems } from './plan-items.js';

/**
 * その日に出すものを決める。
 *
 * ・実績は、その日に記録された取り組みそのもの（予定に無かった問題も含む）
 * ・チャレンジの中で解いた問題は、例題の段には出さずチャレンジ1マスにまとめる
 * ・今日の予定は「まだ取り組んでいない分」だけ。
 *   予定が実績に変わったときに、同じ取り組みを二重に出さないため。
 *   ただし同じ問題の「別の取り組み」の予定は残す（itemId で1件ずつ見ている）。
 */
export function buildDay(dateKey, { tasks = [], records = [], challenges = [], today }) {
  const isPast = dateKey < today;
  const isFuture = dateKey > today;

  const doneChallengeTaskIds = new Set();
  const dayChallenges = challenges.filter((result) => (result.date ?? '') === dateKey);
  dayChallenges.forEach((result) => { if (result.taskId) doneChallengeTaskIds.add(result.taskId); });

  // 例題などの実績（チャレンジの中の分は、チャレンジのマスに含めるので出さない）。
  const attempts = records.filter((record) => !record.challengeId);

  const plannedItems = [];
  const plannedChallenges = [];
  if (!isPast) {
    for (const task of tasks) {
      if (task.kind === 'challenge') {
        if (!task.completed && !doneChallengeTaskIds.has(task.id)) plannedChallenges.push(task);
        continue;
      }
      const split = splitPlanItems(task, records, { date: dateKey });
      split.pending.forEach((item) => plannedItems.push({ item, task }));
    }
  }

  return {
    date: dateKey,
    isPast,
    isFuture,
    isToday: dateKey === today,
    attempts,
    challenges: dayChallenges,
    plannedItems,
    plannedChallenges,
  };
}

