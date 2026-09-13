// 「1回の取り組み＝1件の学習記録」と、繰り越しの確認（サーバー・MCP側）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { QUESTIONS, call, callTool, createTestApp, enableAiLink, joinDevice } from "./helpers.mjs";

const Q = QUESTIONS.map((question) => question.id);
const NOW = Date.parse("2026-09-12T03:00:00Z");

function attempt(id, { questionId = Q[0], timestamp = "2026-09-12T02:00:00Z", evaluation = "perfect", ...rest } = {}) {
  return { id, questionId, timestamp, evaluation, durationSeconds: 300, ...rest };
}

async function setup({ tasks = null, records = [], challenges = [], now = () => NOW } = {}) {
  const { app } = createTestApp({ now });
  const token = await enableAiLink(app);
  const device = await joinDevice(app);
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      questions: { questions: QUESTIONS },
      records,
      challenges,
      taskPlans: tasks ? [{ date: "2026-09-12", tasks, updatedAt: "2026-09-12T01:00:00Z", revision: 0 }] : [],
    },
  });
  return { app, token, device };
}

const push = (app, device, body) => call(app, "/api/sync/push", { method: "POST", token: device.deviceKey, body });

test("同じ例題を別の日に2回解くと、各日に1件ずつ・履歴に2件残る", async () => {
  const { app, token } = await setup({
    records: [
      attempt("r1", { timestamp: "2026-09-11T02:00:00Z", evaluation: "calc_error" }),
      attempt("r2", { timestamp: "2026-09-12T02:00:00Z", evaluation: "perfect" }),
    ],
  });
  const range = await callTool(app, token, "getTasksInRange", { from: "2026-09-11", to: "2026-09-12" });
  assert.deepEqual(range.days.map((day) => [day.date, day.attemptCount]), [["2026-09-11", 1], ["2026-09-12", 1]]);

  const history = await callTool(app, token, "getQuestionAttempts", { id: Q[0] });
  assert.equal(history.totalAttempts, 2);
  assert.deepEqual(history.attempts.map((entry) => entry.evaluation), ["calc_error", "perfect"], "古い順");
});

test("同じ日に2回解けば、2件の記録として残る", async () => {
  const { app, token } = await setup({
    records: [
      attempt("r1", { timestamp: "2026-09-12T01:00:00Z", evaluation: "calc_error" }),
      attempt("r2", { timestamp: "2026-09-12T05:00:00Z", evaluation: "perfect" }),
    ],
  });
  const day = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.equal(day.attemptCount, 2);
  assert.equal((await callTool(app, token, "getQuestionAttempts", { id: Q[0] })).totalAttempts, 2);
});

test("1回目を実施しても、同じ日の2回目の予定は消えない", async () => {
  const { app, token } = await setup({
    tasks: [{ id: "t1", questionIds: [Q[0], Q[0]], kind: "new" }],
  });
  const before = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  const [first, second] = before.tasks[0].items;

  const { device } = await setup();
  void device;
  // 1回目の取り組みだけを記録する。
  const joined = await joinDevice(app, "iPad");
  await push(app, joined, { records: [attempt("r1", { planTaskId: "t1", planItemId: first.itemId })] });

  const after = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.deepEqual(after.tasks[0].doneItemIds, [first.itemId]);
  assert.deepEqual(after.tasks[0].pendingItemIds, [second.itemId], "2回目の予定は残る");
  assert.equal(after.attemptCount, 1);
});

test("あとで解き直しても、前の記録の評価は変わらない", async () => {
  const { app, token, device } = await setup({
    records: [attempt("r1", { timestamp: "2026-09-11T02:00:00Z", evaluation: "wrong_approach" })],
  });
  await push(app, device, { records: [attempt("r2", { timestamp: "2026-09-12T02:00:00Z", evaluation: "perfect" })] });

  const history = await callTool(app, token, "getQuestionAttempts", { id: Q[0] });
  assert.deepEqual(history.attempts.map((entry) => [entry.date, entry.evaluation]), [
    ["2026-09-11", "wrong_approach"],
    ["2026-09-12", "perfect"],
  ]);
});

test("元の予定に無かった実績も、実施した日に出る", async () => {
  const { app, token } = await setup({
    tasks: [{ id: "t1", questionIds: [Q[0]], kind: "new" }],
    records: [attempt("r1", { questionId: Q[2] })],
  });
  const day = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.deepEqual(day.attempts.map((entry) => entry.questionId), [Q[2]]);
  // 予定のほうは、まだ手つかずのまま残っている。
  assert.equal(day.tasks[0].pendingItemIds.length, 1);
});

test("未実施の予定を繰り越しても、取り組み回数は増えない", async () => {
  const { app, token } = await setup({
    tasks: [{ id: "t1", questionIds: [Q[0], Q[1]], kind: "new" }],
  });
  const before = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  const result = await callTool(app, token, "applyTaskChanges", {
    operationId: "op-carry-1",
    reason: "今日は時間が足りなかった",
    expectedRevisions: [{ date: "2026-09-12", revision: before.revision }, { date: "2026-09-13", revision: 0 }],
    changes: [{ op: "carryOver", taskId: "t1", fromDate: "2026-09-12", toDate: "2026-09-13", reason: "time_shortage" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.moves.length, 1);
  assert.equal(result.moves[0].kind, "carry_over");
  assert.equal(result.moves[0].reason, "time_shortage");

  const today = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.equal(today.tasks.length, 0);
  assert.equal(today.attemptCount, 0, "繰り越しは実績を作らない");
  const tomorrow = await callTool(app, token, "getTodayTasks", { date: "2026-09-13" });
  assert.equal(tomorrow.tasks[0].items.length, 2);
  // 予定項目のIDは変わらず、当初の予定日と繰り越し回数が残る。
  assert.deepEqual(tomorrow.tasks[0].items.map((item) => item.itemId), before.tasks[0].items.map((item) => item.itemId));
  assert.deepEqual(tomorrow.tasks[0].items.map((item) => item.originalDate), ["2026-09-12", "2026-09-12"]);
  assert.deepEqual(tomorrow.tasks[0].items.map((item) => item.carriedCount), [1, 1]);
  assert.equal(tomorrow.tasks[0].items[0].carriedOver, true);
  assert.equal((await callTool(app, token, "getQuestionAttempts", { id: Q[0] })).totalAttempts, 0);
});

test("一部だけ実施済みのまとまりから、未実施の分だけ繰り越せる", async () => {
  const { app, token, device } = await setup({
    tasks: [{ id: "t1", questionIds: [Q[0], Q[1]], kind: "new" }],
  });
  const before = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  const [doneItem, pendingItem] = before.tasks[0].items;
  await push(app, device, { records: [attempt("r1", { questionId: Q[0], planTaskId: "t1", planItemId: doneItem.itemId })] });

  const revision = (await callTool(app, token, "getTodayTasks", { date: "2026-09-12" })).revision;
  // 実施済みを混ぜると断られる。
  const denied = await callTool(app, token, "applyTaskChanges", {
    operationId: "op-carry-bad",
    expectedRevisions: [{ date: "2026-09-12", revision }, { date: "2026-09-13", revision: 0 }],
    changes: [{ op: "carryOver", taskId: "t1", fromDate: "2026-09-12", toDate: "2026-09-13", itemIds: [doneItem.itemId, pendingItem.itemId] }],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "already_done");

  // 未実施の分だけなら通る。
  const ok = await callTool(app, token, "applyTaskChanges", {
    operationId: "op-carry-good",
    expectedRevisions: [{ date: "2026-09-12", revision }, { date: "2026-09-13", revision: 0 }],
    changes: [{ op: "carryOver", taskId: "t1", fromDate: "2026-09-12", toDate: "2026-09-13" }],
  });
  assert.equal(ok.ok, true);

  const today = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.deepEqual(today.tasks[0].items.map((item) => item.itemId), [doneItem.itemId], "実施済みの予定は実施日に残る");
  assert.equal(today.attemptCount, 1);
  const tomorrow = await callTool(app, token, "getTodayTasks", { date: "2026-09-13" });
  assert.deepEqual(tomorrow.tasks[0].items.map((item) => item.itemId), [pendingItem.itemId]);
});

test("チャレンジの中の1問も、その問題の履歴では1回として数える", async () => {
  const { app, token } = await setup({
    tasks: [{ id: "c1", kind: "challenge", questionIds: [Q[0], Q[1]], title: "10分チャレンジ" }],
    records: [
      attempt("r1", { questionId: Q[0], challengeId: "chl1", planTaskId: "c1" }),
      attempt("r2", { questionId: Q[1], challengeId: "chl1", planTaskId: "c1", evaluation: "calc_error" }),
    ],
    challenges: [{
      id: "chl1",
      taskId: "c1",
      timestamp: "2026-09-12T02:10:00Z",
      timeLimitSeconds: 600,
      totalElapsedSeconds: 580,
      succeeded: true,
      laps: [
        { questionId: Q[0], durationSeconds: 300, evaluation: "perfect" },
        { questionId: Q[1], durationSeconds: 280, evaluation: "calc_error" },
      ],
    }],
  });
  const history = await callTool(app, token, "getQuestionAttempts", { id: Q[0] });
  assert.equal(history.totalAttempts, 1, "チャレンジと通常で二重に数えない");
  assert.equal(history.attempts[0].inChallenge, true);

  const day = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.equal(day.attemptCount, 2);
  assert.equal((await callTool(app, token, "getChallengeResults")).total, 1);
});

test("繰り越しの履歴をMCPから取れる（当初の予定日と回数つき）", async () => {
  const { app, token } = await setup({ tasks: [{ id: "t1", questionIds: [Q[0]], kind: "new" }] });
  const first = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  await callTool(app, token, "applyTaskChanges", {
    operationId: "op-m1",
    expectedRevisions: [{ date: "2026-09-12", revision: first.revision }, { date: "2026-09-13", revision: 0 }],
    changes: [{ op: "carryOver", taskId: "t1", fromDate: "2026-09-12", toDate: "2026-09-13", reason: "too_hard" }],
  });
  const second = await callTool(app, token, "getTodayTasks", { date: "2026-09-13" });
  await callTool(app, token, "applyTaskChanges", {
    operationId: "op-m2",
    expectedRevisions: [{ date: "2026-09-13", revision: second.revision }, { date: "2026-09-14", revision: 0 }],
    changes: [{ op: "carryOver", taskId: second.tasks[0].id, fromDate: "2026-09-13", toDate: "2026-09-14" }],
  });

  const moves = await callTool(app, token, "getPlanMoves", { limit: 1 });
  assert.equal(moves.total, 2);
  assert.equal(moves.count, 1);
  assert.equal(moves.nextOffset, 1, "続きがあることが分かる");
  const all = await callTool(app, token, "getPlanMoves", {});
  assert.deepEqual(all.moves.map((move) => [move.fromDate, move.toDate]), [
    ["2026-09-13", "2026-09-14"],
    ["2026-09-12", "2026-09-13"],
  ]);
  assert.equal(all.moves[1].reason, "too_hard");
  assert.equal(all.moves[0].reason, "unspecified", "理由を渡さなければ未入力のまま");
  assert.equal(all.moves[0].items[0].originalDate, "2026-09-12");
  assert.equal(all.moves[0].items[0].carriedCount, 2);
  assert.equal(all.moves[0].actorKind, "ai");

  // まだ取り組んでいない予定も分かる。
  const unfinished = await callTool(app, token, "getUnfinishedPlanItems", { from: "2026-09-12", to: "2026-09-20" });
  assert.equal(unfinished.total, 1);
  assert.equal(unfinished.days[0].date, "2026-09-14");
});

test("繰り越しの記録は、同期を送り直しても増えない", async () => {
  const { app, token, device } = await setup({ tasks: [{ id: "t1", questionIds: [Q[0]], kind: "new" }] });
  const move = {
    id: "mv-local-1",
    fromDate: "2026-09-12",
    toDate: "2026-09-13",
    at: "2026-09-12T04:00:00Z",
    actorKind: "user",
    kind: "carry_over",
    reason: "time_shortage",
    items: [{ itemId: "t1#0", questionId: Q[0], originalDate: "2026-09-12", carriedCount: 1 }],
  };
  const first = await push(app, device, { moves: [move] });
  assert.equal(first.body.accepted.moves, 1);
  const again = await push(app, device, { moves: [move] });
  assert.equal(again.body.accepted.moves, 0);
  assert.equal(again.body.accepted.duplicatedMoves, 1);
  assert.equal((await callTool(app, token, "getPlanMoves", {})).total, 1);
  // 端末へも配られる。
  assert.equal(again.body.snapshot.moves.length, 1);
});

test("古い記録（予定との対応が無いもの）も失われず、再送でも増えない", async () => {
  const { app, token, device } = await setup({
    records: [attempt("old1", { timestamp: "2026-09-01T02:00:00Z" })],
  });
  const again = await push(app, device, { records: [attempt("old1", { timestamp: "2026-09-01T02:00:00Z" })] });
  assert.equal(again.body.accepted.records, 0);
  const history = await callTool(app, token, "getQuestionAttempts", { id: Q[0] });
  assert.equal(history.totalAttempts, 1);
  assert.equal(history.attempts[0].legacy, true, "予定との対応が分からない記録として返る");
  assert.equal(history.attempts[0].planItemId, null);
});

test("日本時間の日付の境目でも、正しい日の実績になる", async () => {
  const { app, token } = await setup({
    // 日本時間 2026-09-13 の 0:30（UTC では 2026-09-12 の 15:30）。
    records: [attempt("r1", { timestamp: "2026-09-12T15:30:00Z" })],
    now: () => Date.parse("2026-09-13T01:00:00Z"),
  });
  const range = await callTool(app, token, "getTasksInRange", { from: "2026-09-12", to: "2026-09-13" });
  assert.deepEqual(range.days.map((day) => [day.date, day.attemptCount]), [["2026-09-13", 1]]);
});

test("問題ごとの履歴は、多いときに区切って返る", async () => {
  const records = Array.from({ length: 7 }, (_, index) => attempt(`r${index}`, {
    timestamp: `2026-09-0${index + 1}T02:00:00Z`,
  }));
  const { app, token } = await setup({ records });
  const page = await callTool(app, token, "getQuestionAttempts", { id: Q[0], limit: 3 });
  assert.equal(page.totalAttempts, 7);
  assert.equal(page.count, 3);
  assert.equal(page.nextOffset, 3);
  const next = await callTool(app, token, "getQuestionAttempts", { id: Q[0], limit: 3, offset: page.nextOffset });
  assert.equal(next.attempts[0].recordId, "r3");
});

test("AIは学習記録を作れないまま（取り組みを増やせない）", async () => {
  const { app, token } = await setup({ tasks: [{ id: "t1", questionIds: [Q[0]], kind: "new" }] });
  const before = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  const denied = await callTool(app, token, "applyTaskChanges", {
    operationId: "op-fake",
    expectedRevisions: [{ date: "2026-09-12", revision: before.revision }],
    changes: [{ op: "update", taskId: "t1", patch: { kind: "review" } }],
  });
  assert.equal(denied.ok, true);
  assert.equal((await callTool(app, token, "getQuestionAttempts", { id: Q[0] })).totalAttempts, 0);
});
