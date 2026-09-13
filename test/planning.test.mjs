// 目標・学習可能時間・見積もり・再計画の確認。

import { test } from "node:test";
import assert from "node:assert/strict";

import { QUESTIONS, call, callTool, createTestApp, enableAiLink, joinDevice } from "./helpers.mjs";

const Q = QUESTIONS.map((question) => question.id);
const NOW = Date.parse("2026-09-12T03:00:00Z");   // 日本時間 2026-09-12 12:00

async function setup({ now = () => NOW } = {}) {
  const { app } = createTestApp({ now });
  const token = await enableAiLink(app);
  const device = await joinDevice(app);
  await call(app, "/api/sync/push", {
    method: "POST", token: device.deviceKey,
    body: { questions: { questions: QUESTIONS } },
  });
  return { app, token, device };
}

const push = (app, device, body) => call(app, "/api/sync/push", { method: "POST", token: device.deviceKey, body });

function attempt(id, { questionId = Q[0], timestamp = "2026-09-12T02:00:00Z", evaluation = "perfect", durationSeconds = 600, ...rest } = {}) {
  return { id, questionId, timestamp, evaluation, durationSeconds, ...rest };
}

/** 目標に結び付いた予定を1件置いて、その itemId を返す。 */
async function planFor(app, token, { date, goalId, questionIds, operationId }) {
  const before = await callTool(app, token, "getTodayTasks", { date });
  const result = await callTool(app, token, "applyTaskChanges", {
    operationId,
    expectedRevisions: [{ date, revision: before.revision }],
    changes: [{ op: "add", date, task: { questionIds, kind: "new", goalId } }],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = await callTool(app, token, "getTodayTasks", { date });
  const task = after.tasks[after.tasks.length - 1];
  return { taskId: task.id, items: task.items, revision: after.revision };
}

/* ------------------------------------------------------------------ */
/* 目標                                                                */
/* ------------------------------------------------------------------ */

test("取り組む目標では、不正解でも実施数が増える", async () => {
  const { app, token, device } = await setup();
  const goal = await callTool(app, token, "addGoal", {
    title: "1周目", questionIds: [Q[0], Q[1]], completion: { type: "attempt" },
  });
  const { items } = await planFor(app, token, { date: "2026-09-12", goalId: goal.goal.id, questionIds: [Q[0]], operationId: "p1" });
  await push(app, device, { records: [attempt("r1", { questionId: Q[0], evaluation: "wrong_approach", planItemId: items[0].itemId })] });

  const progress = await callTool(app, token, "getGoalProgress", { goalIds: [goal.goal.id] });
  const entry = progress.goals[0];
  assert.equal(entry.satisfiedCount, 1, "✕でも「取り組んだ」として数える");
  assert.equal(entry.unsatisfiedCount, 1);
  assert.equal(entry.remainingIsComplete, true);
});

test("習得する目標は、決めた評価で判定される（最新の取り組みで見る）", async () => {
  const { app, token, device } = await setup();
  const goal = await callTool(app, token, "addGoal", {
    title: "習得", questionIds: [Q[0]], completion: { type: "mastery" },
  });
  const { items } = await planFor(app, token, { date: "2026-09-12", goalId: goal.goal.id, questionIds: [Q[0]], operationId: "p1" });
  assert.equal(goal.goal.completion.evaluations[0], "perfect");

  await push(app, device, { records: [attempt("r1", { evaluation: "calc_error", planItemId: items[0].itemId })] });
  let progress = await callTool(app, token, "getGoalProgress", { goalIds: [goal.goal.id] });
  assert.equal(progress.goals[0].satisfiedCount, 0, "△では達成にならない");
  assert.equal(progress.goals[0].remainingIsComplete, false, "習得までの総時間は不確実");
  assert.match(progress.goals[0].remainingNote, /あと1回ずつ/);

  await push(app, device, {
    records: [attempt("r2", { evaluation: "perfect", timestamp: "2026-09-12T02:30:00Z", planItemId: items[0].itemId })],
  });
  progress = await callTool(app, token, "getGoalProgress", { goalIds: [goal.goal.id] });
  assert.equal(progress.goals[0].satisfiedCount, 1);

  // 最新が条件を満たさなくなれば、また未達成に戻る（latest 方式）。
  await push(app, device, {
    records: [attempt("r3", { evaluation: "calc_error", timestamp: "2026-09-12T03:00:00Z", planItemId: items[0].itemId })],
  });
  progress = await callTool(app, token, "getGoalProgress", { goalIds: [goal.goal.id] });
  assert.equal(progress.goals[0].satisfiedCount, 0);
});

test("2周目の目標は、1周目の記録では達成にならない", async () => {
  const { app, token, device } = await setup();
  const first = await callTool(app, token, "addGoal", { title: "1周目", questionIds: [Q[0]] });
  const firstPlan = await planFor(app, token, { date: "2026-09-12", goalId: first.goal.id, questionIds: [Q[0]], operationId: "p1" });
  await push(app, device, { records: [attempt("r1", { planItemId: firstPlan.items[0].itemId })] });

  const second = await callTool(app, token, "addGoal", { title: "2周目", questionIds: [Q[0]], startDate: "2026-09-13" });
  const progress = await callTool(app, token, "getGoalProgress", { goalIds: [first.goal.id, second.goal.id] });
  const byId = Object.fromEntries(progress.goals.map((entry) => [entry.goalId, entry]));
  assert.equal(byId[first.goal.id].satisfiedCount, 1);
  assert.equal(byId[second.goal.id].satisfiedCount, 0, "1周目の記録を流用しない");
  assert.deepEqual(byId[second.goal.id].unplannedQuestionIds, [Q[0]]);
});

test("同じ取り組みを複数の目標に関連付けても、時間を二重に数えない", async () => {
  const { app, token } = await setup();
  const goalA = await callTool(app, token, "addGoal", { title: "A", questionIds: [Q[0]] });
  const goalB = await callTool(app, token, "addGoal", { title: "B", questionIds: [Q[0]] });
  // 予定は1つだけ置き、目標Aに結び付ける。
  await planFor(app, token, { date: "2026-09-12", goalId: goalA.goal.id, questionIds: [Q[0]], operationId: "p1" });

  const context = await callTool(app, token, "getPlanningContext", { from: "2026-09-12", to: "2026-09-12" });
  const day = context.days.find((entry) => entry.date === "2026-09-12");
  assert.equal(day.pendingItems.length, 1, "予定は1件のまま");
  const total = day.pendingItems.reduce((sum, item) => sum + item.estimateSeconds, 0);
  assert.equal(day.plannedSeconds, total, "日の合計は予定1件ぶんだけ");
  // 目標Bから見ると、まだ予定に入っていない（勝手に流用しない）。
  const progress = await callTool(app, token, "getGoalProgress", { goalIds: [goalB.goal.id] });
  assert.deepEqual(progress.goals[0].unplannedQuestionIds, [Q[0]]);
});

/* ------------------------------------------------------------------ */
/* 学習可能時間                                                        */
/* ------------------------------------------------------------------ */

test("曜日別・日付ごと・0分・未設定が、それぞれ区別される", async () => {
  const { app, token } = await setup();
  const before = await callTool(app, token, "getStudyAvailability", { from: "2026-09-12", to: "2026-09-14" });
  assert.equal(before.days[0].available, null);
  assert.equal(before.days[0].source, "not_configured");

  await callTool(app, token, "updateStudyAvailability", {
    weekly: { mon: 60, tue: 60, wed: 60, thu: 60, fri: 60, sat: 120, sun: null },
    overrides: { "2026-09-14": 0 },
  });
  const after = await callTool(app, token, "getStudyAvailability", { from: "2026-09-12", to: "2026-09-14" });
  const byDate = Object.fromEntries(after.days.map((day) => [day.date, day]));
  // 2026-09-12 は土曜、13 は日曜、14 は月曜。
  assert.equal(byDate["2026-09-12"].available, 120, "土曜は120分");
  assert.equal(byDate["2026-09-12"].source, "weekly");
  assert.equal(byDate["2026-09-13"].available, null, "日曜は未設定のまま（0分とは違う）");
  assert.equal(byDate["2026-09-13"].source, "not_configured");
  assert.equal(byDate["2026-09-13"].configured, false);
  assert.equal(byDate["2026-09-14"].available, 0, "日付ごとの上書きで0分にした月曜");
  assert.equal(byDate["2026-09-14"].source, "override");
  assert.equal(byDate["2026-09-14"].configured, true, "0分は「設定してある」扱い");

  await callTool(app, token, "updateStudyAvailability", { overrides: { "2026-09-15": 0 } });
  const zero = await callTool(app, token, "getStudyAvailability", { from: "2026-09-15", to: "2026-09-15" });
  assert.equal(zero.days[0].available, 0);
  assert.equal(zero.days[0].source, "override");
  assert.equal(zero.days[0].configured, true);
});

test("「今日はあと30分」から、実施済みの時間をもう一度引かない", async () => {
  const { app, token, device } = await setup();
  await callTool(app, token, "updateStudyAvailability", { weekly: { sat: 90 } });
  // 今日すでに40分（2400秒）学習している。
  await push(app, device, { records: [attempt("r1", { durationSeconds: 2400 })] });

  const standard = await callTool(app, token, "getStudyAvailability", { from: "2026-09-12", to: "2026-09-12" });
  assert.equal(standard.days[0].available, 50, "標準90分から実施済み40分を引く");
  assert.equal(standard.days[0].spentSubtracted, true);

  await callTool(app, token, "updateStudyAvailability", { todayRemainingMinutes: 30 });
  const remaining = await callTool(app, token, "getStudyAvailability", { from: "2026-09-12", to: "2026-09-12" });
  assert.equal(remaining.days[0].available, 30, "指定した残り時間から、さらに引かない");
  assert.equal(remaining.days[0].spentSubtracted, false);
  assert.equal(remaining.days[0].source, "today_remaining");
});

test("予備時間は1日につき1回だけ引かれる", async () => {
  const { app, token } = await setup();
  await callTool(app, token, "updateStudyAvailability", { weekly: { sat: 60, sun: 60 }, reserveMinutes: 10 });
  const days = await callTool(app, token, "getStudyAvailability", { from: "2026-09-12", to: "2026-09-13" });
  assert.deepEqual(days.days.map((day) => day.available), [50, 50]);
  assert.deepEqual(days.days.map((day) => day.reserveMinutes), [10, 10]);
});

/* ------------------------------------------------------------------ */
/* 見積もり                                                            */
/* ------------------------------------------------------------------ */

test("記録がない問題にも見積もりが返り、仮の値だと分かる", async () => {
  const { app, token } = await setup();
  const estimates = await callTool(app, token, "getQuestionEstimates", { questionIds: [Q[0]] });
  const entry = estimates.estimates[0];
  assert.ok(entry.seconds > 0);
  assert.equal(entry.source, "default");
  assert.equal(entry.confidence, "low");
  assert.equal(entry.method, "v1");
});

test("AIの仮見積もりは保存できるが、実績にはならない", async () => {
  const { app, token } = await setup();
  await callTool(app, token, "saveQuestionEstimates", { estimates: [{ questionId: Q[0], seconds: 900, note: "誌面から推定" }] });
  const estimates = await callTool(app, token, "getQuestionEstimates", { questionIds: [Q[0]] });
  assert.equal(estimates.estimates[0].seconds, 900);
  assert.equal(estimates.estimates[0].source, "ai_estimate");
  assert.equal(estimates.estimates[0].confidence, "low");
  // 学習実績は1件も増えない。
  assert.equal((await callTool(app, token, "getStudyStats")).totalRecords, 0);
});

test("初見・復習・チャレンジの実績を、無条件には混ぜない", async () => {
  const { app, token, device } = await setup();
  await push(app, device, {
    records: [
      attempt("r1", { durationSeconds: 900, timestamp: "2026-09-01T02:00:00Z" }),                   // 初見
      attempt("r2", { durationSeconds: 300, timestamp: "2026-09-05T02:00:00Z" }),                   // 復習
      attempt("r3", { durationSeconds: 200, timestamp: "2026-09-08T02:00:00Z" }),                   // 復習
      attempt("r4", { durationSeconds: 120, timestamp: "2026-09-09T02:00:00Z", challengeId: "c1" }), // チャレンジ
    ],
    challenges: [{ id: "c1", timestamp: "2026-09-09T02:00:00Z", succeeded: true, laps: [{ questionId: Q[0], durationSeconds: 120 }] }],
  });
  const normal = await callTool(app, token, "getQuestionEstimates", { questionIds: [Q[0]] });
  // すでに解いたことがあるので復習として見積もる（初見の900秒に引きずられない）。
  assert.ok(normal.estimates[0].seconds < 600, `復習の見積もりが大きすぎる: ${normal.estimates[0].seconds}`);
  assert.match(normal.estimates[0].source, /history/);

  const challenge = await callTool(app, token, "getQuestionEstimates", { questionIds: [Q[0]], inChallenge: true });
  assert.notEqual(challenge.estimates[0].seconds, normal.estimates[0].seconds, "チャレンジは別に見積もる");
});

test("極端な値・0秒・制限時間切れの記録で、見積もりが崩れない", async () => {
  const { app, token, device } = await setup();
  await push(app, device, {
    records: [
      attempt("r1", { durationSeconds: 0, timestamp: "2026-09-01T02:00:00Z" }),        // 計測忘れ
      attempt("r2", { durationSeconds: 20000, timestamp: "2026-09-02T02:00:00Z" }),    // 計測しっぱなし
      attempt("r3", { durationSeconds: 480, timestamp: "2026-09-03T02:00:00Z" }),
      attempt("r4", { durationSeconds: 520, timestamp: "2026-09-04T02:00:00Z" }),
      attempt("r5", { durationSeconds: 500, timestamp: "2026-09-05T02:00:00Z" }),
      attempt("r6", { durationSeconds: 60, timestamp: "2026-09-06T02:00:00Z", challengeId: "c1" }),
    ],
    challenges: [{ id: "c1", timestamp: "2026-09-06T02:00:00Z", succeeded: false, laps: [{ questionId: Q[0], durationSeconds: 60 }] }],
  });
  const estimates = await callTool(app, token, "getQuestionEstimates", { questionIds: [Q[0]] });
  const entry = estimates.estimates[0];
  assert.ok(entry.seconds >= 400 && entry.seconds <= 600, `外れ値に引っぱられている: ${entry.seconds}`);
  // 記録そのものは消えていない。
  assert.equal((await callTool(app, token, "getQuestionAttempts", { id: Q[0] })).totalAttempts, 6);

  // 制限時間で終わったチャレンジの記録は、チャレンジの見積もりにも使わない。
  const challenge = await callTool(app, token, "getQuestionEstimates", { questionIds: [Q[0]], inChallenge: true });
  assert.notEqual(challenge.estimates[0].seconds, 60);
});

test("答え合わせの時間を二重に足さない", async () => {
  const { app, token } = await setup();
  const base = await callTool(app, token, "getQuestionEstimates", { questionIds: [Q[0]] });
  assert.equal(base.estimates[0].reviewSeconds, 0, "既定ではタイマーに含まれているので足さない");
  assert.equal(base.estimates[0].reviewIncludedInSolve, true);

  await callTool(app, token, "updateStudyAvailability", { timerIncludesReview: false, reviewOverheadSeconds: 120 });
  const withReview = await callTool(app, token, "getQuestionEstimates", { questionIds: [Q[0]] });
  assert.equal(withReview.estimates[0].reviewSeconds, 120);
  assert.equal(withReview.estimates[0].seconds, base.estimates[0].seconds + 120);
  assert.equal(withReview.estimates[0].solveSeconds, base.estimates[0].solveSeconds, "解く時間は変わらない");
});

/* ------------------------------------------------------------------ */
/* 計画の検証と反映                                                    */
/* ------------------------------------------------------------------ */

test("すでに置いてある予定を、同じ目標でもう一度置こうとすると断られる", async () => {
  const { app, token } = await setup();
  const goal = await callTool(app, token, "addGoal", { title: "A", questionIds: [Q[0], Q[1]] });
  await planFor(app, token, { date: "2026-09-13", goalId: goal.goal.id, questionIds: [Q[0]], operationId: "p1" });

  const context = await callTool(app, token, "getPlanningContext", { from: "2026-09-12", to: "2026-09-14" });
  const target = context.days.find((day) => day.date === "2026-09-14");
  const denied = await callTool(app, token, "validatePlanChanges", {
    operationId: "dup",
    expectedRevisions: [{ date: "2026-09-14", revision: target.revision }],
    changes: [{ op: "add", date: "2026-09-14", task: { questionIds: [Q[0]], kind: "new", goalId: goal.goal.id } }],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "duplicate_plan_item");

  // 反映しようとしても同じように断られ、予定は変わらない。
  const applied = await callTool(app, token, "applyTaskChanges", {
    operationId: "dup-apply",
    expectedRevisions: [{ date: "2026-09-14", revision: target.revision }],
    changes: [{ op: "add", date: "2026-09-14", task: { questionIds: [Q[0]], kind: "new", goalId: goal.goal.id } }],
  });
  assert.equal(applied.error, "duplicate_plan_item");
  assert.equal((await callTool(app, token, "getTodayTasks", { date: "2026-09-14" })).tasks.length, 0);
});

test("時間が足りなければ警告し、未配置分は理由とともに残る", async () => {
  const { app, token } = await setup();
  await callTool(app, token, "updateStudyAvailability", { weekly: { sun: 20 } });
  const goal = await callTool(app, token, "addGoal", { title: "A", questionIds: [Q[0], Q[1], Q[2]] });

  const context = await callTool(app, token, "getPlanningContext", { from: "2026-09-13", to: "2026-09-13" });
  const day = context.days[0];
  const checked = await callTool(app, token, "validatePlanChanges", {
    operationId: "tight",
    expectedRevisions: [{ date: "2026-09-13", revision: day.revision }],
    changes: [{ op: "add", date: "2026-09-13", task: { questionIds: [Q[0], Q[1]], kind: "new", goalId: goal.goal.id } }],
    expectedContext: context.expectedContext,
  });
  assert.equal(checked.ok, true, "断りはしないが、足りないことを知らせる");
  assert.equal(checked.overCapacity, true);
  const warning = checked.warnings.find((entry) => entry.type === "over_capacity");
  assert.ok(warning.shortageMinutes > 0);
  // 置けていない分は、目標の対象として残る。
  assert.ok(checked.unplaced.some((entry) => entry.questionId === Q[2]));
  assert.ok(checked.unplaced.every((entry) => entry.reason));
});

test("学習可能時間が未設定の日は、時間があると決めつけない", async () => {
  const { app, token } = await setup();
  const context = await callTool(app, token, "getPlanningContext", { from: "2026-09-13", to: "2026-09-13" });
  assert.deepEqual(context.unconfiguredDates, ["2026-09-13"]);
  const checked = await callTool(app, token, "validatePlanChanges", {
    operationId: "unset",
    expectedRevisions: [{ date: "2026-09-13", revision: 0 }],
    changes: [{ op: "add", date: "2026-09-13", task: { questionIds: [Q[0]], kind: "new" } }],
  });
  assert.ok(checked.warnings.some((entry) => entry.type === "capacity_not_configured"));
  assert.equal(checked.days[0].availableMinutes, null);
});

test("下見のあとで目標や学習可能時間が変わったら、反映を断る", async () => {
  const { app, token } = await setup();
  const context = await callTool(app, token, "getPlanningContext", { from: "2026-09-13", to: "2026-09-13" });
  // 下見のあとで、利用者が学習可能時間を変えた。
  await callTool(app, token, "updateStudyAvailability", { weekly: { sun: 30 } });

  const denied = await callTool(app, token, "applyTaskChanges", {
    operationId: "stale",
    expectedRevisions: [{ date: "2026-09-13", revision: 0 }],
    changes: [{ op: "add", date: "2026-09-13", task: { questionIds: [Q[0]], kind: "new" } }],
    expectedContext: context.expectedContext,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "context_stale");
  assert.equal(denied.stale[0].field, "availabilityRevision");
  assert.equal((await callTool(app, token, "getTodayTasks", { date: "2026-09-13" })).tasks.length, 0);
});

test("完了済み・固定の予定は、再計画でも動かせない", async () => {
  const { app, token, device } = await setup();
  const goal = await callTool(app, token, "addGoal", { title: "A", questionIds: [Q[0], Q[1]] });
  const plan = await planFor(app, token, { date: "2026-09-12", goalId: goal.goal.id, questionIds: [Q[0], Q[1]], operationId: "p1" });
  await call(app, "/api/sync/pin", {
    method: "POST", token: device.deviceKey,
    body: { date: "2026-09-12", taskId: plan.taskId, pinned: true },
  });
  const current = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  const denied = await callTool(app, token, "validatePlanChanges", {
    operationId: "move-pinned",
    expectedRevisions: [{ date: "2026-09-12", revision: current.revision }, { date: "2026-09-13", revision: 0 }],
    changes: [{ op: "move", taskId: plan.taskId, fromDate: "2026-09-12", toDate: "2026-09-13" }],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "protected_task");
});

test("同じ配分案を送り直しても、予定も移動履歴も増えない", async () => {
  const { app, token } = await setup();
  const args = {
    operationId: "resend-1",
    expectedRevisions: [{ date: "2026-09-13", revision: 0 }],
    changes: [{ op: "add", date: "2026-09-13", task: { questionIds: [Q[0]], kind: "new" } }],
  };
  const first = await callTool(app, token, "applyTaskChanges", args);
  const second = await callTool(app, token, "applyTaskChanges", args);
  assert.equal(first.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(second.changeId, first.changeId);
  assert.equal((await callTool(app, token, "getTodayTasks", { date: "2026-09-13" })).tasks.length, 1);
  assert.equal((await callTool(app, token, "getPlanMoves", {})).total, 0);
});

test("getPlanningContext は期間を絞って返し、省略があれば知らせる", async () => {
  const { app, token } = await setup();
  const context = await callTool(app, token, "getPlanningContext", { from: "2026-09-12", to: "2026-09-18" });
  assert.equal(context.today, "2026-09-12");
  assert.equal(context.days.length, 7);
  assert.equal(context.limits.maxDays, 60);
  assert.equal(context.unplannedTruncated, false);
  assert.ok(context.expectedContext.goalsRevision !== undefined);
  assert.ok(context.expectedContext.availabilityRevision !== undefined);
  assert.ok(context.storage);
  assert.ok(context.howTo.includes("validatePlanChanges"));
});

/* ------------------------------------------------------------------ */
/* ひととおりの流れ                                                    */
/* ------------------------------------------------------------------ */

test("目標作成 → 配分 → 一部実施 → 残り30分で再計画 → 進捗確認", async () => {
  let clock = NOW;
  const { app, token, device } = await setup({ now: () => clock });

  // 1. 学習可能時間と目標を決める。
  await callTool(app, token, "updateStudyAvailability", {
    weekly: { mon: 60, tue: 60, wed: 60, thu: 60, fri: 60, sat: 120, sun: 60 },
  });
  const goal = await callTool(app, token, "addGoal", {
    title: "今週中に3問を一通り解く",
    deadline: "2026-09-14",
    questionIds: [Q[0], Q[1], Q[2]],
    completion: { type: "attempt" },
    priority: 1,
  });
  assert.equal(goal.ok, true);

  // 2. 計画のもとを取る。
  const context = await callTool(app, token, "getPlanningContext", { from: "2026-09-12", to: "2026-09-14" });
  assert.equal(context.goals[0].unplannedQuestionIds.length, 3);
  assert.equal(context.days[0].capacity.available, 120, "2026-09-12 は土曜");

  // 3. 配分案を確かめてから反映する。
  const changes = [
    { op: "add", date: "2026-09-12", task: { questionIds: [Q[0], Q[1]], kind: "new", goalId: goal.goal.id } },
    { op: "add", date: "2026-09-13", task: { questionIds: [Q[2]], kind: "new", goalId: goal.goal.id } },
  ];
  const expectedRevisions = context.days.slice(0, 2).map((day) => ({ date: day.date, revision: day.revision }));
  const checked = await callTool(app, token, "validatePlanChanges", {
    operationId: "week-plan", expectedRevisions, changes, expectedContext: context.expectedContext,
  });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const applied = await callTool(app, token, "applyTaskChanges", {
    operationId: "week-plan", expectedRevisions, changes,
    expectedContext: context.expectedContext,
    reason: "期限までに3問を配分",
  });
  assert.equal(applied.ok, true);

  // 4. 今日の1問だけ実施する。
  const today = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  const [doneItem, pendingItem] = today.tasks[0].items;
  clock += 3600000;
  await push(app, device, {
    records: [attempt("r1", { questionId: doneItem.questionId, timestamp: "2026-09-12T04:00:00Z", durationSeconds: 1500, planItemId: doneItem.itemId, planTaskId: today.tasks[0].id })],
  });

  // 5. 「今日はあと30分」で組み直す。
  //    残っている1問は、教材をもとにした仮見積もりで40分かかる想定にしておく。
  await callTool(app, token, "saveQuestionEstimates", {
    estimates: [{ questionId: pendingItem.questionId, seconds: 2400, note: "誌面から推定" }],
  });
  await callTool(app, token, "updateStudyAvailability", { todayRemainingMinutes: 30, todayRemainingDate: "2026-09-12" });
  const replanContext = await callTool(app, token, "getPlanningContext", { from: "2026-09-12", to: "2026-09-14" });
  const day0 = replanContext.days.find((day) => day.date === "2026-09-12");
  assert.equal(day0.capacity.available, 30);
  assert.equal(day0.capacity.spentSubtracted, false, "指定した残り時間から実施済みを引かない");
  assert.equal(day0.pendingItems.length, 1, "残っているのは未実施の1件だけ");
  assert.equal(day0.overCapacity, true, "30分では入りきらない");

  const carry = [{
    op: "carryOver", taskId: today.tasks[0].id, fromDate: "2026-09-12", toDate: "2026-09-14",
    itemIds: [pendingItem.itemId], reason: "time_shortage",
  }];
  const carryRevisions = [
    { date: "2026-09-12", revision: day0.revision },
    { date: "2026-09-14", revision: replanContext.days.find((day) => day.date === "2026-09-14").revision },
  ];
  const replan = await callTool(app, token, "applyTaskChanges", {
    operationId: "replan-today",
    expectedRevisions: carryRevisions,
    changes: carry,
    expectedContext: replanContext.expectedContext,
    reason: "今日は残り30分のため、1件を日曜へ",
  });
  assert.equal(replan.ok, true, JSON.stringify(replan));
  assert.equal(replan.moves[0].reason, "time_shortage");

  // 6. 進捗を確かめる。
  const progress = await callTool(app, token, "getGoalProgress", { goalIds: [goal.goal.id] });
  const entry = progress.goals[0];
  assert.equal(entry.satisfiedCount, 1, "実施した1問だけが達成");
  assert.equal(entry.unsatisfiedCount, 2);
  assert.equal(entry.unplannedQuestionIds.length, 0, "残りはすべて予定に入っている");
  assert.equal(entry.daysLeft, 2);
  const todayAfter = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.equal(todayAfter.pendingItemCount, 0, "今日に残っている未実施はもう無い");
  assert.equal(todayAfter.tasks[0].doneItemIds.length, 1, "実施済みの分は今日に残る");
  assert.equal((await callTool(app, token, "getTodayTasks", { date: "2026-09-14" })).pendingItemCount, 1);
});

/* ------------------------------------------------------------------ */
/* 既存データ・同期・バックアップ                                      */
/* ------------------------------------------------------------------ */

test("古い目標（文章の範囲だけ）は、対象を勝手に決めずそのまま残る", async () => {
  const { app, token, device } = await setup();
  // 以前の版が作った目標の形。
  await push(app, device, {
    goals: [{ id: "g-old", title: "12月までにI+Aを終える", deadline: "2026-12-31", scope: "数学I+A 例題1〜200", updatedAt: "2026-09-01T00:00:00Z" }],
  });
  const goals = await callTool(app, token, "getGoals", {});
  const goal = goals.goals.find((entry) => entry.id === "g-old");
  assert.equal(goal.needsScopeSetup, true, "対象が決まっていないことが分かる");
  assert.deepEqual(goal.questionIds, [], "文章から問題IDをでっちあげない");
  assert.equal(goal.scope, "数学I+A 例題1〜200", "もとの文章は残る");
  assert.equal(goal.completion.type, "attempt");
  assert.equal(goal.status, "active");

  // 進捗は「対象0」として数え、勝手に達成にしない。
  const progress = await callTool(app, token, "getGoalProgress", { goalIds: ["g-old"] });
  assert.equal(progress.goals[0].totalQuestions, 0);
  assert.equal(progress.goals[0].needsScopeSetup, true);
});

test("目標の対象が問題マスタから消えても、目標は消えない", async () => {
  const { app, token, device } = await setup();
  const goal = await callTool(app, token, "addGoal", { title: "A", questionIds: [Q[0], Q[1]] });
  // 問題マスタを入れ替えて、1問を無くす。
  await push(app, device, { questions: { questions: [QUESTIONS[0]] } });
  const goals = await callTool(app, token, "getGoals", {});
  const saved = goals.goals.find((entry) => entry.id === goal.goal.id);
  assert.deepEqual(saved.questionIds, [Q[0], Q[1]], "対象は黙って減らさない");
  const progress = await callTool(app, token, "getGoalProgress", { goalIds: [goal.goal.id] });
  assert.equal(progress.goals[0].totalQuestions, 2);
});

test("学習可能時間と見積もりの指定が同期され、古い端末の同期で消えない", async () => {
  const { app, token, device } = await setup();
  await callTool(app, token, "updateStudyAvailability", { weekly: { sat: 90 }, reserveMinutes: 5 });
  await callTool(app, token, "saveQuestionEstimates", { estimates: [{ questionId: Q[0], seconds: 600 }] });

  // 端末は同期で受け取れる。
  const pulled = await call(app, "/api/sync/pull", { token: device.deviceKey });
  assert.equal(pulled.body.availability.weekly.sat, 90);
  assert.equal(pulled.body.availability.reserveMinutes, 5);
  assert.equal(pulled.body.estimates[Q[0]].aiSeconds, 600);

  // これらを知らない古い端末が同期しても、消えない。
  const old = await push(app, device, { records: [] });
  assert.equal(old.body.snapshot.availability.weekly.sat, 90);
  assert.equal(old.body.snapshot.estimates[Q[0]].aiSeconds, 600);

  // 端末が自分の設定を送れば、新しいほうが残る。
  await push(app, device, {
    availability: { weekly: { sat: 120 }, updatedAt: "2099-01-01T00:00:00Z", revision: 1 },
  });
  const after = await callTool(app, token, "getStudyAvailability", { from: "2026-09-12", to: "2026-09-12" });
  assert.equal(after.availability.weekly.sat, 120);
});

test("利用者が指定した時間を、AIの仮見積もりが上書きしない", async () => {
  const { app, token, device } = await setup();
  // 端末（利用者）が指定した時間。
  await push(app, device, {
    estimates: { [Q[0]]: { manualSeconds: 300, manualUpdatedAt: "2026-09-10T00:00:00Z" } },
  });
  await callTool(app, token, "saveQuestionEstimates", { estimates: [{ questionId: Q[0], seconds: 1200 }] });
  const estimates = await callTool(app, token, "getQuestionEstimates", { questionIds: [Q[0]] });
  assert.equal(estimates.estimates[0].source, "manual");
  assert.equal(estimates.estimates[0].seconds, 300);
});
