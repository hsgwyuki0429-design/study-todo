// 保存先ごとの保証の確認。
//
// ここで確かめられるのは、Node で動かせる範囲（メモリ・ファイル・KVの模型）まで。
// Cloudflare の Durable Object そのものの振る舞いは、この自動テストでは動かせない
// （Workers の実行環境が要る）。この点は docs/mcp.md にも書いてある。
// ただし「KV 単体では、まとめての安全な書き換えを行わずに断る」ことは、
// 実際の KV ドライバを通して確かめられる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createStudyTodoMcpApp } from "../server/app.js";
import { createKvDriver } from "../server/storage/kv-driver.js";
import { createMemoryDriver } from "../server/storage/memory-driver.js";
import { createFileDriver } from "../server/storage/file-driver.js";
import { runTransaction, supportsTransactions } from "../server/storage/driver.js";
import { OWNER_KEY, QUESTIONS, call, callTool, enableAiLink, joinDevice } from "./helpers.mjs";

/** Cloudflare KV の形だけをまねた、その場かぎりの保存先。比較して書く仕組みは無い。 */
function fakeKvNamespace() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix = "", cursor } = {}) {
      void cursor;
      return {
        keys: [...store.keys()].filter((key) => key.startsWith(prefix)).sort().map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

test("KV 単体では、まとめての変更を実行せずに理由を返す", async () => {
  const storage = createKvDriver(fakeKvNamespace());
  assert.equal(supportsTransactions(storage), false);
  const app = createStudyTodoMcpApp({
    storage,
    now: () => Date.parse("2026-09-12T03:00:00Z"),
    env: { STUDY_TODO_OWNER_KEY: OWNER_KEY },
  });
  const token = await enableAiLink(app);
  const device = await joinDevice(app);
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      questions: { questions: QUESTIONS },
      taskPlans: [{
        date: "2026-09-12",
        tasks: [{ id: "t1", questionIds: [QUESTIONS[0].id], kind: "new" }],
        updatedAt: "2026-09-12T01:00:00Z",
        revision: 0,
      }],
    },
  });

  // 読み取りと同期は、これまでどおり動く。
  const view = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.equal(view.tasks.length, 1);
  const info = await callTool(app, token, "getAppInfo");
  assert.equal(info.storage.atomicBatchUpdates, false);

  // 予定の変更は、黙って書かずに断る。
  const result = await callTool(app, token, "applyTaskChanges", {
    operationId: "op-kv",
    expectedRevisions: [{ date: "2026-09-12", revision: view.revision }],
    changes: [{ op: "remove", taskId: "t1" }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "storage_not_atomic");
  assert.match(result.message, /Durable Object/);
  assert.equal((await callTool(app, token, "getTodayTasks", { date: "2026-09-12" })).tasks.length, 1);

  const health = await call(app, "/health");
  assert.equal(health.body.storage.atomicBatchUpdates, false);
});

test("メモリの保存先では、まとめ書きの途中に別の書き込みが割り込まない", async () => {
  const storage = createMemoryDriver();
  await storage.put("counter", { value: 0 });
  const bump = () => runTransaction(storage, async (tx) => {
    const current = (await tx.get("counter")).value;
    // わざと待って、割り込みが起きうる隙を作る。
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tx.put("counter", { value: current + 1 });
  });
  await Promise.all([bump(), bump(), bump(), bump(), bump()]);
  assert.equal((await storage.get("counter")).value, 5);
});

test("まとめ書きの途中で失敗したら、1つも書かれない", async () => {
  const storage = createMemoryDriver();
  await storage.put("a", { value: "もと" });
  await assert.rejects(runTransaction(storage, async (tx) => {
    await tx.put("a", { value: "あたらしい" });
    await tx.put("b", { value: "あたらしい" });
    throw new Error("途中で失敗");
  }));
  assert.deepEqual(await storage.get("a"), { value: "もと" });
  assert.equal(await storage.get("b"), null);
});

test("ファイルの保存先でも、まとめ書きが直列になる", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "study-todo-test-"));
  try {
    const storage = createFileDriver(directory);
    await storage.put("studytodo:counter", { value: 0 });
    const bump = () => runTransaction(storage, async (tx) => {
      const current = (await tx.get("studytodo:counter")).value;
      await new Promise((resolve) => setTimeout(resolve, 2));
      await tx.put("studytodo:counter", { value: current + 1 });
    });
    await Promise.all([bump(), bump(), bump()]);
    assert.equal((await storage.get("studytodo:counter")).value, 3);
    assert.deepEqual(await storage.list("studytodo:"), ["studytodo:counter"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
