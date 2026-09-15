import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStudyTodoMcpApp } from '../server/app.js';
import { createMemoryDriver } from '../server/storage/memory-driver.js';
import { fireClaudeRoutine, PROVIDER_TIMEOUT_MS } from '../server/service/claude-routine.js';
import { replanEventKey, dailyEventKey, dailyEvent, DEFERRED_KEY } from '../server/service/replan-events.js';
import { SYNC_KEYS } from '../server/service/sync-service.js';
import { STORAGE_KEYS } from '../server/auth/tokens.js';
import worker, { StudyTodoStore } from '../server/adapters/cloudflare.js';
import { OWNER_KEY, QUESTIONS, call, callTool, enableAiLink, joinDevice, record } from './helpers.mjs';

const ENV = { STUDY_TODO_OWNER_KEY: OWNER_KEY,
  CLAUDE_ROUTINE_FIRE_URL: 'https://api.anthropic.com/v1/claude_code/routines/trig_TEST_ONLY/fire',
  CLAUDE_ROUTINE_API_TOKEN: 'routine-token-TEST-ONLY' };
const ended = { sessionId: 'local-session-1', eventId: 'study_end_local-session-1', date: '2026-09-14', endedAt: '2026-09-14T03:00:00.000Z' };
const scheduledTime = Date.parse('2026-09-14T18:00:00Z');
const OPERATION = 'a1b2c3d4e5f60718';
const event = dailyEvent(scheduledTime);
// Cloudflare Workers が受け付けない要求の作り方を、Nodeのテストでも弾く。
// workerd は redirect:'error' を TypeError で拒む（Node は受け付けるため気づけなかった）。
// 本番だけで落ちる差を、mock を通る全テストで見張る。
function assertWorkerdCompatible([url, init]) {
  assert.ok(['follow', 'manual', undefined].includes(init.redirect),
    `Cloudflare Workers rejects redirect: ${JSON.stringify(init.redirect)}`);
  assert.equal(typeof url, 'string');
  for (const [key, value] of Object.entries(init.headers ?? {})) {
    assert.ok(!/[\r\n]/.test(String(value)), `header ${key} must not contain a line break`);
  }
}

const providerResponse = () => Response.json({ type: 'routine_fire',
  claude_code_session_id: 'session_TEST_ONLY', claude_code_session_url: 'https://claude.ai/code/session_TEST_ONLY' });

async function heartbeat(f, sessionId = ended.sessionId, device = f.device) {
  const response = await call(f.app, '/api/sync/activity', { method: 'POST', token: device.deviceKey,
    body: { date: event.date, sessionId, sessionActive: true, taskId: null } });
  assert.equal(response.status, 200);
}

test('JST planning date is explicit, including UTC/JST day and year boundaries', () => {
  assert.deepEqual(dailyEvent(scheduledTime), { trigger: 'daily_3am', eventId: 'daily_replan_2026-09-15', date: '2026-09-15' });
  assert.equal(dailyEvent(Date.parse('2026-12-31T18:00:00Z')).date, '2027-01-01');
  assert.equal(dailyEvent(Date.parse('2026-09-14T14:59:59Z')).date, '2026-09-14');
  // 0:00〜3:00 JST はまだ前の日の学習日。アプリ側（api.todayKey）と同じ区切りで数えないと、
  // この時間帯に動かしたときだけ /api/sync/replan が1日ずれて見つからなくなる。
  assert.equal(dailyEvent(Date.parse('2026-09-14T15:00:00Z')).date, '2026-09-14');
  assert.equal(dailyEvent(Date.parse('2026-09-14T17:59:59Z')).date, '2026-09-14');
  assert.throws(() => dailyEvent('2026-09-15'));
});

test('three ordinary ends before 03:00, repeated sync and resume create no daily event', async () => {
  const f = await fixture({ now: () => scheduledTime - 3600000 });
  for (let i = 0; i < 3; i++) {
    const body = { ...ended, sessionId: `session-${i}`, eventId: undefined };
    await heartbeat(f, body.sessionId);
    assert.equal((await f.end(body)).body.studyEnd, 'success');
    assert.equal((await f.end(body)).body.replan.state, 'not_requested');
  }
  await f.app.replans.resumeDeferred();
  assert.equal(f.calls.length, 0);
  assert.equal(await f.storage.get(dailyEventKey(event.date)), null);
  assert.equal((await f.storage.get(SYNC_KEYS.devices)).devices[f.device.deviceId].activeSession, undefined);
});

test('zero study records still dispatches the daily event', async () => {
  const f = await fixture();
  assert.equal((await call(f.app, '/api/sync/pull', { token: f.device.deviceKey })).body.records.length, 0);
  await f.daily(); await f.flush();
  assert.equal(f.calls.length, 1);
});

test('active taskless session defers; concurrent end, cron and alarm resume only once', async () => {
  const f = await fixture();
  await heartbeat(f);
  assert.equal((await f.daily()).state, 'deferred');
  assert.equal(f.calls.length, 0);
  assert.equal((await f.storage.get(dailyEventKey(event.date))).attemptedAt, undefined);
  await Promise.all(Array.from({ length: 20 }, async () => {
    assert.equal((await f.end()).body.studyEnd, 'success');
    await f.daily(); await f.app.replans.resumeDeferred();
  }));
  await f.flush();
  assert.equal(f.calls.length, 1);
  await heartbeat(f); // in-flight late request must not resurrect a closed session
  assert.equal((await f.storage.get(SYNC_KEYS.devices)).devices[f.device.deviceId].activeSession, undefined);
});

test('renewing session heartbeat supports long sessions; crash expires instead of deferring forever', async () => {
  let time = scheduledTime - 3 * 3600000;
  const f = await fixture({ now: () => time });
  for (let i = 0; i <= 180; i++) { await heartbeat(f); time += 60000; }
  assert.equal((await f.daily()).state, 'deferred');
  time += 10 * 60000;
  await heartbeat(f);
  await f.app.replans.resumeDeferred();
  assert.equal(f.calls.length, 0);
  time += 16 * 60000;
  await createStudyTodoMcpApp(f.options).replans.resumeDeferred();
  await f.flush();
  assert.equal(f.calls.length, 1);
  await f.end(); await f.app.replans.resumeDeferred();
  assert.equal(f.calls.length, 1);
});

test('another device or newer session remains active after an older end', async () => {
  const f = await fixture();
  const other = await joinDevice(f.app, 'second');
  await heartbeat(f); await heartbeat(f, 'other-session', other);
  await f.daily(); await f.end();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.app.replans.status(event.date)).state, 'deferred');
  const body = { ...ended, sessionId: 'other-session', eventId: undefined };
  await call(f.app, '/api/sync/study-end', { method: 'POST', token: other.deviceKey, body });
  await f.flush(); assert.equal(f.calls.length, 1);
});

for (const permission of ['read', 'write']) {
  test(`AI ${permission} OFF prevents HTTP`, async () => {
    const f = await fixture();
    const settings = await f.storage.get(STORAGE_KEYS.settings);
    settings.permissions[permission] = false;
    await f.storage.put(STORAGE_KEYS.settings, settings);
    assert.equal((await f.daily()).error, 'ai_disabled');
    assert.equal(f.calls.length, 0);
  });
}

test('timeout persists an uncertain claim and duplicate daily never retries HTTP', async (t) => {
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => original(fn, ms === PROVIDER_TIMEOUT_MS ? 5 : ms, ...args));
  const f = await fixture({ fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('not logged')));
  }) });
  await f.daily(); await f.flush();
  const replay = await f.daily();
  assert.equal(replay.error, 'timeout');
  assert.equal(replay.outcomeUnknown, true);
  assert.equal(f.calls.length, 1);
});

async function fixture({ env = ENV, fetchImpl = async () => providerResponse(), storage = createMemoryDriver(), now = () => scheduledTime, onReplan } = {}) {
  const jobs = [], calls = [];
  const options = { storage, env, now, onReplan, waitUntil: (p) => jobs.push(p), routineFetch: async (...args) => {
    assertWorkerdCompatible(args);
    calls.push(args); return fetchImpl(...args);
  } };
  const app = createStudyTodoMcpApp(options);
  const token = await enableAiLink(app);
  const device = await joinDevice(app);
  return { app, options, token, device, storage, calls, jobs,
    daily: (target = app) => target.replans.daily(scheduledTime),
    end: (body = ended, target = app) => call(target, '/api/sync/study-end', { method: 'POST', token: device.deviceKey, body }),
    flush: () => Promise.all(jobs),
  };
}

test('daily_3am: concurrent replay and app restart issue exactly one POST; metadata only', async () => {
  const f = await fixture();
  const replies = await Promise.all(Array.from({ length: 20 }, () => f.daily()));
  await f.flush();
  await f.daily(createStudyTodoMcpApp(f.options));
  assert.equal(f.calls.length, 1);
  assert.ok(replies.every((r) => r.eventId === event.eventId));
  const [url, request] = f.calls[0];
  assert.equal(url, ENV.CLAUDE_ROUTINE_FIRE_URL);
  assert.equal(request.headers.authorization, `Bearer ${ENV.CLAUDE_ROUTINE_API_TOKEN}`);
  assert.equal(request.headers['anthropic-beta'], 'experimental-cc-routine-2026-04-01');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  // 'error' は Workers で送信できない。転送は 'manual' + 3xxを断る形で防ぐ。
  assert.equal(request.redirect, 'manual');
  assert.deepEqual(JSON.parse(request.body), { text: `trigger=daily_3am eventId=${event.eventId} date=${event.date}` });
  const internal = await f.storage.get(dailyEventKey(event.date));
  assert.equal(internal.state, 'triggered');
  assert.equal(internal.providerSessionId, 'session_TEST_ONLY');
  assert.equal(internal.providerSessionUrl, 'https://claude.ai/code/session_TEST_ONLY');
  const status = await call(f.app, `/api/sync/replan?date=${event.date}`, { token: f.device.deviceKey });
  assert.equal(status.body.state, 'triggered');
  const exposed = JSON.stringify([...replies, status.body, internal]);
  assert.ok(!exposed.includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
  assert.ok(!exposed.includes(ENV.CLAUDE_ROUTINE_FIRE_URL));
  assert.ok(!JSON.stringify(status.body).includes('session_TEST_ONLY'));
});

for (const [status, error] of [[400, 'invalid_request'], [401, 'authentication'], [403, 'permission'], [404, 'routine_not_found'],
  [429, 'rate_limit'], [500, 'provider_failure'], [502, 'provider_failure'], [503, 'provider_failure']]) {
  test(`provider ${status}: records and plans survive; no re-fire`, async () => {
    const f = await fixture({ fetchImpl: async () => new Response(ENV.CLAUDE_ROUTINE_API_TOKEN, { status }) });
    await call(f.app, '/api/sync/push', { method: 'POST', token: f.device.deviceKey,
      body: { records: [record('saved')], questions: { questions: QUESTIONS },
        taskPlans: [{ date: event.date, tasks: [{ id: 'task1', questionIds: [QUESTIONS[0].id], kind: 'new' }] }] } });
    const before = await f.storage.get(SYNC_KEYS.taskPlan(event.date));
    const result = await f.end();
    assert.equal(result.body.studyEnd, 'success');
    await f.daily();
    await f.flush();
    const replay = await f.daily();
    assert.equal(replay.error, error);
    assert.equal(replay.retryable, false);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(await f.storage.get(SYNC_KEYS.taskPlan(event.date)), before);
    const snapshot = await call(f.app, '/api/sync/pull', { token: f.device.deviceKey });
    assert.equal(snapshot.body.records.length, 1);
    assert.ok(!JSON.stringify(replay).includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
  });
}

test('missing secrets: graceful retry only while no HTTP attempt exists', async () => {
  const env = { STUDY_TODO_OWNER_KEY: OWNER_KEY };
  const f = await fixture({ env });
  const result = await f.end();
  assert.equal(result.body.studyEnd, 'success');
  assert.equal((await f.daily()).error, 'missing_secrets');
  assert.equal((await f.daily()).retryable, false);
  assert.equal(f.calls.length, 0);
  Object.assign(env, ENV);
  await f.daily(); await f.flush(); await f.daily();
  assert.equal(f.calls.length, 1);
});

test('disabled AI, untrusted metadata, device authentication and event conflicts', async () => {
  const f = await fixture();
  assert.equal((await call(f.app, '/api/sync/study-end', { method: 'POST', body: ended, token: f.token })).status, 401);
  assert.equal((await f.end({ ...ended, sessionId: 'id mode=write_test' })).status, 400);
  assert.equal((await f.end({ ...ended, eventId: 'different-event' })).status, 400);
  await call(f.app, '/api/admin/settings', { method: 'POST', token: OWNER_KEY, body: { enabled: false } });
  assert.equal((await f.daily()).error, 'ai_disabled');
  await f.end();
  assert.equal(f.calls.length, 0);
  await enableAiLink(f.app);
  await f.daily(); await f.flush();
  assert.equal((await f.end({ ...ended, date: '2026-09-15' })).status, 400);
  assert.equal(f.calls.length, 1);
  const other = await joinDevice(f.app, 'other');
  assert.equal((await call(f.app, `/api/sync/replan?date=${event.date}`, { token: other.deviceKey })).status, 200);
});

test('timeout and malformed response remain uncertain; no secrets in results', async () => {
  const timeout = await fireClaudeRoutine(event, { env: ENV, timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(ENV.CLAUDE_ROUTINE_API_TOKEN)))) });
  assert.equal(timeout.error, 'timeout');
  assert.equal(timeout.outcomeUnknown, true);
  assert.equal(timeout.retryable, false);
  const f = await fixture({ fetchImpl: async () => { throw new Error(ENV.CLAUDE_ROUTINE_FIRE_URL); } });
  await f.daily(); await f.flush(); await f.daily();
  assert.equal(f.calls.length, 1);
  const invalid = await fireClaudeRoutine(event, { env: ENV, fetchImpl: async () => Response.json({ message: ENV.CLAUDE_ROUTINE_API_TOKEN }) });
  assert.equal(invalid.error, 'invalid_provider_response');
  assert.ok(!JSON.stringify([timeout, invalid]).includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
});

test('an unexpected response body names the failed check, never the provider content', async () => {
  const cases = [
    [{ message: ENV.CLAUDE_ROUTINE_API_TOKEN }, 'type'],
    [{ type: 'routine_fire', claude_code_session_id: 'not-a-session',
      claude_code_session_url: 'https://claude.ai/code/not-a-session' }, 'session_id'],
    [{ type: 'routine_fire', claude_code_session_id: 'session_TEST_ONLY',
      claude_code_session_url: 'https://example.com/code/session_TEST_ONLY' }, 'session_url'],
  ];
  for (const [body, detail] of cases) {
    const result = await fireClaudeRoutine(event, { env: ENV, fetchImpl: async () => Response.json(body) });
    assert.equal(result.error, 'invalid_provider_response');
    assert.equal(result.detail, detail);
    assert.equal(result.outcomeUnknown, true);
    assert.ok(!JSON.stringify(result).includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
  }
  const broken = await fireClaudeRoutine(event, { env: ENV,
    fetchImpl: async () => new Response(ENV.CLAUDE_ROUTINE_API_TOKEN, { headers: { 'content-type': 'application/json' } }) });
  assert.equal(broken.detail, 'json');
  assert.ok(!JSON.stringify(broken).includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
  // 画面とログへは、この検査項目の名前だけが出る。
  const f = await fixture({ fetchImpl: async () => Response.json({ type: 'wrong' }) });
  const reply = await fire(f);
  assert.equal(reply.body.replan.detail, 'type');
  assert.ok(!JSON.stringify(reply.body).includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
});

test('the provider timeout leaves room for session creation', () => {
  // Fire API はセッションが作られてから返る。短く切ると、起動済みでも結果不明になる。
  assert.ok(PROVIDER_TIMEOUT_MS >= 20000, 'provider timeout must allow for session creation');
});

test('a redirect is refused instead of followed, and never re-sent to the new location', async () => {
  let calls = 0;
  for (const status of [301, 302, 303, 307, 308]) {
    const result = await fireClaudeRoutine(event, { env: ENV, fetchImpl: async (url, init) => {
      calls++;
      assertWorkerdCompatible([url, init]);
      return new Response(null, { status, headers: { location: 'https://example.com/fire' } });
    } });
    assert.equal(result.error, 'provider_redirect');
    assert.equal(result.retryable, false);
    assert.equal(result.outcomeUnknown, undefined);
  }
  assert.equal(calls, 5); // 転送先へは1回も送らない
});

test('a transport failure names the kind of exception only', async () => {
  const result = await fireClaudeRoutine(event, { env: ENV,
    fetchImpl: async () => { throw new TypeError(ENV.CLAUDE_ROUTINE_FIRE_URL); } });
  assert.equal(result.error, 'provider_transport');
  assert.equal(result.detail, 'TypeError');
  assert.equal(result.outcomeUnknown, true);
  assert.ok(!JSON.stringify(result).includes(ENV.CLAUDE_ROUTINE_FIRE_URL));
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
    assert.ok((await storage.get(dailyEventKey(event.date))).attemptedAt);
    storage.transaction = async () => { throw new Error('simulated storage failure'); };
    return providerResponse();
  } });
  await f.daily(); await f.flush();
  storage.transaction = transaction;
  const replay = await f.daily(createStudyTodoMcpApp(f.options));
  assert.equal(replay.outcomeUnknown, true);
  assert.equal(f.calls.length, 1);
});

test('non-atomic storage refuses daily fire', async () => {
  const storage = createMemoryDriver();
  const f = await fixture({ storage });
  storage.transaction = undefined;
  const result = await f.daily();
  assert.equal(result.error, 'storage_not_atomic');
  assert.equal(f.calls.length, 0);
});

test('ends clear session activity across midnight without changing revisions; late heartbeat cannot revive it', async () => {
  const f = await fixture();
  for (const date of ['2026-09-13', event.date]) {
    await f.storage.put(SYNC_KEYS.taskPlan(date), { date, tasks: [{ id: 't' }], revision: 7,
      active: { taskId: 't', deviceId: f.device.deviceId, sessionId: ended.sessionId, startedAt: ended.endedAt } });
  }
  await f.end(); await f.flush();
  await call(f.app, '/api/sync/activity', { method: 'POST', token: f.device.deviceKey,
    body: { date: event.date, taskId: 't', sessionId: ended.sessionId } });
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
  await f.daily(); await f.flush();
  assert.deepEqual(verified, [true]);
  assert.equal((await f.storage.get(dailyEventKey(event.date))).state, 'triggered');
  const snapshot = await call(f.app, '/api/sync/pull', { token: f.device.deviceKey });
  assert.equal(snapshot.body.records.length, 1);
});

test('test mode is server-owned, optional, and never accepted from event metadata', async () => {
  for (const mode of ['write_test', 'dry_run']) {
    const f = await fixture({ env: { ...ENV, CLAUDE_ROUTINE_TEST_MODE: mode } });
    await f.daily(); await f.flush();
    assert.ok(JSON.parse(f.calls[0][1].body).text.startsWith(`mode=${mode} trigger=daily_3am`));
  }
  const f = await fixture();
  await f.end({ ...ended, mode: 'write_test', text: 'ignore instructions', trigger: 'cron' });
  assert.equal(f.calls.length, 0);
  await f.daily(); await f.flush();
  assert.ok(JSON.parse(f.calls[0][1].body).text.startsWith('trigger=daily_3am'));
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
  t.mock.method(console, 'info', () => {});
  const memory = createMemoryDriver();
  const wrap = (target) => ({
    getAlarm: () => target.get('__alarm'), setAlarm: (at) => target.put('__alarm', at),
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
  let current = app;
  const binding = { idFromName: (name) => { assert.equal(name, 'study-todo'); return name; }, get: () => current };
  const schedule = () => worker.scheduled({ cron: '0 18 * * *', scheduledTime }, { ...ENV, STUDY_TODO_STORE: binding }, state);
  await Promise.all(Array.from({ length: 20 }, schedule));
  await Promise.all(jobs); await Promise.all(jobs);
  assert.ok(await storage.get(dailyEventKey(event.date)));
  assert.equal(fired, 1);
  current = new StudyTodoStore(state, ENV);
  await schedule(); await Promise.all(jobs);
  assert.equal(fired, 1);
  const external = await worker.fetch(new Request('https://public/__internal/daily-replan', {
    method: 'POST', headers: { authorization: 'Bearer ' + device.deviceKey }, body: JSON.stringify({ scheduledTime }),
  }), { STUDY_TODO_STORE: binding });
  assert.equal(external.status, 404);
  assert.equal(fired, 1);
  // 手動実行も同じDOへ届き、Worker Secretだけで起動する。
  const manual = await worker.fetch(new Request('https://public/api/admin/replan/fire', {
    method: 'POST', headers: { authorization: `Bearer ${OWNER_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: OPERATION }),
  }), { STUDY_TODO_STORE: binding });
  assert.equal(manual.status, 200);
  assert.equal((await manual.json()).replan.state, 'triggered');
  assert.equal(fired, 2);
  // 端末キーでは管理APIを通れない。
  const asDevice = await worker.fetch(new Request('https://public/api/admin/replan/fire', {
    method: 'POST', headers: { authorization: `Bearer ${device.deviceKey}` }, body: '{}',
  }), { STUDY_TODO_STORE: binding });
  assert.equal(asDevice.status, 401);
  assert.equal(fired, 2);
});

test('DO alarm persists, re-arms for heartbeat, and fires after lease expiry and DO recreation', async (t) => {
  let time = scheduledTime;
  t.mock.method(Date, 'now', () => time);
  const logs = [];
  t.mock.method(console, 'info', (...args) => logs.push(args));
  const memory = createMemoryDriver();
  const wrap = (target) => ({
    getAlarm: () => target.get('__alarm'), setAlarm: (at) => target.put('__alarm', at),
    get: (key) => target.get(key), put: (key, value) => target.put(key, value), delete: (key) => target.delete(key),
    list: async ({ prefix }) => new Map(await Promise.all((await target.list(prefix)).map(async (key) => [key, await target.get(key)]))),
  });
  const storage = { ...wrap(memory), transaction: (fn) => memory.transaction((tx) => fn(wrap(tx))) };
  const jobs = [];
  const state = { storage, blockConcurrencyWhile: (fn) => fn(), waitUntil: (p) => jobs.push(p) };
  let fired = 0;
  t.mock.method(globalThis, 'fetch', async () => { fired++; return providerResponse(); });
  let app = new StudyTodoStore(state, ENV);
  await enableAiLink(app);
  const device = await joinDevice(app);
  await heartbeat({ app, device });
  const schedule = () => app.fetch(new Request('https://internal/__internal/daily-replan', {
    method: 'POST', body: JSON.stringify({ scheduledTime }),
  }));
  assert.equal((await (await schedule()).json()).state, 'deferred');
  const firstAlarm = await storage.getAlarm();
  assert.equal(firstAlarm, time + 15 * 60000 + 1000);
  time += 10 * 60000;
  await heartbeat({ app, device });
  time = firstAlarm;
  await memory.delete('__alarm'); // Cloudflare getAlarm() returns null inside alarm().
  app = new StudyTodoStore(state, ENV);
  await app.alarm();
  assert.equal(fired, 0);
  assert.ok(await storage.getAlarm() > firstAlarm);
  time = await storage.getAlarm();
  await memory.delete('__alarm');
  await app.alarm(); await Promise.all(jobs);
  assert.equal(fired, 1);
  await app.alarm(); await schedule(); await Promise.all(jobs);
  assert.equal(fired, 1);
  assert.equal((await storage.get(dailyEventKey(event.date))).state, 'triggered');
  const exposed = JSON.stringify(logs);
  assert.ok(exposed.includes('deferred') && exposed.includes('triggered'));
  assert.ok(!exposed.includes(ENV.CLAUDE_ROUTINE_FIRE_URL));
  assert.ok(!exposed.includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
  assert.ok(!exposed.includes('session_TEST_ONLY'));
});

test('end receipt survives planning storage failure; notification is acknowledged after commit', async () => {
  const f = await fixture();
  await heartbeat(f); await f.daily();
  const transaction = f.storage.transaction.bind(f.storage);
  let count = 0;
  f.storage.transaction = async (fn) => {
    if (++count === 2) throw new Error('planning failure');
    return transaction(fn);
  };
  const response = await f.end();
  assert.equal(response.status, 200);
  assert.equal(response.body.studyEnd, 'success');
  assert.equal(response.body.replan.error, 'planning_storage');
  assert.equal((await f.storage.get(replanEventKey(ended.sessionId))).state, 'ended');
  f.storage.transaction = transaction;
  await f.app.replans.resumeDeferred(); await f.flush();
  assert.equal(f.calls.length, 1);
});

test('failed receipt persistence returns 503 for PWA retry; malformed provider JSON remains at-most-once', async () => {
  const logs = [];
  const f = await fixture({ onReplan: (summary) => logs.push(summary),
    fetchImpl: async () => new Response(ENV.CLAUDE_ROUTINE_API_TOKEN) });
  const transaction = f.storage.transaction;
  f.storage.transaction = async () => { throw new Error(ENV.CLAUDE_ROUTINE_API_TOKEN); };
  const response = await f.end();
  assert.equal(response.status, 503);
  assert.ok(!JSON.stringify(response).includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
  f.storage.transaction = transaction;
  assert.equal((await f.end()).body.studyEnd, 'success');
  await f.daily(); await f.flush();
  assert.equal((await f.daily()).error, 'invalid_provider_response');
  assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(logs).includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
});

/* ------------------------------------------------------------------ */
/* 手動実行（設定画面の「プランナーを今すぐ実行」）                      */
/* ------------------------------------------------------------------ */

const fire = (f, { token = OWNER_KEY, body = { operationId: OPERATION } } = {}) =>
  call(f.app, '/api/admin/replan/fire', { method: 'POST', token, body });

test('manual fire requires the owner key and POST; no secret reaches the PWA', async () => {
  const f = await fixture();
  const device = await joinDevice(f.app, 'other');
  for (const token of [null, 'wrong-owner-key', f.token, device.deviceKey]) {
    assert.equal((await fire(f, { token })).status, 401);
  }
  // 副作用はPOSTだけ。GETやDELETEでは起動しない。
  for (const method of ['GET', 'DELETE']) {
    assert.equal((await call(f.app, '/api/admin/replan/fire', { method, token: OWNER_KEY })).status, 404);
  }
  assert.equal(f.calls.length, 0);

  const ok = await fire(f);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.replan, { eventId: `manual_replan_${OPERATION}`, trigger: 'manual',
    date: event.date, operationId: OPERATION, state: 'triggered', retryable: false, outcomeUnknown: false });
  assert.equal(f.calls.length, 1);
  const [url, request] = f.calls[0];
  assert.equal(url, ENV.CLAUDE_ROUTINE_FIRE_URL);
  // 03:00の自動実行と同じ経路・同じ本文の形。triggerだけが違う。
  assert.deepEqual(JSON.parse(request.body),
    { text: `trigger=manual eventId=manual_replan_${OPERATION} date=${event.date}` });
  const exposed = JSON.stringify(ok.body);
  assert.ok(!exposed.includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
  assert.ok(!exposed.includes(ENV.CLAUDE_ROUTINE_FIRE_URL));
  assert.ok(!exposed.includes('session_TEST_ONLY'));
  // providerのsession情報はサーバーの中だけに残す。
  assert.equal((await f.storage.get(`studytodo:replan:manual:${OPERATION}`)).providerSessionId, 'session_TEST_ONLY');
});

test('manual fire is refused before POST when AI link, permissions, secrets or config are wrong', async () => {
  for (const [permission, error] of [['read', 'read_permission_required'], ['write', 'write_permission_required']]) {
    // read は管理APIからは切れないので（常に必要）、保存内容を直接壊して確かめる。
    const f = await fixture();
    const settings = await f.storage.get(STORAGE_KEYS.settings);
    settings.permissions[permission] = false;
    await f.storage.put(STORAGE_KEYS.settings, settings);
    const result = await fire(f);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.replan.error, error);
    assert.equal(f.calls.length, 0);
  }
  {
    const f = await fixture();
    await call(f.app, '/api/admin/settings', { method: 'POST', token: OWNER_KEY, body: { enabled: false } });
    const result = await fire(f);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.replan.error, 'ai_disabled');
    assert.equal(f.calls.length, 0);
  }
  const missing = await fixture({ env: { STUDY_TODO_OWNER_KEY: OWNER_KEY } });
  assert.equal((await fire(missing)).body.replan.error, 'missing_secrets');
  assert.equal(missing.calls.length, 0);

  for (const url of ['https://example.com/fire', `${ENV.CLAUDE_ROUTINE_FIRE_URL}?token=x`, 'invalid']) {
    const f = await fixture({ env: { ...ENV, CLAUDE_ROUTINE_FIRE_URL: url } });
    assert.equal((await fire(f)).body.replan.error, 'invalid_configuration');
    assert.equal(f.calls.length, 0);
  }
  const broken = await fixture({ env: { ...ENV, CLAUDE_ROUTINE_TEST_MODE: 'nonsense' } });
  assert.equal((await fire(broken)).body.replan.error, 'invalid_configuration');
  assert.equal(broken.calls.length, 0);

  const notAtomic = await fixture();
  notAtomic.storage.transaction = undefined;
  assert.equal((await fire(notAtomic)).body.replan.error, 'storage_not_atomic');
  assert.equal(notAtomic.calls.length, 0);
});

test('repeated taps and the same operationId issue exactly one POST', async () => {
  const f = await fixture();
  const replies = await Promise.all(Array.from({ length: 20 }, () => fire(f)));
  await f.flush();
  assert.equal(f.calls.length, 1);
  assert.ok(replies.every((reply) => reply.body.replan.eventId === `manual_replan_${OPERATION}`));
  // 別のoperationId（押し直し）は、明示的な新しい実行として通す。
  assert.equal((await fire(f, { body: { operationId: 'second-press-0000' } })).body.replan.state, 'triggered');
  assert.equal(f.calls.length, 2);
  // operationIdを省略すると、サーバーが毎回新しいものを作る。
  const generated = await fire(f, { body: {} });
  assert.match(generated.body.replan.operationId, /^[0-9a-f]{32}$/);
  assert.equal(f.calls.length, 3);
  assert.equal((await fire(f, { body: { operationId: 'short' } })).status, 400);
  assert.equal((await fire(f, { body: { operationId: 'bad id mode=write_test' } })).status, 400);
  assert.equal(f.calls.length, 3);
});

for (const [status, error] of [[401, 'authentication'], [403, 'permission'], [404, 'routine_not_found'],
  [429, 'rate_limit'], [500, 'provider_failure']]) {
  test(`manual fire reports provider ${status} without re-firing`, async () => {
    const f = await fixture({ fetchImpl: async () => new Response(ENV.CLAUDE_ROUTINE_API_TOKEN, { status }) });
    const result = await fire(f);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.replan.error, error);
    assert.equal(result.body.replan.retryable, false);
    // 同じ操作の再送では、結果を返すだけで送り直さない。
    assert.equal((await fire(f)).body.replan.error, error);
    assert.equal(f.calls.length, 1);
    assert.ok(!JSON.stringify(result.body).includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
  });
}

test('manual fire keeps an uncertain outcome and never re-POSTs after a timeout', async (t) => {
  const original = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => original(fn, ms === PROVIDER_TIMEOUT_MS ? 5 : ms, ...args));
  const f = await fixture({ fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('not logged')));
  }) });
  const result = await fire(f);
  assert.equal(result.body.replan.error, 'timeout');
  assert.equal(result.body.replan.outcomeUnknown, true);
  assert.equal((await fire(f)).body.replan.outcomeUnknown, true);
  assert.equal(f.calls.length, 1);
});

test('manual fire is refused while a study session is active, and works once it ends', async () => {
  const f = await fixture();
  await heartbeat(f);
  const refused = await fire(f);
  assert.equal(refused.body.replan.error, 'study_in_progress');
  assert.equal(f.calls.length, 0);
  // 延期はしない。dailyの延期索引にも足さない。
  assert.deepEqual(await f.storage.get(DEFERRED_KEY), null);
  assert.equal((await f.end()).body.studyEnd, 'success');
  assert.equal((await fire(f, { body: { operationId: 'after-the-session' } })).body.replan.state, 'triggered');
  assert.equal(f.calls.length, 1);
});

test('manual fire leaves the daily ledger, its at-most-once state and the next 03:00 cron untouched', async () => {
  const f = await fixture();
  await f.daily(); await f.flush();
  const dailyBefore = await f.storage.get(dailyEventKey(event.date));
  assert.equal(dailyBefore.state, 'triggered');
  assert.equal((await fire(f)).body.replan.state, 'triggered');
  assert.deepEqual(await f.storage.get(dailyEventKey(event.date)), dailyBefore);
  // 手動実行は当日のdailyを作り直さない。翌日のCronはふだんどおり動く。
  await f.daily(); await f.flush();
  assert.equal(f.calls.length, 2);
  const tomorrow = await f.app.replans.daily(scheduledTime + 86400000);
  await f.flush();
  assert.equal(tomorrow.eventId, 'daily_replan_2026-09-16');
  assert.equal(tomorrow.state, 'pending');
  assert.equal(f.calls.length, 3);
});

test('manual fire works when the daily event failed or has not run at all', async () => {
  const failed = await fixture({ fetchImpl: async () => new Response(null, { status: 500 }) });
  await failed.daily(); await failed.flush();
  assert.equal((await failed.storage.get(dailyEventKey(event.date))).error, 'provider_failure');
  // dailyの失敗は手動実行を妨げない。
  const result = await fire(failed);
  assert.equal(result.body.replan.state, 'failed'); // 同じ模擬providerなので500のまま
  assert.equal(failed.calls.length, 2);
  assert.equal((await failed.storage.get(dailyEventKey(event.date))).error, 'provider_failure');

  const fresh = await fixture();
  assert.equal((await fire(fresh)).body.replan.state, 'triggered');
  assert.equal(await fresh.storage.get(dailyEventKey(event.date)), null);
  // 手動実行のあとでも、その日のdailyは通常どおり1回起動できる。
  assert.equal((await fresh.daily()).state, 'pending');
  await fresh.flush();
  assert.equal(fresh.calls.length, 2);
});

test('manual planning date follows the 03:00 JST study day', async () => {
  for (const [at, date] of [['2026-09-14T14:59:59Z', '2026-09-14'], ['2026-09-14T17:59:59Z', '2026-09-14'],
    ['2026-09-14T18:00:00Z', '2026-09-15'], ['2026-12-31T18:00:00Z', '2027-01-01']]) {
    const f = await fixture({ now: () => Date.parse(at) });
    assert.equal((await fire(f)).body.replan.date, date);
  }
});

test('manual fire reports safe telemetry only', async () => {
  const seen = [];
  const f = await fixture({ onReplan: (summary) => seen.push(summary) });
  await fire(f);
  assert.deepEqual(seen.map((entry) => entry.trigger), ['manual']);
  assert.deepEqual(Object.keys(seen[0]).sort(),
    ['date', 'eventId', 'operationId', 'outcomeUnknown', 'retryable', 'state', 'trigger']);
  const logged = JSON.stringify(seen);
  assert.ok(!logged.includes(ENV.CLAUDE_ROUTINE_API_TOKEN));
  assert.ok(!logged.includes(ENV.CLAUDE_ROUTINE_FIRE_URL));
  assert.ok(!logged.includes('session_TEST_ONLY'));
  assert.ok(!logged.includes(OWNER_KEY));
});
