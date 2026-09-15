import { fail } from '../core/validate.js';
import { runTransaction, supportsTransactions } from '../storage/driver.js';
import { DEFAULT_TIMEZONE_OFFSET_MINUTES, isDateKey, studyDateKeyOf } from '../../src/datetime.js';
import { STORAGE_KEYS, DEFAULT_SETTINGS, generateToken } from '../auth/tokens.js';
import { SYNC_KEYS } from './sync-service.js';
import { fireClaudeRoutine, routineConfigurationError } from './claude-routine.js';

// Keep old study_end keys as closed-session tombstones. Never fire them again.
export const replanEventKey = SYNC_KEYS.replanEvent;
export const dailyEventKey = (date) => `studytodo:replan:daily:${date}`;
// 手動実行はdailyとは別の台帳に置く。日付単位で1回のdailyの冪等性と、
// 「押すたびに新しい実行」という手動の意味を混ぜないため。
export const manualEventKey = (operationId) => `studytodo:replan:manual:${operationId}`;
export const DEFERRED_KEY = 'studytodo:replan:deferred';

const OPERATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function dailyEvent(scheduledTime) {
  if (typeof scheduledTime !== 'number' || !Number.isFinite(scheduledTime)) fail('scheduledTimeが不正です。', 'scheduledTime');
  // 学習日（03:00 JST区切り）で数える。アプリ側が同じ区切りで今日を決めているため、
  // 暦の日付で数えると、0:00〜3:00 に動かしたときだけ1日ずれて見つからなくなる。
  const date = studyDateKeyOf(scheduledTime, 540);
  if (!isDateKey(date)) fail('scheduledTimeが不正です。', 'scheduledTime');
  return { trigger: 'daily_3am', eventId: `daily_replan_${date}`, date };
}

/**
 * 設定画面の「プランナーを今すぐ実行」で作る、手動実行専用のイベント。
 * operationId は同じ操作の再送（連打・timeout後の再試行）を見分けるための鍵で、
 * 省略されたらサーバーが作る（その場合は毎回新しい実行になる）。
 */
export function manualEvent(body, at) {
  const operationId = body?.operationId === undefined || body.operationId === null
    ? generateToken(16) : String(body.operationId);
  if (!OPERATION_ID.test(operationId)) fail('operationId が正しくありません。', 'operationId');
  // 日付は03:00 JST区切りの学習日。dailyと同じ数え方をここでも使う。
  const date = studyDateKeyOf(at, DEFAULT_TIMEZONE_OFFSET_MINUTES);
  if (!isDateKey(date)) fail('現在時刻を学習日に直せませんでした。', 'date');
  return { trigger: 'manual', eventId: `manual_replan_${operationId}`, date, operationId };
}

export function readStudyEnd(body) {
  if (!body || typeof body.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(body.sessionId)
    || (body.eventId !== undefined && body.eventId !== `study_end_${body.sessionId}`) || !isDateKey(body.date)
    || typeof body.endedAt !== 'string' || !Number.isFinite(Date.parse(body.endedAt))) {
    fail('session終了の情報が正しくありません。', 'event');
  }
  return { sessionId: body.sessionId, date: body.date, endedAt: new Date(body.endedAt).toISOString() };
}

// Exclude secret URL, provider ID/URL, auth headers and free-form provider content.
export function publicReplan(event) {
  return Object.fromEntries(['eventId', 'trigger', 'date', 'operationId', 'state', 'error', 'detail', 'retryable', 'temporary', 'outcomeUnknown']
    .filter((key) => event[key] !== undefined).map((key) => [key, event[key]]));
}

async function arm(tx, at) {
  if (!tx.setAlarm) return; // Node/test drivers need not implement platform alarms.
  const current = await tx.getAlarm();
  if (current === null || current > at) await tx.setAlarm(at);
}

// Session leases live on existing devices; legacy task activity remains a fallback.
async function activeUntil(tx, at) {
  const devices = await tx.get(SYNC_KEYS.devices);
  const deadlines = Object.values(devices?.devices ?? {})
    .filter((device) => device.keyHash).map((device) => Date.parse(device.activeSession?.expiresAt ?? ''));
  for (const key of await tx.list(SYNC_KEYS.taskPlanPrefix)) {
    const active = (await tx.get(key))?.active;
    if (active?.sessionId && await tx.get(replanEventKey(active.sessionId))) continue;
    deadlines.push(Date.parse(active?.expiresAt ?? ''));
  }
  const live = deadlines.filter((expiry) => Number.isFinite(expiry) && expiry > at);
  return live.length ? Math.min(...live) : null;
}

export function createReplanEvents({ storage, env, now = () => Date.now(),
  waitUntil = (promise) => { void promise.catch(() => {}); }, fetchImpl = fetch, onReplan = () => {} }) {
  const report = (event) => { try { onReplan(publicReplan(event)); } catch { /* telemetry must not affect delivery */ } };

  /**
   * 起動してよいか。dailyと手動で同じ設定・権限・Secretの確認を使う。
   * 手動実行は押した人に直せる場所を伝えたいので、権限の不足を分けて返す。
   */
  async function blocker(tx) {
    const settings = (await tx.get(STORAGE_KEYS.settings)) ?? DEFAULT_SETTINGS;
    if (!settings.enabled) return 'ai_disabled';
    if (!settings.permissions?.read) return 'read_permission_required';
    if (!settings.permissions?.write) return 'write_permission_required';
    return routineConfigurationError(env);
  }

  const coarseBlocker = (error) => (error?.endsWith('_permission_required') ? 'ai_disabled' : error);

  const testMode = () => (['dry_run', 'write_test'].includes(env.CLAUDE_ROUTINE_TEST_MODE)
    ? { testMode: env.CLAUDE_ROUTINE_TEST_MODE } : {});

  /**
   * claim（attemptedAt）を保存し終えたイベントをRoutineへ渡す。
   * HTTPはtransactionの外で1回だけ行い、結果不明でも送り直さない。
   */
  function fireAfterClaim(key, event) {
    const job = (async () => {
      const outcome = await fireClaudeRoutine(event, { env, fetchImpl });
      let merged = { ...event, ...outcome };
      await runTransaction(storage, async (tx) => {
        const current = await tx.get(key);
        merged = { ...current, ...outcome, outcomeUnknown: outcome.outcomeUnknown ?? false,
          revision: current.revision + 1, updatedAt: new Date(now()).toISOString() };
        await tx.put(key, merged);
      });
      report(merged);
      return merged;
    })();
    // Claim survives; no secret-bearing exception logging/re-fire.
    waitUntil(job.catch(() => {}));
    return job;
  }

  /**
   * 手動実行。dailyの台帳・重複防止・alarm・延期には一切触らない。
   * 学習中は延期せず、はっきり断る（「今すぐ実行」の意味を曖昧にしないため）。
   */
  async function manual(event) {
    if (!supportsTransactions(storage)) {
      return publicReplan({ ...event, state: 'failed', error: 'storage_not_atomic', retryable: false });
    }
    const key = manualEventKey(event.operationId);
    const result = await runTransaction(storage, async (tx) => {
      const previous = await tx.get(key);
      // 同じ操作の再送では新しい起動を作らない（連打・timeout後の再試行）。
      if (previous) return { event: previous, dispatch: false };
      const at = now();
      const error = (await blocker(tx)) ?? (await activeUntil(tx, at) ? 'study_in_progress' : null);
      const entry = { ...event, revision: 1, ...testMode(),
        receivedAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(),
        state: error ? 'failed' : 'pending', retryable: false,
        ...(error ? { error } : { attemptedAt: new Date(at).toISOString(), outcomeUnknown: true }) };
      await tx.put(key, entry);
      return { event: entry, dispatch: !error };
    });
    if (!result.dispatch) {
      report(result.event);
      return publicReplan(result.event);
    }
    // 押した人へ結果を返したいので、ここだけは送信の結果を待つ。
    // waitUntil にも渡してあるので、画面を閉じられても結果の保存は続く。
    const settled = await fireAfterClaim(key, event).catch(() => null);
    return publicReplan(settled ?? result.event);
  }

  async function process(event, { deferredOnly = false } = {}) {
    if (!supportsTransactions(storage)) return { ...event, state: 'failed', error: 'storage_not_atomic', retryable: false };
    const key = dailyEventKey(event.date);
    const result = await runTransaction(storage, async (tx) => {
      const previous = await tx.get(key);
      if (deferredOnly && previous?.state !== 'deferred') return null;
      if (previous?.attemptedAt) return { event: previous, dispatch: false };
      const at = now();
      // dailyの失敗分類は既存の契約のまま（read/writeの不足もai_disabledにまとめる）。
      const error = coarseBlocker(await blocker(tx));
      const until = error ? null : await activeUntil(tx, at);
      const entry = { ...event, revision: (previous?.revision ?? 0) + 1, ...testMode(),
        receivedAt: previous?.receivedAt ?? new Date(at).toISOString(), updatedAt: new Date(at).toISOString(),
        state: error ? 'failed' : until ? 'deferred' : 'pending', retryable: false,
        ...(error ? { error } : until ? {} : { attemptedAt: new Date(at).toISOString(), outcomeUnknown: true }) };
      const deferred = (await tx.get(DEFERRED_KEY)) ?? {};
      if (until) {
        deferred[event.date] = true;
        // Lease expiry is checked even if the browser crashes and no end arrives.
        await arm(tx, until + 1000);
      } else { delete deferred[event.date]; }
      await tx.put(DEFERRED_KEY, deferred);
      await tx.put(key, entry);
      return { event: entry, dispatch: !error && !until };
    });
    if (!result) return null;
    // Claim commits BEFORE I/O; never POST inside a retried transaction.
    if (result.dispatch) fireAfterClaim(key, event).catch(() => {});
    report(result.event);
    return publicReplan(result.event);
  }

  async function resumeDeferred() {
    const dates = Object.keys((await storage.get(DEFERRED_KEY)) ?? {}).sort();
    const results = [];
    for (const date of dates) {
      const result = await process({ trigger: 'daily_3am', eventId: `daily_replan_${date}`, date }, { deferredOnly: true });
      if (result) results.push(result);
    }
    return results;
  }

  return {
    daily: (scheduledTime) => process(dailyEvent(scheduledTime)),
    manual: (body) => manual(manualEvent(body, now())),
    resumeDeferred,
    async end(event, deviceId) {
      await runTransaction(storage, async (tx) => {
        const key = replanEventKey(event.sessionId);
        const previous = await tx.get(key);
        if (previous && (previous.deviceId !== deviceId || previous.date !== event.date || previous.endedAt !== event.endedAt)) {
          fail('同じsessionIdの終了情報が一致しません。', 'event');
        }
        // Preserve old attemptedAt tombstones; this is a receipt, not a replan.
        if (!previous) await tx.put(key, { ...event, deviceId, state: 'ended', receivedAt: new Date(now()).toISOString() });
        const devices = await tx.get(SYNC_KEYS.devices);
        if (devices?.devices?.[deviceId]?.activeSession?.sessionId === event.sessionId) {
          delete devices.devices[deviceId].activeSession;
          devices.revision = (devices.revision ?? 0) + 1;
          await tx.put(SYNC_KEYS.devices, devices);
        }
        for (const planKey of await tx.list(SYNC_KEYS.taskPlanPrefix)) {
          const plan = await tx.get(planKey);
          if (plan?.active?.deviceId === deviceId
            && (plan.active.sessionId === event.sessionId
              || (!plan.active.sessionId && Date.parse(plan.active.startedAt) <= Date.parse(event.endedAt)))) {
            delete plan.active;
            await tx.put(planKey, plan); // no plan revision change
          }
        }
        if (Object.keys((await tx.get(DEFERRED_KEY)) ?? {}).length) await arm(tx, now() + 1000);
      });
      try {
        // Only existing deferred dates; study_end never creates a daily event.
        const resumed = await resumeDeferred();
        return resumed.at(-1) ?? { state: 'not_requested', retryable: false };
      } catch {
        // End receipt committed. Alarm owns deferred work; PWA can acknowledge.
        return { state: 'failed', error: 'planning_storage', retryable: false };
      }
    },
    async status(date) {
      if (!isDateKey(date)) return null;
      const entry = await storage.get(dailyEventKey(date));
      return entry ? publicReplan(entry) : null;
    },
  };
}
