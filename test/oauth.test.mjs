// OAuth 2.1 + PKCE と、RFC 8707 の resource（宛先）の確認。
// claude.ai のコネクタ登録は、この道すじで接続してくる。

import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalResource, pkceChallengeOf, resourceMatches } from "../server/oauth.js";
import { call, createTestApp, enableAiLink, mcp } from "./helpers.mjs";

const BASE = "https://study-todo.test";
const MCP_URL = `${BASE}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "verifier-for-tests-0123456789012345678901234567890123";

async function registerClient(app) {
  const response = await call(app, "/oauth/register", {
    method: "POST",
    body: {
      redirect_uris: [REDIRECT],
      client_name: "Claude",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  return response;
}

async function postForm(app, path, values) {
  const form = new FormData();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null) form.set(key, value);
  });
  const response = await app.fetch(new Request(`${BASE}${path}`, { method: "POST", body: form }));
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

/** 認可 → 引き換え を一気に行う。resource の指定はテストごとに変える。 */
async function authorize(app, { clientId, token, resource, challenge }) {
  return postForm(app, "/oauth/authorize", {
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    state: "xyz",
    resource,
    connection_token: token,
  });
}

test("resource の比較（末尾の / や大文字小文字を無視し、入口も認める）", () => {
  assert.equal(canonicalResource("https://Example.com/mcp/"), "https://example.com/mcp");
  assert.equal(canonicalResource("ただの文字列"), null);
  assert.equal(resourceMatches("https://example.com/mcp", "https://example.com/mcp"), true);
  assert.equal(resourceMatches("https://example.com", "https://example.com/mcp"), true);
  assert.equal(resourceMatches("https://other.example.com/mcp", "https://example.com/mcp"), false);
  // 指定が無いクライアント（Claude Code など）は、今までどおり通す。
  assert.equal(resourceMatches(null, "https://example.com/mcp"), true);
});

test("1. クライアントの動的登録ができる", async () => {
  const { app } = createTestApp();
  const registered = await registerClient(app);
  assert.equal(registered.status, 201);
  assert.match(registered.body.client_id, /^[0-9a-f]{32}$/);
  assert.deepEqual(registered.body.redirect_uris, [REDIRECT]);
  assert.equal(registered.body.token_endpoint_auth_method, "none");

  // http の折り返し先（localhost 以外）は受け付けない。
  const denied = await call(app, "/oauth/register", {
    method: "POST",
    body: { redirect_uris: ["http://evil.example.com/cb"] },
  });
  assert.equal(denied.status, 400);
});

test("2. PKCE S256：code_verifier が違えば引き換えられない", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  const clientId = (await registerClient(app)).body.client_id;
  const challenge = await pkceChallengeOf(VERIFIER);
  const authorized = await authorize(app, { clientId, token, resource: MCP_URL, challenge });
  const code = new URL(authorized.headers.get("location")).searchParams.get("code");

  const wrong = await postForm(app, "/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: "ちがう合言葉".replace("ちがう合言葉", "another-verifier-000000000000000000000000000000"),
    resource: MCP_URL,
  });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, "invalid_grant");
});

test("3. 正しい resource なら認可でき、6. そのトークンで /mcp を使える", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  const clientId = (await registerClient(app)).body.client_id;
  const challenge = await pkceChallengeOf(VERIFIER);

  const authorized = await authorize(app, { clientId, token, resource: MCP_URL, challenge });
  assert.equal(authorized.status, 302);
  const location = new URL(authorized.headers.get("location"));
  assert.equal(location.searchParams.get("state"), "xyz");
  assert.equal(location.searchParams.get("iss"), BASE);

  const exchanged = await postForm(app, "/oauth/token", {
    grant_type: "authorization_code",
    code: location.searchParams.get("code"),
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: MCP_URL,
  });
  assert.equal(exchanged.status, 200);
  assert.equal(exchanged.body.token_type, "Bearer");

  const used = await mcp(app, exchanged.body.access_token, "tools/list");
  assert.equal(used.status, 200);

  // 認可コードは一度きり。
  const reused = await postForm(app, "/oauth/token", {
    grant_type: "authorization_code",
    code: location.searchParams.get("code"),
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: MCP_URL,
  });
  assert.equal(reused.status, 400);
});

test("4. 別のサーバー宛ての resource では認可されない", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  const clientId = (await registerClient(app)).body.client_id;
  const challenge = await pkceChallengeOf(VERIFIER);

  // GET は折り返し先へ invalid_target を返す。
  const shown = await app.fetch(new Request(
    `${BASE}/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}`
    + `&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`
    + `&resource=${encodeURIComponent("https://other.example.com/mcp")}`,
  ));
  assert.equal(shown.status, 302);
  const back = new URL(shown.headers.get("location"));
  assert.equal(back.searchParams.get("error"), "invalid_target");
  assert.equal(back.searchParams.get("state"), "xyz");

  // POST も同じく拒む。
  const denied = await authorize(app, { clientId, token, resource: "https://other.example.com/mcp", challenge });
  assert.equal(denied.status, 400);
});

test("5. 認可と引き換えで resource が違えば失敗する", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  const clientId = (await registerClient(app)).body.client_id;
  const challenge = await pkceChallengeOf(VERIFIER);
  const authorized = await authorize(app, { clientId, token, resource: MCP_URL, challenge });
  const code = new URL(authorized.headers.get("location")).searchParams.get("code");

  const mismatched = await postForm(app, "/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: "https://other.example.com/mcp",
  });
  assert.equal(mismatched.status, 400);
  assert.equal(mismatched.body.error, "invalid_target");
});

test("7. 別の resource に結び付いたトークンでは /mcp を使えない", async () => {
  const { app, storage } = createTestApp();
  const token = await enableAiLink(app);
  const clientId = (await registerClient(app)).body.client_id;
  const challenge = await pkceChallengeOf(VERIFIER);
  const authorized = await authorize(app, { clientId, token, resource: MCP_URL, challenge });
  const exchanged = await postForm(app, "/oauth/token", {
    grant_type: "authorization_code",
    code: new URL(authorized.headers.get("location")).searchParams.get("code"),
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: MCP_URL,
  });

  // 保存されている宛先を別のサーバーに書き換えると、その鍵は使えなくなる。
  const document = await storage.get("studytodo:oauth");
  for (const entry of Object.values(document.tokens)) entry.resource = "https://other.example.com/mcp";
  await storage.put("studytodo:oauth", document);

  const used = await mcp(app, exchanged.body.access_token, "tools/list");
  assert.equal(used.status, 401);
  assert.match(used.headers.get("www-authenticate") ?? "", /oauth-protected-resource\/mcp/);
});

test("resource を送らないクライアントでも、今までどおり接続できる", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  const clientId = (await registerClient(app)).body.client_id;
  const challenge = await pkceChallengeOf(VERIFIER);
  const authorized = await authorize(app, { clientId, token, resource: undefined, challenge });
  const exchanged = await postForm(app, "/oauth/token", {
    grant_type: "authorization_code",
    code: new URL(authorized.headers.get("location")).searchParams.get("code"),
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
  });
  assert.equal(exchanged.status, 200);
  assert.equal((await mcp(app, exchanged.body.access_token, "tools/list")).status, 200);
});

test("JSONで /oauth/token を呼んでも引き換えられる", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  const clientId = (await registerClient(app)).body.client_id;
  const challenge = await pkceChallengeOf(VERIFIER);
  const authorized = await authorize(app, { clientId, token, resource: MCP_URL, challenge });
  const exchanged = await call(app, "/oauth/token", {
    method: "POST",
    body: {
      grant_type: "authorization_code",
      code: new URL(authorized.headers.get("location")).searchParams.get("code"),
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource: MCP_URL,
    },
  });
  assert.equal(exchanged.status, 200);
  assert.ok(exchanged.body.access_token);
});

test("8. 接続トークンを直接渡す方式（Claude Code）はそのまま使える", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  const used = await mcp(app, token, "tools/list");
  assert.equal(used.status, 200);
});

test("9・10. OAuth経由でも read / write の権限がそのまま引き継がれる", async () => {
  for (const write of [false, true]) {
    const { app } = createTestApp();
    const token = await enableAiLink(app, { write });
    const clientId = (await registerClient(app)).body.client_id;
    const challenge = await pkceChallengeOf(VERIFIER);
    const authorized = await authorize(app, { clientId, token, resource: MCP_URL, challenge });
    const exchanged = await postForm(app, "/oauth/token", {
      grant_type: "authorization_code",
      code: new URL(authorized.headers.get("location")).searchParams.get("code"),
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER,
      resource: MCP_URL,
    });
    assert.equal(exchanged.body.scope, write ? "read write" : "read");

    const accessToken = exchanged.body.access_token;
    const read = await call(app, "/mcp", {
      method: "POST",
      token: accessToken,
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "getAppInfo", arguments: {} } },
    });
    assert.equal(read.body.result.structuredContent.dataVersion !== undefined, true);

    const changed = await call(app, "/mcp", {
      method: "POST",
      token: accessToken,
      body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "updateTodayTasks", arguments: { tasks: [] } } },
    });
    const result = changed.body.result.structuredContent;
    assert.equal(result.ok, write ? true : false);
    if (!write) assert.equal(result.error, "permission_denied");
  }
});

test("接続トークンが無効なら、同意画面でその場で分かる", async () => {
  const { app } = createTestApp();
  await enableAiLink(app);
  const clientId = (await registerClient(app)).body.client_id;
  const challenge = await pkceChallengeOf(VERIFIER);
  const denied = await authorize(app, { clientId, token: "wrong-token-0000", resource: MCP_URL, challenge });
  assert.equal(denied.status, 401);
});

test("MCPの案内（RFC 9728 / 8414）が、/mcp 付きの場所でも返る", async () => {
  const { app } = createTestApp();
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    const response = await call(app, path);
    assert.equal(response.status, 200);
    assert.equal(response.body.resource, MCP_URL);
    assert.deepEqual(response.body.authorization_servers, [BASE]);
  }
  for (const path of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
    "/.well-known/openid-configuration",
  ]) {
    const response = await call(app, path);
    assert.equal(response.status, 200);
    assert.equal(response.body.issuer, BASE);
    assert.equal(response.body.registration_endpoint, `${BASE}/oauth/register`);
    assert.equal(response.body.resource_indicators_supported, true);
    assert.deepEqual(response.body.code_challenge_methods_supported, ["S256"]);
  }
});

test("claude.ai からの呼び出しにCORSを返す", async () => {
  const { app } = createTestApp();
  const response = await app.fetch(new Request(`${BASE}/mcp`, {
    method: "OPTIONS",
    headers: { origin: "https://claude.ai" },
  }));
  assert.equal(response.headers.get("access-control-allow-origin"), "https://claude.ai");
});

test("更新トークンでアクセストークンを取り直せる", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  const clientId = (await registerClient(app)).body.client_id;
  const challenge = await pkceChallengeOf(VERIFIER);
  const authorized = await authorize(app, { clientId, token, resource: MCP_URL, challenge });
  const exchanged = await postForm(app, "/oauth/token", {
    grant_type: "authorization_code",
    code: new URL(authorized.headers.get("location")).searchParams.get("code"),
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: MCP_URL,
  });
  assert.ok(exchanged.body.refresh_token);

  const refreshed = await postForm(app, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: exchanged.body.refresh_token,
    client_id: clientId,
    resource: MCP_URL,
  });
  assert.equal(refreshed.status, 200);
  assert.equal((await mcp(app, refreshed.body.access_token, "tools/list")).status, 200);

  // 使った更新トークンは二度目には使えない。
  const reused = await postForm(app, "/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: exchanged.body.refresh_token,
    client_id: clientId,
  });
  assert.equal(reused.status, 400);
});
