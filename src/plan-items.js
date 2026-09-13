// 「予定（やるつもり）」と「実績（実際にやったこと）」を結び付けるための、
// PWAとサーバーで共有する純粋な処理。DOM にも Node にも依存しない。
//
// ことばの区別:
//
//   問題       … 例題50 のような、問題マスタ上の対象（questionId）
//   予定項目   … 「その問題に今回取り組む」という1件の予定（itemId）
//   学習記録   … 「実際に今回取り組んだ」1件の結果（record.id）
//
// 基本の約束は「1回の取り組み＝1件の学習記録」である。
// 同じ問題を2周目に解いても、同じ日に2回解いても、記録は別々に増える。
// 逆に、やらなかった予定を翌日へ繰り越しても、取り組み回数は増えない。
//
// 予定項目には itemId という安定した識別子を持たせ、学習記録の planItemId から
// 「どの予定に対する取り組みだったか」を後から追えるようにする。

/** 繰り越し・予定変更の種類。 */
export const MOVE_KINDS = Object.freeze(['carry_over', 'reschedule']);

/** 移動の理由。本人はワンタップで選べる値だけを使う。 */
export const MOVE_REASONS = Object.freeze([
  'time_shortage',
  'too_hard',
  'schedule_change',
  'other',
  'unspecified',
]);

export const MOVE_REASON_LABELS = Object.freeze({
  time_shortage: '時間が足りなかった',
  too_hard: '難しかった',
  schedule_change: '予定が変わった',
  other: 'その他',
  unspecified: '理由は未入力',
});

export const MOVE_KIND_LABELS = Object.freeze({
  carry_over: '未実施の繰り越し',
  reschedule: '事前の予定変更',
});

const randomSuffix = () => Math.random().toString(36).slice(2, 8);

/** 新しい予定項目のID。タスクIDを頭に付けて、どこの項目か読めるようにする。 */
export const newItemId = (taskId) => `${taskId}#${randomSuffix()}`;

/**
 * タスクの予定項目を取り出す。
 *
 * 古いデータ（items を持たないタスク）からは、questionIds の並びから組み立てる。
 * 組み立て方は決め打ちなので、読むたびに同じ itemId になる
 * （保存されていない古い予定でも、画面とサーバーで同じIDを指せる）。
 */
export function itemsOf(task) {
  if (!task) return [];
  const questionIds = Array.isArray(task.questionIds) ? task.questionIds : [];
  const stored = Array.isArray(task.items) ? task.items.filter((item) => item && item.itemId) : null;
  if (stored && stored.length === questionIds.length
    && stored.every((item, index) => item.questionId === questionIds[index])) {
    return stored.map((item) => normalizeItem(item, task));
  }
  if (stored && stored.length) {
    // items と questionIds が食い違っている場合は questionIds を正とし、
    // 同じ問題の項目からIDを引き継ぐ（編集の途中で壊れたデータの受け皿）。
    return reconcileItems(task, questionIds, stored);
  }
  return questionIds.map((questionId, index) => normalizeItem({
    itemId: `${task.id}#${index}`,
    questionId,
  }, task));
}

function normalizeItem(item, task) {
  return {
    itemId: String(item.itemId),
    questionId: String(item.questionId ?? ''),
    // 当初の予定日。繰り越しても変えない（「本当はいつやるはずだったか」）。
    originalDate: item.originalDate ?? task?.date ?? null,
    carriedCount: Number.isFinite(Number(item.carriedCount)) ? Number(item.carriedCount) : 0,
  };
}

/**
 * questionIds を書き換えるときに、残る問題の itemId を引き継ぐ。
 * 同じ問題が2つ入っている場合も、先頭から順に対応させる。
 */
export function reconcileItems(task, nextQuestionIds, previousItems = null) {
  const previous = previousItems ?? itemsOf(task);
  const pool = new Map();
  for (const item of previous) {
    if (!pool.has(item.questionId)) pool.set(item.questionId, []);
    pool.get(item.questionId).push(item);
  }
  return nextQuestionIds.map((questionId) => {
    const reused = pool.get(questionId)?.shift();
    return normalizeItem(reused ?? { itemId: newItemId(task.id), questionId }, task);
  });
}

/** items と questionIds を必ず同じ並びに保ったタスクを返す。 */
export function withItems(task) {
  const items = itemsOf(task);
  return { ...task, items, questionIds: items.map((item) => item.questionId) };
}

/**
 * 学習記録が、その予定項目に対する取り組みかどうか。
 * planItemId が入っている記録だけを、確かな対応として扱う。
 */
export const recordFulfilsItem = (record, item) => Boolean(record?.planItemId) && record.planItemId === item.itemId;

/**
 * その日の予定項目を「実施済み」と「未実施」に分ける。
 *
 * planItemId を持たない古い記録（この仕組みより前に作られたもの）は、
 * どの予定に対応するか確かめようがない。同じ問題・同じ日というだけで
 * 対応付けを作ってしまうと、実際とは違う結びつきを残すことになるので、
 * 記録そのものには結び付けない。
 * ただし画面で「もう解いた問題がまだ残っている」ように見えるのは困るため、
 * 表示の上でだけ、同じ日・同じ問題の古い記録1件につき予定1件を伏せる
 * （legacyCovered として返し、保存はしない）。
 */
export function splitPlanItems(task, records, { date = null, allowLegacyMatch = true } = {}) {
  const items = itemsOf(task);
  const byItemId = new Set(
    records.filter((record) => record.planItemId).map((record) => record.planItemId),
  );
  const legacyPool = new Map();
  if (allowLegacyMatch) {
    for (const record of records) {
      if (record.planItemId) continue;
      if (date && recordDateOf(record) !== date) continue;
      legacyPool.set(record.questionId, (legacyPool.get(record.questionId) ?? 0) + 1);
    }
  }
  const done = [];
  const pending = [];
  const legacyCovered = [];
  for (const item of items) {
    if (byItemId.has(item.itemId)) {
      done.push(item);
      continue;
    }
    const remaining = legacyPool.get(item.questionId) ?? 0;
    if (remaining > 0) {
      legacyPool.set(item.questionId, remaining - 1);
      legacyCovered.push(item);
      continue;
    }
    pending.push(item);
  }
  return { items, done, pending, legacyCovered };
}

// 記録の日付は、呼び出し側が dateKeyOf を渡さなくても使えるよう、
// 記録に入っている date（サーバーが付ける）か timestamp の先頭から読む。
// 厳密な日本時間の判定が要るところでは、呼び出し側が date を入れてから渡す。
function recordDateOf(record) {
  return record.date ?? (typeof record.timestamp === 'string' ? record.timestamp.slice(0, 10) : null);
}

/** 移動イベント1件の形を整える。id が同じものは何度届いても1件として扱う。 */
export function normalizeMove(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const fromDate = typeof raw.fromDate === 'string' ? raw.fromDate : '';
  const toDate = typeof raw.toDate === 'string' ? raw.toDate : '';
  if (!id || !fromDate || !toDate) return null;
  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    id: id.slice(0, 80),
    fromDate,
    toDate,
    at: typeof raw.at === 'string' ? raw.at : new Date(now).toISOString(),
    // 誰が動かしたか（本人 / AI）。
    actorKind: raw.actorKind === 'ai' ? 'ai' : 'user',
    actorName: typeof raw.actorName === 'string' ? raw.actorName.slice(0, 60) : null,
    kind: MOVE_KINDS.includes(raw.kind) ? raw.kind : 'reschedule',
    // 理由は任意。AIが推測した理由を事実として保存しないよう、
    // 渡されなかったときは unspecified のままにする。
    reason: MOVE_REASONS.includes(raw.reason) ? raw.reason : 'unspecified',
    reasonNote: typeof raw.reasonNote === 'string' ? raw.reasonNote.slice(0, 200) : null,
    taskId: typeof raw.taskId === 'string' ? raw.taskId.slice(0, 80) : null,
    toTaskId: typeof raw.toTaskId === 'string' ? raw.toTaskId.slice(0, 80) : null,
    changeId: typeof raw.changeId === 'string' ? raw.changeId.slice(0, 80) : null,
    // 動かした未実施の予定項目。
    items: items.slice(0, 100).map((item) => ({
      itemId: String(item?.itemId ?? ''),
      questionId: String(item?.questionId ?? ''),
      originalDate: item?.originalDate ?? null,
      carriedCount: Number.isFinite(Number(item?.carriedCount)) ? Number(item.carriedCount) : 0,
    })).filter((item) => item.itemId),
  };
}
