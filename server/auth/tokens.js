// 接続トークンと権限。
//
// 鍵は2種類に分ける。
//
//  1. オーナーキー（STUDY_TODO_OWNER_KEY）
//     study-todo を使う本人だけが持つ鍵。環境変数（Cloudflare の secret）に置く。
//     設定画面からの管理（AI連携の有効・無効、権限、トークン発行、同期コード）に使う。
//     AIへは絶対に渡さない。
//  2. 接続トークン
//     AIへ渡す鍵。オーナーキーで発行し、できることを read / write に絞ってある。
//
// 接続トークンはそのままの形では保存しない。ハッシュだけを保存し、
// 発行したその場でしか本体を見られないようにする。

import { fail, readString, readStringArray } from "../core/validate.js";
import { updateDocument } from "../storage/driver.js";

export const STORAGE_KEYS = Object.freeze({
  settings: "studytodo:settings",
  tokens: "studytodo:tokens",
});

/**
 * できることの単位。
 *
 *   read    … 学習状況を見る（常に必要）
 *   write   … これからの予定・目標を変える
 *   records … 本人が「やった」と言った学習を、実績として代理で記録・訂正する
 *
 * records を write と分けてあるのは、予定を任せることと、実績を書き換えられることが
 * まったく別の話だからである。すでに発行してある read / write のトークンに、
 * 黙って実績を触る力が付くことはない。
 */
export const SCOPES = Object.freeze(["read", "write", "records"]);

export const SCOPE_LABELS = Object.freeze({
  read: "学習状況を見る",
  write: "予定・目標を変える",
  records: "本人が申告した学習を記録・訂正する",
});

/** 初期状態。書き込みは本人が設定画面で明示的に入れるまで使えない。 */
export const DEFAULT_PERMISSIONS = Object.freeze({ read: true, write: false, records: false });
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  permissions: { ...DEFAULT_PERMISSIONS },
  updatedAt: null,
});

const DEFAULT_TOKENS = { tokens: [] };

/** ランダムな文字列。Web Crypto はどのサーバーレス環境にもある。 */
export function generateToken(bytes = 32) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * 文字列を長さに関わらず同じ手間で比べる。
 * 「どこまで合っていたか」が応答時間から漏れないようにするため。
 */
export function timingSafeEqual(left, right) {
  const a = String(left ?? "");
  const b = String(right ?? "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

export function createAuth({ storage, ownerKey, now = () => Date.now() }) {
  async function readSettings() {
    const stored = await storage.get(STORAGE_KEYS.settings);
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...(stored ?? {}),
      permissions: { ...DEFAULT_PERMISSIONS, ...(stored?.permissions ?? {}) },
    };
  }

  async function readTokens() {
    const stored = await storage.get(STORAGE_KEYS.tokens);
    return { ...structuredClone(DEFAULT_TOKENS), ...(stored ?? {}) };
  }

  return {
    readSettings,
    readTokens,

    /** オーナーキーが設定されているか。未設定なら管理APIは一切使えない。 */
    hasOwnerKey() {
      return Boolean(ownerKey && ownerKey.length >= 16);
    },

    isOwner(presented) {
      return this.hasOwnerKey() && timingSafeEqual(presented, ownerKey);
    },

    async updateSettings(changes) {
      const { document } = await updateDocument(storage, STORAGE_KEYS.settings, (draft) => {
        if (changes.enabled !== undefined) {
          if (typeof changes.enabled !== "boolean") fail("enabled は true か false で渡してください。", "enabled");
          draft.enabled = changes.enabled;
        }
        if (changes.permissions !== undefined) {
          const permissions = { ...DEFAULT_PERMISSIONS, ...(draft.permissions ?? {}) };
          for (const scope of SCOPES) {
            const value = changes.permissions[scope];
            if (value === undefined) continue;
            if (typeof value !== "boolean") fail(`permissions.${scope} は true か false で渡してください。`, scope);
            permissions[scope] = value;
          }
          // 読み取りを切ると何もできなくなるので、連携を使うなら read は常に必要。
          draft.permissions = { ...permissions, read: true };
        }
        draft.updatedAt = new Date(now()).toISOString();
      }, { defaults: structuredClone(DEFAULT_SETTINGS) });
      return {
        enabled: document.enabled,
        permissions: document.permissions,
        updatedAt: document.updatedAt,
      };
    },

    /** 新しい接続トークンを発行する。本体を返すのはこのときだけ。 */
    async issueToken({ label = "AI連携", scopes = ["read"] } = {}) {
      const name = readString(label, "label", { max: 40 }) || "AI連携";
      const requested = readStringArray(scopes, "scopes", { max: SCOPES.length, allowed: SCOPES }) ?? ["read"];
      if (!requested.includes("read")) requested.unshift("read");
      const token = generateToken();
      const hash = await hashToken(token);
      const entry = {
        id: generateToken(8),
        label: name,
        hash,
        scopes: requested,
        createdAt: new Date(now()).toISOString(),
        lastUsedAt: null,
        // 見分けるための先頭だけ。これだけでは接続できない。
        preview: `${token.slice(0, 6)}…`,
      };
      await updateDocument(storage, STORAGE_KEYS.tokens, (document) => {
        // 発行しなおしたら前のトークンは使えなくする（AIに配る鍵は1つに保つ）。
        document.tokens = [entry];
      }, { defaults: structuredClone(DEFAULT_TOKENS) });
      return { token, entry: { ...entry, hash: undefined } };
    },

    async revokeTokens() {
      await updateDocument(storage, STORAGE_KEYS.tokens, (document) => {
        document.tokens = [];
      }, { defaults: structuredClone(DEFAULT_TOKENS) });
      return { revoked: true };
    },

    /**
     * 提示されたトークンから、いま何ができるかを決める。
     * トークンのスコープと、本人が設定画面で入れた権限、その両方にある操作だけ通す。
     */
    async authenticate(presented, { clientName = null } = {}) {
      const [settings, stored] = await Promise.all([readSettings(), readTokens()]);
      if (!settings.enabled) {
        return { ok: false, reason: "disabled", message: "study-todo の設定画面でAI連携が有効になっていません。" };
      }
      const token = readString(presented, "token", { max: 200 });
      if (!token) return { ok: false, reason: "missing", message: "接続トークンがありません。" };
      const hash = await hashToken(token);
      const entry = (stored.tokens ?? []).find((candidate) => timingSafeEqual(candidate.hash, hash));
      if (!entry) return { ok: false, reason: "invalid", message: "接続トークンが正しくありません。" };

      const granted = entry.scopes.filter((scope) => settings.permissions[scope]);
      // 最後に使われた時刻の記録は、失敗しても本来の処理を止めない。
      updateDocument(storage, STORAGE_KEYS.tokens, (document) => {
        const target = (document.tokens ?? []).find((candidate) => candidate.id === entry.id);
        if (target) target.lastUsedAt = new Date(now()).toISOString();
      }, { defaults: structuredClone(DEFAULT_TOKENS) }).catch(() => {});

      return {
        ok: true,
        actor: {
          tokenId: entry.id,
          tokenLabel: entry.label,
          clientName,
          scopes: granted,
          tokenScopes: entry.scopes,
          permissions: settings.permissions,
        },
      };
    },
  };
}

/** 権限が足りないことを表す誤り。ツール側でそのまま結果に載せる。 */
export class PermissionError extends Error {
  constructor(scope, actor) {
    const label = SCOPE_LABELS[scope] ?? scope;
    const allowedByUser = actor?.permissions?.[scope];
    super(
      allowedByUser === false
        ? `この操作には「${label}」の権限が必要です。study-todo の設定画面 → AI連携 で許可してください。`
        : `この接続トークンには「${label}」の権限がありません。設定画面でトークンを再発行してください。`,
    );
    this.name = "PermissionError";
    this.scope = scope;
  }
}

export function requireScope(actor, scope) {
  if (!actor?.scopes?.includes(scope)) throw new PermissionError(scope, actor);
  return actor;
}
