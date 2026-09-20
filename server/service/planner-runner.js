// 自動プランナーの本体。取得 → 判断 → 配分 → 検証 → 反映 → 読み直し を統括する。
//
// 分担:
//   Jev  … 履歴から読み取る小さな判断（復習の必要度・次の行動・次の間隔）だけ。
//   ここ … 候補の絞り込み、日付への配置、制約の確認、保存、結果の記録。
//
// 自動で保存するので、対話のときより厳しくする。
//   ・validatePlanChanges の warnings は「気づき」ではなく停止条件として扱う。
//     over_capacity / capacity_not_configured / after_deadline / single_item_too_long が
//     1件でも出たら、その案は保存しない（配分エンジンが作らないはずのもの＝取りこぼし）。
//   ・判断した時点と保存の時点がずれていないか、plannerSnapshotVersion で確かめる。
//   ・operationId は eventId から作る。結果が分からないときは、同じ要求をそのまま送り直す。
//     内容を変えた要求を重ねると、二重の予定になりうる。

import { shiftDateKey } from '../../src/datetime.js';
import { goalAttempts } from '../../src/goals.js';
import { CHANGE_LIMITS } from './task-changes.js';
import { buildItemGoalMap } from './planning.js';
import { JEV_BATCH_SIZE, askJev } from './jev-client.js';
import {
  POLICY_DEFAULTS, PRIORITY_BUCKETS, REVIEW_NEED_LEVELS,
  actionFrom, compareCandidates, difficultyDeferred, explain, intervalDaysFrom,
  keepForLongTerm, reviewNeedFrom,
} from './planner-policy.js';
import {
  bucketFor, dueDateFor, featuresFor, jevStateFor, prerequisiteFor,
} from './planner-features.js';
import { allocate, buildChanges, buildSlots } from './planner-allocation.js';

/** 初期の計画範囲。API の上限（60日）より短くして、毎日ずらしながら埋めていく。 */
export const PLANNING_HORIZON_DAYS = 14;

/** 自動反映を止める警告。ここに出たものは「配分の取りこぼし」として扱う。 */
export const BLOCKING_WARNINGS = Object.freeze([
  'over_capacity', 'capacity_not_configured', 'after_deadline', 'single_item_too_long',
]);

const QUESTION_LIMIT = 2000;

/**
 * Jev への質問（1候補ぶん）。質問どうしは独立に評価されるので、
 * 片方の答えを参照させる書き方はしない。
 */
export function questionsFor(key) {
  return {
    [`${key}__review_need`]: {
      type: 'score',
      instructions: 'この問題の評価履歴が示す、もう一度確認する必要度を判定する。'
        + '解答の中身や、計測していない原因を推測しない。',
      criteria: [...REVIEW_NEED_LEVELS],
    },
    [`${key}__next_action`]: {
      type: 'choice',
      instructions: 'この問題の履歴と、使える前提情報に照らして、次の学習行動を選ぶ。'
        + '判断の材料が足りなければ unknown。ほかの質問の答えは参照しない。',
      criteria: {
        repeat: '同じ問題をもう一度解く',
        prerequisite: '確認済みの関連する基礎を先に置く',
        keep: '今の方針を保つ',
        unknown: '判断の材料が足りない',
      },
    },
    [`${key}__next_review_interval`]: {
      type: 'choice',
      instructions: 'この問題を次に解くまでの望ましい間隔を選ぶ。'
        + '根拠にしてよいのは、評価履歴・前回からの経過日数・perfectの回数だけ。'
        + '実際の予定日や、その日に使える時間は決めない。材料が足りなければ unknown。',
      criteria: {
        day_1: '翌日に確認する',
        day_3: '3日後に確認する',
        day_7: '7日後に確認する',
        day_14: '14日後に確認する',
        day_30: '30日後に確認する',
        unknown: '間隔を決める材料が足りない',
      },
    },
  };
}

/** 候補を小分けにして Jev へ尋ねる。失敗しても止めず、規則へ戻すために null を返す。 */
export async function askForCandidates(candidates, { env, fetchImpl, batchSize = JEV_BATCH_SIZE }) {
  const answers = new Map();
  const usage = { inputTokens: 0, outputTokens: 0, requests: 0, failed: 0 };
  let lastError = null;
  for (let start = 0; start < candidates.length; start += batchSize) {
    const batch = candidates.slice(start, start + batchSize);
    const state = { candidates: {} };
    let questions = {};
    batch.forEach((candidate, index) => {
      const key = `c${index}`;
      state.candidates[key] = jevStateFor(candidate.features);
      questions = { ...questions, ...questionsFor(key) };
    });
    const result = await askJev({ state, questions }, { env, fetchImpl });
    usage.requests += 1;
    if (!result.ok) {
      usage.failed += 1;
      lastError = { error: result.error, retryable: result.retryable === true, httpStatus: result.httpStatus };
      // 認証・設定の誤りは、残りの batch を送っても同じ結果になる。繰り返し呼ばない。
      if (['missing_secrets', 'invalid_configuration', 'authentication', 'permission'].includes(result.error)) break;
      continue;
    }
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    batch.forEach((candidate, index) => {
      const key = `c${index}`;
      answers.set(candidate.key, {
        reviewNeed: result.answers[`${key}__review_need`],
        nextAction: result.answers[`${key}__next_action`],
        interval: result.answers[`${key}__next_review_interval`],
      });
    });
  }
  return { answers, usage, lastError };
}

export function createPlannerRunner({ service, sync, env = {}, fetchImpl = fetch, now = () => Date.now(), policy = POLICY_DEFAULTS }) {
  /**
   * 1回ぶんの計画づくり。
   *   apply=false（shadow）… 案を作るところまでで、保存はしない。
   */
  async function run(event, { apply = true } = {}) {
    const context = await service.getPlanningContext({
      unplannedLimit: QUESTION_LIMIT, overdueLimit: QUESTION_LIMIT,
    });
    const today = context.today;

    const [questionsDoc, records, relations, rawGoals, wholePlans] = await Promise.all([
      sync.readQuestions(),
      sync.readAllRecords(),
      sync.readRelationEntries().then((entries) => Object.values(entries)),
      sync.readGoals(),
      sync.readTaskPlansInRange(shiftDateKey(today, -400), shiftDateKey(today, 400)),
    ]);
    const questions = new Map((questionsDoc.questions ?? []).map((question) => [question.id, question]));
    const itemGoalMap = buildItemGoalMap(wholePlans);
    const historyByQuestion = new Map();
    for (const record of [...records].sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)))) {
      if (!historyByQuestion.has(record.questionId)) historyByQuestion.set(record.questionId, []);
      historyByQuestion.get(record.questionId).push(record);
    }

    const built = buildCandidates({
      context, questions, historyByQuestion, relations, goals: rawGoals,
      records, itemGoalMap, today, policy,
    });
    if (!built.candidates.length) {
      return { state: 'no_change', reason: 'no_candidates', today, proposed: 0, applied: 0 };
    }

    // Jev へ尋ねるのは、履歴がある候補だけ（初見の問題に判断させることは無い）。
    const asked = built.candidates.filter((candidate) => candidate.features.attemptCount > 0);
    const { answers, usage, lastError } = asked.length
      ? await askForCandidates(asked, { env, fetchImpl })
      : { answers: new Map(), usage: { inputTokens: 0, outputTokens: 0, requests: 0, failed: 0 }, lastError: null };

    // 設定・権限の誤りは、予定を触らずに知らせる（繰り返し呼ばない）。
    if (lastError && !answers.size
      && ['missing_secrets', 'invalid_configuration', 'authentication', 'permission'].includes(lastError.error)) {
      return { state: 'failed', error: lastError.error, retryable: false, today, proposed: 0, applied: 0 };
    }

    const decided = decide(built.candidates, answers, { today, policy, questions, relations, built });
    decided.sort((left, right) => compareCandidates(left, right, { today, policy }));

    const slots = buildSlots(context.days, { keepItemIds: built.keepItemIds });
    const { placements, unplaced } = allocate(decided, slots, { today, maxPerDay: CHANGE_LIMITS.tasksPerDay });
    const { changes, dates, skipped } = buildChanges(placements, { today, limits: CHANGE_LIMITS });

    const summary = {
      today, from: context.from, to: context.to,
      proposed: placements.length,
      unplaced: unplaced.map((entry) => ({ questionId: entry.questionId, goalId: entry.goalId ?? null, reason: entry.reason })),
      deferredToNextRun: skipped.length,
      usage,
      ...(lastError ? { providerError: lastError.error } : {}),
      decisions: decided.slice(0, 50).map((candidate) => ({
        questionId: candidate.questionId,
        goalId: candidate.goalId ?? null,
        bucket: candidate.bucket,
        source: candidate.decisionSource,
        intervalDays: candidate.intervalDays,
        desiredDate: candidate.desiredDate,
        reason: explain(candidate),
      })),
    };

    if (!changes.length) return { state: 'no_change', reason: 'nothing_to_move', ...summary, applied: 0 };
    if (!apply) return { state: 'validated', shadow: true, ...summary, applied: 0, changes: changes.length };

    // 反映する日の版。過去日は context.overdue が、期間内は days が持っている。
    const revisions = revisionsFor(dates, context, built.overdueRevisions);
    const missing = dates.filter((date) => revisions.get(date) === undefined);
    if (missing.length) return { state: 'failed', error: 'missing_revision', detail: missing[0], retryable: true, ...summary, applied: 0 };

    const request = {
      operationId: `auto-replan-${event.eventId}`.slice(0, CHANGE_LIMITS.operationIdLength),
      reason: `自動プランナー（${event.trigger}）`,
      expectedRevisions: dates.map((date) => ({ date, revision: revisions.get(date) })),
      expectedContext: context.expectedContext,
      changes,
    };
    const actor = { clientName: 'planner', tokenLabel: 'planner' };

    const checked = await service.validatePlanChanges(request, actor);
    if (!checked.ok) return { state: 'failed', error: checked.error, retryable: true, ...summary, applied: 0 };
    const blocking = (checked.warnings ?? []).filter((warning) => BLOCKING_WARNINGS.includes(warning.type));
    if (blocking.length) {
      // ok=true でも、これが出ている案は自動では保存しない。
      return { state: 'failed', error: 'blocking_warning', detail: blocking[0].type, retryable: false, ...summary, applied: 0, warnings: blocking };
    }

    const result = await service.applyTaskChanges(request, actor);
    if (!result.ok) return { state: 'failed', error: result.error, retryable: true, ...summary, applied: 0 };

    // 反映を読み直して、本当に入っているかを確かめてから applied と呼ぶ。
    const after = await service.getPlanningContext({ unplannedLimit: 1, overdueLimit: 1 });
    return {
      state: 'applied', ...summary, applied: changes.length,
      appliedAt: new Date(now()).toISOString(),
      changeId: result.changeId ?? null,
      verifiedDates: after.days.filter((day) => dates.includes(day.date)).map((day) => ({ date: day.date, revision: day.revision })),
    };
  }

  return { run };
}

/** 反映する日の期待版。期間外（過去日）の分は overdue の revision を使う。 */
function revisionsFor(dates, context, overdueRevisions) {
  const map = new Map();
  for (const day of context.days) map.set(day.date, day.revision);
  for (const [date, revision] of overdueRevisions) if (!map.has(date)) map.set(date, revision);
  return new Map(dates.map((date) => [date, map.get(date)]));
}

/**
 * 候補を作る。
 *
 *   A. 過ぎた日に残っている、やり残しの予定（必ず置き直す）
 *   B. 目標の未配置分（まだ予定に入っていない問題）
 *   C. ✕方針が違った が続いた問題の、確認済みの土台
 *   D. クリア済みでも長期復習に残す問題
 *
 * すでにこれからの日に置いてある予定は、動かさずそのままにする（無用な入れ替えを避ける）。
 */
export function buildCandidates({
  context, questions, historyByQuestion, relations, goals, records, itemGoalMap, today, policy,
}) {
  const activeGoals = goals.filter((goal) => goal.status === 'active' && !goal.deletedAt);
  const goalById = new Map(activeGoals.map((goal) => [goal.id, goal]));
  const progressById = new Map(context.goals.map((entry) => [entry.goalId, entry]));

  // これから置いてある予定は触らない。その時間は先に押さえておく。
  const keepItemIds = new Set();
  const plannedKeys = new Set();
  for (const day of context.days) {
    for (const item of day.pendingItems) {
      keepItemIds.add(item.itemId);
      plannedKeys.add(`${item.goalId ?? '-'}|${item.questionId}`);
    }
  }

  const estimateByQuestion = new Map();
  for (const day of context.days) {
    for (const item of day.pendingItems) estimateByQuestion.set(item.questionId, item.estimateSeconds);
  }
  for (const entry of context.unplanned) estimateByQuestion.set(entry.questionId, entry.estimateSeconds);
  for (const entry of context.overdue) estimateByQuestion.set(entry.questionId, entry.estimateSeconds);

  const estimateOf = (questionId) => ({
    seconds: estimateByQuestion.get(questionId) ?? 720,
    source: 'context',
    confidence: 'medium',
  });

  const orderOf = (questionId) => {
    const question = questions.get(questionId);
    if (!question) return 9999;
    return question.number ?? 9999;
  };

  const attemptsCache = new Map();
  const attemptsFor = (goal) => {
    if (!attemptsCache.has(goal.id)) attemptsCache.set(goal.id, goalAttempts(goal, { records, itemGoalMap }));
    return attemptsCache.get(goal.id);
  };

  // 難易度の進み方を見るための、3以下の未クリアの数。
  let remainingBelowGate = 0;
  for (const entry of progressById.values()) {
    for (const questionId of entry.unsatisfiedQuestionIds ?? []) {
      if ((questions.get(questionId)?.difficulty ?? 9) <= 3) remainingBelowGate += 1;
    }
  }

  const candidates = [];
  const seen = new Set();
  const overdueRevisions = new Map();

  const push = (candidate) => {
    if (seen.has(candidate.key)) return;
    seen.add(candidate.key);
    candidates.push(candidate);
  };

  const makeCandidate = ({ questionId, goalId, itemId = null, taskId = null, fromDate = null, isUnfinished = false, isPrerequisite = false }) => {
    const goal = goalId ? goalById.get(goalId) : null;
    const history = historyByQuestion.get(questionId) ?? [];
    const attempts = goal ? (attemptsFor(goal).get(questionId) ?? []) : [];
    const features = featuresFor({
      questionId, question: questions.get(questionId) ?? null, attempts, history,
      estimate: estimateOf(questionId), today,
    });
    return {
      key: itemId ?? `${goalId ?? '-'}|${questionId}${isPrerequisite ? '|pre' : ''}`,
      questionId, goalId: goalId ?? null, itemId, taskId, fromDate,
      isUnfinished, isPrerequisite,
      features,
      estimateSeconds: features.estimateSeconds,
      difficulty: features.difficulty,
      goalPriority: goal?.priority ?? 3,
      goalDeadline: goal?.deadline || null,
      order: orderOf(questionId),
      // 予定の種類。初見は new、解いたことがあるものは review として置く。
      taskKind: features.attemptCount > 0 ? 'review' : 'new',
      perfectCount: features.perfectCount,
      lastEvaluation: features.lastEvaluation,
      deferred: difficultyDeferred(features, { remainingBelowGate }, policy),
    };
  };

  // A. やり残し（過ぎた日に残っている予定）。
  for (const entry of context.overdue) {
    overdueRevisions.set(entry.date, entry.revision);
    push({
      ...makeCandidate({
        questionId: entry.questionId, goalId: entry.goalId, itemId: entry.itemId,
        taskId: entry.taskId, fromDate: entry.date, isUnfinished: true,
      }),
    });
  }

  // B. 目標の未配置分。
  for (const entry of context.unplanned) {
    if (plannedKeys.has(`${entry.goalId}|${entry.questionId}`)) continue;
    push(makeCandidate({ questionId: entry.questionId, goalId: entry.goalId }));
  }

  // D. クリア済みでも長期復習に残すもの。
  for (const goal of activeGoals) {
    const progress = progressById.get(goal.id);
    if (!progress) continue;
    const satisfied = new Set(goal.questionIds.filter((id) => !progress.unsatisfiedQuestionIds.includes(id)));
    for (const questionId of satisfied) {
      if (plannedKeys.has(`${goal.id}|${questionId}`)) continue;
      const history = historyByQuestion.get(questionId) ?? [];
      if (!history.length) continue;
      const features = featuresFor({
        questionId, question: questions.get(questionId) ?? null, attempts: [], history,
        estimate: estimateOf(questionId), today,
      });
      if (!keepForLongTerm(features, policy)) continue;
      push(makeCandidate({ questionId, goalId: goal.id }));
    }
  }

  return {
    candidates, keepItemIds, plannedKeys, overdueRevisions, remainingBelowGate,
    relations, questions, goalById, progressById, historyByQuestion, estimateOf, makeCandidate, today,
  };
}

/**
 * 判断を候補へ当てはめる。
 * Jev の答えが無い・低確信度・unknown のときは、決定的な規則へ戻す。
 */
export function decide(candidates, answers, { today, policy, questions, relations, built }) {
  const decided = [];
  const added = new Set(candidates.map((candidate) => candidate.key));

  for (const candidate of candidates) {
    const answer = answers.get(candidate.key) ?? {};
    const { need, source: needSource } = reviewNeedFrom(answer.reviewNeed, candidate.features, policy);
    const { days, source: intervalSource } = intervalDaysFrom(answer.interval, candidate.features, policy);
    const { action } = actionFrom(answer.nextAction, policy);

    const dueDate = candidate.isUnfinished
      // やり残しは、間隔ではなく「できるだけ早く」置き直す。
      ? today
      : dueDateFor(candidate.features, days, today);

    const enriched = {
      ...candidate,
      reviewNeed: need,
      intervalDays: days,
      dueDate,
      desiredDate: dueDate,
      decisionSource: needSource === 'jev' || intervalSource === 'jev' ? 'jev' : intervalSource,
      bucket: bucketFor({
        isPrerequisite: candidate.isPrerequisite,
        dueDate, today,
        hasAttempts: candidate.features.attemptCount > 0,
        isUnfinished: candidate.isUnfinished,
      }),
    };
    decided.push(enriched);

    // C. 「関連する基礎へ戻る」。保存された関連の中に、対象として使えるものがあるときだけ。
    if (action !== 'prerequisite') continue;
    const prerequisite = prerequisiteFor(candidate.questionId, {
      relations,
      allowedQuestionIds: new Set(built.questions.keys()),
      satisfiedQuestionIds: new Set(),
    });
    if (!prerequisite) continue;
    const extra = built.makeCandidate({
      questionId: prerequisite.questionId, goalId: candidate.goalId, isPrerequisite: true,
    });
    if (added.has(extra.key) || built.plannedKeys.has(`${candidate.goalId ?? '-'}|${prerequisite.questionId}`)) continue;
    added.add(extra.key);
    decided.push({
      ...extra,
      reviewNeed: 2,
      intervalDays: 0,
      dueDate: today,
      desiredDate: today,
      decisionSource: 'jev',
      relationSource: prerequisite.source,
      bucket: PRIORITY_BUCKETS.prerequisite,
    });
    // 土台へ戻る間は、元の問題は少なくとも翌日以降へ。
    enriched.desiredDate = enriched.desiredDate > today ? enriched.desiredDate : shiftDateKey(today, 1);
  }
  return decided;
}
