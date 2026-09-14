// 学習記録（1回の取り組み）の形を決める、PWAとサーバーで共有する処理。
//
// これまで学習記録は「実際に study-todo で解いたときだけ作られる、追加専用のイベント」だった。
// 本人が「昨日やったのに記録し忘れた」「評価を間違えた」と言ったときに直せるよう、
// 次のことを扱えるようにしてある。
//
//   ・後から足した記録と、タイマーで測った記録を見分ける（source）
//   ・評価が分からない記録（evaluation: null）。正解とも不正解とも数えない
//   ・所要時間が分からない記録（durationSeconds: null）。0秒として数えない
//   ・時刻までは分からない記録（datePrecision: 'date'）。架空の時刻を作らない
//   ・訂正（revision と corrections）。誰がいつ何を直したかを残す
//
// 大事な約束:
//   実績を作ってよいのは「本人が実際にやったと言ったとき」だけである。
//   予定が入っていることや、時間の見積もりは、実績の根拠にならない。

import { isDateKey, studyDateKeyOf } from './datetime.js';

/** 5段階の評価。ここは変えない。評価が分からないときは null にする。 */
export const EVALUATION_VALUES = Object.freeze([
  'perfect', 'better_solution', 'weak_writing', 'calc_error', 'wrong_approach',
]);

/** 記録がどうやって入ったか。 */
export const RECORD_SOURCES = Object.freeze(['timer', 'manual', 'self_report_ai']);

export const RECORD_SOURCE_LABELS = Object.freeze({
  timer: 'アプリで計測',
  manual: '本人の手入力',
  self_report_ai: '本人の申告をAIが代理入力',
});

/** 日付の細かさ。date は「その日にやった」ことだけが分かっている記録。 */
export const DATE_PRECISIONS = Object.freeze(['datetime', 'date']);

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const readDuration = (value) => {
  // null / undefined は「分からない」。0 は「0秒だった」として区別する。
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number);
};

// Optional measured breakdown. Old records stay unclassified; never invent a split.
export function normalizedTiming(raw) {
  const duration = readDuration(raw.durationSeconds);
  const solve = readDuration(raw.solveSeconds), review = readDuration(raw.reviewSeconds);
  const unclassified = readDuration(raw.unclassifiedSeconds) ?? 0;
  const result = {};
  if (duration !== null && solve !== null && review !== null && solve + review + unclassified === duration) {
    Object.assign(result, { solveSeconds: solve, reviewSeconds: review }, unclassified ? { unclassifiedSeconds: unclassified } : {});
  }
  if (isObject(raw.studySecondsByDate)) {
    const entries = Object.entries(raw.studySecondsByDate);
    if (entries.length && entries.length <= 730 && entries.every(([date, seconds]) => isDateKey(date) && readDuration(seconds) !== null)
      && entries.reduce((sum, [, seconds]) => sum + readDuration(seconds), 0) === duration) {
      result.studySecondsByDate = Object.fromEntries(entries.map(([date, seconds]) => [date, readDuration(seconds)]));
    }
  }
  return result;
}

/**
 * 学習記録を、保存してよい形へ整える。
 * 古い記録（date も source も無いもの）は、timestamp から日付を出し、
 * 「アプリで計測した記録」として扱う。既存のデータはそのまま読める。
 */
export function normalizeStudyRecord(raw, { receivedAt = Date.now(), timezoneOffsetMinutes } = {}) {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const questionId = typeof raw.questionId === 'string' ? raw.questionId.trim() : '';
  if (!id || !questionId) return null;

  const timestamp = typeof raw.timestamp === 'string' && Number.isFinite(Date.parse(raw.timestamp))
    ? raw.timestamp
    : null;
  const date = isDateKey(raw.date)
    ? raw.date
    : (timestamp ? studyDateKeyOf(timestamp, timezoneOffsetMinutes) : null);
  if (!date) return null;

  const precision = DATE_PRECISIONS.includes(raw.datePrecision)
    ? raw.datePrecision
    : (timestamp ? 'datetime' : 'date');
  const evaluation = EVALUATION_VALUES.includes(raw.evaluation) ? raw.evaluation : null;

  return {
    id: id.slice(0, 80),
    questionId: questionId.slice(0, 120),
    // 実施日（日本時間）。カレンダーや日別の集計はこれを使う。
    date,
    // 時刻まで分かっているときだけ本物の時刻が入る。分からなければその日の始まりで、
    // datePrecision が 'date' になる（画面では時刻を出さない）。
    timestamp: timestamp ?? `${date}T00:00:00.000Z`,
    datePrecision: precision,
    // 評価が分からない記録は null。正解にも不正解にも数えない。
    evaluation,
    // 所要時間が分からない記録は null。0秒として平均や見積もりに混ぜない。
    durationSeconds: readDuration(raw.durationSeconds),
    ...normalizedTiming(raw),
    // 「4問で合計40分」のような、まとまりでの申告時間。
    // 1問ずつの時間はでっち上げず、まとまりの合計として持つ。
    ...(isObject(raw.durationGroup) && raw.durationGroup.id
      ? {
        durationGroup: {
          id: String(raw.durationGroup.id).slice(0, 80),
          totalSeconds: readDuration(raw.durationGroup.totalSeconds) ?? 0,
          count: Math.max(1, Math.round(Number(raw.durationGroup.count) || 1)),
        },
      }
      : {}),
    ...(typeof raw.challengeId === 'string' && raw.challengeId ? { challengeId: raw.challengeId.slice(0, 80) } : {}),
    ...(typeof raw.planTaskId === 'string' && raw.planTaskId ? { planTaskId: raw.planTaskId.slice(0, 80) } : {}),
    ...(typeof raw.planItemId === 'string' && raw.planItemId ? { planItemId: raw.planItemId.slice(0, 120) } : {}),
    // どうやって入った記録か。古い記録は計測として扱う。
    source: RECORD_SOURCES.includes(raw.source) ? raw.source : 'timer',
    // 登録した日時（実施日とは別物）。
    enteredAt: typeof raw.enteredAt === 'string' ? raw.enteredAt : (timestamp ?? new Date(receivedAt).toISOString()),
    ...(typeof raw.enteredBy === 'string' && raw.enteredBy ? { enteredBy: raw.enteredBy.slice(0, 80) } : {}),
    // 本人が言った内容の短い要約（会話全文は保存しない）。
    ...(typeof raw.claimSummary === 'string' && raw.claimSummary ? { claimSummary: raw.claimSummary.slice(0, 200) } : {}),
    ...(typeof raw.updatedAt === 'string' ? { updatedAt: raw.updatedAt } : {}),
    // 訂正のたびに増える。古い内容で新しい内容を上書きしないために使う。
    revision: Number.isFinite(Number(raw.revision)) ? Math.max(0, Math.floor(Number(raw.revision))) : 0,
    // 取り消し。いまは削除で消すので新しくは付かないが、
    // 古い版で取り消した記録がまだ残っていることがあるため、読めるようにしておく。
    ...(raw.voided === true
      ? {
        voided: true,
        voidedAt: typeof raw.voidedAt === 'string' ? raw.voidedAt : new Date(receivedAt).toISOString(),
        ...(typeof raw.voidReason === 'string' && raw.voidReason ? { voidReason: raw.voidReason.slice(0, 200) } : {}),
      }
      : {}),
    // 訂正の履歴（変更前後・理由・日時・実行者）。多くなりすぎないよう上限つき。
    corrections: Array.isArray(raw.corrections)
      ? raw.corrections.slice(-20).map((entry) => ({
        at: typeof entry?.at === 'string' ? entry.at : null,
        by: typeof entry?.by === 'string' ? entry.by.slice(0, 80) : null,
        reason: typeof entry?.reason === 'string' ? entry.reason.slice(0, 200) : null,
        before: isObject(entry?.before) ? entry.before : {},
        after: isObject(entry?.after) ? entry.after : {},
      }))
      : [],
    syncedAt: receivedAt,
  };
}

/** その記録がどの日のものか。古い記録は timestamp から出す。 */
export const recordDateOf = (record, timezoneOffsetMinutes) =>
  (isDateKey(record?.date) ? record.date : studyDateKeyOf(record?.timestamp, timezoneOffsetMinutes));

/** ふだんの集計に数える記録か（取り消したものは数えない）。 */
export const isCountedRecord = (record) => Boolean(record) && record.voided !== true;

/** 時刻まで分かっているか（分からない記録に架空の時刻を出さないため）。 */
export const hasExactTime = (record) => record?.datePrecision !== 'date';

/** 所要時間が分かっているか。 */
export const hasDuration = (record) => typeof record?.durationSeconds === 'number';

/**
 * 計測時間を学習日ごとに返す。
 * 03:00をまたいだ新しい記録は studySecondsByDate の実測配分を使い、
 * 古い記録は従来どおり record.date（無ければtimestamp）へ全時間を置く。
 */
export function durationEntriesByStudyDate(record, timezoneOffsetMinutes) {
  if (!isCountedRecord(record) || !hasDuration(record)) return [];
  const split = record.studySecondsByDate;
  if (isObject(split)) {
    const entries = Object.entries(split)
      .filter(([date, seconds]) => isDateKey(date) && readDuration(seconds) !== null)
      .map(([date, seconds]) => [date, readDuration(seconds)]);
    if (entries.length && entries.reduce((sum, [, seconds]) => sum + seconds, 0) === record.durationSeconds) {
      return entries;
    }
  }
  const date = recordDateOf(record, timezoneOffsetMinutes);
  return date ? [[date, record.durationSeconds]] : [];
}

export function durationOnStudyDate(record, date, timezoneOffsetMinutes) {
  return durationEntriesByStudyDate(record, timezoneOffsetMinutes)
    .reduce((sum, [entryDate, seconds]) => sum + (entryDate === date ? seconds : 0), 0);
}

/**
 * 学習時間の合計。
 *
 *   ・分からない時間（null）は 0秒として足さない。何件あったかを別に返す。
 *   ・まとまりで申告された時間（durationGroup）は、そのまとまりにつき1回だけ足す。
 *     1問ずつに割り振らないので、二重に数えることがない。
 */
export function sumDurations(records = []) {
  let seconds = 0;
  let known = 0;
  let unknown = 0;
  const groups = new Map();
  for (const record of records) {
    if (!isCountedRecord(record)) continue;
    if (hasDuration(record)) {
      seconds += record.durationSeconds;
      known += 1;
      continue;
    }
    if (record.durationGroup?.id) {
      groups.set(record.durationGroup.id, record.durationGroup.totalSeconds ?? 0);
      known += 1;
      continue;
    }
    unknown += 1;
  }
  for (const total of groups.values()) seconds += total;
  return {
    seconds,
    knownCount: known,
    unknownCount: unknown,
    groupCount: groups.size,
  };
}

/**
 * 同じ記録が2か所から届いたときに、どちらを残すか。
 *
 * 訂正のたびに revision が増えるので、大きいほうが新しい。
 * 古い端末が訂正前の内容を送ってきても、これで戻らない。
 */
export function mergeStudyRecord(stored, incoming) {
  if (!stored) return incoming;
  if (!incoming) return stored;
  const storedRevision = Number(stored.revision ?? 0);
  const incomingRevision = Number(incoming.revision ?? 0);
  if (incomingRevision > storedRevision) return incoming;
  if (incomingRevision < storedRevision) return stored;
  const storedAt = Date.parse(stored.updatedAt ?? stored.enteredAt ?? '') || 0;
  const incomingAt = Date.parse(incoming.updatedAt ?? incoming.enteredAt ?? '') || 0;
  return incomingAt > storedAt ? incoming : stored;
}

/** 画面やAIへ返すときの、分かりやすい形。 */
export function describeRecord(record) {
  return {
    recordId: record.id,
    questionId: record.questionId,
    date: recordDateOf(record),
    time: hasExactTime(record) ? record.timestamp : null,
    datePrecision: record.datePrecision ?? 'datetime',
    evaluation: record.evaluation ?? null,
    evaluationKnown: Boolean(record.evaluation),
    durationSeconds: hasDuration(record) ? record.durationSeconds : null,
    ...normalizedTiming(record),
    durationKnown: hasDuration(record),
    ...(record.durationGroup ? { durationGroup: record.durationGroup } : {}),
    source: record.source ?? 'timer',
    enteredAt: record.enteredAt ?? null,
    enteredBy: record.enteredBy ?? null,
    claimSummary: record.claimSummary ?? null,
    updatedAt: record.updatedAt ?? null,
    revision: Number(record.revision ?? 0),
    voided: record.voided === true,
    voidReason: record.voidReason ?? null,
    corrections: (record.corrections ?? []).length,
    challengeId: record.challengeId ?? null,
    planTaskId: record.planTaskId ?? null,
    planItemId: record.planItemId ?? null,
  };
}
