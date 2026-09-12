// 鍵まわりの確認。オーナーキー・接続トークン・ハッシュ保存・権限・失効。

import { test } from "node:test";
import assert from "node:assert/strict";

import { hashToken, timingSafeEqual } from "../server/auth/tokens.js";
import { OWNER_KEY, call, callTool, createTestApp, enableAiLink, mcp } from "./helpers.mjs";

test("オーナーキーが無ければ管理APIは使えない", async () => {
  const { app } = createTestApp();
  const denied = await call(app, "/api/admin/status");
  assert.equal(denied.status, 401);
  const ok = await call(app, "/api/admin/status", { token: OWNER_KEY });
  assert.equal(ok.status, 200);
});

test("オーナーキーが未設定なら管理APIは503で止まる", async () => {
  const { app } = createTestApp({ env: { STUDY_TODO_OWNER_KEY: "" } });
  const response = await call(app, "/api/admin/status", { token: "なんでも".replace("なんでも", "anything") });
  assert.equal(response.status, 503);
});

test("接続トークンは平文で保存されず、ハッシュだけが残る", async () => {
  const { app, storage } = createTestApp();
  const token = await enableAiLink(app);
  const stored = await storage.get("studytodo:tokens");
  const entry = stored.tokens[0];
  assert.equal(entry.hash, await hashToken(token));
  assert.ok(!JSON.stringify(stored).includes(token));
  assert.match(entry.preview, /…$/);
});

test("トークンを再発行すると前のトークンは使えない", async () => {
  const { app } = createTestApp();
  const first = await enableAiLink(app);
  const second = (await call(app, "/api/admin/token", {
    method: "POST", token: OWNER_KEY, body: { scopes: ["read"] },
  })).body.token;
  assert.notEqual(first, second);
  assert.equal((await mcp(app, first, "tools/list")).status, 401);
  assert.equal((await mcp(app, second, "tools/list")).status, 200);
});

test("失効させると接続できなくなる", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  await call(app, "/api/admin/token", { method: "DELETE", token: OWNER_KEY });
  assert.equal((await mcp(app, token, "tools/list")).status, 401);
});

test("AI連携がオフのあいだは接続できない", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  await call(app, "/api/admin/settings", { method: "POST", token: OWNER_KEY, body: { enabled: false } });
  assert.equal((await mcp(app, token, "tools/list")).status, 401);
});

test("write の許可を外すと、トークンに write があっても書けない", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app, { write: true });
  await call(app, "/api/admin/settings", {
    method: "POST", token: OWNER_KEY, body: { permissions: { write: false } },
  });
  const result = await callTool(app, token, "updateTodayTasks", { tasks: [] });
  assert.equal(result.error, "permission_denied");
});

test("read の許可は外せない（外すと何もできなくなるため）", async () => {
  const { app } = createTestApp();
  await enableAiLink(app);
  const response = await call(app, "/api/admin/settings", {
    method: "POST", token: OWNER_KEY, body: { permissions: { read: false } },
  });
  assert.equal(response.body.permissions.read, true);
});

test("timingSafeEqual は長さの違う文字列を区別する", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
});

test("CORS は許可したオリジンにだけ返る", async () => {
  const { app } = createTestApp();
  const allowed = await app.fetch(new Request("https://study-todo.test/mcp", {
    method: "OPTIONS",
    headers: { origin: "https://hsgwyuki0429-design.github.io" },
  }));
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://hsgwyuki0429-design.github.io");

  const denied = await app.fetch(new Request("https://study-todo.test/mcp", {
    method: "OPTIONS",
    headers: { origin: "https://example.com" },
  }));
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("OAuth の案内が出る", async () => {
  const { app } = createTestApp();
  const resource = await call(app, "/.well-known/oauth-protected-resource");
  assert.equal(resource.body.resource, "https://study-todo.test/mcp");
  const server = await call(app, "/.well-known/oauth-authorization-server");
  assert.deepEqual(server.body.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(server.body.scopes_supported, ["read", "write"]);
});

test("OAuth で接続トークンをアクセストークンに引き換えられる", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  const { pkceChallengeOf } = await import("../server/oauth.js");
  const verifier = "verifier-for-tests-0123456789012345678901234567890123";
  const challenge = await pkceChallengeOf(verifier);

  const registered = await call(app, "/oauth/register", {
    method: "POST",
    body: { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" },
  });
  const clientId = registered.body.client_id;

  const form = new FormData();
  form.set("client_id", clientId);
  form.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  form.set("code_challenge", challenge);
  form.set("state", "xyz");
  form.set("connection_token", token);
  const authorized = await app.fetch(new Request("https://study-todo.test/oauth/authorize", { method: "POST", body: form }));
  assert.equal(authorized.status, 302);
  const code = new URL(authorized.headers.get("location")).searchParams.get("code");

  const tokenForm = new FormData();
  tokenForm.set("grant_type", "authorization_code");
  tokenForm.set("code", code);
  tokenForm.set("client_id", clientId);
  tokenForm.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
  tokenForm.set("code_verifier", verifier);
  const exchanged = await app.fetch(new Request("https://study-todo.test/oauth/token", { method: "POST", body: tokenForm }));
  const issued = await exchanged.json();
  assert.equal(exchanged.status, 200);

  const used = await mcp(app, issued.access_token, "tools/list");
  assert.equal(used.status, 200);
});
