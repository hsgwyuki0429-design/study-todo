// テスト用の下ごしらえ。メモリ保存のサーバーを1つ立てる。

import { createStudyTodoMcpApp } from "../server/app.js";
import { createMemoryDriver } from "../server/storage/memory-driver.js";

export const OWNER_KEY = "owner-key-for-tests-0123456789";

export function createTestApp({ now = () => Date.parse("2026-09-12T03:00:00Z"), env = {} } = {}) {
  const storage = createMemoryDriver();
  const app = createStudyTodoMcpApp({
    storage,
    now,
    env: { STUDY_TODO_OWNER_KEY: OWNER_KEY, ...env },
  });
  return { app, storage };
}

const BASE = "https://study-todo.test";

export async function call(app, path, { method = "GET", body = null, token = null, headers = {} } = {}) {
  const response = await app.fetch(new Request(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === null ? undefined : JSON.stringify(body),
  }));
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, body: payload, headers: response.headers };
}

/** AI連携を有効にして接続トークンを発行する。 */
export async function enableAiLink(app, { write = true } = {}) {
  await call(app, "/api/admin/settings", {
    method: "POST",
    token: OWNER_KEY,
    body: { enabled: true, permissions: { read: true, write } },
  });
  const issued = await call(app, "/api/admin/token", {
    method: "POST",
    token: OWNER_KEY,
    body: { scopes: write ? ["read", "write"] : ["read"] },
  });
  return issued.body.token;
}

/** 端末を1台登録して端末キーを得る。 */
export async function joinDevice(app, deviceName = "iPhone") {
  const issued = await call(app, "/api/admin/sync-code", { method: "POST", token: OWNER_KEY, body: {} });
  const joined = await call(app, "/api/sync/join", {
    method: "POST",
    body: { code: issued.body.syncCode, deviceName },
  });
  return { ...joined.body, syncCode: issued.body.syncCode };
}

export async function mcp(app, token, method, params = {}, headers = {}) {
  return call(app, "/mcp", {
    method: "POST",
    token,
    headers,
    body: { jsonrpc: "2.0", id: 1, method, params },
  });
}

export async function callTool(app, token, name, args = {}) {
  const response = await mcp(app, token, "tools/call", { name, arguments: args });
  return response.body?.result?.structuredContent ?? response.body;
}

export function record(id, { questionId = "数学I+A-例題-90", evaluation = "perfect", timestamp = "2026-09-12T02:00:00Z", durationSeconds = 300 } = {}) {
  return { id, questionId, evaluation, timestamp, durationSeconds };
}

export const QUESTIONS = [
  { id: "数学I+A-例題-90", subject: "数学I+A", chapter: "数列", section: "漸化式", type: "例題", number: 90, label: "例題 90" },
  { id: "数学I+A-例題-91", subject: "数学I+A", chapter: "数列", section: "漸化式", type: "例題", number: 91, label: "例題 91" },
  { id: "数学I+A-例題-92", subject: "数学I+A", chapter: "図形", section: "円", type: "例題", number: 92, label: "例題 92" },
];
