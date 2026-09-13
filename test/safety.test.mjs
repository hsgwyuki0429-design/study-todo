// AIにさせてはいけないことの確認。

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTools } from "../server/tools.js";
import { QUESTIONS, call, callTool, createTestApp, enableAiLink, joinDevice, record } from "./helpers.mjs";

const toolNames = createTools().map((tool) => tool.name);

test("学習記録・チャレンジ結果を作るツールは存在しない", () => {
  const forbidden = ["addStudyRecord", "saveChallengeResult", "recordStudy", "addChallengeResult"];
  for (const name of forbidden) assert.ok(!toolNames.includes(name), `${name} が公開されている`);
});

test("削除・初期化のツールは存在しない", () => {
  const destructive = toolNames.filter((name) => /delete|remove|clear|reset|wipe/i.test(name));
  assert.deepEqual(destructive, []);
});

test("タイマー（この端末の状態）を操作するツールは存在しない", () => {
  const timers = toolNames.filter((name) => /session|timer|startQuestion|stopQuestion/i.test(name));
  assert.deepEqual(timers, []);
});

test("知らないツール名を呼んでも何も起きない", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  const response = await call(app, "/mcp", {
    method: "POST",
    token,
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "addStudyRecord", arguments: {} } },
  });
  assert.equal(response.body.error.code, -32602);
});

test("AIが予定を変えても、学習記録は1件も変わらない", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  const device = await joinDevice(app);
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      questions: { questions: QUESTIONS },
      records: [record("rec1"), record("rec2", { questionId: "数学I+A-例題-91" })],
    },
  });

  await callTool(app, token, "updateTodayTasks", { tasks: [] });
  const stats = await callTool(app, token, "getStudyStats");
  assert.equal(stats.totalRecords, 2);
});

test("書き込みツールには、置き換えであることが説明に書いてある", () => {
  const tools = createTools();
  for (const name of ["updateTodayTasks", "updateTasksForDate"]) {
    const tool = tools.find((entry) => entry.name === name);
    assert.match(tool.description, /置き換える/);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.inputSchema.properties.tasks.items.properties.questionIds.description.length > 20);
  }
});

test("読み取りツールには readOnlyHint が付いている", () => {
  for (const tool of createTools()) {
    if (tool.scope === "read") assert.equal(tool.annotations.readOnlyHint, true);
    if (tool.scope === "write") assert.equal(tool.annotations.readOnlyHint, false);
  }
});

test("AIは完了の印を付けられない", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  const device = await joinDevice(app);
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: { questions: { questions: QUESTIONS } },
  });
  const result = await callTool(app, token, "updateTasksForDate", {
    date: "2026-09-13",
    tasks: [{ questionIds: [QUESTIONS[0].id], kind: "new", completed: true }],
  });
  assert.equal(result.error, "invalid_input");
  // 新しい経路には completed そのものが無い。
  const apply = createTools().find((tool) => tool.name === "applyTaskChanges");
  const body = apply.inputSchema.properties.changes.items.properties.patch;
  assert.ok(!("completed" in body.properties));
  assert.ok(!("pinned" in body.properties));
});

test("予定を変えるツールには、保護と競合の説明が入っている", () => {
  const tools = createTools();
  const apply = tools.find((tool) => tool.name === "applyTaskChanges");
  assert.match(apply.description, /固定/);
  assert.match(apply.description, /operationId/);
  assert.equal(apply.inputSchema.required.includes("expectedRevisions"), true);
  assert.equal(apply.inputSchema.required.includes("operationId"), true);
  for (const name of ["updateTodayTasks", "updateTasksForDate"]) {
    const tool = tools.find((entry) => entry.name === name);
    assert.match(tool.description, /完了済み・実行中・固定/);
  }
});
