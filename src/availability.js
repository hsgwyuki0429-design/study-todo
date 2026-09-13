// 「1日に何分、study-todo の学習に使えるか」を扱う、PWAとサーバーで共有する処理。
//
// 時刻の入った時間割は作らない。1日あたりの分数だけで計画する。
//
//   曜日別の標準（weekly）… 平日60分・休日120分 のような決め方
//   日付ごとの上書き（overrides）… その日だけ 0分 や 180分 にする
//   今日の残り（todayRemaining）… 「今日はあと30分」を直接指定する
//   予備（reserveMinutes）… 予定を詰めすぎないための余白
//
// 大事な決めごとが3つある。
//
//   1. 「未設定」と「0分」は別物として扱う。
//      未設定の日は available を null で返し、使える時間を勝手に決めない。
//      計画を作る側は、未設定の日には予定を置かない（利用者に設定を促す）。
//   2. 「今日はあと30分」と言われたら、そこから実施済みの時間をさらに引かない。
//      標準の枠から計算するときだけ、その日にすでに使った時間を引く。
//   3. 予備時間は1日につき1回だけ引く。見積もりの補助時間（答え合わせ）とは別のもので、
//      二重に足したり引いたりしない。
//
// ここでいう「使える時間」は study-todo で管理している学習のための枠である。
// 学校の授業や他教科を含む、生活全体の空き時間ではない。

export const WEEKDAY_KEYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

export const WEEKDAY_LABELS = Object.freeze({
  sun: '日', mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土',
});

export const DEFAULT_AVAILABILITY = Object.freeze({
  // すべて未設定から始める。勝手に「1日60分」などと決めない。
  weekly: Object.freeze({ sun: null, mon: null, tue: null, wed: null, thu: null, fri: null, sat: null }),
  overrides: Object.freeze({}),
  todayRemaining: null,
  reserveMinutes: 0,
  // タイマーが「問題を始めてから評価を記録するまで」を測っているかどうか。
  // true なら答え合わせの時間はすでに含まれているので、補助時間を足さない。
  timerIncludesReview: true,
  // タイマーに含まれないときの、1問あたりの答え合わせ・解説確認の目安（秒）。
  reviewOverheadSeconds: 0,
  updatedAt: null,
  revision: 0,
});

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const readMinutes = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(1440, Math.round(number)));
};

export function normalizeAvailability(raw, { now = Date.now() } = {}) {
  const source = isObject(raw) ? raw : {};
  const weekly = {};
  for (const key of WEEKDAY_KEYS) {
    weekly[key] = readMinutes(isObject(source.weekly) ? source.weekly[key] : null);
  }
  const overrides = {};
  if (isObject(source.overrides)) {
    for (const [date, value] of Object.entries(source.overrides).slice(0, 400)) {
      const minutes = readMinutes(value);
      if (minutes !== null) overrides[date] = minutes;
    }
  }
  const todayRemaining = isObject(source.todayRemaining)
    && typeof source.todayRemaining.date === 'string'
    && readMinutes(source.todayRemaining.minutes) !== null
    ? {
      date: source.todayRemaining.date.slice(0, 10),
      minutes: readMinutes(source.todayRemaining.minutes),
      setAt: typeof source.todayRemaining.setAt === 'string' ? source.todayRemaining.setAt : new Date(now).toISOString(),
    }
    : null;
  return {
    weekly,
    overrides,
    todayRemaining,
    reserveMinutes: readMinutes(source.reserveMinutes) ?? 0,
    timerIncludesReview: source.timerIncludesReview !== false,
    reviewOverheadSeconds: Math.max(0, Math.min(1800, Math.round(Number(source.reviewOverheadSeconds) || 0))),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    revision: Number.isFinite(Number(source.revision)) ? Math.max(0, Math.floor(Number(source.revision))) : 0,
  };
}

const weekdayKeyOf = (dateKey) => {
  const ms = Date.parse(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return WEEKDAY_KEYS[new Date(ms).getUTCDay()];
};

/**
 * その日に使える時間を出す。
 *
 * 返す内容:
 *   available      … 使える分数。未設定なら null（勝手に決めない）
 *   source         … どこから決まったか
 *                    today_remaining=「今日はあと○分」/ override=日付の上書き
 *                    weekly=曜日別の標準 / not_configured=未設定
 *   spentMinutes   … その日にすでに学習した時間（標準の枠から引くときだけ使う）
 *   reserveMinutes … 予備として残した分（1日1回だけ引く）
 *   note           … 画面や説明にそのまま出せる一言
 */
export function availabilityForDate(availability, dateKey, { spentSeconds = 0, isToday = false } = {}) {
  const settings = normalizeAvailability(availability);
  const spentMinutes = Math.round(Math.max(0, spentSeconds) / 60);
  const reserve = settings.reserveMinutes;

  const remaining = settings.todayRemaining;
  if (remaining && remaining.date === dateKey) {
    // 明示された残り時間が最優先。ここから実施済みを引くと二重に減ってしまうので引かない。
    const available = Math.max(0, remaining.minutes - reserve);
    return {
      date: dateKey,
      available,
      rawMinutes: remaining.minutes,
      source: 'today_remaining',
      spentMinutes,
      spentSubtracted: false,
      reserveMinutes: reserve,
      configured: true,
      note: `「あと${remaining.minutes}分」の指定${reserve ? `（予備${reserve}分を除く）` : ''}。実施済みの時間は引いていません。`,
    };
  }

  const override = Object.prototype.hasOwnProperty.call(settings.overrides, dateKey)
    ? settings.overrides[dateKey]
    : null;
  const weekly = settings.weekly[weekdayKeyOf(dateKey)] ?? null;
  const base = override !== null ? override : weekly;

  if (base === null) {
    return {
      date: dateKey,
      available: null,
      rawMinutes: null,
      source: 'not_configured',
      spentMinutes,
      spentSubtracted: false,
      reserveMinutes: reserve,
      configured: false,
      note: 'この日の学習可能時間は未設定です（0分とは違います）。設定するまで予定を置かないでください。',
    };
  }

  // 今日だけは、標準の枠からその日にすでに学習した時間を引く。
  // 計測していない学習（アプリを使わずに解いた分）は分からないので引けない。
  // 正確に決めたいときは「今日はあと○分」を指定してもらう。
  const used = isToday ? spentMinutes : 0;
  const available = Math.max(0, base - used - reserve);
  return {
    date: dateKey,
    available,
    rawMinutes: base,
    source: override !== null ? 'override' : 'weekly',
    spentMinutes,
    spentSubtracted: isToday,
    reserveMinutes: reserve,
    configured: true,
    note: isToday
      ? `標準${base}分から、計測できた学習${spentMinutes}分${reserve ? `と予備${reserve}分` : ''}を引いた残りです。アプリの外で解いた分は分かりません。`
      : `${override !== null ? 'この日の設定' : '曜日別の標準'}${base}分${reserve ? `（予備${reserve}分を除く）` : ''}。`,
  };
}
