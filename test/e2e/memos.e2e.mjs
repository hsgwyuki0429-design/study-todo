// AIメモの通し確認。AIが足したメモが同期で端末へ届き、画面で読める・解決済みにできる・消せて、
// その結果がクラウドとほかの端末へ戻ること。
//
//   npm run test:e2e
//
// Playwright が無い環境では、何も落とさずに飛ばす。

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { OWNER_KEY, loadPlaywright, startTestServer } from "./server.mjs";
import { call, callTool } from "../helpers.mjs";

const playwright = await loadPlaywright();
const options = playwright ? {} : { skip: "Playwright が無いので飛ばします" };

let server = null;
let browser = null;

before(async () => {
  if (!playwright) return;
  browser = await playwright.chromium.launch();
});

after(async () => {
  await browser?.close();
});

beforeEach(async () => {
  if (!playwright) return;
  server = await startTestServer();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

/** AI連携を有効にして、読み書きできる接続トークンを得る（この E2E のサーバーのオーナーキーで）。 */
async function issueAiToken() {
  await call(server.app, "/api/admin/settings", {
    method: "POST", token: OWNER_KEY, body: { enabled: true, permissions: { read: true, write: true } },
  });
  const issued = await call(server.app, "/api/admin/token", {
    method: "POST", token: OWNER_KEY, body: { scopes: ["read", "write"] },
  });
  return issued.body.token;
}

async function openDevice() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // /api/sync/replan は、プランナーが一度も動いていないと 404 を返す（メモとは無関係の既存の動き）。
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of 404/.test(message.text())) errors.push(message.text());
  });
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(`${server.origin}/index.html`);
  await page.waitForFunction(() => document.querySelectorAll(".tabbar button").length > 0);
  await page.waitForFunction(async () => {
    const api = await import("./src/api.js");
    return (await api.listQuestions()).length > 0;
  });
  return { page, context, errors };
}

async function link(page, deviceName) {
  await page.evaluate(async ({ ownerKey, deviceName }) => {
    const cloud = await import("./src/cloud-sync.js");
    await cloud.saveCloudConfig({ serverUrl: location.origin, ownerKey });
    const config = await cloud.getCloudConfig();
    const issued = await cloud.admin.issueSyncCode(config);
    await cloud.joinDevice({ serverUrl: location.origin, code: issued.syncCode, deviceName });
  }, { ownerKey: OWNER_KEY, deviceName });
}

const syncNow = (page) => page.evaluate(async () => {
  const cloud = await import("./src/cloud-sync.js");
  const result = await cloud.syncNow({ force: true });
  return result.ok ? "ok" : (result.message ?? result.reason);
});

const localMemos = (page) => page.evaluate(async () => (await (await import("./src/api.js")).listMemos()));

async function openMemoPanel(page) {
  await page.locator(".tabbar button", { hasText: "設定" }).click();
  const toggle = page.locator(".section-toggle", { hasText: "AIメモ" });
  // すでに開いているときは押さない（押すと閉じてしまう）。
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.waitForSelector("#screen-settings .memo-intro");
}

test("AIが足したメモが端末に届き、画面で解決済みにして消すと、クラウドとほかの端末へ戻る", options, async () => {
  const a = await openDevice();
  await link(a.page, "iPhone");
  assert.equal(await syncNow(a.page), "ok");
  const questionId = await a.page.evaluate(async () => (await (await import("./src/api.js")).listQuestions())[0].id);

  const token = await issueAiToken();
  const added = await callTool(server.app, token, "addAiMemo", {
    operationId: "e2e-memo-1", category: "handoff", pinned: true,
    body: "次回は図形の復習を先に入れる", questionIds: [questionId],
  });
  assert.equal(added.ok, true, JSON.stringify(added));
  await callTool(server.app, token, "addAiMemo", {
    operationId: "e2e-memo-2", category: "trend", body: "直近14日で学習記録があるのは10/2と10/5のみ",
  });

  // 同期で届く。
  assert.equal(await syncNow(a.page), "ok");
  assert.equal((await localMemos(a.page)).length, 2);

  // 画面: 固定が先頭、AIのアイコンが付く。
  await openMemoPanel(a.page);
  const cards = a.page.locator(".memo-list .memo");
  assert.equal(await cards.count(), 2);
  assert.match(await cards.nth(0).innerText(), /固定/);
  assert.match(await cards.nth(0).innerText(), /次回は図形の復習を先に入れる/);
  assert.equal(await cards.nth(0).locator(".memo-ai").count(), 1);

  // 種類のタブで絞れる。
  await a.page.locator(".memo-choices .choice", { hasText: "傾向" }).click();
  await a.page.waitForFunction(() => document.querySelectorAll(".memo-list .memo").length === 1);
  await a.page.locator(".memo-choices .choice", { hasText: "すべて" }).click();
  await a.page.waitForFunction(() => document.querySelectorAll(".memo-list .memo").length === 2);

  // 問題の詳細に、その問題IDを含むメモが小さく出る。
  await a.page.evaluate(async (id) => {
    const { state, render } = await import("./src/state.js");
    const q = state.questions.get(id);
    state.records.toc = { chapter: q.chapter, section: q.section, questionId: id, attemptId: null };
    state.tab = "records";
    render();
  }, questionId);
  await a.page.waitForSelector(".memo-mini");
  assert.match(await a.page.locator(".memo-mini").innerText(), /次回は図形の復習を先に入れる/);
  assert.doesNotMatch(await a.page.locator(".memo-mini").innerText(), /10\/2/);

  // 「解決済みにする」→ 同期 → AIから見ても解決済み。
  await openMemoPanel(a.page);
  await a.page.locator(".memo-list .memo", { hasText: "次回は図形の復習" }).getByRole("button", { name: "解決済みにする" }).click();
  await a.page.waitForFunction(() => document.querySelectorAll(".memo-list .memo").length === 1);
  assert.equal(await syncNow(a.page), "ok");
  const active = await callTool(server.app, token, "getAiMemos", {});
  assert.equal(active.total, 1);
  const resolved = await callTool(server.app, token, "getAiMemos", { status: "resolved" });
  assert.equal(resolved.memos[0].id, added.memo.id);
  assert.equal(resolved.memos[0].revision, 2);

  // 別の端末にも届く。
  const b = await openDevice();
  await link(b.page, "iPad");
  assert.equal(await syncNow(b.page), "ok");
  const onB = await localMemos(b.page);
  assert.equal(onB.length, 2);
  assert.equal(onB.find((memo) => memo.id === added.memo.id).status, "resolved");

  // B で消す → クラウドから消え、A にも反映される。
  await b.page.evaluate(async (id) => (await import("./src/api.js")).deleteMemo(id), added.memo.id);
  assert.equal(await syncNow(b.page), "ok");
  assert.equal((await callTool(server.app, token, "getAiMemos", { status: "resolved" })).total, 0);
  assert.equal(await syncNow(a.page), "ok");
  assert.deepEqual((await localMemos(a.page)).map((memo) => memo.id).includes(added.memo.id), false);

  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  await a.context.close();
  await b.context.close();
});

test("v3 の IndexedDB を開き直しても、既存のデータは残り、メモも使える", options, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

  // アプリを開く前に、v3 のデータベース（memos ストアが無い）を同じオリジンに作っておく。
  await page.goto(`${server.origin}/manifest.webmanifest`);
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("aochart", 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      // v3 までの構成（索引も含めて、src/idb.js の移行前と同じ）。
      const make = (name, keyPath, indexes = []) => {
        const store = db.createObjectStore(name, { keyPath });
        for (const index of indexes) store.createIndex(index, index);
      };
      make("questions", "id", ["chapter", "section", "subject"]);
      make("records", "id", ["questionId", "timestamp", "evaluation"]);
      make("tasks", "id", ["date"]);
      make("challenges", "id", ["timestamp", "taskId"]);
      make("goals", "id");
      make("meta", "key");
      make("outbox", "key", ["type"]);
      make("moves", "id", ["fromDate", "toDate"]);
    };
    request.onsuccess = () => {
      const tx = request.result.transaction("records", "readwrite");
      tx.objectStore("records").put({
        id: "rec_old", questionId: "q-old", evaluation: "perfect", timestamp: "2026-09-12T02:00:00.000Z",
        date: "2026-09-12", datePrecision: "exact", durationSeconds: 90, source: "timer", revision: 1,
      });
      tx.oncomplete = () => { request.result.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    request.onerror = () => reject(request.error);
  }));

  await page.goto(`${server.origin}/index.html`);
  await page.waitForFunction(() => document.querySelectorAll(".tabbar button").length > 0);
  await page.waitForFunction(async () => (await (await import("./src/api.js")).listQuestions()).length > 0);

  const upgraded = await page.evaluate(() => new Promise((resolve) => {
    const request = indexedDB.open("aochart");
    request.onsuccess = () => { resolve({ version: request.result.version, names: [...request.result.objectStoreNames] }); request.result.close(); };
  }));
  assert.equal(upgraded.version, 4);
  assert.ok(upgraded.names.includes("memos"));
  const records = await page.evaluate(async () => (await (await import("./src/api.js")).listRecords()).map((record) => record.id));
  assert.deepEqual(records, ["rec_old"], "移行で既存の学習記録が消えた");
  assert.deepEqual(await localMemos(page), []);
  await openMemoPanel(page);
  assert.match(await page.locator("#screen-settings .empty").first().innerText(), /メモはまだありません/);
  assert.deepEqual(errors, []);
  await context.close();
});
