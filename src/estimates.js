// 「この問題にどれくらい時間がかかりそうか」を、保存してある情報だけで見積もる。
//
// 毎回ページを読み直したり、AIに推測させたりしない。使うのは次の4つで、上から優先する。
//
//   1. 本人が指定した時間（manual）
//      … 利用者が自分で決めた値。ここが一番強い。勝手に上書きしない。
//   2. 同じ問題の、近い条件での本人の実績
//      … 初見どうし・復習どうし・通常どうしで比べる。初見の1件だけで復習を決めつけない。
//   3. 似た問題（同じ単元・種類・難易度）の本人の実績
//   4. 保存された仮見積もり（AIが教材を見て入れたもの）、または種類・難易度別の既定値
//
// 記録の選び方で気をつけていること:
//
//   ・極端な値は外す。数秒で終わっている記録は計測忘れ、長すぎる記録は中断とみなす。
//     外すのは「見積もりの計算から」だけで、学習記録そのものは消さない。
//   ・時間が未登録の記録（本人の申告で「時間は覚えていない」など）は、0秒として混ぜない。
//     取り消した記録も使わない。
//   ・制限時間で打ち切られたチャレンジの記録は「解き終えるのに必要な時間」ではないので、
//     見積もりには使わない。
//   ・平均ではなく中央値を使う。1件の外れ値で見積もりが崩れないようにする。
//   ・自分の記録が少ないときは、似た問題や既定値と混ぜて、少数の記録に引っ張られすぎないようにする。
//
// 返す値には必ず「どこから決まったか（source）」「何件の記録を見たか」「どのくらい確かか」を付ける。
// 根拠のない精密な数字（信頼区間など）は出さない。

export const ESTIMATE_METHOD_VERSION = 'v1';

/** 種類・難易度別の既定値（秒）。設定で変えられるようにしてある。 */
export const DEFAULT_ESTIMATE_SECONDS = Object.freeze({
  byType: Object.freeze({
    基本例題: 600,
    重要例題: 780,
    演習例題: 840,
    EXERCISES: 720,
  }),
  fallback: 720,
  // 難易度（コンパス1〜5）ごとの倍率。
  difficultyFactor: Object.freeze({ 1: 0.7, 2: 0.85, 3: 1, 4: 1.25, 5: 1.5 }),
});

/** 見積もりの計算から外す値。学習記録そのものは消さない。 */
export const SAMPLE_LIMITS = Object.freeze({
  minSeconds: 30,      // これ未満は計測忘れ・誤タップとみなす
  maxSeconds: 3600,    // これを超えるものは中断・計測しっぱなしとみなす
  // これだけ集まれば、本人の実績だけで決めてよい。
  enoughSamples: 3,
});

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

/** 学習の条件。初見と復習、通常とチャレンジを混ぜないために使う。 */
export const conditionOf = ({ attemptIndex = 0, inChallenge = false } = {}) => ({
  firstTry: attemptIndex === 0,
  inChallenge,
});

/**
 * 見積もりに使ってよい記録だけを残す。
 *
 * truncatedChallengeIds … 制限時間で終わったチャレンジのID。その中の記録は使わない。
 */
export function usableSamples(records, { truncatedChallengeIds = new Set() } = {}) {
  return records.filter((record) => {
    // 取り消した記録と、時間が未登録の記録は使わない。
    // 未登録を0秒として混ぜると、見積もりが実際より短くなってしまう。
    if (record.voided === true) return false;
    if (typeof record.durationSeconds !== 'number') return false;
    const seconds = Number(record.durationSeconds);
    if (!Number.isFinite(seconds)) return false;
    if (seconds < SAMPLE_LIMITS.minSeconds || seconds > SAMPLE_LIMITS.maxSeconds) return false;
    if (record.challengeId && truncatedChallengeIds.has(record.challengeId)) return false;
    return true;
  });
}

const difficultyFactor = (question, defaults) =>
  defaults.difficultyFactor[question?.difficulty] ?? 1;

/** 種類と難易度から決める既定値。 */
export function defaultEstimateSeconds(question, defaults = DEFAULT_ESTIMATE_SECONDS) {
  const base = defaults.byType[question?.type] ?? defaults.fallback;
  return Math.round(base * difficultyFactor(question, defaults));
}

/**
 * 1問ぶんの見積もりを作る。
 *
 *   question   … 問題マスタの1件（無くてもよい）
 *   history    … その問題への、本人の取り組み記録（古い順）
 *   similar    … 似た問題への本人の記録（同じ単元・種類・難易度）
 *   stored     … 保存してある指定（manualSeconds / aiSeconds）
 *   condition  … これから解く条件（初見か復習か、チャレンジか）
 *   review     … 答え合わせ・解説確認の扱い
 */
export function estimateForQuestion({
  question = null,
  history = [],
  similar = [],
  stored = null,
  condition = { firstTry: true, inChallenge: false },
  review = { timerIncludesReview: true, reviewOverheadSeconds: 0 },
  defaults = DEFAULT_ESTIMATE_SECONDS,
  truncatedChallengeIds = new Set(),
  now = Date.now(),
} = {}) {
  // タイマーが評価を記録するまでを測っているなら、答え合わせの時間はすでに入っている。
  // 入っていないときだけ、設定された補助時間を足す（予備時間とは別物で、二重には足さない）。
  const reviewSeconds = review.timerIncludesReview ? 0 : Math.max(0, review.reviewOverheadSeconds || 0);

  const finish = (solveSeconds, { source, sampleCount, confidence, note = null }) => ({
    questionId: question?.id ?? null,
    seconds: Math.max(60, Math.round(solveSeconds + reviewSeconds)),
    solveSeconds: Math.max(60, Math.round(solveSeconds)),
    // タイマーに含まれているぶんは 0。内訳として、分かる範囲だけを返す。
    reviewSeconds,
    reviewIncludedInSolve: review.timerIncludesReview,
    source,
    sampleCount,
    confidence,
    method: ESTIMATE_METHOD_VERSION,
    updatedAt: new Date(now).toISOString(),
    note,
  });

  // 1. 本人の指定は、そのまま使う。
  if (stored?.manualSeconds) {
    return finish(stored.manualSeconds, {
      source: 'manual',
      sampleCount: 0,
      confidence: 'high',
      note: '利用者が指定した時間です。',
    });
  }

  const fallbackSeconds = stored?.aiSeconds
    ? stored.aiSeconds
    : defaultEstimateSeconds(question, defaults);
  const fallbackSource = stored?.aiSeconds ? 'ai_estimate' : 'default';

  // 2. 同じ問題の、近い条件の実績。
  const usable = usableSamples(history, { truncatedChallengeIds });
  const sameCondition = usable.filter((record) => Boolean(record.challengeId) === Boolean(condition.inChallenge));
  // 初見の見積もりには初見の記録を、復習には2回目以降の記録を使う。
  const wanted = sameCondition.filter((record, index) => (condition.firstTry ? index === 0 : index > 0));
  const ownSamples = (wanted.length ? wanted : sameCondition).map((record) => record.durationSeconds);

  if (ownSamples.length) {
    const own = median(ownSamples);
    if (ownSamples.length >= SAMPLE_LIMITS.enoughSamples) {
      return finish(own, {
        source: 'history',
        sampleCount: ownSamples.length,
        confidence: 'high',
        note: `同じ問題の${condition.inChallenge ? 'チャレンジでの' : ''}実績${ownSamples.length}件の中央値です。`,
      });
    }
    // 記録が少ないときは、既定値（または仮見積もり）と混ぜて落ち着かせる。
    const weight = ownSamples.length;
    const blended = (own * weight + fallbackSeconds * (SAMPLE_LIMITS.enoughSamples - weight))
      / SAMPLE_LIMITS.enoughSamples;
    return finish(blended, {
      source: 'history_blended',
      sampleCount: ownSamples.length,
      confidence: 'medium',
      note: `同じ問題の実績${ownSamples.length}件と、${fallbackSource === 'ai_estimate' ? '仮見積もり' : '既定値'}を合わせた値です。`,
    });
  }

  // 3. 似た問題の実績。
  const similarSamples = usableSamples(similar, { truncatedChallengeIds })
    .filter((record) => Boolean(record.challengeId) === Boolean(condition.inChallenge))
    .map((record) => record.durationSeconds);
  if (similarSamples.length >= SAMPLE_LIMITS.enoughSamples) {
    return finish(median(similarSamples), {
      source: 'similar',
      sampleCount: similarSamples.length,
      confidence: 'medium',
      note: `同じ単元・種類・難易度の問題での実績${similarSamples.length}件の中央値です。`,
    });
  }

  // 4. 仮見積もり、または既定値。
  return finish(fallbackSeconds, {
    source: fallbackSource,
    sampleCount: similarSamples.length,
    confidence: 'low',
    note: fallbackSource === 'ai_estimate'
      ? '教材をもとにAIが入れた仮の見積もりです（実績ではありません）。'
      : '実績がないため、種類と難易度から決めた仮の値です。',
  });
}

/** 見積もりの確からしさを、人が読める言葉にする。 */
export const CONFIDENCE_LABELS = Object.freeze({
  high: '実績あり',
  medium: 'おおよそ',
  low: '仮の値',
});
