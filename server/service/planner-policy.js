// 学習の進め方の決まりごと。判断を任せる範囲と、コードで固める範囲の境目。
//
// Jev に尋ねるのは「どれくらい復習が要るか」「次は何をするか」「次はどれくらい空けるか」
// という、履歴から読み取る小さな判断だけ。
// 何月何日に置くか、期限に間に合うか、枠に収まるかは、ここと配分エンジンが決める。
//
// 方針（利用者の希望を、そのまま規則にしたもの）:
//
//   ・通常の予定は1タスク1問。既存の複数問題タスクやチャレンジは勝手に分割しない。
//   ・復習を新規学習より優先する。置ききれない分は「不足」として残し、詰め込まない。
//   ・難易度3までを進めてから4以上へ行く（目標の priority と問題の difficulty は別物）。
//   ・◯完璧にできた が合計2回そろえば一旦クリア（目標の completion.mode = count）。
//   ・クリア後も、応用・複合問題や、誤答を繰り返した問題は長期復習の候補に残す。
//   ・いちばん基本的で安定した問題の反復は減らす。

/** 次の復習までの間隔。Jev にはこの中から選ばせる（自由な日数は書かせない）。 */
export const REVIEW_INTERVALS = Object.freeze({
  day_1: 1, day_3: 3, day_7: 7, day_14: 14, day_30: 30,
});

export const REVIEW_INTERVAL_KEYS = Object.freeze(Object.keys(REVIEW_INTERVALS));

/** 次の学習行動。unknown は「材料が足りない」という正直な答え。 */
export const NEXT_ACTIONS = Object.freeze(['repeat', 'prerequisite', 'keep', 'unknown']);

/** 復習必要度の段階（Score の criteria と同じ並び）。 */
export const REVIEW_NEED_LEVELS = Object.freeze(['低い', '中程度', '高い']);

/** 優先枠。小さいほど先に置く。日付や容量ではなく「種類」だけを表す。 */
export const PRIORITY_BUCKETS = Object.freeze({
  overdue_review: 0,   // 復習予定日を過ぎている
  prerequisite: 1,     // ✕方針が違った の土台へ戻る
  due_review: 2,       // 今日が復習予定日
  unfinished: 3,       // やり残した予定
  new_work: 4,         // まだ手を付けていない目標の問題
});

/** 採否の閾値。shadow 運用の結果で見直す前提の初期値。 */
export const POLICY_DEFAULTS = Object.freeze({
  // これ未満の confidence の判断は使わず、決定的な規則へ戻す。
  minConfidence: 0.4,
  // 難易度4以上へ進む前に、3以下の未クリアがこれだけ残っていたら後回しにする。
  difficultyGateRemaining: 1,
  // 同じ優先枠で待たされ続ける問題を拾い上げるまでの日数。
  agingDays: 7,
  // 長期復習に残す条件（クリア済みでも候補にする）。
  longTermDifficulty: 4,
  longTermFailures: 2,
  // 決定的な規則で使う間隔（Jev が使えないとき）。
  fallbackIntervals: Object.freeze({
    fail: 1,          // ✕方針が違った・繰り返しの失敗
    partial: 3,       // △計算ミス・記述が甘い・もっと良い解法
    firstPerfect: 7,  // perfect 1回目
    repeatPerfect: 14, // perfect が続いている
  }),
});

/** 不正解にあたる評価（弱点の判断に使う）。 */
export const FAILURE_EVALUATIONS = Object.freeze(['wrong_approach', 'calc_error']);
export const PARTIAL_EVALUATIONS = Object.freeze(['weak_writing', 'better_solution']);

/**
 * Jev が使えないとき（障害・低確信度・材料不足）の復習間隔。
 * 評価履歴だけから決める、説明できる規則。
 */
export function fallbackIntervalDays(features, policy = POLICY_DEFAULTS) {
  const { fallbackIntervals: days } = policy;
  const last = features.evaluations.at(-1) ?? null;
  if (last === null) return days.fail;
  if (FAILURE_EVALUATIONS.includes(last)) return days.fail;
  if (PARTIAL_EVALUATIONS.includes(last)) return days.partial;
  // perfect。何回そろっているかで空け方を変える。
  return features.perfectCount >= 2 ? days.repeatPerfect : days.firstPerfect;
}

/** Jev の答えを、実際に使う間隔（日数）へ直す。使えないものは規則へ戻す。 */
export function intervalDaysFrom(answer, features, policy = POLICY_DEFAULTS) {
  if (!answer || answer.value === 'unknown') return { days: fallbackIntervalDays(features, policy), source: 'policy' };
  const days = REVIEW_INTERVALS[answer.value];
  if (!days) return { days: fallbackIntervalDays(features, policy), source: 'policy' };
  if (answer.confidence !== null && answer.confidence < policy.minConfidence) {
    return { days: fallbackIntervalDays(features, policy), source: 'policy_low_confidence' };
  }
  return { days, source: 'jev' };
}

/** 次の学習行動。低確信度・unknown のときは「今の方針を保つ」へ戻す。 */
export function actionFrom(answer, policy = POLICY_DEFAULTS) {
  if (!answer || !NEXT_ACTIONS.includes(answer.value) || answer.value === 'unknown') {
    return { action: 'keep', source: 'policy' };
  }
  if (answer.confidence !== null && answer.confidence < policy.minConfidence) {
    return { action: 'keep', source: 'policy_low_confidence' };
  }
  return { action: answer.value, source: 'jev' };
}

/** 復習必要度（0〜2の連続値）。Score は小数で返るので、添字には使わない。 */
export function reviewNeedFrom(answer, features, policy = POLICY_DEFAULTS) {
  if (answer && Number.isFinite(answer.value)
    && (answer.confidence === null || answer.confidence >= policy.minConfidence)) {
    return { need: answer.value, source: 'jev' };
  }
  // 規則での必要度。直近の失敗が重いほど高い。
  const last = features.evaluations.at(-1) ?? null;
  if (last && FAILURE_EVALUATIONS.includes(last)) return { need: 2, source: 'policy' };
  if (last && PARTIAL_EVALUATIONS.includes(last)) return { need: 1, source: 'policy' };
  return { need: 0, source: 'policy' };
}

/**
 * 難易度の進み方。3以下に未クリアが残っているうちは、4以上を後回しにする。
 * 「後回し」であって「除外」ではない。置ける余地があれば置く。
 */
export function difficultyDeferred(features, { remainingBelowGate }, policy = POLICY_DEFAULTS) {
  return (features.difficulty ?? 0) >= 4 && remainingBelowGate >= policy.difficultyGateRemaining;
}

/**
 * クリア済みでも長期復習に残すか。
 * 応用・複合（難易度が高い）か、誤答を繰り返した問題だけを残す。
 * いちばん基本的で安定した問題は、ここで落として反復を減らす。
 */
export function keepForLongTerm(features, policy = POLICY_DEFAULTS) {
  if ((features.difficulty ?? 0) >= policy.longTermDifficulty) return true;
  return features.failureCount >= policy.longTermFailures;
}

/**
 * 並び順を確定させる。AIの点数で、必須の制約（期限・枠・保護）は覆さない。
 * 同点のときは問題IDまで見て、いつ走らせても同じ順になるようにする。
 */
export function compareCandidates(left, right, { today, policy = POLICY_DEFAULTS } = {}) {
  // 1. 期限が近いものが先（期限なしは後ろ）。
  const deadline = (candidate) => candidate.goalDeadline || '9999-12-31';
  if (deadline(left) !== deadline(right)) return deadline(left) < deadline(right) ? -1 : 1;
  // 2. 待たされ続けている問題を拾い上げる（短い問題ばかりが先に進むのを防ぐ）。
  const aged = (candidate) => (waitingDays(candidate, today) >= policy.agingDays ? 0 : 1);
  if (aged(left) !== aged(right)) return aged(left) - aged(right);
  // 3. 優先枠。
  if (left.bucket !== right.bucket) return left.bucket - right.bucket;
  // 4. 目標の優先順位（1が高い）。
  if (left.goalPriority !== right.goalPriority) return left.goalPriority - right.goalPriority;
  // 5. 難易度の進み方（後回しの印が付いたものは後ろ）。
  if (left.deferred !== right.deferred) return left.deferred ? 1 : -1;
  // 6. 復習必要度が高い順。
  if (left.reviewNeed !== right.reviewNeed) return right.reviewNeed - left.reviewNeed;
  // 7. もとの並び（教材の掲載順）、最後は問題IDで決着させる。
  if (left.order !== right.order) return left.order - right.order;
  return left.questionId < right.questionId ? -1 : left.questionId > right.questionId ? 1 : 0;
}

export function waitingDays(candidate, today) {
  if (!candidate.dueDate || !today) return 0;
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${candidate.dueDate}T00:00:00Z`)) / 86400000);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/** 保存された事実と判断の分類だけから、短い理由を作る（推測を事実として書かない）。 */
export function explain(candidate) {
  const parts = [];
  if (candidate.bucket === PRIORITY_BUCKETS.prerequisite) parts.push('方針の誤りが続いたため、関連する基礎を先に置きました');
  else if (candidate.bucket === PRIORITY_BUCKETS.overdue_review) parts.push(`復習予定日（${candidate.dueDate}）を過ぎています`);
  else if (candidate.bucket === PRIORITY_BUCKETS.due_review) parts.push('復習の予定日です');
  else if (candidate.bucket === PRIORITY_BUCKETS.unfinished) parts.push('やり残した予定です');
  else parts.push('まだ取り組んでいない目標の問題です');
  if (candidate.lastEvaluation) parts.push(`直近の評価は ${EVALUATION_SHORT[candidate.lastEvaluation] ?? candidate.lastEvaluation}`);
  if (candidate.perfectCount) parts.push(`◯完璧にできた ${candidate.perfectCount}回`);
  if (candidate.deferred) parts.push('難易度3までを先に進める方針のため、後ろへ回しました');
  return parts.join('。');
}

const EVALUATION_SHORT = Object.freeze({
  perfect: '◯完璧にできた',
  better_solution: '解もっと良い解法',
  weak_writing: '記記述が甘い',
  calc_error: '△計算ミス',
  wrong_approach: '✕方針が違った',
});
