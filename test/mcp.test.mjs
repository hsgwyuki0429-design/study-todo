// MCP プロトコルとツールの確認。

import { test } from "node:test";
import assert from "node:assert/strict";

import { OWNER_KEY, QUESTIONS, call, callTool, createTestApp, enableAiLink, joinDevice, mcp, record } from "./helpers.mjs";

async function seed(app, { write = true } = {}) {
  const token = await enableAiLink(app, { write });
  const device = await joinDevice(app);
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      questions: { questions: QUESTIONS },
      records: [
        record("rec1", { evaluation: "wrong_approach" }),
        record("rec2", { questionId: "数学I+A-例題-91", evaluation: "calc_error" }),
        record("rec3", { questionId: "数学I+A-例題-92", evaluation: "perfect" }),
      ],
      taskPlans: [{
        date: "2026-09-12",
        tasks: [{ id: "t1", questionIds: ["数学I+A-例題-90"], kind: "new", order: 0 }],
        updatedAt: "2026-09-12T01:00:00Z",
        revision: 0,
      }],
    },
  });
  return { token, device };
}

test("initialize / tools/list / tools/call が動く", async () => {
  const { app } = createTestApp();
  const { token } = await seed(app);

  const initialized = await mcp(app, token, "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.body.result.serverInfo.name, "study-todo");

  const list = await mcp(app, token, "tools/list");
  const names = list.body.result.tools.map((tool) => tool.name);
  for (const expected of [
    "getAppInfo", "listQuestions", "searchQuestions", "getQuestion", "getStudyHistory",
    "getRecentMistakes", "getStudyStats", "getRecentChallengeResult", "getChallengeResults",
    "getTodayTasks", "getTasksInRange", "getGoals", "updateTodayTasks", "updateTasksForDate",
    "addGoal", "updateGoal",
  ]) {
    assert.ok(names.includes(expected), `${expected} が tools/list にない`);
  }
  // 学習実績は「本人の申告を代理入力する」ツールだけ。権限も別（records）。
  for (const expected of ["addStudyRecords", "updateStudyRecords", "voidStudyRecords"]) {
    assert.ok(names.includes(expected), `${expected} が tools/list にない`);
  }
  // チャレンジ結果を作るツールは、今も公開しない。
  assert.ok(!names.some((name) => /saveChallengeResult|addChallengeResult/.test(name)));

  const info = await callTool(app, token, "getAppInfo");
  assert.equal(info.questionCount, 3);
  assert.equal(info.today, "2026-09-12");
});

test("新しい版（2026-07-28）でも握手なしで呼べる", async () => {
  const { app } = createTestApp();
  const { token } = await seed(app);
  const response = await mcp(app, token, "tools/list", {}, { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" });
  assert.equal(response.status, 200);
  assert.equal(response.body.result.resultType, "complete");
});

test("ヘッダーと本文が食い違えば拒む", async () => {
  const { app } = createTestApp();
  const { token } = await seed(app);
  const response = await mcp(app, token, "tools/list", {}, { "mcp-method": "tools/call" });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, -32020);
});

test("読み取りツールが学習状況を返す", async () => {
  const { app } = createTestApp();
  const { token } = await seed(app);

  const mistakes = await callTool(app, token, "getRecentMistakes", { days: 7 });
  assert.equal(mistakes.total, 2);
  assert.equal(mistakes.calcErrors, 1);
  assert.equal(mistakes.wrongApproaches, 1);

  const stats = await callTool(app, token, "getStudyStats");
  assert.equal(stats.totalRecords, 3);
  assert.equal(stats.byChapter["数列"].count, 2);

  const today = await callTool(app, token, "getTodayTasks");
  assert.equal(today.date, "2026-09-12");
  assert.equal(today.tasks[0].labels[0], "例題 90");

  const search = await callTool(app, token, "searchQuestions", { query: "漸化式" });
  assert.equal(search.total, 2);

  const range = await callTool(app, token, "listQuestions", { numberFrom: 91, numberTo: 92 });
  assert.equal(range.total, 2);
});

test("書き込みツールで予定を置き換えられ、操作が記録に残る", async () => {
  const { app } = createTestApp();
  const { token } = await seed(app);

  const updated = await callTool(app, token, "updateTasksForDate", {
    date: "2026-09-13",
    tasks: [
      { questionIds: ["数学I+A-例題-91", "数学I+A-例題-92"], kind: "new" },
      { title: "復習3問", questionIds: ["数学I+A-例題-90"], kind: "review" },
    ],
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.taskCount, 2);

  const read = await callTool(app, token, "getTodayTasks", { date: "2026-09-13" });
  assert.equal(read.tasks.length, 2);
  assert.equal(read.updatedBy.startsWith("ai"), true);

  // 置き換えであることの確認。
  await callTool(app, token, "updateTasksForDate", { date: "2026-09-13", tasks: [] });
  const cleared = await callTool(app, token, "getTodayTasks", { date: "2026-09-13" });
  assert.equal(cleared.tasks.length, 0);

  const log = await callTool(app, token, "getRecentAiChanges");
  assert.equal(log.entries.length, 2);
  assert.ok(log.entries[0].summary.includes("2026-09-13"));
});

test("目標を追加・変更できる", async () => {
  const { app } = createTestApp();
  const { token } = await seed(app);
  // 目標の対象は、問題IDの一覧として確定させる（文章だけでは作れない）。
  const vague = await callTool(app, token, "addGoal", { title: "がんばる" });
  assert.equal(vague.error, "invalid_input");

  const added = await callTool(app, token, "addGoal", {
    title: "12月までにI+Aを終える",
    deadline: "2026-12-31",
    questionIds: QUESTIONS.map((question) => question.id),
  });
  assert.equal(added.ok, true);
  assert.equal(added.goal.questionIds.length, 3);
  assert.equal(added.goal.completion.type, "attempt");
  const changed = await callTool(app, token, "updateGoal", { id: added.goal.id, title: "1月までにI+Aを終える" });
  assert.equal(changed.goal.title, "1月までにI+Aを終える");
  const goals = await callTool(app, token, "getGoals");
  assert.equal(goals.total, 1);
});

test("read だけの接続では予定を書き換えられない", async () => {
  const { app } = createTestApp();
  const { token } = await seed(app, { write: false });
  const result = await callTool(app, token, "updateTodayTasks", { tasks: [] });
  assert.equal(result.ok, false);
  assert.equal(result.error, "permission_denied");
  const goal = await callTool(app, token, "addGoal", { title: "だめ" });
  assert.equal(goal.error, "permission_denied");
});

test("不正な入力は理由つきで返る", async () => {
  const { app } = createTestApp();
  const { token } = await seed(app);
  const bad = await callTool(app, token, "updateTasksForDate", { date: "2026-13-99", tasks: [] });
  assert.equal(bad.error, "invalid_input");

  const badTask = await callTool(app, token, "updateTasksForDate", {
    date: "2026-09-14",
    tasks: [{ kind: "unknown", questionIds: ["数学I+A-例題-90"] }],
  });
  assert.equal(badTask.error, "invalid_input");

  const missing = await callTool(app, token, "getQuestion", { id: "存在しないID" });
  assert.equal(missing.error, "not_found");
});

test("接続トークンが無ければMCPは使えない", async () => {
  const { app } = createTestApp();
  await seed(app);
  const anonymous = await call(app, "/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate") ?? "", /resource_metadata/);

  const wrong = await mcp(app, "wrong-token-0000", "tools/list");
  assert.equal(wrong.status, 401);
});

test("オーナーキーではMCPを使えず、接続トークンでは管理APIを使えない", async () => {
  const { app } = createTestApp();
  const { token } = await seed(app);
  const asOwner = await mcp(app, OWNER_KEY, "tools/list");
  assert.equal(asOwner.status, 401);
  const asAi = await call(app, "/api/admin/status", { token });
  assert.equal(asAi.status, 401);
});
