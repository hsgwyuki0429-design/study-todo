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
// 「学習開始」ボタンは廃止し、続いているか止まっているかを表すスライダー
// （やること／やったこと と同じ仕組み）で代わりに始める・再開する。
async function start() { await page.getByRole('button', { name: '▶', exact: true }).click(); }
async function pause() { await page.getByRole('button', { name: '⏹', exact: true }).click(); }
async function review() {
  // 解いている行（色が変わっている行）をもう一度押すと採点へ進む。
  await page.locator('#screen-home .row.active, #screen-home .row.current').first().click();
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
  await pause();
  await page.clock.fastForward(300000);
  assert.equal(await total(), 60);
  await start();
  await page.clock.fastForward(10000); await review();
  assert.equal((await session()).mode, 'record_input');
  await page.clock.fastForward(20000);
  assert.equal(await page.locator('[data-timer="main"]').textContent(), '00:20');
  await pause();
  await page.clock.fastForward(120000);
  await start();
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

test('home undo (やったこと) survives synchronization', options, async () => {
  // スケジュールの日別詳細は「やること」しか出さないので、記録の取り消しは
  // ホームの「やったこと」タブから行う。取り消しが同期にもきちんと伝わることを確認する。
  const device = await joinDevice(server.app);
  await page.evaluate(async ({ origin, device }) => (await import('./src/cloud-sync.js')).saveCloudConfig({ serverUrl: origin, ...device, enabled: true }), { origin: server.origin, device });
  await start(); await page.clock.fastForward(10000); await review(); await evaluate();
  await page.evaluate(async () => (await import('./src/cloud-sync.js')).syncNow());
  await page.getByRole('button', { name: /終了/, exact: true }).click();
  await until(async () => !(await session()).active);
  await page.getByRole('button', { name: /やったこと/ }).click();
  await page.getByRole('button', { name: /を未着手に戻す/ }).click();
  await until(async () => (await records()).length === 0);
  await page.evaluate(async () => (await import('./src/cloud-sync.js')).syncNow());
  assert.equal((await call(server.app, '/api/sync/pull', { token: device.deviceKey })).body.records.length, 0);
  await page.reload(); assert.equal((await records()).length, 0);
});

test('schedule day detail shows only the remaining plan, with a working carry-over', options, async () => {
  // 例題2つのタスクだけ残し、その一方だけ今日のうちに解いて記録する。
  await start(); await page.clock.fastForward(10000); await review(); await evaluate();
  await page.getByRole('tab', { name: /スケジュール/ }).click();
  await page.locator('.day-row.is-today').click();
  // 済んだ記録の見出し（実施した問題／チャレンジ）は出ず、「残っている予定」だけが出る。
  await page.getByText(/残っている予定/).waitFor();
  assert.equal(await page.getByText(/実施した問題/).count(), 0);
  assert.equal(await page.locator('.detail-item').count(), 1); // ids[1] の1件だけが残っている
  await page.getByRole('button', { name: '繰り越す', exact: true }).click();
  await page.getByRole('button', { name: '理由は未入力', exact: true }).click();
  await until(async () => (await page.locator('.detail-item').count()) === 0);
});

test('the play slider stops and restarts the timer, and the digits turn red while stopped', options, async () => {
  await start(); await page.clock.fastForward(10000);
  await pause();
  await page.locator('.timer-value.danger').waitFor({ state: 'visible' });
  await page.clock.fastForward(60000);
  assert.equal(await total(), 10);
  await start();
  await page.locator('.timer-value.danger').waitFor({ state: 'detached' });
  await page.clock.fastForward(5000);
  assert.equal(await total(), 15);
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

test('accidentally starting review can be undone with the back button, resuming solve', options, async () => {
  await start(); await page.clock.fastForward(20000); await review();
  assert.equal((await session()).mode, 'record_input');
  await page.clock.fastForward(15000);
  await page.getByRole('button', { name: '戻る', exact: true }).click();
  assert.equal((await session()).mode, 'task_list');
  assert.equal((await session()).questionTiming[ids[0]].phase, 'solve');
  await page.clock.fastForward(5000);
  await page.getByRole('button', { name: '終了', exact: true }).click();
  await until(async () => !(await session()).active);
  assert.equal((await records()).length, 0);
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

test('daily total keeps post-midnight study in the prior label and resets at 03:00 JST', options, async () => {
  // Setup is 12:00:01 JST on Sep 14. Move close to Sep 15 03:00 without changing timers manually.
  await page.clock.fastForward(14 * 3600000 + 59 * 60000 + 49 * 1000);
  const beforeBoundary = await page.evaluate(async () => {
    const api = await import('./src/api.js');
    return { day: api.todayKey(), todoCount: (await api.getTodayTasks()).length };
  });
  assert.deepEqual(beforeBoundary, { day: '2026-09-14', todoCount: 2 });
  await start();
  await page.clock.fastForward(20000); // 10 seconds before and 10 seconds after 03:00.
  const values = await page.evaluate(async () => {
    const api = await import('./src/api.js');
    const home = await import('./src/home.js');
    const session = await api.getSessionState();
    return {
      day: api.studyDayKey(),
      todoCount: (await api.getTodayTasks()).length,
      current: home.dailyElapsed(),
      prior: (await api.getTodayStats('2026-09-14')).seconds,
      next: (await api.getTodayStats('2026-09-15')).seconds,
      draft: session.questionTiming[session.currentQuestionId].byDate,
    };
  });
  assert.equal(values.day, '2026-09-15');
  assert.equal(values.todoCount, 0);
  assert.equal(values.current, 10);
  assert.deepEqual(values.draft, {}); // running time is included from the live timestamp until checkpoint.
  assert.equal(values.prior, 0); assert.equal(values.next, 0);
  await pause();
  const checkpointed = await session();
  assert.deepEqual(checkpointed.questionTiming[ids[0]].byDate, { '2026-09-14': 10, '2026-09-15': 10 });
  assert.equal(await total(), 10);
});

test('finished sub-items of a multi-question task drop out of the idle "やること" list', options, async () => {
  const [qA, qB] = await page.evaluate(async () => {
    const api = await import('./src/api.js');
    const { loadTasks, refreshToday, render } = await import('./src/state.js');
    const questions = (await api.listQuestions()).filter((q) => q.type === '基本例題').slice(2, 4);
    await api.saveTask({
      id: 'task-multi', date: api.todayKey(), order: 2, kind: 'new', completed: false,
      questionIds: questions.map((q) => q.id),
      items: questions.map((q, i) => ({ itemId: 'multi-' + i, questionId: q.id })),
    });
    await loadTasks(); await refreshToday(); render();
    return questions.map((q) => q.id);
  });
  const labelOf = (qid) => page.evaluate(async (qid) => (await import('./src/state.js')).qLabel(qid), qid);
  const [labelA, labelB] = [await labelOf(qA), await labelOf(qB)];

  await start(); // 未着手のタスク（idsの1問目）から始まる
  // task-multi の最初の未着手問題（qA）を直接タップして解答・記録する。
  await page.getByText(new RegExp(labelA)).first().click();
  await until(async () => (await session()).currentQuestionId === qA);
  await page.clock.fastForward(10000); await review(); await evaluate();
  await page.getByRole('button', { name: '終了', exact: true }).click();
  await until(async () => !(await session()).active);

  const todo = page.locator('#screen-home .list .row-title');
  await until(async () => (await todo.allTextContents()).length > 0);
  const titles = await todo.allTextContents();
  assert.ok(!titles.some((t) => t.includes(labelA)), `${labelA} should have moved to やったこと`);
  assert.ok(titles.some((t) => t.includes(labelB)), `${labelB} should remain in やること`);
});

test('やること／やったこと の切り替えバーは指の動きにつれて滑る', options, async () => {
  const drag = (points) => page.evaluate((points) => {
    const bar = document.querySelector('#screen-home .panel .segmented');
    const rect = bar.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const fire = (type, x) => {
      const touch = new Touch({ identifier: 1, target: bar, clientX: x, clientY: y });
      bar.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [touch], changedTouches: [touch], bubbles: true, cancelable: true }));
    };
    points.forEach(([type, ratio]) => fire(type, rect.left + rect.width * ratio));
  }, points);

  const thumbX = () => page.locator('#screen-home .panel .segmented-thumb').first().evaluate((el) => el.getBoundingClientRect().x);
  const startX = await thumbX();

  // 途中まで動かした時点で、指の位置に応じて中間の位置まで動いている（両端に固定されない）。
  await drag([['touchstart', 0.25], ['touchmove', 0.55]]);
  await page.waitForTimeout(50);
  const midX = await thumbX();
  assert.ok(midX > startX, 'thumb should have moved partway toward the finger');

  // 大きく動かしてから離すと、その側のタブへ切り替わる。
  await drag([['touchend', 0.9]]);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /やったこと/, exact: false }).waitFor();
  assert.equal(
    await page.locator('#screen-home .panel .segmented button[aria-selected="true"]').textContent(),
    'やったこと 0',
  );
});

test('下のタブバーは指を離さずドラッグしただけで、その上に来たタブへ切り替わる', options, async () => {
  const homeBox = await page.locator('.tabbar button[data-tab="home"]').boundingBox();
  const scheduleBox = await page.locator('.tabbar button[data-tab="schedule"]').boundingBox();
  const fire = (type, box) => page.evaluate(({ type, x, y }) => {
    const bar = document.querySelector('.tabbar');
    const touch = new Touch({ identifier: 1, target: bar, clientX: x, clientY: y });
    bar.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [touch], changedTouches: [touch], bubbles: true, cancelable: true }));
  }, { type, x: box.x + box.width / 2, y: box.y + box.height / 2 });

  await fire('touchstart', homeBox);
  await fire('touchmove', scheduleBox);
  await page.waitForTimeout(100);
  // touchend していない時点で、すでにスケジュールへ切り替わっている。
  assert.equal(
    await page.evaluate(() => document.querySelector('.tabbar button[aria-selected="true"]').dataset.tab),
    'schedule',
  );
  assert.equal(await page.evaluate(() => document.querySelector('#screen-schedule').hidden), false);
  await fire('touchend', scheduleBox);
});

test('タップで切り替えても、やること／やったこと の光は前の位置を経由してから今の位置へ動く', options, async () => {
  await page.locator('#screen-home .panel .segmented').first().waitFor();
  const thumbX = () => page.locator('#screen-home .panel .segmented-thumb').first().evaluate((el) => el.getBoundingClientRect().x);
  const startX = await thumbX();
  // ドラッグではなくタップでも、瞬間移動ではなく「前の位置→今の位置」の
  // 2段階でスタイルが当たっていることを、実際のCSSトランジションの経過時間
  // に頼らず（疑似クロック環境でも安定するよう）スタイル変更の履歴で確かめる。
  await page.evaluate(() => {
    window.__thumbTransforms = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.target.classList.contains('segmented-thumb')) window.__thumbTransforms.push(r.target.style.transform);
      }
    });
    observer.observe(document.querySelector('#screen-home'), { attributes: true, attributeFilter: ['style'], subtree: true });
    window.__thumbObserver = observer;
  });
  await page.getByRole('button', { name: /やったこと/ }).click();
  // 入れ子の requestAnimationFrame は、疑似クロックでは1回の fastForward では
  // 両方まとめて発火しないことがあるため、少しずつ複数回進める。
  for (let i = 0; i < 5; i++) await page.clock.fastForward(50);
  await page.waitForTimeout(250); // CSSトランジション自体は実時間で進む
  await page.evaluate(() => window.__thumbObserver.disconnect());
  const transforms = await page.evaluate(() => window.__thumbTransforms);
  const finalX = await thumbX();
  assert.notEqual(finalX, startX, '最終的には位置が変わっている');
  assert.ok(transforms.length >= 2, `位置合わせが前の位置→今の位置の2段階になっていない: ${JSON.stringify(transforms)}`);
  assert.notEqual(transforms[0], transforms[transforms.length - 1], '最初と最後で同じ位置ではない（経由地点がある）');
});

test('carry-over date can be chosen freely, not just today/tomorrow', options, async () => {
  await page.getByRole('tab', { name: /スケジュール/ }).click();
  await page.locator('.day-row.is-today').click();
  await page.getByText(/残っている予定/).waitFor();
  assert.equal(await page.locator('.detail-item').count(), 2);
  await page.getByRole('button', { name: '繰り越す', exact: true }).first().click();
  const dateInput = page.locator('input[type="date"]');
  await dateInput.waitFor();
  await dateInput.fill('2026-09-20');
  await page.getByRole('button', { name: '理由は未入力', exact: true }).click();
  await until(async () => (await page.locator('.detail-item').count()) === 1);
  const tasks = await page.evaluate(async () => (await import('./src/api.js')).getTasksInRange('2026-09-20', '2026-09-20'));
  assert.ok(tasks.some((t) => (t.questionIds ?? []).length > 0), '選んだ日付にタスクが移っている');
});
