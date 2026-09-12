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
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function base64UrlOfBytes(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE の S256。code_verifier をSHA-256して base64url にしたものが code_challenge。 */
export async function pkceChallengeOf(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlOfBytes(new Uint8Array(digest));
}

export function createOAuth({ storage, now = () => Date.now() }) {
  async function read() {
    return (await storage.get(OAUTH_KEY)) ?? { clients: {}, codes: {}, tokens: {} };
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
    async issueCode({ clientId, redirectUri, codeChallenge, scopes, tokenId }) {
      const code = generateToken(24);
      const document = await read();
      document.codes[await hashToken(code)] = {
        clientId,
        redirectUri,
        codeChallenge,
        scopes,
        tokenId,
        expiresAt: now() + CODE_TTL_MS,
      };
      await write(document);
      return code;
    },

    /** 符号をアクセストークンに引き換える。PKCE の確認もここで行う。 */
    async exchangeCode({ code, clientId, redirectUri, codeVerifier }) {
      const document = await read();
      const key = await hashToken(String(code ?? ""));
      const entry = document.codes[key];
      if (!entry || entry.expiresAt <= now()) throw new Error("認可コードが無効か、期限切れです。");
      if (entry.clientId !== clientId) throw new Error("client_id が一致しません。");
      if (entry.redirectUri !== redirectUri) throw new Error("redirect_uri が一致しません。");
      if (!codeVerifier || (await pkceChallengeOf(codeVerifier)) !== entry.codeChallenge) {
        throw new Error("code_verifier が一致しません。");
      }
      // 認可コードは一度きり。引き換えたらすぐ捨てる。
      delete document.codes[key];
      const accessToken = generateToken(32);
      document.tokens[await hashToken(accessToken)] = {
        clientId,
        scopes: entry.scopes,
        tokenId: entry.tokenId,
        expiresAt: now() + TOKEN_TTL_MS,
      };
      await write(document);
      return { accessToken, expiresIn: Math.floor(TOKEN_TTL_MS / 1000), scopes: entry.scopes };
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
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read", "write"],
    // RFC 9207: どの認可サーバーが応えたかを折り返しに含める。
    authorization_response_iss_parameter_supported: true,
  };
}
