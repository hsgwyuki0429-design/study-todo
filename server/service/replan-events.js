import { fail } from '../core/validate.js';
import { runTransaction, supportsTransactions } from '../storage/driver.js';
import { isDateKey } from '../../src/datetime.js';
import { SYNC_KEYS } from './sync-service.js';
import { fireClaudeRoutine, routineConfigurationError } from './claude-routine.js';

// No TTL/capped history: removing these tombstones would permit old requests to fire again.
export const replanEventKey = SYNC_KEYS.replanEvent;

export function readStudyEnd(body) {
  if (!body || typeof body.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(body.sessionId)
    || body.eventId !== `study_end_${body.sessionId}` || !isDateKey(body.date)
    || typeof body.endedAt !== 'string' || !Number.isFinite(Date.parse(body.endedAt))) {
    fail('study_end のイベント情報が正しくありません。', 'event');
  }
  return { trigger: 'study_end', eventId: body.eventId, sessionId: body.sessionId,
    date: body.date, endedAt: new Date(body.endedAt).toISOString() };
}

// Deliberately exclude provider session details and all free-form provider content.
export function publicReplan(event) {
  return Object.fromEntries(['eventId', 'state', 'error', 'retryable', 'temporary', 'outcomeUnknown']
    .filter((key) => event[key] !== undefined).map((key) => [key, event[key]]));
}

export function createReplanEvents({ storage, env, now = () => Date.now(),
  waitUntil = (promise) => { void promise.catch(() => {}); }, fetchImpl = fetch }) {
  return {
    async end(event, deviceId, enabled) {
      if (!supportsTransactions(storage)) return { eventId: event.eventId, state: 'failed',
        error: 'storage_not_atomic', retryable: true };
      const key = replanEventKey(event.sessionId);
      const result = await runTransaction(storage, async (tx) => {
        const previous = await tx.get(key);
        if (previous && (previous.deviceId !== deviceId || previous.date !== event.date || previous.endedAt !== event.endedAt)) {
          fail('同じsessionIdの終了情報が一致しません。', 'event');
        }
        if (previous?.attemptedAt) return { event: previous, dispatch: false };
        const error = enabled ? routineConfigurationError(env) : 'ai_disabled';
        const entry = { ...event, deviceId, revision: (previous?.revision ?? 0) + 1,
          ...(['dry_run', 'write_test'].includes(env.CLAUDE_ROUTINE_TEST_MODE) ? { testMode: env.CLAUDE_ROUTINE_TEST_MODE } : {}),
          receivedAt: previous?.receivedAt ?? new Date(now()).toISOString(),
          state: error ? 'failed' : 'pending', retryable: Boolean(error),
          ...(error ? { error } : { attemptedAt: new Date(now()).toISOString(), outcomeUnknown: true }) };
        // Clear only this session's activity; a newer session/other device remains protected.
        // A study session can cross JST midnight, so clear its activity on all days.
        for (const planKey of await tx.list(SYNC_KEYS.taskPlanPrefix)) {
          const plan = await tx.get(planKey);
          if (plan?.active?.deviceId === deviceId
            && (plan.active.sessionId === event.sessionId
              || (!plan.active.sessionId && Date.parse(plan.active.startedAt) <= Date.parse(event.endedAt)))) {
            delete plan.active;
            await tx.put(planKey, plan); // activity never advances the plan revision
          }
        }
        await tx.put(key, entry);
        return { event: entry, dispatch: !error };
      });
      if (result.dispatch) {
        // Claim commits BEFORE network I/O, outside the transaction callback (which can retry).
        const job = (async () => {
          const outcome = await fireClaudeRoutine(event, { env, fetchImpl });
          await runTransaction(storage, async (tx) => {
            const current = await tx.get(key);
            await tx.put(key, { ...current, ...outcome, outcomeUnknown: outcome.outcomeUnknown ?? false,
              revision: current.revision + 1, updatedAt: new Date(now()).toISOString() });
          });
        })().catch(() => { /* Durable claim remains; never log secrets or re-fire. */ });
        waitUntil(job);
      }
      return publicReplan(result.event);
    },
    async status(sessionId, deviceId) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) return null;
      const entry = await storage.get(replanEventKey(sessionId));
      return entry?.deviceId === deviceId ? publicReplan(entry) : null;
    },
  };
}
