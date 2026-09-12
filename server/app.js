// HTTPの入口。標準の Request / Response だけで書いてあるので、
// Cloudflare Workers でも Node でも同じコードが動く。
//
//   POST /mcp                    … MCP本体（AIはここへつなぐ）
//   GET  /health                 … 生存確認
//   GET  /                       … 人が見るための案内ページ
//   GET  /.well-known/oauth-*    … OAuthで登録するクライアント向けの案内
//   /oauth/*                     … OAuth 2.1 + PKCE（接続トークンの引き換え）
//   /api/admin/*                 … study-todo の設定画面からの管理（オーナーキーが必要）
//   /api/sync/*                  … study-todo のPWAとのデータ同期（端末キーで守る）

import { ERROR, createMcpServer } from "./core/mcp.js";
import { ValidationError } from "./core/validate.js";
import { SCOPES, SCOPE_LABELS, createAuth } from "./auth/tokens.js";
import {
  authorizationServerMetadata,
  canonicalResource,
  createOAuth,
  protectedResourceMetadata,
  resourceMatches,
} from "./oauth.js";
import { SERVER_INSTRUCTIONS, createTools } from "./tools.js";
import { createSyncService } from "./service/sync-service.js";
import { DATA_VERSION, createStudyService } from "./service/study-service.js";

export const SERVER_INFO = Object.freeze({
  name: "study-todo",
  title: "study-todo（青チャート学習管理）",
  version: "1.0.0",
  description: "青チャートの学習状況を読み取り、これからの予定と目標を変更します。",
});

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** MCPコネクタとして接続してくる相手のオリジン。 */
const CONNECTOR_ORIGINS = Object.freeze([
  "https://claude.ai",
  "https://claude.com",
  "https://www.claude.ai",
]);

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[character]));
}

/** 許可した相手からの呼び出しだけにCORSを返す。* は使わない。 */
function corsHeaders(request, allowedOrigins) {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id, x-study-todo-owner-key",
    "access-control-expose-headers": "www-authenticate",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

function bearerOf(request) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** 設定から、この配備で使う値をまとめる。秘密はここから先へ持ち出さない。 */
export function readConfig(env = {}) {
  const siteOrigin = (env.STUDY_TODO_SITE_ORIGIN ?? "https://hsgwyuki0429-design.github.io/study-todo")
    .replace(/\/+$/, "");
  const extraOrigins = String(env.STUDY_TODO_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  // CORS で見るのは「オリジン」（https://example.github.io）までで、
  // パス（/study-todo）は含まれない。site origin からオリジンだけを取り出す。
  let siteOriginHost = siteOrigin;
  try {
    siteOriginHost = new URL(siteOrigin).origin;
  } catch {
    siteOriginHost = siteOrigin;
  }
  return {
    ownerKey: env.STUDY_TODO_OWNER_KEY ?? "",
    siteOrigin,
    publicUrl: env.STUDY_TODO_PUBLIC_URL ? String(env.STUDY_TODO_PUBLIC_URL).replace(/\/+$/, "") : null,
    // study-todo 本体に加えて、MCPコネクタを登録する claude.ai / claude.com からの
    // 呼び出しも受け付ける。* は使わず、ここに並べた相手だけに返す。
    allowedOrigins: [...new Set([siteOriginHost, ...CONNECTOR_ORIGINS, ...extraOrigins])],
  };
}

/**
 * サーバー本体を組み立てる。
 * storage（保存先）と env（設定）を差し替えるだけで、どの環境でも動く。
 */
export function createStudyTodoMcpApp({ storage, env = {}, now = () => Date.now() }) {
  const config = readConfig(env);
  const sync = createSyncService({ storage, now });
  const service = createStudyService({ sync, now });
  const auth = createAuth({ storage, ownerKey: config.ownerKey, now });
  const oauth = createOAuth({ storage, now });
  const mcp = createMcpServer({
    serverInfo: SERVER_INFO,
    instructions: SERVER_INSTRUCTIONS,
    tools: createTools(),
  });

  function originOf(request) {
    return config.publicUrl ?? new URL(request.url).origin;
  }

  /** このサーバーのMCPの入口（resource の値）。 */
  function mcpUrlOf(request) {
    return `${originOf(request)}/mcp`;
  }

  function unauthorized(request, message) {
    // RFC 9728: どこを見れば認証のやり方が分かるかを示す。
    // MCPの入口に合わせた /mcp 付きの案内を返す。
    const metadataUrl = `${originOf(request)}/.well-known/oauth-protected-resource/mcp`;
    return json({ error: "unauthorized", message }, {
      status: 401,
      headers: { "www-authenticate": `Bearer realm="study-todo", resource_metadata="${metadataUrl}"` },
    });
  }

  /** 管理APIはオーナーキーだけで通す。AIへ渡す接続トークンでは操作できない。 */
  function ownerGuard(request) {
    if (!auth.hasOwnerKey()) {
      return json({
        error: "not_configured",
        message: "STUDY_TODO_OWNER_KEY が設定されていません。サーバーの環境変数を確認してください。",
      }, { status: 503 });
    }
    const presented = bearerOf(request) ?? request.headers.get("x-study-todo-owner-key");
    if (!auth.isOwner(presented)) {
      return json({ error: "unauthorized", message: "管理キーが正しくありません。" }, { status: 401 });
    }
    return null;
  }

  async function readJsonBody(request) {
    const text = await request.text();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("オブジェクトで送ってください。");
      }
      return parsed;
    } catch (error) {
      throw new ValidationError(`本文をJSONとして読めませんでした: ${error.message}`);
    }
  }

  /**
   * OAuthの入口は、フォーム（application/x-www-form-urlencoded）で送られることも、
   * JSONで送られることもある。どちらでも同じ形にして受け取る。
   */
  async function readFormOrJson(request) {
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("json")) return readJsonBody(request);
    const form = await request.formData();
    const values = {};
    for (const [key, value] of form.entries()) {
      if (values[key] === undefined) values[key] = typeof value === "string" ? value : String(value);
      else if (Array.isArray(values[key])) values[key].push(String(value));
      else values[key] = [values[key], String(value)];
    }
    return values;
  }

  // ------------------------------------------------------------------
  // MCP
  // ------------------------------------------------------------------

  async function handleMcp(request) {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed", message: "POST で呼び出してください。" }, {
        status: 405,
        headers: { allow: "POST, OPTIONS" },
      });
    }
    const presented = bearerOf(request);
    if (!presented) return unauthorized(request, "Authorization: Bearer <接続トークン> が必要です。");

    // OAuthで発行したアクセストークンなら、元の接続トークンの権限に読み替える。
    const oauthEntry = await oauth.resolveAccessToken(presented);
    let authenticated;
    if (oauthEntry) {
      const tokens = await auth.readTokens();
      const settings = await auth.readSettings();
      const entry = (tokens.tokens ?? []).find((candidate) => candidate.id === oauthEntry.tokenId);
      if (!entry || !settings.enabled) {
        return unauthorized(request, "この接続は無効になりました。study-todo の設定画面から接続しなおしてください。");
      }
      // 別のサーバー向けに発行されたトークンでは、ここを使えないようにする。
      if (oauthEntry.resource && !resourceMatches(oauthEntry.resource, mcpUrlOf(request))) {
        return unauthorized(request, "このアクセストークンは別のサーバー向けに発行されています。接続しなおしてください。");
      }
      authenticated = {
        ok: true,
        actor: {
          tokenId: entry.id,
          tokenLabel: entry.label,
          scopes: entry.scopes.filter((scope) => settings.permissions[scope]),
          tokenScopes: entry.scopes,
          permissions: settings.permissions,
        },
      };
    } else {
      authenticated = await auth.authenticate(presented);
    }
    if (!authenticated.ok) return unauthorized(request, authenticated.message);

    const body = await request.text();
    const { status, body: response } = await mcp.handle(body, request.headers, {
      service,
      sync,
      actor: authenticated.actor,
    });
    if (response === null) return new Response(null, { status });
    return json(response, { status });
  }

  // ------------------------------------------------------------------
  // 管理API（study-todo の設定画面から使う）
  // ------------------------------------------------------------------

  async function handleAdmin(request, path) {
    const denied = ownerGuard(request);
    if (denied) return denied;

    if (path === "/api/admin/status" && request.method === "GET") {
      const [settings, tokens, status, log] = await Promise.all([
        auth.readSettings(),
        auth.readTokens(),
        sync.status(),
        sync.readLog({ limit: 20 }),
      ]);
      return json({
        enabled: settings.enabled,
        permissions: settings.permissions,
        updatedAt: settings.updatedAt,
        mcpUrl: `${originOf(request)}/mcp`,
        serverInfo: SERVER_INFO,
        dataVersion: DATA_VERSION,
        scopes: SCOPES,
        scopeLabels: SCOPE_LABELS,
        token: (tokens.tokens ?? []).map((entry) => ({
          id: entry.id,
          label: entry.label,
          scopes: entry.scopes,
          preview: entry.preview,
          createdAt: entry.createdAt,
          lastUsedAt: entry.lastUsedAt,
        }))[0] ?? null,
        sync: status,
        log: log.entries,
      });
    }

    if (path === "/api/admin/settings" && request.method === "POST") {
      return json(await auth.updateSettings(await readJsonBody(request)));
    }

    if (path === "/api/admin/token" && request.method === "POST") {
      const body = await readJsonBody(request);
      const issued = await auth.issueToken({ label: body.label, scopes: body.scopes });
      return json({
        // 本体を返すのはこの一度だけ。あとはハッシュしか残らない。
        token: issued.token,
        entry: issued.entry,
        mcpUrl: `${originOf(request)}/mcp`,
      });
    }

    if (path === "/api/admin/token" && request.method === "DELETE") {
      return json(await auth.revokeTokens());
    }

    if (path === "/api/admin/sync-code" && request.method === "POST") {
      // 同期コードを返すのはここだけ。保存してあるのはハッシュだけ。
      return json(await sync.issueSyncCode());
    }

    if (path === "/api/admin/devices" && request.method === "GET") {
      return json(await sync.status());
    }

    if (path === "/api/admin/devices" && request.method === "DELETE") {
      const body = await readJsonBody(request);
      if (!body.deviceId) {
        return json({ error: "invalid_input", message: "deviceId を指定してください。" }, { status: 400 });
      }
      return json(await sync.leaveDevice(String(body.deviceId)));
    }

    if (path === "/api/admin/log" && request.method === "GET") {
      const limit = Number(new URL(request.url).searchParams.get("limit") ?? 20);
      return json(await sync.readLog({ limit }));
    }

    return json({ error: "not_found" }, { status: 404 });
  }

  // ------------------------------------------------------------------
  // 同期API（study-todo のPWAから使う）
  // ------------------------------------------------------------------

  async function handleSync(request, path) {
    // 登録は同期コードで行う。ここを通ったときだけ端末キーを配る。
    if (path === "/api/sync/join" && request.method === "POST") {
      const body = await readJsonBody(request);
      const joined = await sync.joinDevice({ code: body.code, deviceName: body.deviceName });
      return json(joined);
    }

    const deviceKey = bearerOf(request);
    const device = deviceKey ? await sync.resolveDeviceKey(deviceKey) : null;
    if (!device) {
      return json({
        error: "unauthorized",
        message: "この端末の同期は解除されています。設定画面から同期コードで接続しなおしてください。",
      }, { status: 401 });
    }

    if (path === "/api/sync/push" && request.method === "POST") {
      const body = await readJsonBody(request);
      const saved = await sync.push(device.deviceId, body);
      // 送ったあとの内容をそのまま返す。往復を1回で済ませるため。
      return json({
        ...saved,
        device,
        snapshot: await sync.pull({
          since: body.since ?? null,
          questionsHash: body.questions?.hash ?? null,
        }),
      });
    }

    if (path === "/api/sync/pull" && request.method === "GET") {
      const params = new URL(request.url).searchParams;
      return json({
        device,
        ...(await sync.pull({
          since: params.get("since"),
          questionsHash: params.get("questionsHash"),
        })),
      });
    }

    if (path === "/api/sync/leave" && request.method === "POST") {
      return json(await sync.leaveDevice(device.deviceId));
    }

    return json({ error: "not_found" }, { status: 404 });
  }

  // ------------------------------------------------------------------
  // OAuth
  // ------------------------------------------------------------------

  function consentPage(origin, query, message = null) {
    return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>study-todo への接続を許可</title>
<style>
 :root { color-scheme: light dark; }
 body { font-family: -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; margin: 0;
        display: grid; place-items: center; min-height: 100vh; padding: 24px; background: #f5f5f7; }
 @media (prefers-color-scheme: dark) { body { background: #000; color: #fff; } }
 .card { background: canvas; border-radius: 20px; padding: 28px; max-width: 420px; width: 100%;
         box-shadow: 0 20px 60px rgba(0,0,0,.12); }
 h1 { font-size: 20px; margin: 0 0 6px; }
 p { font-size: 14px; line-height: 1.7; color: color-mix(in srgb, canvastext 65%, transparent); }
 input { width: 100%; padding: 12px 14px; font-size: 16px; border-radius: 12px;
         border: 1px solid color-mix(in srgb, canvastext 20%, transparent); background: canvas; color: canvastext;
         box-sizing: border-box; }
 button { width: 100%; margin-top: 16px; padding: 14px; font-size: 16px; font-weight: 600;
          border: 0; border-radius: 12px; background: #0a84ff; color: #fff; }
 .error { color: #d70015; font-size: 13px; }
</style></head>
<body><main class="card">
 <h1>study-todo への接続を許可しますか？</h1>
 <p><strong>${escapeHtml(query.clientName)}</strong> が study-todo の学習状況と予定にアクセスしようとしています。
 study-todo の設定画面 → AI連携 で発行した接続トークンを貼り付けてください。</p>
 ${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
 <form method="post" action="${escapeHtml(origin)}/oauth/authorize">
  <input type="hidden" name="client_id" value="${escapeHtml(query.clientId)}">
  <input type="hidden" name="redirect_uri" value="${escapeHtml(query.redirectUri)}">
  <input type="hidden" name="code_challenge" value="${escapeHtml(query.codeChallenge)}">
  <input type="hidden" name="state" value="${escapeHtml(query.state)}">
  <input type="hidden" name="resource" value="${escapeHtml(query.resource ?? "")}">
  <input name="connection_token" type="password" autocomplete="off" placeholder="接続トークン" required>
  <button type="submit">許可する</button>
 </form>
</main></body></html>`;
  }

  async function handleOAuth(request, path) {
    const url = new URL(request.url);
    const origin = originOf(request);

    if (path === "/oauth/register" && request.method === "POST") {
      const body = await readFormOrJson(request);
      try {
        const client = await oauth.registerClient({
          // フォームで送られた場合は1つの文字列で届くので、配列に揃える。
          redirectUris: Array.isArray(body.redirect_uris)
            ? body.redirect_uris
            : (body.redirect_uris ? [body.redirect_uris] : []),
          clientName: body.client_name,
        });
        return json({
          client_id: client.clientId,
          client_name: client.clientName,
          redirect_uris: client.redirectUris,
          client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
          scope: "read write",
        }, { status: 201 });
      } catch (error) {
        return json({ error: "invalid_client_metadata", error_description: error.message }, { status: 400 });
      }
    }

    if (path === "/oauth/authorize" && request.method === "GET") {
      const clientId = url.searchParams.get("client_id") ?? "";
      const client = await oauth.getClient(clientId);
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      if (!client || !client.redirectUris.includes(redirectUri)) {
        return new Response("client_id または redirect_uri が登録されていません。", {
          status: 400, headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (url.searchParams.get("code_challenge_method") !== "S256") {
        return new Response("code_challenge_method は S256 だけに対応しています。", {
          status: 400, headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      // RFC 8707: どのMCPサーバー向けの認可かの指定。送られてきたら中身を確かめる。
      const resource = url.searchParams.get("resource");
      if (!resourceMatches(resource, mcpUrlOf(request))) {
        // 宛先が違うので、クライアントへ理由を返して戻す。
        const target = new URL(redirectUri);
        target.searchParams.set("error", "invalid_target");
        target.searchParams.set("error_description", `resource は ${mcpUrlOf(request)} を指定してください。`);
        const state = url.searchParams.get("state");
        if (state) target.searchParams.set("state", state);
        return new Response(null, { status: 302, headers: { location: target.toString() } });
      }
      return new Response(consentPage(origin, {
        clientName: client.clientName,
        clientId,
        redirectUri,
        codeChallenge: url.searchParams.get("code_challenge") ?? "",
        state: url.searchParams.get("state") ?? "",
        resource: resource ?? "",
      }), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (path === "/oauth/authorize" && request.method === "POST") {
      const form = await request.formData();
      const clientId = String(form.get("client_id") ?? "");
      const redirectUri = String(form.get("redirect_uri") ?? "");
      const client = await oauth.getClient(clientId);
      if (!client || !client.redirectUris.includes(redirectUri)) {
        return new Response("redirect_uri が登録されていません。", { status: 400 });
      }
      const resource = form.get("resource") ? String(form.get("resource")) : null;
      if (!resourceMatches(resource, mcpUrlOf(request))) {
        return new Response("resource がこのサーバーのものと一致しません。", {
          status: 400, headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      const authenticated = await auth.authenticate(String(form.get("connection_token") ?? ""));
      if (!authenticated.ok) {
        return new Response(consentPage(origin, {
          clientName: client.clientName,
          clientId,
          redirectUri,
          codeChallenge: String(form.get("code_challenge") ?? ""),
          state: String(form.get("state") ?? ""),
          resource: resource ?? "",
        }, authenticated.message), { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      const code = await oauth.issueCode({
        clientId,
        redirectUri,
        codeChallenge: String(form.get("code_challenge") ?? ""),
        scopes: authenticated.actor.tokenScopes,
        tokenId: authenticated.actor.tokenId,
        // 宛先の指定が無いクライアントには、このサーバーのMCPを宛先として結び付ける。
        resource: canonicalResource(resource) ?? mcpUrlOf(request),
      });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      const state = String(form.get("state") ?? "");
      if (state) target.searchParams.set("state", state);
      // RFC 9207: どの認可サーバーが返したかを明示する。
      target.searchParams.set("iss", origin);
      return new Response(null, { status: 302, headers: { location: target.toString() } });
    }

    if (path === "/oauth/token" && request.method === "POST") {
      // form でも JSON でも受け取れるようにする（クライアントによって送り方が違う）。
      const form = await readFormOrJson(request);
      if (form.grant_type === "refresh_token") {
        try {
          const refreshed = await oauth.refresh({
            refreshToken: form.refresh_token,
            clientId: form.client_id ? String(form.client_id) : null,
            resource: form.resource ?? null,
          });
          return json({
            access_token: refreshed.accessToken,
            refresh_token: refreshed.refreshToken,
            token_type: "Bearer",
            expires_in: refreshed.expiresIn,
            scope: refreshed.scopes.join(" "),
          }, { headers: { "cache-control": "no-store" } });
        } catch (error) {
          return json({ error: "invalid_grant", error_description: error.message }, { status: 400 });
        }
      }
      if (form.grant_type !== "authorization_code") {
        return json({
          error: "unsupported_grant_type",
          error_description: "grant_type は authorization_code か refresh_token だけに対応しています。",
        }, { status: 400 });
      }
      try {
        const issued = await oauth.exchangeCode({
          code: form.code,
          clientId: String(form.client_id ?? ""),
          redirectUri: String(form.redirect_uri ?? ""),
          codeVerifier: String(form.code_verifier ?? ""),
          resource: form.resource ?? null,
        });
        return json({
          access_token: issued.accessToken,
          refresh_token: issued.refreshToken,
          token_type: "Bearer",
          expires_in: issued.expiresIn,
          scope: issued.scopes.join(" "),
        }, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        const isTarget = /resource/.test(error.message);
        return json({
          error: isTarget ? "invalid_target" : "invalid_grant",
          error_description: error.message,
        }, { status: 400 });
      }
    }

    return json({ error: "not_found" }, { status: 404 });
  }

  // ------------------------------------------------------------------

  function landingPage(request) {
    const origin = originOf(request);
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>study-todo MCP Server</title>
<style>body{font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;max-width:640px;margin:0 auto;padding:32px 20px;line-height:1.8}
code{background:#f0f0f3;padding:2px 6px;border-radius:6px}:root{color-scheme:light dark}
@media(prefers-color-scheme:dark){code{background:#222}}</style></head><body>
<h1>study-todo MCP Server</h1>
<p>学習管理アプリ <a href="${escapeHtml(config.siteOrigin)}">study-todo</a> の学習状況を、MCP対応のAIから読み取り、予定や目標を変更するためのサーバーです。</p>
<p>接続先（MCP Server URL）: <code>${escapeHtml(origin)}/mcp</code></p>
<p>接続には、study-todo の設定画面 → AI連携 で発行した接続トークンが必要です。
このページからデータを見ることはできません。</p>
<p>学習記録とチャレンジ結果は、AIからは作成・変更できません。</p>
<p>対応プロトコル: MCP 2026-07-28（2025-03-26 以降の旧版にも対応）</p>
</body></html>`;
  }

  return {
    config,
    service,
    sync,
    auth,
    oauth,
    mcp,

    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const cors = corsHeaders(request, config.allowedOrigins);

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }

      let response;
      try {
        if (path === "/health") {
          response = json({ ok: true, server: SERVER_INFO.name, version: SERVER_INFO.version });
        } else if (path === "/") {
          response = new Response(landingPage(request), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        } else if (path === "/mcp") {
          response = await handleMcp(request);
        } else if (path === "/.well-known/oauth-protected-resource"
          || path === "/.well-known/oauth-protected-resource/mcp") {
          response = json(protectedResourceMetadata(originOf(request)));
        } else if (path === "/.well-known/oauth-authorization-server"
          || path === "/.well-known/oauth-authorization-server/mcp"
          || path === "/.well-known/openid-configuration"
          || path === "/.well-known/openid-configuration/mcp") {
          // MCPクライアントは、入口のパス（/mcp）を付けた場所も探しに来る。
          response = json(authorizationServerMetadata(originOf(request)));
        } else if (path.startsWith("/oauth/")) {
          response = await handleOAuth(request, path);
        } else if (path.startsWith("/api/admin/")) {
          response = await handleAdmin(request, path);
        } else if (path.startsWith("/api/sync/")) {
          response = await handleSync(request, path);
        } else {
          response = json({ error: "not_found", message: `${path} はありません。` }, { status: 404 });
        }
      } catch (error) {
        if (error instanceof ValidationError) {
          response = json({ error: "invalid_input", field: error.field, message: error.message }, { status: 400 });
        } else {
          response = json({ error: "server_error", message: error?.message ?? "不明な問題が起きました。" }, { status: 500 });
        }
      }

      const merged = new Response(response.body, response);
      Object.entries(cors).forEach(([key, value]) => merged.headers.set(key, value));
      return merged;
    },
  };
}

export { ERROR };
