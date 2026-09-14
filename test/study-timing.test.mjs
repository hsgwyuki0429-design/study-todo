import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkpoint, questionTiming, timingRecord, pendingSecondsForDay, forgetQuestion } from '../src/study-timing.js';
import { normalizeStudyRecord, describeRecord, durationEntriesByStudyDate, durationOnStudyDate } from '../src/records-model.js';

const start = Date.parse('2026-09-14T03:00:00Z');
const draft = () => ({ active: true, mode: 'task_list', currentQuestionId: 'q1', questionElapsed: {},
  questionTiming: {}, sessionElapsed: 0, sessionStartedAt: new Date(start).toISOString(), currentStartedAt: new Date(start).toISOString() });

test('solve and review clocks pause independently of wall time; cumulative draft is not doubled', () => {
  const s = draft();
  checkpoint(s, start + 60000);
  s.currentStartedAt = null; s.sessionStartedAt = null;
  assert.equal(pendingSecondsForDay(s, '2026-09-14', start + 3600000), 60);
  s.currentStartedAt = s.sessionStartedAt = new Date(start + 3600000).toISOString();
  questionTiming(s, 'q1').phase = 'review';
  checkpoint(s, start + 3630000);
  assert.deepEqual(timingRecord(s, 'q1'), { solveSeconds: 60, reviewSeconds: 30, durationSeconds: 90, studySecondsByDate: { '2026-09-14': 90 } });
  assert.equal(pendingSecondsForDay(s, '2026-09-14', start + 3630000), 90);
  forgetQuestion(s, 'q1');
  assert.equal(pendingSecondsForDay(s, '2026-09-14', start + 3630000), 0);
});

test('JST midnight stays in the previous study day', () => {
  const s = draft();
  const midnight = Date.parse('2026-09-14T15:00:00Z');
  s.sessionStartedAt = s.currentStartedAt = new Date(midnight - 20000).toISOString();
  checkpoint(s, midnight + 10000);
  questionTiming(s, 'q1').phase = 'review';
  checkpoint(s, midnight + 30000);
  const r = timingRecord(s, 'q1');
  assert.equal(r.solveSeconds, 30); assert.equal(r.reviewSeconds, 20);
  assert.deepEqual(r.studySecondsByDate, { '2026-09-14': 50 });
  assert.equal(pendingSecondsForDay(s, '2026-09-14', midnight + 30000), 50);
});

test('03:00 JST splits measured seconds between study days exactly', () => {
  const s = draft();
  const boundary = Date.parse('2026-09-14T18:00:00Z');
  s.sessionStartedAt = s.currentStartedAt = new Date(boundary - 20000).toISOString();
  checkpoint(s, boundary + 30000);
  assert.deepEqual(timingRecord(s, 'q1').studySecondsByDate,
    { '2026-09-14': 20, '2026-09-15': 30 });
  assert.equal(pendingSecondsForDay(s, '2026-09-14', boundary + 30000), 20);
  assert.equal(pendingSecondsForDay(s, '2026-09-15', boundary + 30000), 30);
});

test('legacy timing preserves unknown breakdown; old records acquire no invented solve/review times', () => {
  const s = draft(); s.questionElapsed.q1 = 100;
  checkpoint(s, start + 10000);
  const timing = timingRecord(s, 'q1');
  assert.equal(timing.unclassifiedSeconds, 100); assert.equal(timing.solveSeconds, 10);
  const old = normalizeStudyRecord({ id: 'old', questionId: 'q1', date: '2026-09-14', durationSeconds: 500 });
  assert.equal(old.solveSeconds, undefined); assert.equal(old.reviewSeconds, undefined);
});

test('normalization and MCP descriptions preserve consistent measured fields; stale corrections discard breakdown', () => {
  const raw = { id: 'r1', questionId: 'q1', date: '2026-09-15', durationSeconds: 90, solveSeconds: 60, reviewSeconds: 30,
    studySecondsByDate: { '2026-09-14': 50, '2026-09-15': 40 } };
  const record = normalizeStudyRecord(raw);
  assert.equal(describeRecord(record).reviewSeconds, 30);
  assert.deepEqual(record.studySecondsByDate, raw.studySecondsByDate);
  const corrected = normalizeStudyRecord({ ...raw, durationSeconds: 120 });
  assert.equal(corrected.solveSeconds, undefined); assert.equal(corrected.studySecondsByDate, undefined);
});

test('daily capacity uses the measured 03:00 split and keeps legacy records on their stored day', () => {
  const split = normalizeStudyRecord({ id: 'split', questionId: 'q1', date: '2026-09-15', durationSeconds: 50,
    solveSeconds: 50, reviewSeconds: 0, studySecondsByDate: { '2026-09-14': 20, '2026-09-15': 30 } });
  assert.deepEqual(durationEntriesByStudyDate(split), [['2026-09-14', 20], ['2026-09-15', 30]]);
  assert.equal(durationOnStudyDate(split, '2026-09-14'), 20);
  const legacy = normalizeStudyRecord({ id: 'legacy', questionId: 'q1', date: '2026-09-14', durationSeconds: 40 });
  assert.deepEqual(durationEntriesByStudyDate(legacy), [['2026-09-14', 40]]);
});
