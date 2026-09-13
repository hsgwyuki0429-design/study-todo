// 日付と時間帯（タイムゾーン）の扱いをここに集約する。
//
// このアプリは日本で使うため、「今日」は日本時間（UTC+9）で判断する。
// ISO文字列の先頭10文字（UTC日付）をそのまま使うと、日本時間の午前0時〜9時に
// 前日の日付として扱われてしまうため、必ずこのモジュールを通す。
//
// PWA側とサーバー側の両方から読み込むので、DOM にも Node にも依存しない。

/** 日本標準時のずれ（分）。 */
export const DEFAULT_TIMEZONE_OFFSET_MINUTES = 540;

const DAY_MS = 86400000;

/** MCP から渡された timezoneOffsetMinutes を確かめて整える。 */
export function normalizeOffset(offsetMinutes) {
  const value = Number(offsetMinutes);
  if (!Number.isFinite(value)) return DEFAULT_TIMEZONE_OFFSET_MINUTES;
  if (value < -840 || value > 840) return DEFAULT_TIMEZONE_OFFSET_MINUTES;
  return Math.round(value);
}

const pad = (n) => String(n).padStart(2, '0');

/** 時刻（ISO文字列・Date・ミリ秒）を、その時間帯での YYYY-MM-DD に直す。 */
export function dateKeyOf(value, offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES) {
  const offset = normalizeOffset(offsetMinutes);
  const ms = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
      : Date.parse(String(value));
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + offset * 60000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** その時間帯での「今日」。 */
export function todayKeyOf(offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES, nowMs = Date.now()) {
  return dateKeyOf(nowMs, offsetMinutes);
}

/** YYYY-MM-DD を日数ぶんずらす。 */
export function shiftDateKey(dateKey, days) {
  const ms = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return dateKeyOf(ms + days * DAY_MS, 0);
}

/** その時間帯での日付の始まり（UTCのミリ秒）。 */
export function startOfDayMs(dateKey, offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES) {
  const ms = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return ms - normalizeOffset(offsetMinutes) * 60000;
}

/** YYYY-MM-DD の形かどうか（存在しない日付も弾く）。 */
export function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && dateKeyOf(ms, 0) === value;
}

/**
 * その日が属する週の初日（月曜）。カレンダーは月曜はじまりで数える。
 * 曜日の計算は地域差を避けるため UTC で行う（日付キーは日本時間で作られている）。
 */
export function startOfWeekKey(dateKey) {
  const ms = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(ms)) return dateKey;
  const weekday = new Date(ms).getUTCDay();
  return dateKeyOf(ms - ((weekday + 6) % 7) * DAY_MS, 0);
}

/** 学習記録の月シャード用のキー（YYYY-MM）。 */
export function monthKeyOf(value, offsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES) {
  const key = dateKeyOf(value, offsetMinutes);
  return key ? key.slice(0, 7) : null;
}
