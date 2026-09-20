// 候補1件ぶんの「数えられること」を作る層。
//
// Jev へ送るのはここで作った要約だけで、全履歴は送らない（予算と費用のため）。
// 送る中身は匿名の問題IDと、評価・回数・日数・秒数だけ。
// 氏名・認証情報・教材の本文は、そもそもここへ入ってこない。
//
// 「解答時間が長い＝知識不足」のような断定はしない。
// 現行のタイマーは答え合わせまでを含む扱いなので、内訳を後付けで作ることもしない。

import { shiftDateKey } from '../../src/datetime.js';
import { recordDateOf } from '../../src/records-model.js';
import { FAILURE_EVALUATIONS, PARTIAL_EVALUATIONS, PRIORITY_BUCKETS } from './planner-policy.js';
import { relationsForQuestion } from './question-relations.js';

/** Jev へ渡す評価履歴の長さ。古い分まで送っても判断は良くならず、予算だけ増える。 */
const HISTORY_WINDOW = 6;

const daysBetween = (from, to) => {
  const left = Date.parse(`${from}T00:00:00Z`);
  const right = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.round((right - left) / 86400000);
};

/**
 * 1問ぶんの特徴量。
 *
 *   attempts … その目標に結び付いた取り組み（古い順）。目標をまたいだ記録は混ぜない。
 *   history  … 目標を問わない、その問題への全取り組み（間隔の判断に使う）。
 */
export function featuresFor({
  questionId, question = null, attempts = [], history = [], estimate, today,
}) {
  const evaluations = history.map((record) => record.evaluation).filter(Boolean);
  const lastRecord = history.at(-1) ?? null;
  const lastDate = lastRecord ? recordDateOf(lastRecord) : null;
  let consecutiveFailures = 0;
  for (let index = evaluations.length - 1; index >= 0; index -= 1) {
    if (!FAILURE_EVALUATIONS.includes(evaluations[index])) break;
    consecutiveFailures += 1;
  }
  return {
    questionId,
    difficulty: Number.isInteger(question?.difficulty) ? question.difficulty : null,
    type: question?.type ?? null,
    // 評価履歴は直近ぶんだけ。古い順のまま渡す（並びに意味がある）。
    evaluations: evaluations.slice(-HISTORY_WINDOW),
    attemptCount: history.length,
    goalAttemptCount: attempts.length,
    perfectCount: history.filter((record) => record.evaluation === 'perfect').length,
    failureCount: history.filter((record) => FAILURE_EVALUATIONS.includes(record.evaluation)).length,
    partialCount: history.filter((record) => PARTIAL_EVALUATIONS.includes(record.evaluation)).length,
    consecutiveFailures,
    lastEvaluation: evaluations.at(-1) ?? null,
    lastAttemptDate: lastDate,
    daysSinceLastAttempt: lastDate ? daysBetween(lastDate, today) : null,
    estimateSeconds: estimate.seconds,
    estimateSource: estimate.source,
    estimateConfidence: estimate.confidence,
  };
}

/** 次の復習予定日。最後に解いた日から間隔ぶん空ける。未実施なら今日から。 */
export function dueDateFor(features, intervalDays, today) {
  if (!features.lastAttemptDate) return today;
  const due = shiftDateKey(features.lastAttemptDate, intervalDays);
  return due < today ? today : due;
}

/**
 * ✕方針が違った が続いている問題について、先に戻すべき土台を探す。
 *
 * 見るのは保存されている関連だけ。対象（目標の範囲か、すでに解いたことのある問題）に
 * 入っているものしか返さない。関係が無ければ null を返し、勝手に基礎を作らない。
 */
export function prerequisiteFor(questionId, {
  relations = [], allowedQuestionIds = new Set(), satisfiedQuestionIds = new Set(),
} = {}) {
  const buckets = relationsForQuestion(relations, questionId);
  const candidates = buckets.prerequisites
    .filter((relation) => allowedQuestionIds.has(relation.questionId))
    // すでに安定してできている土台へは戻さない。
    .filter((relation) => !satisfiedQuestionIds.has(relation.questionId))
    // 教材に書いてあるつながりを、AIの推測より先に使う。
    .sort((left, right) => {
      if (left.source !== right.source) return left.source === 'book' ? -1 : 1;
      return left.questionId < right.questionId ? -1 : 1;
    });
  return candidates[0] ?? null;
}

/** 候補の優先枠を決める。日付の比較だけで決まる、説明できる分類。 */
export function bucketFor({ isPrerequisite, dueDate, today, hasAttempts, isUnfinished }) {
  if (isPrerequisite) return PRIORITY_BUCKETS.prerequisite;
  if (isUnfinished) return PRIORITY_BUCKETS.unfinished;
  if (!hasAttempts) return PRIORITY_BUCKETS.new_work;
  if (dueDate < today) return PRIORITY_BUCKETS.overdue_review;
  return PRIORITY_BUCKETS.due_review;
}

/** Jev の state に載せる形。送る項目を1か所に集めて、増やしすぎないようにする。 */
export function jevStateFor(features) {
  return {
    id: features.questionId,
    evaluations: features.evaluations,
    attemptCount: features.attemptCount,
    perfectCount: features.perfectCount,
    failureCount: features.failureCount,
    consecutiveFailures: features.consecutiveFailures,
    daysSinceLastAttempt: features.daysSinceLastAttempt,
    difficulty: features.difficulty,
    type: features.type,
    estimateSeconds: features.estimateSeconds,
    estimateSource: features.estimateSource,
    verifiedPrerequisitesAvailable: features.verifiedPrerequisitesAvailable === true,
  };
}
