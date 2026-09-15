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
async function waitForEnd() {
  await until(async () => await page.evaluate(async () => {
    const { idb, STORES } = await import('./src/idb.js');
    return (await idb.get(STORES.meta, 'lastSessionEnd'))?.value?.state === 'acknowledged' && !(await (await import('./src/api.js')).listOutbox()).some(e => e.type === 'session_end');
  }));
}
async function daily() { return server.app.replans.daily(Date.now()); }
async function defer() {
  await until(async () => Object.values((await server.storage.get('studytodo:devices'))?.devices ?? {}).some(d => d.activeSession));
  assert.equal((await daily()).state, 'deferred');
  assert.equal(calls.length, 0);
}
async function waitForDispatch() {
  await until(async () => calls.length > 0 && await page.evaluate(async () => {
    const api = await import('./src/api.js');
    return !(await api.listOutbox()).some((e) => e.type === 'session_end');
  }));
  await server.flushJobs();
}

test('PWA double-tap end saves without fire; daily fires once, and schedule refresh loads real MCP changes', options, async () => {
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
  await end(); await waitForEnd();
  assert.equal(calls.length, 0);
  await daily(); await waitForDispatch();
  assert.equal(calls.length, 1);
  assert.deepEqual(recordsAtFire, [1]);
  assert.ok(calls[0].text.includes('trigger=daily_3am eventId=daily_replan_'));
  assert.ok(!calls[0].text.includes(sessionId));
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
  const event = await page.evaluate(async () => (await (await import('./src/api.js')).listOutbox()).find((e) => e.type === 'session_end'));
  assert.equal(event.event.sessionId, sessionId);
  assert.equal(event.event.eventId, undefined);
  assert.equal(calls.length, 0);
  await context.setOffline(false);
  await page.reload();
  await waitForEnd();
  assert.equal(calls.length, 0);
  assert.equal((await call(server.app, '/api/sync/pull', { token: device.deviceKey })).body.records.length, 1);
});

test('PWA first-sync overflow: all 405 records arrive before fire', options, async () => {
  await addRecords(405);
  await start(); await defer(); await end(); await waitForDispatch();
  assert.equal(calls.length, 1);
  assert.deepEqual(recordsAtFire, [405]);
});

test('PWA provider failure preserves end and records, and replay does not fire again', options, async () => {
  provider = async () => new Response('temporary', { status: 503 });
  await addRecords();
  await start(); await defer();
  await end(); await waitForDispatch();
  const status = await page.evaluate(async () => (await import('./src/cloud-sync.js')).getReplanStatus());
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
  await addRecords(); await start(); await defer(); await end();
  try {
    await until(() => page.evaluate(async () => {
      const { idb, STORES } = await import('./src/idb.js');
      return (await idb.get(STORES.meta, 'lastSessionEnd'))?.value?.state === 'acknowledged';
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
    const events = (await api.listOutbox()).filter((e) => e.type === 'session_end');
    if (events.length !== 1) throw new Error('duplicate event');
  });
});

test('evaluation write finishes before end, and an already-running sync cannot fire from stale data', options, async () => {
  await start(); await defer();
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
    const commitAttempt = idb.commitAttempt;
    const recordGate = new Promise((resolve) => { window.releaseRecordForTest = resolve; });
    idb.commitAttempt = async (...args) => {
      await recordGate;
      return commitAttempt(...args);
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

test('three separate PWA sessions, startup, sync and schedule navigation do not fire Claude', options, async () => {
  for (let i = 0; i < 3; i++) {
    await start(); await addRecords(); await end(); await waitForEnd();
    await page.evaluate(async () => (await import('./src/cloud-sync.js')).syncNow());
    assert.equal(calls.length, 0);
  }
  await page.getByRole('tab', { name: /スケジュール/ }).click();
  await page.reload();
  await page.evaluate(async () => (await import('./src/cloud-sync.js')).syncNow());
  assert.equal(calls.length, 0);
  assert.equal((await call(server.app, '/api/sync/pull', { token: device.deviceKey })).body.records.length, 3);
});

test('PR #5 offline replan outbox upgrades to an end receipt without automatic fire', options, async () => {
  await page.evaluate(async () => {
    const { idb, STORES } = await import('./src/idb.js');
    const api = await import('./src/api.js');
    const sessionId = 'legacy-ended-session';
    await idb.put(STORES.outbox, { key: `replan:study_end_${sessionId}`, type: 'replan', id: sessionId,
      event: { sessionId, eventId: `study_end_${sessionId}`, date: api.todayKey(), endedAt: new Date().toISOString() } });
    await (await import('./src/cloud-sync.js')).syncNow();
  });
  await waitForEnd();
  assert.equal(calls.length, 0);
  assert.equal(await page.evaluate(async () => (await (await import('./src/api.js')).listOutbox()).filter(e => e.type === 'replan').length), 0);
});

test('offline end retains deferred daily until records and end notification reach server', options, async () => {
  await start(); await defer();
  await context.setOffline(true);
  await addRecords(); await end();
  assert.equal(calls.length, 0);
  await context.setOffline(false);
  await page.reload(); await waitForDispatch(); await waitForEnd();
  assert.equal(calls.length, 1);
  assert.deepEqual(recordsAtFire, [1]);
});

test('paused session heartbeat remains active without a running question timer', options, async () => {
  const id = await start();
  await page.evaluate(async () => {
    const { state } = await import('./src/state.js');
    state.session.currentStartedAt = null;
    state.session.sessionStartedAt = null;
    await (await import('./src/api.js')).setSessionState(state.session);
    (await import('./src/home.js')).heartbeatActivity();
  });
  await defer();
  const index = await server.storage.get('studytodo:devices');
  assert.equal(index.devices[device.deviceId].activeSession.sessionId, id);
  await end(); await waitForDispatch();
  assert.equal(calls.length, 1);
});

// 画面に出ているだけでなく、ボタンのそばで実際に見えているかを確かめる。
// カード上端に出すと、ボタンまでスクロールした画面からは見えない。
async function plannerMessageInView(text) {
  return page.evaluate((expected) => {
    const node = [...document.querySelectorAll('*')]
      .find((n) => !n.children.length && n.textContent.trim() === expected);
    if (!node) return { found: false };
    const box = node.getBoundingClientRect();
    return { found: true, inView: box.bottom > 0 && box.top < innerHeight };
  }, text);
}

async function openSettingsWithOwnerKey() {
  await page.evaluate(async ({ origin, key }) => {
    const cloud = await import('./src/cloud-sync.js');
    await cloud.saveCloudConfig({ serverUrl: origin, ownerKey: key });
  }, { origin: server.origin, key: OWNER_KEY });
  await page.getByRole('tab', { name: /設定/ }).click();
  await page.getByText('AI連携 / 同期', { exact: true }).click();
  await page.getByRole('button', { name: 'プランナーを今すぐ実行' }).waitFor();
}

test('PWA settings button fires the planner once through the Worker and shows the result', options, async () => {
  await openSettingsWithOwnerKey();
  provider = async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return Response.json({ type: 'routine_fire', claude_code_session_id: 'session_E2E',
      claude_code_session_url: 'https://claude.ai/code/session_E2E' });
  };
  await page.getByRole('button', { name: 'プランナーを今すぐ実行' }).click();
  // 押した瞬間から表示が変わってdisabledになり、応答が返るまで押し直せない。
  const busy = page.getByRole('button', { name: 'プランナーを起動中…' });
  await busy.waitFor();
  assert.equal(await busy.isDisabled(), true);
  await until(async () => (await plannerMessageInView('プランナーを起動しました。')).found);
  assert.deepEqual(await plannerMessageInView('プランナーを起動しました。'), { found: true, inView: true });
  // 同期などで描き直されても、結果は消えない。
  await page.evaluate(async () => (await import('./src/cloud-sync.js')).syncNow({ force: true }));
  await until(async () => (await plannerMessageInView('プランナーを起動しました。')).inView);
  await server.flushJobs();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].text.startsWith('trigger=manual eventId=manual_replan_'));
  // 秘密（Fire URL / APIトークン / providerのsession）は画面へ渡らない。
  const shown = await page.evaluate(() => document.body.innerText);
  for (const secret of ['routine-E2E-ONLY', 'api.anthropic.com', 'trig_E2E_ONLY', 'session_E2E']) {
    assert.ok(!shown.includes(secret), `settings screen must not show ${secret}`);
  }
  // 03:00のdailyは手動実行のあとも通常どおり動く。
  assert.equal((await daily()).state, 'pending');
  await server.flushJobs();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].text.startsWith('trigger=daily_3am eventId=daily_replan_'));
});

test('PWA shows a human-readable reason when the planner cannot start', options, async () => {
  await call(server.app, '/api/admin/settings', { method: 'POST', token: OWNER_KEY, body: { permissions: { write: false } } });
  await openSettingsWithOwnerKey();
  await page.getByRole('button', { name: 'プランナーを今すぐ実行' }).click();
  const denied = 'プランナーを起動できませんでした：AI連携の「予定を変更する」権限を許可してください';
  await until(async () => (await plannerMessageInView(denied)).found);
  assert.deepEqual(await plannerMessageInView(denied), { found: true, inView: true });
  assert.equal(calls.length, 0);
  // 権限を戻すと、同じボタンから起動できる。
  await call(server.app, '/api/admin/settings', { method: 'POST', token: OWNER_KEY, body: { permissions: { write: true } } });
  await page.getByRole('button', { name: 'プランナーを今すぐ実行' }).click();
  await until(async () => (await plannerMessageInView('プランナーを起動しました。')).found);
  // 前の失敗の表示は残らない。
  assert.equal((await plannerMessageInView(denied)).found, false);
  assert.equal(calls.length, 1);
});
