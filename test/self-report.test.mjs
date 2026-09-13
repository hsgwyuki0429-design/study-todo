// 本人の申告にもとづく、学習実績の代理入力・訂正・取り消しの確認。
//
// いちばん大事なのは「言っていないことを作らない」こと。
// 分からない評価や時間は埋めず、未登録のまま保存できることを確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";

import { OWNER_KEY, QUESTIONS, call, callTool, createTestApp, joinDevice } from "./helpers.mjs";

const Q = QUESTIONS.map((question) => question.id);
const NOW = Date.parse("2026-09-12T03:00:00Z");   // 日本時間 2026-09-12 12:00

/** 実績を扱える接続（records の権限つき）を用意する。 */
async function setup({ now = () => NOW, records = true } = {}) {
  const { app } = createTestApp({ now });
  await call(app, "/api/admin/settings", {
    method: "POST",
    token: OWNER_KEY,
    body: { enabled: true, permissions: { read: true, write: true, records } },
  });
  const issued = await call(app, "/api/admin/token", {
    method: "POST",
    token: OWNER_KEY,
    body: { scopes: records ? ["read", "write", "records"] : ["read", "write"] },
  });
  const device = await joinDevice(app);
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: { questions: { questions: QUESTIONS } },
  });
  return { app, token: issued.body.token, device };
}

const add = (app, token, args) => callTool(app, token, "addStudyRecords", args);

test("昨日やった分を、昨日の日付で記録できる", async () => {
  const { app, token } = await setup();
  const result = await add(app, token, {
    operationId: "op-1",
    claimSummary: "昨日、例題90〜91を解いた",
    records: [
      { questionId: Q[0], date: "2026-09-11", evaluation: "perfect" },
      { questionId: Q[1], date: "2026-09-11", evaluation: "calc_error" },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.counts.added, 2);
  assert.equal(result.today, "2026-09-12", "返答に使える「今日」も分かる");
  assert.deepEqual(result.added.map((entry) => entry.date), ["2026-09-11", "2026-09-11"]);
  assert.equal(result.added[0].source, "self_report_ai");

  // 昨日の日として集計される（登録した日ではない）。
  const range = await callTool(app, token, "getTasksInRange", { from: "2026-09-11", to: "2026-09-12" });
  const byDate = Object.fromEntries(range.days.map((day) => [day.date, day.attemptCount]));
  assert.equal(byDate["2026-09-11"], 2);
  assert.equal(byDate["2026-09-12"], undefined, "今日には入らない");
});

test("評価も時間も時刻も分からないまま記録できる", async () => {
  const { app, token } = await setup();
  const result = await add(app, token, {
    operationId: "op-unknown",
    records: [{ questionId: Q[0], date: "2026-09-11" }],
  });
  assert.equal(result.ok, true);
  const saved = result.added[0];
  assert.equal(saved.evaluation, null, "「解いた」だけで perfect にしない");
  assert.equal(saved.evaluationKnown, false);
  assert.equal(saved.durationSeconds, null, "分からない時間を0秒で埋めない");
  assert.equal(saved.durationKnown, false);
  assert.equal(saved.datePrecision, "date", "時刻は作らない");
  assert.equal(saved.time, null);

  // 統計でも、未登録として数える。
  const stats = await callTool(app, token, "getStudyStats");
  assert.equal(stats.totalRecords, 1);
  assert.equal(stats.totalSeconds, 0);
  assert.equal(stats.durationUnknownCount, 1);
  assert.equal(Object.keys(stats.byEvaluation).length, 0, "評価未登録は評価の内訳に入れない");
});

test("未登録の時間が、平均や見積もりを壊さない", async () => {
  const { app, token, device } = await setup();
  // 実測が2件（600秒・620秒）。
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      records: [
        { id: "t1", questionId: Q[0], timestamp: "2026-09-01T02:00:00Z", evaluation: "perfect", durationSeconds: 600 },
        { id: "t2", questionId: Q[0], timestamp: "2026-09-03T02:00:00Z", evaluation: "perfect", durationSeconds: 620 },
      ],
    },
  });
  const before = await callTool(app, token, "getQuestionEstimates", { questionIds: [Q[0]] });

  // 時間が分からない申告を足しても、見積もりは変わらない。
  await add(app, token, { operationId: "op-noduration", records: [{ questionId: Q[0], date: "2026-09-11" }] });
  const after = await callTool(app, token, "getQuestionEstimates", { questionIds: [Q[0]] });
  assert.equal(after.estimates[0].seconds, before.estimates[0].seconds);
  assert.equal(after.estimates[0].sampleCount, before.estimates[0].sampleCount, "0秒の標本として混ざらない");

  const question = await callTool(app, token, "getQuestion", { id: Q[0] });
  assert.equal(question.attempts, 3, "取り組み回数にはちゃんと入る");
});

test("「4問で合計40分」を、1問10分に割り振らない", async () => {
  const { app, token } = await setup();
  const result = await add(app, token, {
    operationId: "op-group",
    totalDurationSeconds: 2400,
    records: [Q[0], Q[1], Q[2]].map((questionId) => ({ questionId, date: "2026-09-11" })),
  });
  assert.equal(result.ok, true);
  assert.ok(result.added.every((entry) => entry.durationSeconds === null), "1問ずつの時間はでっち上げない");
  assert.ok(result.added.every((entry) => entry.durationGroup.totalSeconds === 2400));

  // 合計は「まとまり1つぶん」だけ。3倍にならない。
  const stats = await callTool(app, token, "getStudyStats");
  assert.equal(stats.totalSeconds, 2400);
});

test("同じ日に2回解いた分を、別々に記録できる", async () => {
  const { app, token } = await setup();
  const first = await add(app, token, {
    operationId: "op-a",
    records: [{ questionId: Q[0], date: "2026-09-11", evaluation: "calc_error" }],
  });
  const second = await add(app, token, {
    operationId: "op-b",
    records: [{ questionId: Q[0], date: "2026-09-11", evaluation: "perfect" }],
  });
  assert.equal(second.ok, true);
  assert.notEqual(first.added[0].recordId, second.added[0].recordId);
  // 2件目では「似た記録がある」と知らせるが、勝手には消さない。
  assert.equal(second.possibleDuplicates.length, 1);
  assert.equal(second.possibleDuplicates[0].existing.length, 1);

  const history = await callTool(app, token, "getQuestionAttempts", { id: Q[0] });
  assert.equal(history.totalAttempts, 2);
});

test("同じ操作IDの送り直しでは、記録も履歴も増えない", async () => {
  const { app, token } = await setup();
  const args = {
    operationId: "op-retry",
    records: [{ questionId: Q[0], date: "2026-09-11", evaluation: "perfect" }],
  };
  const first = await add(app, token, args);
  const second = await add(app, token, args);
  assert.equal(second.replayed, true);
  assert.equal(second.added[0].recordId, first.added[0].recordId);
  assert.equal((await callTool(app, token, "getQuestionAttempts", { id: Q[0] })).totalAttempts, 1);
  assert.equal((await callTool(app, token, "getRecordChanges", {})).total, 1);

  // 同じ操作IDで内容が違えば断る。
  const conflict = await add(app, token, {
    operationId: "op-retry",
    records: [{ questionId: Q[1], date: "2026-09-11" }],
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error, "operation_conflict");
});

test("一部だけの訂正で、IDと指定しなかった項目は変わらない", async () => {
  const { app, token } = await setup();
  const added = await add(app, token, {
    operationId: "op-add",
    records: [{ questionId: Q[0], date: "2026-09-11", time: "20:30", evaluation: "calc_error", durationSeconds: 600 }],
  });
  const recordId = added.added[0].recordId;

  const fixed = await callTool(app, token, "updateStudyRecords", {
    operationId: "op-fix",
    reason: "評価を言い間違えた",
    updates: [{ recordId, expectedRevision: 0, evaluation: "perfect" }],
  });
  assert.equal(fixed.ok, true);
  const after = fixed.updated[0];
  assert.equal(after.recordId, recordId, "記録IDは変わらない");
  assert.equal(after.evaluation, "perfect");
  assert.equal(after.durationSeconds, 600, "渡していない項目はそのまま");
  assert.equal(after.date, "2026-09-11");
  assert.equal(after.revision, 1);
  assert.equal(after.corrections, 1, "訂正の履歴が残る");

  // 履歴から、変更前後と理由が分かる。
  const changes = await callTool(app, token, "getRecordChanges", {});
  const entry = changes.operations.find((operation) => operation.operationId === "op-fix");
  assert.equal(entry.reason, "評価を言い間違えた");
  assert.equal(entry.changes[0].before.evaluation, "calc_error");
  assert.equal(entry.changes[0].after.evaluation, "perfect");
});

test("日付の訂正で、元の日と移動先の日の集計が両方変わる", async () => {
  const { app, token } = await setup();
  const added = await add(app, token, {
    operationId: "op-add",
    records: [{ questionId: Q[0], date: "2026-09-12", evaluation: "perfect" }],
  });
  const recordId = added.added[0].recordId;

  const moved = await callTool(app, token, "updateStudyRecords", {
    operationId: "op-move",
    reason: "今日として入れたが、本当は昨日だった",
    updates: [{ recordId, date: "2026-09-11" }],
  });
  assert.equal(moved.ok, true);
  assert.equal(moved.updated[0].date, "2026-09-11");

  const range = await callTool(app, token, "getTasksInRange", { from: "2026-09-11", to: "2026-09-12" });
  const byDate = Object.fromEntries(range.days.map((day) => [day.date, day.attemptCount]));
  assert.equal(byDate["2026-09-11"], 1);
  assert.equal(byDate["2026-09-12"], undefined, "元の日からは消える");
});

test("古い revision での訂正は断られ、何も変わらない", async () => {
  const { app, token } = await setup();
  const added = await add(app, token, {
    operationId: "op-add",
    records: [{ questionId: Q[0], date: "2026-09-11", evaluation: "calc_error" }],
  });
  const recordId = added.added[0].recordId;
  await callTool(app, token, "updateStudyRecords", {
    operationId: "op-fix1",
    updates: [{ recordId, expectedRevision: 0, evaluation: "perfect" }],
  });
  const stale = await callTool(app, token, "updateStudyRecords", {
    operationId: "op-fix2",
    updates: [{ recordId, expectedRevision: 0, evaluation: "wrong_approach" }],
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "revision_conflict");
  assert.equal(stale.currentRevision, 1);
  const history = await callTool(app, token, "getQuestionAttempts", { id: Q[0] });
  assert.equal(history.attempts[0].evaluation, "perfect", "何も変わっていない");
});

test("取り消した記録は集計から外れ、同期しても復活しない", async () => {
  const { app, token, device } = await setup();
  const added = await add(app, token, {
    operationId: "op-add",
    records: [
      { questionId: Q[0], date: "2026-09-11", evaluation: "perfect" },
      { questionId: Q[0], date: "2026-09-11", evaluation: "perfect" },
    ],
  });
  const [keep, remove] = added.added.map((entry) => entry.recordId);
  void keep;

  const voided = await callTool(app, token, "voidStudyRecords", {
    operationId: "op-void",
    reason: "同じ取り組みを2回入れてしまった",
    records: [{ recordId: remove }],
  });
  assert.equal(voided.ok, true);
  assert.equal((await callTool(app, token, "getQuestionAttempts", { id: Q[0] })).totalAttempts, 1);
  assert.equal((await callTool(app, token, "getStudyStats")).totalRecords, 1);

  // 取り消しを知らない端末が、古い内容を送ってきても戻らない。
  const resurrect = await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      records: [{
        id: remove, questionId: Q[0], date: "2026-09-11", evaluation: "perfect",
        timestamp: "2026-09-11T02:00:00Z", revision: 0,
      }],
    },
  });
  assert.equal(resurrect.status, 200);
  assert.equal((await callTool(app, token, "getQuestionAttempts", { id: Q[0] })).totalAttempts, 1, "取り消した記録が復活した");

  // 端末へ配る内容には、取り消しの印つきで入っている（端末側でも消える）。
  const pulled = await call(app, "/api/sync/pull", { token: device.deviceKey });
  const sent = pulled.body.records.find((record) => record.id === remove);
  assert.equal(sent.voided, true);
  assert.equal(sent.revision, 1);
});

test("日本時間の日付の境目でも、正しい日に入る", async () => {
  // 日本時間 2026-09-13 の 0:30（UTC では 2026-09-12 の 15:30）。
  const { app, token } = await setup({ now: () => Date.parse("2026-09-12T15:30:00Z") });
  const result = await add(app, token, {
    operationId: "op-midnight",
    records: [{ questionId: Q[0], date: "2026-09-12", time: "23:50", evaluation: "perfect" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.today, "2026-09-13", "サーバーの今日は日本時間で判断する");
  assert.equal(result.added[0].date, "2026-09-12");
  const range = await callTool(app, token, "getTasksInRange", { from: "2026-09-12", to: "2026-09-13" });
  const byDate = Object.fromEntries(range.days.map((day) => [day.date, day.attemptCount]));
  assert.equal(byDate["2026-09-12"], 1);

  // 未来の日付は実績にできない。
  const future = await add(app, token, {
    operationId: "op-future",
    records: [{ questionId: Q[0], date: "2026-09-20" }],
  });
  assert.equal(future.error, "invalid_input");
});

test("予定との結び付けを、勝手に広げない", async () => {
  const { app, token } = await setup();
  // 同じ問題を2回やる予定を今日に置く。
  const plan = await callTool(app, token, "applyTaskChanges", {
    operationId: "op-plan",
    expectedRevisions: [{ date: "2026-09-12", revision: 0 }],
    changes: [{ op: "add", date: "2026-09-12", task: { questionIds: [Q[0], Q[0]], kind: "new" } }],
  });
  assert.equal(plan.ok, true);
  const today = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  const [firstItem, secondItem] = today.tasks[0].items;

  await add(app, token, {
    operationId: "op-done1",
    records: [{ questionId: Q[0], date: "2026-09-12", evaluation: "perfect", planItemId: firstItem.itemId }],
  });
  const after = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.deepEqual(after.tasks[0].doneItemIds, [firstItem.itemId]);
  assert.deepEqual(after.tasks[0].pendingItemIds, [secondItem.itemId], "同じ問題の別の予定まで完了にしない");

  // 同じ予定項目を二重に完了にはできない。
  const twice = await add(app, token, {
    operationId: "op-done2",
    records: [{ questionId: Q[0], date: "2026-09-12", planItemId: firstItem.itemId }],
  });
  assert.equal(twice.ok, false);
  assert.equal(twice.error, "plan_item_already_done");

  // 別の問題の予定へは結び付けられない。
  const mismatched = await add(app, token, {
    operationId: "op-done3",
    records: [{ questionId: Q[1], date: "2026-09-12", planItemId: secondItem.itemId }],
  });
  assert.equal(mismatched.error, "plan_item_mismatch");
});

test("目標の進捗は、評価が未登録なら「習得」にはしない", async () => {
  const { app, token } = await setup();
  const goal = await callTool(app, token, "addGoal", {
    title: "習得", questionIds: [Q[0]], completion: { type: "mastery" },
  });
  await callTool(app, token, "applyTaskChanges", {
    operationId: "op-plan",
    expectedRevisions: [{ date: "2026-09-12", revision: 0 }],
    changes: [{ op: "add", date: "2026-09-12", task: { questionIds: [Q[0]], kind: "new", goalId: goal.goal.id } }],
  });
  const today = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  const item = today.tasks[0].items[0];

  // 評価が分からないまま記録する。
  await add(app, token, {
    operationId: "op-done",
    records: [{ questionId: Q[0], date: "2026-09-12", planItemId: item.itemId }],
  });
  const progress = await callTool(app, token, "getGoalProgress", { goalIds: [goal.goal.id] });
  assert.equal(progress.goals[0].satisfiedCount, 0, "評価未登録では習得にしない");

  // あとから評価を入れれば達成になる。
  const attempts = await callTool(app, token, "getQuestionAttempts", { id: Q[0] });
  await callTool(app, token, "updateStudyRecords", {
    operationId: "op-eval",
    updates: [{ recordId: attempts.attempts[0].recordId, evaluation: "perfect" }],
  });
  const updated = await callTool(app, token, "getGoalProgress", { goalIds: [goal.goal.id] });
  assert.equal(updated.goals[0].satisfiedCount, 1);
});

test("知らない問題IDは断る。チャレンジの中の記録は評価だけ直せる", async () => {
  const { app, token, device } = await setup();
  const unknown = await add(app, token, {
    operationId: "op-unknown-q",
    records: [{ questionId: "存在しない問題", date: "2026-09-11" }],
  });
  assert.equal(unknown.error, "unknown_question");

  // チャレンジの中の記録は、結果と食い違わない範囲（評価だけ）なら直せる。
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      records: [{
        id: "chl-rec", questionId: Q[0], timestamp: "2026-09-11T02:00:00Z",
        evaluation: "perfect", durationSeconds: 120, challengeId: "chl1",
      }],
      challenges: [{
        id: "chl1", timestamp: "2026-09-11T02:00:00Z", timeLimitSeconds: 600,
        totalElapsedSeconds: 500, succeeded: true,
        laps: [{ questionId: Q[0], durationSeconds: 120, evaluation: "perfect" }],
      }],
    },
  });
  const fixed = await callTool(app, token, "updateStudyRecords", {
    operationId: "op-chl-eval",
    updates: [{ recordId: "chl-rec", evaluation: "calc_error" }],
  });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.updated[0].evaluation, "calc_error");

  // 日付や所要時間は、チャレンジ結果の合計と食い違うので断る。
  const denied = await callTool(app, token, "updateStudyRecords", {
    operationId: "op-chl-date",
    updates: [{ recordId: "chl-rec", date: "2026-09-10" }],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "challenge_record");
});

/* ------------------------------------------------------------------ */
/* チャレンジの履歴を取り消す                                          */
/* ------------------------------------------------------------------ */

/** チャレンジ1回ぶん（結果と、その中の記録2件）を入れておく。 */
async function seedChallenge(app, device, { id = "chl1", date = "2026-09-11" } = {}) {
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      records: [
        { id: `${id}-r1`, questionId: Q[0], timestamp: `${date}T02:00:00Z`, evaluation: "perfect", durationSeconds: 120, challengeId: id },
        { id: `${id}-r2`, questionId: Q[1], timestamp: `${date}T02:03:00Z`, evaluation: "calc_error", durationSeconds: 180, challengeId: id },
      ],
      challenges: [{
        id, timestamp: `${date}T02:00:00Z`, timeLimitSeconds: 600,
        totalElapsedSeconds: 300, succeeded: true,
        laps: [
          { questionId: Q[0], durationSeconds: 120, evaluation: "perfect" },
          { questionId: Q[1], durationSeconds: 180, evaluation: "calc_error" },
        ],
      }],
    },
  });
}

test("チャレンジの履歴を、1回ぶんまるごと取り消せる", async () => {
  const { app, token, device } = await setup();
  await seedChallenge(app, device);
  const before = await callTool(app, token, "getChallengeResults");
  assert.equal(before.total, 1);

  const result = await callTool(app, token, "voidChallengeResults", {
    operationId: "op-void-chl",
    challenges: ["chl1"],
    reason: "間違って始めた",
  });
  assert.equal(result.ok, true);
  assert.equal(result.counts.voidedChallenges, 1);
  // 中の記録もいっしょに取り消す（1問だけ残すと合計時間と食い違うため）。
  assert.equal(result.counts.voided, 2);

  const after = await callTool(app, token, "getChallengeResults");
  assert.equal(after.total, 0);
  const recent = await callTool(app, token, "getRecentChallengeResult");
  assert.equal(recent.result, null);
  const stats = await callTool(app, token, "getStudyStats");
  assert.equal(stats.totalRecords, 0);
});

test("チャレンジの中の記録は、1問だけ取り消せる", async () => {
  const { app, token, device } = await setup();
  await seedChallenge(app, device);
  const result = await callTool(app, token, "voidStudyRecords", {
    operationId: "op-void-chl-rec",
    records: ["chl1-r1"],
    reason: "この1問は数えない",
  });
  assert.equal(result.ok, true);
  assert.equal(result.counts.voided, 1);
  assert.equal(result.counts.voidedChallenges, 0);

  // チャレンジ結果そのものは残る（測った合計時間は事実として残す）。
  const after = await callTool(app, token, "getChallengeResults");
  assert.equal(after.total, 1);
  // 集計からは、その1問だけが外れる。
  const stats = await callTool(app, token, "getStudyStats");
  assert.equal(stats.totalRecords, 1);
});

test("取り消した記録を、あとから戻せる", async () => {
  const { app, token, device } = await setup();
  await seedChallenge(app, device);
  await callTool(app, token, "voidStudyRecords", { operationId: "op-v", records: ["chl1-r1"] });
  assert.equal((await callTool(app, token, "getStudyStats")).totalRecords, 1);

  const restored = await callTool(app, token, "restoreStudyRecords", {
    operationId: "op-r",
    records: ["chl1-r1"],
    reason: "やっぱり解いていた",
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.counts.restored, 1);
  assert.equal((await callTool(app, token, "getStudyStats")).totalRecords, 2);

  // 取り消されていないものは戻せない（二重に版を進めない）。
  const again = await callTool(app, token, "restoreStudyRecords", { operationId: "op-r2", records: ["chl1-r1"] });
  assert.equal(again.ok, false);
  assert.equal(again.error, "not_voided");
});

test("チャレンジを戻すと、道連れで取り消した記録だけが戻る", async () => {
  const { app, token, device } = await setup();
  await seedChallenge(app, device);
  // 先に1問だけ個別に取り消しておく。これは本人が別に決めたことなので、戻さない。
  await callTool(app, token, "voidStudyRecords", { operationId: "op-one", records: ["chl1-r1"] });
  const voided = await callTool(app, token, "voidChallengeResults", { operationId: "op-all", challenges: ["chl1"] });
  assert.equal(voided.counts.voided, 1);   // 残っていた1件だけが道連れになる

  const restored = await callTool(app, token, "restoreStudyRecords", {
    operationId: "op-restore-chl",
    challenges: ["chl1"],
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.counts.restoredChallenges, 1);
  assert.equal(restored.counts.restored, 1);
  assert.equal((await callTool(app, token, "getChallengeResults")).total, 1);
  // 個別に取り消した1問は、取り消したまま。
  assert.equal((await callTool(app, token, "getStudyStats")).totalRecords, 1);
});

test("取り消しを戻す操作にも records の権限が要る", async () => {
  const { app, token, device } = await setup({ records: false });
  await seedChallenge(app, device);
  const denied = await callTool(app, token, "restoreStudyRecords", {
    operationId: "op-restore-denied",
    records: ["chl1-r1"],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "permission_denied");
  assert.equal(denied.requiredScope, "records");
});

test("取り消したチャレンジは、取り消しを知らない端末が送り直しても戻らない", async () => {
  const { app, token, device } = await setup();
  await seedChallenge(app, device);
  await callTool(app, token, "voidChallengeResults", { operationId: "op-void-chl2", challenges: ["chl1"] });

  // 古い端末が、取り消し前の内容をそのまま送ってくる。
  await seedChallenge(app, device);
  const after = await callTool(app, token, "getChallengeResults");
  assert.equal(after.total, 0);
  const stats = await callTool(app, token, "getStudyStats");
  assert.equal(stats.totalRecords, 0);

  // 端末には「取り消した」ことが伝わる（配らないと端末に残り続けるため）。
  const pulled = await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {},
  });
  const voided = (pulled.body.snapshot.challenges ?? []).find((entry) => entry.id === "chl1");
  assert.equal(voided?.voided, true);
});

test("チャレンジの取り消しには records の権限が要る", async () => {
  const { app, token, device } = await setup({ records: false });
  await seedChallenge(app, device);
  const denied = await callTool(app, token, "voidChallengeResults", {
    operationId: "op-void-chl-denied",
    challenges: ["chl1"],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "permission_denied");
  assert.equal(denied.requiredScope, "records");
});

test("同じ operationId でチャレンジの取り消しを送り直しても二重にならない", async () => {
  const { app, token, device } = await setup();
  await seedChallenge(app, device);
  const first = await callTool(app, token, "voidChallengeResults", { operationId: "op-void-once", challenges: ["chl1"] });
  const again = await callTool(app, token, "voidChallengeResults", { operationId: "op-void-once", challenges: ["chl1"] });
  assert.equal(first.ok, true);
  assert.equal(again.replayed, true);
  assert.equal(again.counts.voidedChallenges, 1);
});

test("1件でも通らなければ、1件も保存されない", async () => {
  const { app, token } = await setup();
  const result = await add(app, token, {
    operationId: "op-partial",
    records: [
      { questionId: Q[0], date: "2026-09-11", evaluation: "perfect" },
      { questionId: "存在しない問題", date: "2026-09-11" },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal((await callTool(app, token, "getStudyStats")).totalRecords, 0);
});

test("記録の権限が無ければ、実績は変えられない", async () => {
  const { app, token } = await setup({ records: false });
  const denied = await add(app, token, {
    operationId: "op-denied",
    records: [{ questionId: Q[0], date: "2026-09-11" }],
  });
  assert.equal(denied.error, "permission_denied");
  assert.equal(denied.requiredScope, "records");
  assert.equal((await callTool(app, token, "getStudyStats")).totalRecords, 0);
});

test("古い記録（date も source も無いもの）は、そのまま読める", async () => {
  const { app, token, device } = await setup();
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      records: [{ id: "old1", questionId: Q[0], timestamp: "2026-09-01T02:00:00Z", evaluation: "perfect", durationSeconds: 500 }],
    },
  });
  const attempts = await callTool(app, token, "getQuestionAttempts", { id: Q[0] });
  assert.equal(attempts.totalAttempts, 1);
  assert.equal(attempts.attempts[0].date, "2026-09-01");
  assert.equal(attempts.attempts[0].source, "timer", "古い記録はアプリで計測した扱い");
  assert.equal(attempts.attempts[0].durationSeconds, 500);
  assert.equal(attempts.attempts[0].revision, 0);
});
