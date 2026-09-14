import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, loadPlaywright } from './server.mjs';
import { OWNER_KEY, call, callTool, enableAiLink, joinDevice } from '../helpers.mjs';

const playwright = await loadPlaywright();
const options = playwright ? {} : { skip: 'Playwright unavailable' };
let browser, server, context, page, ids;
async function until(check) {
  const end = Date.now() + 15000;
  while (!await check()) {
    if (Date.now() > end) throw new Error('condition timeout');
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
before(async () => { if (playwright) browser = await playwright.chromium.launch(); });
after(async () => { await browser?.close(); });
beforeEach(async () => {
  if (!playwright) return;
  server = await startTestServer({ env: { STUDY_TODO_OWNER_KEY: OWNER_KEY } });
  context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await context.newPage();
  await page.clock.install({ time: new Date('2026-09-14T03:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-14T03:00:01Z'));
  await page.goto(server.origin);
  await until(() => page.evaluate(async () => (await (await import('./src/api.js')).listQuestions()).length > 0));
  ids = await page.evaluate(async () => {
    const api = await import('./src/api.js');
    const { loadTasks, refreshToday, render } = await import('./src/state.js');
    const questions = (await api.listQuestions()).filter(q => q.type === '基本例題').slice(0, 2);
    for (const [index, q] of questions.entries()) await api.saveTask({ id: 'task-' + index, date: api.todayKey(), order: index,
      kind: 'new', completed: false, questionIds: [q.id], items: [{ itemId: 'item-' + index, questionId: q.id }] });
    await loadTasks(); await refreshToday(); render();
    return questions.map(q => q.id);
  });
  page.on('dialog', dialog => dialog.accept());
});
afterEach(async () => { await context?.close(); await server?.close(); });

const session = () => page.evaluate(async () => (await import('./src/api.js')).getSessionState());
const records = () => page.evaluate(async () => (await import('./src/api.js')).listRecords());
async function start() { await page.getByRole('button', { name: '学習を開始', exact: true }).click(); }
async function review() {
  await page.getByRole('button', { name: '解答終了・採点を始める', exact: true }).click();
  await page.locator('.eval-btn').first().waitFor({ state: 'visible' });
}
async function evaluate() { await page.locator('.eval-btn').first().click(); await until(async () => (await records()).length > 0); }
const total = () => page.evaluate(async () => (await import('./src/home.js')).dailyElapsed());

test('solve → review with pauses → result → next example, with measured fields synced to MCP', options, async () => {
  const token = await enableAiLink(server.app);
  const device = await joinDevice(server.app);
  await page.evaluate(async ({ origin, device }) => (await import('./src/cloud-sync.js')).saveCloudConfig({
    serverUrl: origin, ...device, enabled: true,
  }), { origin: server.origin, device });
  await start(); await page.clock.fastForward(60000);
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  await page.clock.fastForward(300000);
  assert.equal(await total(), 60);
  await page.getByRole('button', { name: '再開', exact: true }).click();
  await page.clock.fastForward(10000); await review();
  assert.equal((await session()).mode, 'record_input');
  await page.clock.fastForward(20000);
  assert.equal(await page.locator('[data-timer="main"]').textContent(), '00:20');
  await page.getByRole('button', { name: '一時停止', exact: true }).click();
  await page.clock.fastForward(120000);
  await page.getByRole('button', { name: '再開', exact: true }).click();
  await page.clock.fastForward(10000); await evaluate();
  await until(async () => (await session()).currentQuestionId === ids[1]);
  const [record] = await records();
  assert.equal(record.solveSeconds, 70); assert.equal(record.reviewSeconds, 30); assert.equal(record.durationSeconds, 100);
  assert.equal(await total(), 100);
  await page.evaluate(async () => (await import('./src/cloud-sync.js')).syncNow());
  const snapshot = await call(server.app, '/api/sync/pull', { token: device.deviceKey });
  assert.equal(snapshot.body.records[0].reviewSeconds, 30);
  const history = await callTool(server.app, token, 'getStudyHistory', { from: '2026-09-14', to: '2026-09-15' });
  assert.equal(history.records[0].reviewSeconds, 30);
});

test('end during review, wait hours and reload offline: resume same draft and daily total', options, async () => {
  await start(); await page.clock.fastForward(60000); await review(); await page.clock.fastForward(30000);
  const previousId = (await session()).sessionId;
  await page.getByRole('button', { name: '終了', exact: true }).click();
  await until(async () => !(await session()).active);
  assert.equal((await records()).length, 0);
  assert.equal((await session()).resumeMode, 'record_input');
  await page.clock.fastForward(3 * 3600000);
  assert.equal(await total(), 90);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await context.setOffline(true);
  await page.reload();
  await start();
  assert.notEqual((await session()).sessionId, previousId);
  assert.equal((await session()).currentQuestionId, ids[0]);
  assert.equal((await session()).mode, 'record_input');
  await page.clock.fastForward(15000); await evaluate();
  const [record] = await records();
  assert.equal(record.solveSeconds, 60); assert.equal(record.reviewSeconds, 45); assert.equal(await total(), 105);
  await page.getByRole('button', { name: '終了', exact: true }).click();
  await until(async () => !(await session()).active);
  await page.clock.fastForward(3600000); await start();
  assert.equal(await total(), 105);
});

test('home undo cancels one result and time, reopens task, preserves the next running example', options, async () => {
  await start(); await page.clock.fastForward(20000); await review(); await page.clock.fastForward(10000); await evaluate();
  await until(async () => (await session()).currentQuestionId === ids[1]);
  await page.getByRole('button', { name: 'やったこと 1', exact: true }).click();
  await page.getByRole('button', { name: /を未着手に戻す/ }).click();
  await until(async () => (await records()).length === 0);
  assert.equal((await session()).currentQuestionId, ids[1]);
  assert.equal(await total(), 0);
  const tasks = await page.evaluate(async () => (await import('./src/api.js')).getTodayTasks());
  assert.equal(tasks[0].completed, false);
  await page.reload(); assert.equal((await records()).length, 0);
});

test('schedule day detail exposes undo and deletion survives synchronization', options, async () => {
  const device = await joinDevice(server.app);
  await page.evaluate(async ({ origin, device }) => (await import('./src/cloud-sync.js')).saveCloudConfig({ serverUrl: origin, ...device, enabled: true }), { origin: server.origin, device });
  await start(); await page.clock.fastForward(10000); await review(); await evaluate();
  await page.evaluate(async () => (await import('./src/cloud-sync.js')).syncNow());
  await page.getByRole('tab', { name: /スケジュール/ }).click();
  await page.locator('.day-row.is-today').click();
  await page.locator('.detail-item').first().click();
  await page.getByRole('button', { name: '未着手に戻す', exact: true }).click();
  await until(async () => (await records()).length === 0);
  await page.evaluate(async () => (await import('./src/cloud-sync.js')).syncNow());
  assert.equal((await call(server.app, '/api/sync/pull', { token: device.deviceKey })).body.records.length, 0);
  await page.reload(); assert.equal((await records()).length, 0);
});

test('accidental start can be cancelled without creating a result', options, async () => {
  await start(); await page.clock.fastForward(10000);
  await page.getByRole('button', { name: 'この取り組みを取り消す', exact: true }).click();
  assert.equal((await session()).currentQuestionId, null);
  assert.equal((await records()).length, 0); assert.equal(await total(), 0);
});

test('double evaluation tap and competing draft commits save one result; failed undo is atomic', options, async () => {
  await start(); await page.clock.fastForward(10000); await review();
  await page.evaluate(() => { const button = document.querySelector('.eval-btn'); button.click(); button.click(); });
  await until(async () => (await session()).currentQuestionId === ids[1]);
  assert.equal((await records()).length, 1);
  await page.evaluate(async () => {
    const api = await import('./src/api.js');
    const { idb, STORES } = await import('./src/idb.js');
    const [record] = await api.listRecords();
    const before = await api.listOutbox();
    try { await idb.undoAttempt(record.id, () => { throw new Error('simulated undo failure'); }); } catch {}
    if (!(await idb.get(STORES.records, record.id))) throw new Error('failed undo deleted record');
    if (JSON.stringify(before) !== JSON.stringify(await api.listOutbox())) throw new Error('failed undo changed outbox');
  });
  await review();
  const result = await page.evaluate(async () => {
    const api = await import('./src/api.js');
    const expected = await api.getSessionState();
    const next = { ...expected, currentQuestionId: null, mode: 'task_list' };
    const input = { questionId: expected.currentQuestionId, evaluation: 'perfect', durationSeconds: 0 };
    return Promise.all([api.completeStudyAttempt(input, expected, next), api.completeStudyAttempt(input, expected, next)]);
  });
  assert.equal(result.filter(r => r.saved).length, 1);
  assert.equal((await records()).length, 2);
});

test('review continues on the next JST day; completed time stays on the day it was measured', options, async () => {
  await start(); await page.clock.fastForward(60000); await review(); await page.clock.fastForward(30000);
  await page.getByRole('button', { name: '終了', exact: true }).click();
  await until(async () => !(await session()).active);
  await page.clock.fastForward(86400000);
  await start();
  assert.equal((await session()).mode, 'record_input');
  await page.clock.fastForward(20000); await evaluate();
  const [record] = await records();
  assert.equal(record.durationSeconds, 110);
  assert.deepEqual(record.studySecondsByDate, { '2026-09-14': 90, '2026-09-15': 20 });
  const days = await page.evaluate(async () => {
    const api = await import('./src/api.js');
    return Promise.all(['2026-09-14', '2026-09-15'].map(date => api.getTodayStats(date)));
  });
  assert.deepEqual(days.map(d => d.seconds), [90, 20]);
  assert.equal(await total(), 20);
});

test('ending during solve resumes solve without a result or the stopped hours', options, async () => {
  await start(); await page.clock.fastForward(20000);
  await page.getByRole('button', { name: '終了', exact: true }).click();
  await until(async () => !(await session()).active);
  await page.clock.fastForward(3600000); await page.reload(); await start();
  assert.equal((await session()).mode, 'task_list');
  assert.equal((await session()).currentQuestionId, ids[0]);
  assert.equal(await total(), 20); assert.equal((await records()).length, 0);
});

test('example row starts study directly and tapping it again begins review', options, async () => {
  await page.locator('#screen-home .list .row-main').first().click();
  await until(async () => (await session()).active);
  assert.equal((await session()).currentQuestionId, ids[0]);
  await page.clock.fastForward(10000);
  await page.locator('#screen-home .row.active').click();
  await page.locator('.eval-btn').first().waitFor({ state: 'visible' });
  assert.equal((await session()).questionTiming[ids[0]].phase, 'review');
  const bounds = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(bounds.scroll <= bounds.width, 'mobile UI must not overflow horizontally');
});
