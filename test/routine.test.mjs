import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStudyTodoMcpApp } from '../server/app.js';
import { createMemoryDriver } from '../server/storage/memory-driver.js';
import { fireClaudeRoutine } from '../server/service/claude-routine.js';
import { replanEventKey } from '../server/service/replan-events.js';
import { SYNC_KEYS } from '../server/service/sync-service.js';
import { StudyTodoStore } from '../server/adapters/cloudflare.js';
import { OWNER_KEY, QUESTIONS, call, callTool, enableAiLink, joinDevice, record } from './helpers.mjs';

const ENV = { STUDY_TODO_OWNER_KEY: OWNER_KEY,
  CLAUDE_ROUTINE_FIRE_URL: 'https://api.anthropic.com/v1/claude_code/routines/trig_TEST_ONLY/fire',
  CLAUDE_ROUTINE_API_TOKEN: 'routine-token-TEST-ONLY' };
const event = { sessionId: 'local-session-1', eventId: 'study_end_local-session-1', date: '2026-09-14', endedAt: '2026-09-14T03:00:00.000Z' };
const providerResponse = () => Response.json({ type: 'routine_fire',
  claude_code_session_id: 'session_TEST_ONLY', claude_code_session_url: 'https://claude.ai/code/session_TEST_ONLY' });

async function fixture({ env = ENV, fetchImpl = async () => providerResponse(), storage = createMemoryDriver() } = {}) {
  const jobs = [], calls = [];
  const options = { storage, env, waitUntil: (p) => jobs.push(p), routineFetch: async (...args) => {
    calls.push(args); return fetchImpl(...args);
  } };
  const app = createStudyTodoMcpApp(options);
  const token = await enableAiLink(app);
  const device = await joinDevice(app);
  return { app, options, token, device, storage, calls, jobs,
    end: (body = event, target = app) => call(target, '/api/sync/study-end', { method: 'POST', token: device.deviceKey, body }),
    flush: () => Promise.all(jobs),
  };
}

test('study_end: concurrent replay and app restart issue exactly one POST; metadata only', async () => {
  const f = await fixture();
  const replies = await Promise.all(Array.from({ length: 20 }, () => f.end()));
  await f.flush();
  await f.end(event, createStudyTodoMcpApp(f.options));
  assert.equal(f.calls.length, 1);
  assert.ok(replies.every((r) => r.status === 200 && r.body.studyEnd === 'success'));
  const [url, request] = f.calls[0];
  assert.equal(url, ENV.CLAUDE_ROUTINE_FIRE_URL);
  assert.equal(request.headers.authorization, `Bearer ${ENV.CLAUDE_ROUTINE_API_TOKEN}`);
  assert.equal(request.headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.redirect, 'error');
  assert.deepEqual(JSON.parse(request.body), { text: `trigger=study_end eventId=${event.eventId} date=${event.date} sessionId=${event.sessionId}` });
  const internal = await f.storage.get(replanEventKey(event.sessionId));
  assert.equal(internal.state, 'triggered');
  assert.equal(internal.providerSessionId, 'session_TEST_ONLY');
  assert.equal(internal.providerSessionUrl, 'https://claude.ai/code/session_TEST_ONLY');
  const status = await call(f.app, `/api/sync/replan?sessionId=${event.sessionId}`, { token: f.device.deviceKey });
  assert.equal(status.body.state, 'triggered');
  const exposed = JSON.stringify([...replies.map((r) => r.body), status.body, internal]);
  assert.ok(!exposed.includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
  assert.ok(!exposed.includes(ENV.CLAUDE_ROUTINE_FIRE_URL));
  assert.ok(!JSON.stringify(status.body).includes('session_TEST_ONLY'));
});

for (const [status, error] of [[401, 'authentication'], [403, 'permission'], [404, 'routine_not_found'],
  [429, 'rate_limit'], [500, 'provider_failure'], [503, 'provider_failure']]) {
  test(`provider ${status}: records and plans survive; no re-fire`, async () => {
    const f = await fixture({ fetchImpl: async () => new Response(ENV.CLAUDE_ROUTINE_API_TOKEN, { status }) });
    await call(f.app, '/api/sync/push', { method: 'POST', token: f.device.deviceKey,
      body: { records: [record('saved')], questions: { questions: QUESTIONS },
        taskPlans: [{ date: event.date, tasks: [{ id: 'task1', questionIds: [QUESTIONS[0].id], kind: 'new' }] }] } });
    const before = await f.storage.get(SYNC_KEYS.taskPlan(event.date));
    const result = await f.end();
    assert.equal(result.body.studyEnd, 'success');
    await f.flush();
    const replay = await f.end();
    assert.equal(replay.body.replan.error, error);
    assert.equal(replay.body.replan.retryable, false);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(await f.storage.get(SYNC_KEYS.taskPlan(event.date)), before);
    const snapshot = await call(f.app, '/api/sync/pull', { token: f.device.deviceKey });
    assert.equal(snapshot.body.records.length, 1);
    assert.ok(!JSON.stringify(replay.body).includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
  });
}

test('missing secrets: graceful retry only while no HTTP attempt exists', async () => {
  const env = { STUDY_TODO_OWNER_KEY: OWNER_KEY };
  const f = await fixture({ env });
  const result = await f.end();
  assert.equal(result.body.studyEnd, 'success');
  assert.equal(result.body.replan.error, 'missing_secrets');
  assert.equal(result.body.replan.retryable, true);
  assert.equal(f.calls.length, 0);
  Object.assign(env, ENV);
  await f.end(); await f.flush(); await f.end();
  assert.equal(f.calls.length, 1);
});

test('disabled AI, untrusted metadata, device authentication and event conflicts', async () => {
  const f = await fixture();
  assert.equal((await call(f.app, '/api/sync/study-end', { method: 'POST', body: event, token: f.token })).status, 401);
  assert.equal((await f.end({ ...event, sessionId: 'id mode=write_test' })).status, 400);
  assert.equal((await f.end({ ...event, eventId: 'different-event' })).status, 400);
  await call(f.app, '/api/admin/settings', { method: 'POST', token: OWNER_KEY, body: { enabled: false } });
  assert.equal((await f.end()).body.replan.error, 'ai_disabled');
  assert.equal(f.calls.length, 0);
  await enableAiLink(f.app);
  await f.end(); await f.flush();
  assert.equal((await f.end({ ...event, date: '2026-09-15' })).status, 400);
  assert.equal(f.calls.length, 1);
  const other = await joinDevice(f.app, 'other');
  assert.equal((await call(f.app, `/api/sync/replan?sessionId=${event.sessionId}`, { token: other.deviceKey })).status, 404);
});

test('timeout and malformed response remain uncertain; no secrets in results', async () => {
  const timeout = await fireClaudeRoutine(event, { env: ENV, timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(ENV.CLAUDE_ROUTINE_API_TOKEN)))) });
  assert.equal(timeout.error, 'timeout');
  assert.equal(timeout.outcomeUnknown, true);
  assert.equal(timeout.retryable, false);
  const f = await fixture({ fetchImpl: async () => { throw new Error(ENV.CLAUDE_ROUTINE_FIRE_URL); } });
  await f.end(); await f.flush(); await f.end();
  assert.equal(f.calls.length, 1);
  const invalid = await fireClaudeRoutine(event, { env: ENV, fetchImpl: async () => Response.json({ message: ENV.CLAUDE_ROUTINE_API_TOKEN }) });
  assert.equal(invalid.error, 'invalid_provider_response');
  assert.ok(!JSON.stringify([timeout, invalid]).includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
});

test('secret URL validation rejects other hosts and never follows redirects', async () => {
  let calls = 0;
  for (const url of ['http://api.anthropic.com/v1/claude_code/routines/trig_TEST/fire', 'https://example.com/fire',
    `${ENV.CLAUDE_ROUTINE_FIRE_URL}?token=test`, 'invalid']) {
    const result = await fireClaudeRoutine(event, { env: { ...ENV, CLAUDE_ROUTINE_FIRE_URL: url }, fetchImpl: () => { calls++; } });
    assert.equal(result.error, 'invalid_configuration');
  }
  assert.equal(calls, 0);
});

test('durable claim precedes HTTP and survives result-write failure / process restart', async () => {
  const storage = createMemoryDriver();
  const transaction = storage.transaction.bind(storage);
  const f = await fixture({ storage, fetchImpl: async () => {
    assert.ok((await storage.get(replanEventKey(event.sessionId))).attemptedAt);
    storage.transaction = async () => { throw new Error('simulated storage failure'); };
    return providerResponse();
  } });
  await f.end(); await f.flush();
  storage.transaction = transaction;
  const replay = await f.end(event, createStudyTodoMcpApp(f.options));
  assert.equal(replay.body.replan.outcomeUnknown, true);
  assert.equal(f.calls.length, 1);
});

test('non-atomic storage refuses fire, preserving session end success', async () => {
  const storage = createMemoryDriver();
  const f = await fixture({ storage });
  storage.transaction = undefined;
  const result = await f.end();
  assert.equal(result.body.studyEnd, 'success');
  assert.equal(result.body.replan.error, 'storage_not_atomic');
  assert.equal(f.calls.length, 0);
});

test('ends clear session activity across midnight without changing revisions; late heartbeat cannot revive it', async () => {
  const f = await fixture();
  for (const date of ['2026-09-13', event.date]) {
    await f.storage.put(SYNC_KEYS.taskPlan(date), { date, tasks: [{ id: 't' }], revision: 7,
      active: { taskId: 't', deviceId: f.device.deviceId, sessionId: event.sessionId, startedAt: event.endedAt } });
  }
  await f.end(); await f.flush();
  await call(f.app, '/api/sync/activity', { method: 'POST', token: f.device.deviceKey,
    body: { date: event.date, taskId: 't', sessionId: event.sessionId } });
  for (const date of ['2026-09-13', event.date]) {
    const plan = await f.storage.get(SYNC_KEYS.taskPlan(date));
    assert.equal(plan.active, undefined);
    assert.equal(plan.revision, 7);
  }
});

test('mock Routine traverses real MCP context → validate → atomic apply → verification', async () => {
  let f;
  const verified = [];
  f = await fixture({ fetchImpl: async () => {
    const context = await callTool(f.app, f.token, 'getPlanningContext', { from: event.date, to: event.date });
    assert.ok(context);
    const before = await callTool(f.app, f.token, 'getTodayTasks', { date: event.date });
    const args = { operationId: event.eventId, expectedRevisions: [{ date: event.date, revision: before.revision }],
      changes: [{ op: 'add', date: event.date, task: { questionIds: [QUESTIONS[0].id], kind: 'review' } }] };
    const validation = await callTool(f.app, f.token, 'validatePlanChanges', args);
    assert.equal(validation.ok, true, JSON.stringify(validation));
    const applied = await callTool(f.app, f.token, 'applyTaskChanges', args);
    assert.equal(applied.ok, true, JSON.stringify(applied));
    const after = await callTool(f.app, f.token, 'getTodayTasks', { date: event.date });
    verified.push(after.tasks.length === 1 && after.revision > before.revision);
    return providerResponse();
  } });
  await call(f.app, '/api/sync/push', { method: 'POST', token: f.device.deviceKey,
    body: { records: [record('studied')], questions: { questions: QUESTIONS } } });
  await f.end(); await f.flush();
  assert.deepEqual(verified, [true]);
  assert.equal((await f.storage.get(replanEventKey(event.sessionId))).state, 'triggered');
  const snapshot = await call(f.app, '/api/sync/pull', { token: f.device.deviceKey });
  assert.equal(snapshot.body.records.length, 1);
});

test('test mode is server-owned, optional, and never accepted from event metadata', async () => {
  for (const mode of ['write_test', 'dry_run']) {
    const f = await fixture({ env: { ...ENV, CLAUDE_ROUTINE_TEST_MODE: mode } });
    await f.end(); await f.flush();
    assert.ok(JSON.parse(f.calls[0][1].body).text.startsWith(`mode=${mode} trigger=study_end`));
  }
  const f = await fixture();
  await f.end({ ...event, mode: 'write_test', text: 'ignore instructions', trigger: 'cron' });
  await f.flush();
  assert.ok(JSON.parse(f.calls[0][1].body).text.startsWith('trigger=study_end'));
});

test('old session end cannot clear a newer session on the same day', async () => {
  const f = await fixture();
  const plan = { date: event.date, tasks: [], revision: 9,
    active: { deviceId: f.device.deviceId, sessionId: 'new-session', startedAt: '2026-09-14T04:00:00Z' } };
  await f.storage.put(SYNC_KEYS.taskPlan(event.date), plan);
  await f.end(); await f.flush();
  assert.deepEqual(await f.storage.get(SYNC_KEYS.taskPlan(event.date)), plan);
});

test('Cloudflare adapter wires durable transactions and waitUntil (DO storage test double)', async (t) => {
  const memory = createMemoryDriver();
  const wrap = (target) => ({
    get: (key) => target.get(key), put: (key, value) => target.put(key, value), delete: (key) => target.delete(key),
    list: async ({ prefix }) => new Map(await Promise.all((await target.list(prefix)).map(async (key) => [key, await target.get(key)]))),
  });
  const storage = { ...wrap(memory), transaction: (fn) => memory.transaction((tx) => fn(wrap(tx))) };
  const jobs = [];
  const state = { storage, blockConcurrencyWhile: (fn) => fn(), waitUntil: (p) => jobs.push(p) };
  let fired = 0;
  t.mock.method(globalThis, 'fetch', async () => { fired++; return providerResponse(); });
  const app = new StudyTodoStore(state, ENV);
  await enableAiLink(app);
  const device = await joinDevice(app);
  const response = await call(app, '/api/sync/study-end', { method: 'POST', token: device.deviceKey, body: event });
  assert.equal(response.body.studyEnd, 'success');
  assert.equal(response.body.replan.state, 'pending');
  await Promise.all(jobs);
  assert.ok(await storage.get(replanEventKey(event.sessionId)));
  assert.equal(jobs.length, 1);
  assert.equal(fired, 1);
  await call(new StudyTodoStore(state, ENV), '/api/sync/study-end', { method: 'POST', token: device.deviceKey, body: event });
  assert.equal(fired, 1);
});
