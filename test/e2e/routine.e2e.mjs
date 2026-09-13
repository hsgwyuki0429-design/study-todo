import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, loadPlaywright } from './server.mjs';
import { OWNER_KEY, call, callTool, enableAiLink, joinDevice } from '../helpers.mjs';

const playwright = await loadPlaywright();
const options = playwright ? {} : { skip: 'Playwright is unavailable' };
let browser, server, context, page, device, token, calls, provider, recordsAtFire;
async function until(check) {
  const deadline = Date.now() + 15000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error('condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
before(async () => { if (playwright) browser = await playwright.chromium.launch(); });
after(async () => { await browser?.close(); });
beforeEach(async () => {
  if (!playwright) return;
  calls = []; recordsAtFire = [];
  provider = async () => Response.json({ type: 'routine_fire', claude_code_session_id: 'session_E2E',
    claude_code_session_url: 'https://claude.ai/code/session_E2E' });
  server = await startTestServer({ env: {
    STUDY_TODO_OWNER_KEY: OWNER_KEY,
    CLAUDE_ROUTINE_FIRE_URL: 'https://api.anthropic.com/v1/claude_code/routines/trig_E2E_ONLY/fire',
    CLAUDE_ROUTINE_API_TOKEN: 'routine-E2E-ONLY',
  }, routineFetch: async (_url, request) => {
    calls.push(JSON.parse(request.body));
    const snapshot = await call(server.app, '/api/sync/pull', { token: device.deviceKey });
    recordsAtFire.push(snapshot.body.records.length);
    return provider();
  } });
  token = await enableAiLink(server.app);
  device = await joinDevice(server.app);
  assert.ok(token && device.deviceKey, 'test backend must be linked before exercising fire');
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await context.newPage();
  await page.goto(server.origin);
  await until(() => page.evaluate(async () => {
    const api = await import('./src/api.js');
    return document.querySelector('.tabbar button') && (await api.listQuestions()).length > 0;
  }));
  await page.evaluate(async ({ origin, device }) => {
    const cloud = await import('./src/cloud-sync.js');
    await cloud.saveCloudConfig({ serverUrl: origin, deviceKey: device.deviceKey, deviceId: device.deviceId, enabled: true });
  }, { origin: server.origin, device });
});
afterEach(async () => { await context?.close(); await server?.close(); });

async function addRecords(count = 1) {
  return page.evaluate(async (count) => {
    const api = await import('./src/api.js');
    const [q] = await api.listQuestions();
    for (let i = 0; i < count; i++) await api.addStudyRecord({ questionId: q.id, evaluation: 'wrong_approach', durationSeconds: 180 });
    return q.id;
  }, count);
}
async function start() {
  await page.getByRole('button', { name: '学習を開始', exact: true }).click();
  return page.evaluate(async () => (await (await import('./src/api.js')).getSessionState()).sessionId);
}
async function end() {
  // Simultaneous handlers model a double tap before IndexedDB completes.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent === '終了');
    button.click(); button.click();
  });
  await until(() => page.evaluate(async () => !(await (await import('./src/api.js')).getSessionState()).active));
}
async function waitForDispatch() {
  await until(async () => calls.length > 0 && await page.evaluate(async () => {
    const api = await import('./src/api.js');
    return !(await api.listOutbox()).some((e) => e.type === 'replan');
  }));
  await server.flushJobs();
}

test('PWA double-tap end saves session, fires once, and schedule refresh loads real MCP changes', options, async () => {
  const questionId = await addRecords();
  provider = async () => {
    const date = await page.evaluate(async () => (await import('./src/api.js')).todayKey());
    const current = await callTool(server.app, token, 'getTodayTasks', { date });
    const args = { operationId: 'e2e-routine-plan', expectedRevisions: [{ date, revision: current.revision }],
      changes: [{ op: 'add', date, task: { title: 'Routine review E2E', questionIds: [questionId], kind: 'review' } }] };
    assert.equal((await callTool(server.app, token, 'validatePlanChanges', args)).ok, true);
    assert.equal((await callTool(server.app, token, 'applyTaskChanges', args)).ok, true);
    return Response.json({ type: 'routine_fire', claude_code_session_id: 'session_E2E', claude_code_session_url: 'https://claude.ai/code/session_E2E' });
  };
  const sessionId = await start();
  await end(); await waitForDispatch();
  assert.equal(calls.length, 1);
  assert.deepEqual(recordsAtFire, [1]);
  assert.ok(calls[0].text.includes(`eventId=study_end_${sessionId}`));
  await page.getByRole('tab', { name: /スケジュール/ }).click();
  await until(() => page.evaluate(async () => (await (await import('./src/api.js')).getTodayTasks()).some((t) => t.title === 'Routine review E2E')));
  await page.reload();
  assert.equal((await page.evaluate(async () => (await (await import('./src/api.js')).listRecords()).length)), 1);
  assert.equal(calls.length, 1);
});

test('PWA offline end persists event and replays after reload/online', options, async () => {
  await addRecords();
  const sessionId = await start();
  await context.setOffline(true);
  await end();
  const event = await page.evaluate(async () => (await (await import('./src/api.js')).listOutbox()).find((e) => e.type === 'replan'));
  assert.equal(event.event.eventId, `study_end_${sessionId}`);
  assert.equal(calls.length, 0);
  await context.setOffline(false);
  await page.reload();
  await waitForDispatch();
  assert.equal(calls.length, 1);
  assert.deepEqual(recordsAtFire, [1]);
});

test('PWA first-sync overflow: all 405 records arrive before fire', options, async () => {
  await addRecords(405);
  await start(); await end(); await waitForDispatch();
  assert.equal(calls.length, 1);
  assert.deepEqual(recordsAtFire, [405]);
});

test('PWA provider failure preserves end and records, and replay does not fire again', options, async () => {
  provider = async () => new Response('temporary', { status: 503 });
  await addRecords();
  const sessionId = await start();
  await end(); await waitForDispatch();
  const status = await page.evaluate(async (id) => (await import('./src/cloud-sync.js')).getReplanStatus(id), sessionId);
  assert.equal(status.state, 'failed');
  assert.equal(status.error, 'provider_failure');
  await page.reload();
  await page.evaluate(async () => (await import('./src/cloud-sync.js')).syncNow());
  assert.equal(calls.length, 1);
  assert.equal((await page.evaluate(async () => (await (await import('./src/api.js')).listRecords()).length)), 1);
});

test('PWA UI and backend receipt do not await provider completion', options, async () => {
  let release;
  provider = () => new Promise((resolve) => { release = resolve; });
  await addRecords(); await start(); await end();
  try {
    await until(() => page.evaluate(async () => {
      const { idb, STORES } = await import('./src/idb.js');
      return (await idb.get(STORES.meta, 'lastReplan'))?.value?.state === 'pending';
    }));
    assert.equal(await page.getByRole('button', { name: '学習を開始', exact: true }).count(), 1);
    assert.equal(calls.length, 1);
  } finally {
    release?.(Response.json({ type: 'routine_fire', claude_code_session_id: 'session_E2E', claude_code_session_url: 'https://claude.ai/code/session_E2E' }));
    await server.flushJobs();
  }
});

test('legacy session upgrade and cross-tab atomic end produce one event', options, async () => {
  await page.evaluate(async () => {
    const api = await import('./src/api.js');
    await api.setSessionState({ ...api.EMPTY_SESSION, active: true, sessionId: null });
    const sessions = await Promise.all([api.getSessionState(), api.getSessionState()]);
    if (sessions[0].sessionId !== sessions[1].sessionId) throw new Error('unstable legacy session');
    const results = await Promise.all(sessions.map((s) => api.finishStudySession(s.sessionId)));
    if (results.filter((r) => r.ended).length !== 1) throw new Error('duplicate end');
    const events = (await api.listOutbox()).filter((e) => e.type === 'replan');
    if (events.length !== 1) throw new Error('duplicate event');
  });
});

test('evaluation write finishes before end, and an already-running sync cannot fire from stale data', options, async () => {
  await start();
  let releasePush;
  let intercepted = false;
  const gate = new Promise((resolve) => { releasePush = resolve; });
  await page.route('**/api/sync/push', async (route) => {
    if (!intercepted) { intercepted = true; await gate; }
    await route.continue();
  });
  await page.evaluate(async () => (await import('./src/cloud-sync.js')).syncInBackground());
  await until(() => intercepted);
  await page.evaluate(async () => {
    const api = await import('./src/api.js');
    const { idb, STORES } = await import('./src/idb.js');
    const { state, render } = await import('./src/state.js');
    const [q] = await api.listQuestions();
    state.session.currentQuestionId = q.id;
    state.session.currentStartedAt = null;
    state.session.questionElapsed[q.id] = 180;
    state.session.mode = 'record_input';
    await api.setSessionState(state.session);
    const put = idb.put;
    const recordGate = new Promise((resolve) => { window.releaseRecordForTest = resolve; });
    idb.put = async (store, value) => {
      if (store === STORES.records) await recordGate;
      return put(store, value);
    };
    render();
    document.querySelector('.eval-btn:last-child').click();
    [...document.querySelectorAll('button')].find((b) => b.textContent === '終了').click();
  });
  try {
    assert.equal(await page.evaluate(async () => (await (await import('./src/api.js')).getSessionState()).active), true);
    assert.equal(calls.length, 0);
    await page.evaluate(() => window.releaseRecordForTest());
    await until(() => page.evaluate(async () => !(await (await import('./src/api.js')).getSessionState()).active));
    assert.equal(calls.length, 0);
  } finally { releasePush(); }
  await waitForDispatch();
  assert.equal(calls.length, 1);
  assert.deepEqual(recordsAtFire, [1]);
  const records = await page.evaluate(async () => (await (await import('./src/api.js')).listRecords()));
  assert.equal(records[0].evaluation, 'wrong_approach');
  assert.equal(records[0].durationSeconds, 180);
});

test('outbox acknowledgment preserves a newer queued edit', options, async () => {
  await page.evaluate(async () => {
    const { idb, STORES } = await import('./src/idb.js');
    const old = { key: 'record:test', type: 'record', id: 'test', version: 'old' };
    const next = { ...old, version: 'new' };
    await idb.put(STORES.outbox, next);
    await idb.acknowledgeOutbox([old]);
    if ((await idb.get(STORES.outbox, old.key))?.version !== 'new') throw new Error('new edit was lost');
    await idb.acknowledgeOutbox([next]);
    if (await idb.get(STORES.outbox, old.key)) throw new Error('acknowledged edit remains');
  });
});
