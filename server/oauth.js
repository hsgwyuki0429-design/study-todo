// MCPクライアントを登録するための、最小限のOAuth 2.1。
//
// Claude Code のように「Authorization: Bearer <接続トークン>」を直接指定できる
// クライアントでは、この仕組みは使わなくてよい。
// 一方、claude.ai のコネクタ登録のように OAuth しか受け付けない入口もあるため、
// 接続トークンをアクセストークンに引き換えるだけの薄い層を用意しておく。
//
// 保存するのは「引き換え待ちの符号」と「発行したアクセストークン」だけで、
// 実際にできることは、もとの接続トークンの権限をそのまま引き継ぐ。

import { generateToken, hashToken } from "./auth/tokens.js";

const OAUTH_KEY = "studytodo:oauth";
const CODE_TTL_MS = 5 * 60 * 1000;
/** アクセストークンの寿命。切れたら更新トークンで取り直す。 */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000;

function base64UrlOfBytes(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * RFC 8707 の resource（どのMCPサーバー向けのトークンか）を見比べられる形に直す。
 * 末尾の / や大文字小文字、#以降の違いで弾かないようにする。
 */
export function canonicalResource(value) {
  if (value === undefined || value === null || value === "") return null;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  url.hash = "";
  url.search = "";
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

/**
 * クライアントが指定した resource が、このサーバーのMCPの入口を指しているか。
 * 「/mcp そのもの」と「サーバーの入口（origin）」のどちらも認める。
 * resource を送ってこないクライアント（Claude Code など）も従来どおり通す。
 */
export function resourceMatches(requested, mcpUrl) {
  if (requested === null || requested === undefined || requested === "") return true;
  const canonical = canonicalResource(requested);
  if (!canonical) return false;
  const target = canonicalResource(mcpUrl);
  const origin = canonicalResource(new URL(mcpUrl).origin);
  return canonical === target || canonical === origin;
}

/** PKCE の S256。code_verifier をSHA-256して base64url にしたものが code_challenge。 */
export async function pkceChallengeOf(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlOfBytes(new Uint8Array(digest));
}

export function createOAuth({ storage, now = () => Date.now() }) {
  async function read() {
    const stored = (await storage.get(OAUTH_KEY)) ?? {};
    return { clients: {}, codes: {}, tokens: {}, refreshTokens: {}, ...stored };
  }

  async function write(document) {
    // 期限切れを掃除してから保存する。放っておくと際限なく増えるため。
    const at = now();
    document.codes = Object.fromEntries(
      Object.entries(document.codes).filter(([, code]) => code.expiresAt > at),
    );
    document.tokens = Object.fromEntries(
      Object.entries(document.tokens).filter(([, token]) => token.expiresAt > at),
    );
    document.refreshTokens = Object.fromEntries(
      Object.entries(document.refreshTokens ?? {}).filter(([, token]) => token.expiresAt > at),
    );
    await storage.put(OAUTH_KEY, document);
  }

  return {
    /** クライアントの動的登録（RFC 7591）。折り返し先だけを覚えておく。 */
    async registerClient({ redirectUris, clientName }) {
      if (!Array.isArray(redirectUris) || !redirectUris.length) {
        throw new Error("redirect_uris が必要です。");
      }
      const uris = redirectUris.map((uri) => String(uri));
      if (uris.some((uri) => !/^https:\/\//.test(uri) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(uri))) {
        throw new Error("redirect_uris は https（またはローカルホスト）だけが使えます。");
      }
      const clientId = generateToken(16);
      const document = await read();
      document.clients[clientId] = {
        clientId,
        clientName: String(clientName ?? "MCP client").slice(0, 80),
        redirectUris: uris,
        createdAt: new Date(now()).toISOString(),
      };
      await write(document);
      return document.clients[clientId];
    },

    async getClient(clientId) {
      return (await read()).clients[String(clientId ?? "")] ?? null;
    },

    /** 利用者が接続トークンを貼って許可したときに、引き換え用の符号を作る。 */
    async issueCode({ clientId, redirectUri, codeChallenge, scopes, tokenId, resource = null }) {
      const code = generateToken(24);
      const document = await read();
      document.codes[await hashToken(code)] = {
        clientId,
        redirectUri,
        codeChallenge,
        scopes,
        tokenId,
        // どのMCPサーバー向けの認可かを覚えておく（RFC 8707）。
        resource: canonicalResource(resource),
        expiresAt: now() + CODE_TTL_MS,
      };
      await write(document);
      return code;
    },

    /** 符号をアクセストークンに引き換える。PKCE の確認もここで行う。 */
    async exchangeCode({ code, clientId, redirectUri, codeVerifier, resource = null }) {
      const document = await read();
      const key = await hashToken(String(code ?? ""));
      const entry = document.codes[key];
      if (!entry || entry.expiresAt <= now()) throw new Error("認可コードが無効か、期限切れです。");
      if (entry.clientId !== clientId) throw new Error("client_id が一致しません。");
      if (entry.redirectUri !== redirectUri) throw new Error("redirect_uri が一致しません。");
      if (!codeVerifier || (await pkceChallengeOf(codeVerifier)) !== entry.codeChallenge) {
        throw new Error("code_verifier が一致しません。");
      }
      // 認可のときと引き換えのときで、宛先（resource）が変わっていないか確かめる。
      const requestedResource = canonicalResource(resource);
      if (resource !== null && resource !== undefined && resource !== "" && !requestedResource) {
        throw new Error("resource はURLで渡してください。");
      }
      if (requestedResource && entry.resource && requestedResource !== entry.resource) {
        throw new Error("認可のときと resource が一致しません。");
      }
      // 認可コードは一度きり。引き換えたらすぐ捨てる。
      delete document.codes[key];
      const accessToken = generateToken(32);
      const boundResource = entry.resource ?? requestedResource ?? null;
      const refreshToken = generateToken(32);
      document.tokens[await hashToken(accessToken)] = {
        clientId,
        scopes: entry.scopes,
        tokenId: entry.tokenId,
        // このアクセストークンが使えるMCPサーバー。
        resource: boundResource,
        expiresAt: now() + TOKEN_TTL_MS,
      };
      document.refreshTokens[await hashToken(refreshToken)] = {
        clientId,
        scopes: entry.scopes,
        tokenId: entry.tokenId,
        resource: boundResource,
        expiresAt: now() + REFRESH_TTL_MS,
      };
      await write(document);
      return {
        accessToken,
        refreshToken,
        expiresIn: Math.floor(TOKEN_TTL_MS / 1000),
        scopes: entry.scopes,
        resource: boundResource,
      };
    },

    /**
     * 更新トークンでアクセストークンを取り直す。
     * 使った更新トークンはその場で捨て、新しいものを渡す（使い回しを防ぐ）。
     */
    async refresh({ refreshToken, clientId, resource = null }) {
      const document = await read();
      const key = await hashToken(String(refreshToken ?? ""));
      const entry = document.refreshTokens[key];
      if (!entry || entry.expiresAt <= now()) throw new Error("更新トークンが無効か、期限切れです。");
      if (clientId && entry.clientId !== clientId) throw new Error("client_id が一致しません。");
      const requested = canonicalResource(resource);
      if (requested && entry.resource && requested !== entry.resource) {
        throw new Error("発行のときと resource が一致しません。");
      }
      delete document.refreshTokens[key];
      const accessToken = generateToken(32);
      const nextRefresh = generateToken(32);
      document.tokens[await hashToken(accessToken)] = {
        clientId: entry.clientId,
        scopes: entry.scopes,
        tokenId: entry.tokenId,
        resource: entry.resource,
        expiresAt: now() + TOKEN_TTL_MS,
      };
      document.refreshTokens[await hashToken(nextRefresh)] = {
        ...entry,
        expiresAt: now() + REFRESH_TTL_MS,
      };
      await write(document);
      return {
        accessToken,
        refreshToken: nextRefresh,
        expiresIn: Math.floor(TOKEN_TTL_MS / 1000),
        scopes: entry.scopes,
        resource: entry.resource,
      };
    },

    /** アクセストークンから、もとの接続トークンの識別子を取り出す。 */
    async resolveAccessToken(accessToken) {
      const document = await read();
      const entry = document.tokens[await hashToken(String(accessToken ?? ""))];
      if (!entry || entry.expiresAt <= now()) return null;
      return entry;
    },
  };
}

/** RFC 9728: この入口を守っている認可サーバーの在り処。 */
export function protectedResourceMetadata(origin) {
  return {
    resource: `${origin}/mcp`,
    resource_name: "study-todo",
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["read", "write"],
    resource_documentation: `${origin}/`,
  };
}

/** RFC 8414: 認可サーバーの案内。 */
export function authorizationServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read", "write"],
    // RFC 9207: どの認可サーバーが応えたかを折り返しに含める。
    authorization_response_iss_parameter_supported: true,
    // RFC 8707: resource（どのMCPサーバー向けか）の指定に対応している。
    resource_indicators_supported: true,
    service_documentation: `${origin}/`,
  };
}
