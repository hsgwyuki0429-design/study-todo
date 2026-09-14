// Timer state is a draft, never a study record until the user submits an evaluation.
import { studyDateKeyOf } from './datetime.js';

export function addInterval(days, from, to) {
  let cursor = Date.parse(from);
  if (!Number.isFinite(cursor) || to <= cursor) return;
  while (cursor < to) {
    // 03:00 JST is 18:00 UTC. Allocate an interval across that boundary.
    const boundary = (Math.floor((cursor + 360 * 60000) / 86400000) + 1) * 86400000 - 360 * 60000;
    const end = Math.min(to, boundary);
    const day = studyDateKeyOf(cursor);
    days[day] = (days[day] ?? 0) + (end - cursor) / 1000;
    cursor = end;
  }
}

export function questionTiming(session, questionId, now = Date.now()) {
  session.questionTiming ??= {};
  if (!session.questionTiming[questionId]) {
    const legacy = session.questionElapsed?.[questionId] ?? 0;
    session.questionTiming[questionId] = {
      solveSeconds: 0, reviewSeconds: 0, unclassifiedSeconds: legacy,
      phase: session.currentQuestionId === questionId && session.mode === 'record_input' ? 'review' : 'solve',
      byDate: legacy ? { [studyDateKeyOf(now)]: legacy } : {},
    };
  }
  return session.questionTiming[questionId];
}

// Checkpoint both clocks at the same instant. Pause/end exclude all subsequent time.
export function checkpoint(session, now = Date.now()) {
  session.questionElapsed ??= {};
  session.idleSecondsByDate ??= {};
  if (session.currentQuestionId && session.currentStartedAt) {
    const timing = questionTiming(session, session.currentQuestionId, now);
    const seconds = Math.max(0, (now - Date.parse(session.currentStartedAt)) / 1000);
    timing[timing.phase === 'review' ? 'reviewSeconds' : 'solveSeconds'] += seconds;
    addInterval(timing.byDate, session.currentStartedAt, now);
    session.questionElapsed[session.currentQuestionId] = (session.questionElapsed[session.currentQuestionId] ?? 0) + seconds;
    session.currentStartedAt = new Date(now).toISOString();
  } else if (session.sessionStartedAt) {
    addInterval(session.idleSecondsByDate, session.sessionStartedAt, now);
  }
  if (session.sessionStartedAt) {
    session.sessionElapsed = (session.sessionElapsed ?? 0) + Math.max(0, (now - Date.parse(session.sessionStartedAt)) / 1000);
    session.sessionStartedAt = new Date(now).toISOString();
  }
  return session;
}

export function timingRecord(session, questionId) {
  const timing = questionTiming(session, questionId);
  const solveSeconds = Math.round(timing.solveSeconds);
  const reviewSeconds = Math.round(timing.reviewSeconds);
  const unclassifiedSeconds = Math.round(timing.unclassifiedSeconds ?? 0);
  const durationSeconds = solveSeconds + reviewSeconds + unclassifiedSeconds;
  const byDate = Object.entries(timing.byDate).sort(([a], [b]) => a.localeCompare(b));
  let remaining = durationSeconds;
  const studySecondsByDate = Object.fromEntries(byDate.map(([date, seconds], index) => {
    const allocated = index === byDate.length - 1 ? remaining : Math.min(remaining, Math.round(seconds));
    remaining -= allocated;
    return [date, allocated];
  }));
  return { durationSeconds, solveSeconds, reviewSeconds,
    ...(unclassifiedSeconds ? { unclassifiedSeconds } : {}), studySecondsByDate };
}

export function pendingSecondsForDay(session, date, now = Date.now()) {
  const draft = checkpoint(structuredClone(session), now);
  let seconds = draft.idleSecondsByDate?.[date] ?? 0;
  for (const qid of Object.keys(draft.questionElapsed ?? {})) {
    if (draft.mode === 'challenge_review' && draft.evaluations?.[qid]) continue;
    seconds += questionTiming(draft, qid, now).byDate?.[date] ?? 0;
  }
  return seconds;
}

export function forgetQuestion(session, questionId) {
  delete session.questionElapsed[questionId];
  if (session.questionTiming) delete session.questionTiming[questionId];
  if (session.currentQuestionId === questionId) {
    session.currentQuestionId = null;
    session.currentStartedAt = null;
    session.currentPlanItemId = null;
    session.currentPlanTaskId = null;
  }
}
