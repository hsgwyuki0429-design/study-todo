// 計画づくりのために「数えられること」を数える層。
//
// 役割の分け方をはっきりさせておく。
//
//   ここ（アプリ・サーバー）… 実績の集計、残りの量、時間の見積もり、制約の確認、安全な保存
//   Claude                  … 目標や事情をふまえた優先順位の判断、日々の配分案、理由の説明
//
// Claude は getPlanningContext で「今どうなっているか」をまとめて受け取り、
// 配分案を作って validatePlanChanges で確かめ、applyTaskChanges で反映する。
// 数えられることを Claude に推測させない。逆に、何を優先するかはここでは決めない。

import { dateKeyOf, shiftDateKey } from "../../src/datetime.js";
import { durationEntriesByStudyDate } from "../../src/records-model.js";
import { itemsOf, splitPlanItems } from "../../src/plan-items.js";
import { goalAttempts, questionSatisfied } from "../../src/goals.js";
import {
  CONFIDENCE_LABELS,
  DEFAULT_ESTIMATE_SECONDS,
  estimateForQuestion,
} from "../../src/estimates.js";
import { availabilityForDate } from "../../src/availability.js";

/** 予定項目ID → 目標ID の対応表。実績を目標へ結び付けるときに使う。 */
export function buildItemGoalMap(plans = []) {
  const map = new Map();
  for (const plan of plans) {
    for (const task of plan.tasks ?? []) {
      for (const item of itemsOf(task)) {
        if (item.goalId) map.set(item.itemId, item.goalId);
      }
    }
  }
  return map;
}

/** 制限時間で終わったチャレンジ。その中の記録は「解き終えるのに必要な時間」ではない。 */
export function truncatedChallengeIds(challenges = []) {
  return new Set(challenges.filter((result) => result.succeeded === false).map((result) => result.id));
}

/**
 * 1問ぶんの見積もりを作る（サーバー側の入口）。
 * 本人の実績・似た問題の実績・保存された指定・既定値から決める。
 */
export function estimateFor(questionId, {
  questions,
  recordsByQuestion,
  questionsByGroup,
  estimates = {},
  availability,
  truncated = new Set(),
  inChallenge = false,
  now = Date.now(),
} = {}) {
  const question = questions.get(questionId) ?? null;
  const history = recordsByQuestion.get(questionId) ?? [];
  const group = groupKeyOf(question);
  const similar = [];
  if (group && questionsByGroup.has(group)) {
    for (const id of questionsByGroup.get(group)) {
      if (id === questionId) continue;
      similar.push(...(recordsByQuestion.get(id) ?? []));
    }
  }
  return estimateForQuestion({
    question,
    history,
    similar,
    stored: estimates[questionId] ?? null,
    // すでに取り組んだことがあるなら復習として見積もる。
    condition: { firstTry: history.length === 0, inChallenge },
    review: {
      timerIncludesReview: availability.timerIncludesReview,
      reviewOverheadSeconds: availability.reviewOverheadSeconds,
    },
    defaults: DEFAULT_ESTIMATE_SECONDS,
    truncatedChallengeIds: truncated,
    now,
  });
}

const groupKeyOf = (question) =>
  (question ? `${question.subject}|${question.section}|${question.type}|${question.difficulty ?? "?"}` : null);

/** 似た問題を引くための索引。 */
export function buildQuestionGroups(questions) {
  const groups = new Map();
  for (const question of questions.values()) {
    const key = groupKeyOf(question);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(question.id);
  }
  return groups;
}

/**
 * 目標の進み具合を数える。
 *
 * 実績として数えるのは「この目標に結び付いた予定から実施された取り組み」だけ。
 * 同じ問題を別の目的で解いた記録を、勝手に流用しない。
 */
export function goalProgress(goal, context) {
  const {
    records, itemGoalMap, plans, questions, estimateOf, today,
  } = context;

  const attemptsByQuestion = goalAttempts(goal, { records, itemGoalMap });

  // この目標に結び付いた、まだ実施していない予定（日付つき）。
  const plannedByQuestion = new Map();
  for (const plan of plans) {
    for (const task of plan.tasks ?? []) {
      const split = splitPlanItems(task, records, { date: plan.date, allowLegacyMatch: false });
      for (const item of split.pending) {
        if (item.goalId !== goal.id) continue;
        if (!plannedByQuestion.has(item.questionId)) plannedByQuestion.set(item.questionId, []);
        plannedByQuestion.get(item.questionId).push({ ...item, date: plan.date, taskId: task.id });
      }
    }
  }

  const satisfied = [];
  const unsatisfied = [];
  for (const questionId of goal.questionIds) {
    const attempts = attemptsByQuestion.get(questionId) ?? [];
    if (questionSatisfied(goal, attempts)) satisfied.push(questionId);
    else unsatisfied.push(questionId);
  }

  const plannedQuestionIds = unsatisfied.filter((id) => plannedByQuestion.has(id));
  const unplannedQuestionIds = unsatisfied.filter((id) => !plannedByQuestion.has(id));

  // 残りの見積もり時間。「1問につきあと1回」ぶんだけを足す。
  let remainingSeconds = 0;
  const perQuestion = [];
  for (const questionId of unsatisfied) {
    const estimate = estimateOf(questionId);
    remainingSeconds += estimate.seconds;
    perQuestion.push({ questionId, seconds: estimate.seconds, source: estimate.source, confidence: estimate.confidence });
  }

  const mastery = goal.completion.type === "mastery";
  return {
    goalId: goal.id,
    title: goal.title,
    status: goal.status,
    priority: goal.priority,
    startDate: goal.startDate,
    deadline: goal.deadline || null,
    completion: goal.completion,
    needsScopeSetup: goal.needsScopeSetup,
    revision: goal.revision,
    totalQuestions: goal.questionIds.length,
    satisfiedCount: satisfied.length,
    unsatisfiedCount: unsatisfied.length,
    unsatisfiedQuestionIds: unsatisfied,
    plannedQuestionIds,
    plannedItems: [...plannedByQuestion.values()].flat().map((item) => ({
      itemId: item.itemId, questionId: item.questionId, date: item.date, taskId: item.taskId,
    })),
    unplannedQuestionIds,
    // 「あと1回ずつ取り組む」ぶんの見積もり。
    remainingSeconds,
    remainingMinutes: Math.round(remainingSeconds / 60),
    perQuestionEstimates: perQuestion,
    // 「取り組む目標」は、これで残量が出そろう。
    // 「習得する目標」は、あと何回で条件を満たせるか分からないので、
    // 残り1回ぶんの見積もりと、達成までの総時間が不確実であることを分けて返す。
    remainingIsComplete: !mastery,
    remainingNote: mastery
      ? "習得する目標のため、これは「未達成の問題にあと1回ずつ取り組む」ぶんの見積もりです。"
        + " 何回で条件を満たせるかは分からないので、達成までの総時間はこれ以上になることがあります。"
      : "未実施の問題に1回ずつ取り組むぶんの見積もりです。",
    achievedByCompletion: satisfied.length === goal.questionIds.length && goal.questionIds.length > 0,
    daysLeft: goal.deadline ? daysBetween(today, goal.deadline) : null,
  };
}

function daysBetween(from, to) {
  const left = Date.parse(`${from}T00:00:00Z`);
  const right = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.round((right - left) / 86400000);
}

/** from から to までの日付を並べる。 */
export function dateRange(from, to, { max = 120 } = {}) {
  const dates = [];
  let cursor = from;
  while (cursor <= to && dates.length < max) {
    dates.push(cursor);
    cursor = shiftDateKey(cursor, 1);
  }
  return dates;
}

/**
 * 期間の各日について「使える時間」と「すでに置いてある予定の時間」を出す。
 */
export function buildDays({
  dates, plans, records, availability, estimateOf, today, timezoneOffsetMinutes,
}) {
  const planByDate = new Map(plans.map((plan) => [plan.date, plan]));
  const spentByDate = new Map();
  for (const record of records) {
    for (const [date, seconds] of durationEntriesByStudyDate(record, timezoneOffsetMinutes)) {
      spentByDate.set(date, (spentByDate.get(date) ?? 0) + seconds);
    }
  }

  return dates.map((date) => {
    const plan = planByDate.get(date) ?? null;
    const capacity = availabilityForDate(availability, date, {
      spentSeconds: spentByDate.get(date) ?? 0,
      isToday: date === today,
    });
    const pending = [];
    for (const task of plan?.tasks ?? []) {
      const split = splitPlanItems(task, records, { date, allowLegacyMatch: false });
      for (const item of split.pending) {
        const estimate = estimateOf(item.questionId, { inChallenge: task.kind === "challenge" });
        pending.push({
          itemId: item.itemId,
          taskId: task.id,
          questionId: item.questionId,
          goalId: item.goalId ?? null,
          kind: task.kind,
          estimateSeconds: estimate.seconds,
          estimateSource: estimate.source,
          confidence: estimate.confidence,
          originalDate: item.originalDate,
          carriedCount: item.carriedCount,
          locked: task.completed === true || task.pinned === true,
        });
      }
    }
    const plannedSeconds = pending.reduce((sum, item) => sum + item.estimateSeconds, 0);
    const plannedMinutes = Math.round(plannedSeconds / 60);
    return {
      date,
      isToday: date === today,
      revision: Number(plan?.revision ?? 0),
      capacity,
      plannedMinutes,
      plannedSeconds,
      pendingItems: pending,
      // 使える時間が未設定の日は、足りているかどうかも判断しない。
      remainingMinutes: capacity.available === null ? null : capacity.available - plannedMinutes,
      overCapacity: capacity.available === null ? null : plannedMinutes > capacity.available,
    };
  });
}

export { CONFIDENCE_LABELS };
