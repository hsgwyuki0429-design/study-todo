// 「その日のカレンダーに何を出すか」を決める、画面に依らない処理。
//
// 画面から切り離してあるのは、ここが仕様のかなめだからである。
// 予定と実績の二重表示や、段の分け方を、テストで確かめられるようにしている。
//
// 段は2つ。
//
//   例題       … 基本例題・重要例題・演習例題など（EXERCISES 以外）
//   エクササイズ … EXERCISES。チャレンジで解いた分も、1問ずつここに並べる
//                 （チャレンジはたいていエクササイズをまとめて解くもののため）
//
// マスは「1回の取り組み」または「1回ぶんの予定」で1つ。チャレンジをまとめて1マスにはしない。

import { splitPlanItems } from './plan-items.js';
import { shiftDateKey } from './datetime.js';

export const ROWS = Object.freeze(['example', 'exercise']);

export const ROW_LABELS = Object.freeze({ example: '例題', exercise: 'Ex' });

/** その問題がどちらの段に入るか。種類が分からないものは例題の段に入れる。 */
export function rowOf(questionType) {
  return questionType === 'EXERCISES' ? 'exercise' : 'example';
}

/**
 * その日に出すものを決める。
 *
 * ・実績は、その日に記録された取り組みそのもの（予定に無かった問題も含む）
 * ・今日の予定は「まだ取り組んでいない分」だけ。
 *   予定が実績に変わったときに、同じ取り組みを二重に出さないため。
 *   ただし同じ問題の「別の取り組み」の予定は残す（itemId で1件ずつ見ている）。
 * ・過ぎた日には、やらなかった予定を実績として並べない（詳細では確認できる）。
 *
 * questionType は問題IDから種類を引く関数。渡さないとすべて例題の段に入る。
 */
export function buildDay(dateKey, {
  tasks = [], records = [], today, questionType = () => null,
} = {}) {
  const isPast = dateKey < today;
  const isFuture = dateKey > today;

  const attempts = { example: [], exercise: [] };
  for (const record of records) {
    attempts[rowOf(questionType(record.questionId))].push(record);
  }

  const planned = { example: [], exercise: [] };
  if (!isPast) {
    for (const task of tasks) {
      // 終わったチャレンジは予定として残さない。
      if (task.completed) continue;
      const split = splitPlanItems(task, records, { date: dateKey });
      for (const item of split.pending) {
        planned[rowOf(questionType(item.questionId))].push({ item, task });
      }
    }
  }

  return {
    date: dateKey,
    isPast,
    isFuture,
    isToday: dateKey === today,
    attempts,
    planned,
    attemptCount: attempts.example.length + attempts.exercise.length,
    plannedCount: planned.example.length + planned.exercise.length,
  };
}


/** from から to までの日付を並べる（連続したカレンダー用）。 */
export function dateRange(from, to, { max = 800 } = {}) {
  const dates = [];
  let cursor = from;
  while (cursor <= to && dates.length < max) {
    dates.push(cursor);
    cursor = shiftDateKey(cursor, 1);
  }
  return dates;
}
