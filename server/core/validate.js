// AIから届いた入力を信用せずに確かめるための道具。
//
// MCPの呼び出しは人ではなくAIが組み立てるため、型の取り違え・項目の抜け・
// 極端に長い文字列・大量の一括処理がふつうに起こりうる。
// ここで弾いてから、はじめてstudy-todo のデータに触れる。

/** 入力が不正だったことを表す誤り。呼び出し元はこれをツールの結果として返す。 */
export class ValidationError extends Error {
  constructor(message, { field = null, details = [] } = {}) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
    this.details = details;
  }
}

export function fail(message, field = null) {
  throw new ValidationError(message, { field });
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireObject(value, field) {
  if (!isPlainObject(value)) fail(`${field} はオブジェクトで渡してください。`, field);
  return value;
}

/** 文字列を確かめて整える。長すぎるものは切らずに誤りにする（黙って欠けるのを防ぐ）。 */
export function readString(value, field, { required = false, max = 2000, min = 0, trim = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`${field} は必須です。`, field);
    return null;
  }
  if (typeof value !== "string") fail(`${field} は文字列で渡してください。`, field);
  const text = trim ? value.trim() : value;
  if (text.length < min || (required && !text)) fail(`${field} が空です。`, field);
  if (text.length > max) fail(`${field} が長すぎます（${max}文字まで／実際は${text.length}文字）。`, field);
  return text;
}

export function readInteger(value, field, { required = false, min = null, max = null, fallback = null } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`${field} は必須です。`, field);
    return fallback;
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    fail(`${field} は整数で渡してください。`, field);
  }
  if (min !== null && number < min) fail(`${field} は${min}以上にしてください。`, field);
  if (max !== null && number > max) fail(`${field} は${max}以下にしてください。`, field);
  return number;
}

export function readBoolean(value, field, { fallback = null } = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") fail(`${field} は true か false で渡してください。`, field);
  return value;
}

export function readEnum(value, field, allowed, { required = false, fallback = null } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`${field} は必須です。`, field);
    return fallback;
  }
  if (!allowed.includes(value)) {
    fail(`${field} には ${allowed.join(" / ")} のいずれかを指定してください（受け取った値: ${String(value)}）。`, field);
  }
  return value;
}

export function readStringArray(value, field, { max = 20, maxLength = 120, allowed = null } = {}) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) fail(`${field} は配列で渡してください。`, field);
  if (value.length > max) fail(`${field} は${max}件までです。`, field);
  const list = value.map((entry, index) => readString(entry, `${field}[${index}]`, { required: true, max: maxLength }));
  if (allowed) {
    const unknown = list.filter((entry) => !allowed.includes(entry));
    if (unknown.length) {
      fail(`${field} に使えない値があります: ${unknown.join(", ")}（使えるのは ${allowed.join(" / ")}）。`, field);
    }
  }
  return [...new Set(list)];
}

export function readArray(value, field, { min = 0, max = 50 } = {}) {
  if (!Array.isArray(value)) fail(`${field} は配列で渡してください。`, field);
  if (value.length < min) fail(`${field} には少なくとも${min}件必要です。`, field);
  if (value.length > max) {
    fail(`${field} は一度に${max}件までです（受け取った件数: ${value.length}）。分けて実行してください。`, field);
  }
  return value;
}

/** 問題IDに使ってよい形。長すぎるものや記号だらけのものを弾く。 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

export function readId(value, field = "id", { required = true } = {}) {
  const text = readString(value, field, { required, max: 80 });
  if (text === null) return null;
  if (!ID_PATTERN.test(text)) {
    fail(`${field} には英数字・ハイフン・アンダースコア・ドットだけが使えます（受け取った値: ${text}）。`, field);
  }
  return text;
}

/** 想定していない項目が混ざっていたら教える。誤字のまま黙って無視されるのを防ぐ。 */
export function rejectUnknownKeys(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    fail(`${field} に知らない項目があります: ${unknown.join(", ")}（使えるのは ${allowed.join(" / ")}）。`, field);
  }
}

/** ISO日付・日時・相対日数のいずれかを、ミリ秒の時刻に直す。 */
export function readTimestamp(value, field, { fallback = null, now = Date.now() } = {}) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${field} が時刻として読めません。`, field);
    return value;
  }
  const text = readString(value, field, { max: 40 });
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(parsed)) {
    fail(`${field} は 2026-09-11 のような日付、または ISO 8601 の日時で渡してください。`, field);
  }
  return parsed;
}
