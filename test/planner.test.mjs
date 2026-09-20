// Jev 自動プランナーの確認。
//
// ここで見るのは「判断を任せても、制約は必ずコードで守られるか」。
// Jev の応答はすべて作り物で、実際のAPIは呼ばない。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OWNER_KEY, QUESTIONS, call, callTool, createTestApp, enableAiLink, joinDevice } from './helpers.mjs';
import { JEV_ENDPOINT, askJev, jevConfigurationError, readAnswer } from '../server/service/jev-client.js';
import {
  POLICY_DEFAULTS, compareCandidates, fallbackIntervalDays, intervalDaysFrom, reviewNeedFrom,
} from '../server/service/planner-policy.js';
import { allocate, buildChanges, buildSlots } from '../server/service/planner-allocation.js';
import { dueDateFor, featuresFor, prerequisiteFor } from '../server/service/planner-features.js';
import { plannerProviderOf, plannerConfigurationError } from '../server/service/planner-provider.js';
import { normalizeGoal, questionSatisfied } from '../src/goals.js';

const Q = QUESTIONS.map((question) => question.id);
const NOW = Date.parse('2026-09-12T03:00:00Z'); // 日本時間 2026-09-12 12:00
const JEV_ENV = { PLANNER_PROVIDER: 'jev', JEV_API_KEY: 'jev-key-TEST-ONLY' };

/* ------------------------------------------------------------------ */
/* 目標の達成条件（perfect 合計2回）                                    */
/* ------------------------------------------------------------------ */

test('perfect2回でクリアする数え方は、失敗を挟んでも回数が消えない', () => {
  const goal = normalizeGoal({
    id: 'g1', questionIds: [Q[0]],
    completion: { type: 'mastery', evaluations: ['perfect'], mode: 'count', count: 2 },
  });
  assert.equal(goal.completion.count, 2);
  const attempt = (evaluation) => ({ evaluation });
  assert.equal(questionSatisfied(goal, [attempt('perfect')]), false);
  assert.equal(questionSatisfied(goal, [attempt('perfect'), attempt('calc_error')]), false);
  assert.equal(questionSatisfied(goal, [attempt('perfect'), attempt('calc_error'), attempt('perfect')]), true,
    '間に失敗があっても、そろった回数は減らない');
});

test('count の回数は範囲内に収められ、他の数え方には残らない', () => {
  const huge = normalizeGoal({ id: 'g', questionIds: ['a'], completion: { type: 'mastery', mode: 'count', count: 999 } });
  assert.equal(huge.completion.count, 10);
  const latest = normalizeGoal({ id: 'g', questionIds: ['a'], completion: { type: 'mastery', mode: 'latest', count: 5 } });
  assert.equal(latest.completion.count, undefined, '意味の無い回数は残さない');
});

test('目標の達成条件として count を保存でき、画面と同じ判定になる', async () => {
  const { app } = createTestApp({ now: () => NOW });
  const token = await enableAiLink(app);
  const device = await joinDevice(app);
  await call(app, '/api/sync/push', {
    method: 'POST', token: device.deviceKey, body: { questions: { questions: QUESTIONS } },
  });
  const created = await callTool(app, token, 'addGoal', {
    title: 'perfect2回', questionIds: [Q[0]],
    completion: { type: 'mastery', evaluations: ['perfect'], mode: 'count', count: 2 },
  });
  assert.equal(created.goal.completion.mode, 'count');
  assert.equal(created.goal.completion.count, 2);
});

/* ------------------------------------------------------------------ */
/* Jev への問い合わせ                                                   */
/* ------------------------------------------------------------------ */

test('設定の誤りは呼び出す前に分かる', () => {
  assert.equal(jevConfigurationError({}), 'missing_secrets');
  assert.equal(jevConfigurationError({ JEV_API_KEY: 'k', JEV_API_URL: 'http://example.test' }), 'invalid_configuration');
  assert.equal(jevConfigurationError({ JEV_API_KEY: 'k', JEV_API_URL: 'https://x.test/v1?token=1' }), 'invalid_configuration');
  assert.equal(jevConfigurationError({ JEV_API_KEY: 'k', JEV_MODEL: 'bad model!' }), 'invalid_configuration');
  assert.equal(jevConfigurationError({ JEV_API_KEY: 'k' }), null);
});

test('想定外の答えは判断として通さない', () => {
  const choice = { type: 'choice', criteria: { repeat: '', keep: '' } };
  assert.equal(readAnswer({ choice: 'repeat', confidence: 0.9 }, choice).value, 'repeat');
  assert.equal(readAnswer({ choice: 'delete_everything' }, choice), null, '選択肢に無い値は捨てる');
  assert.equal(readAnswer('repeat', choice), null);

  const score = { type: 'score', criteria: ['低い', '中程度', '高い'] };
  const answer = readAnswer({ score: 1.7 }, score);
  assert.equal(answer.value, 1.7, 'Score は小数のまま扱う（添字にしない）');
  assert.equal(readAnswer({ score: 9 }, score), null, '範囲外は捨てる');

  const noul = { type: 'noul', criteria: '' };
  assert.equal(readAnswer({ probability: 0.4, confidence: 0.9 }, noul).confidence, null,
    'Noul には独立した confidence が無い');
  assert.equal(readAnswer({ probability: 2 }, noul), null);
});

test('転送・HTTPの失敗は、送り直してよいかを分けて返す', async () => {
  const redirect = await askJev({ state: {}, questions: {} },
    { env: { JEV_API_KEY: 'k' }, fetchImpl: async () => new Response(null, { status: 302 }) });
  assert.deepEqual([redirect.ok, redirect.error, redirect.retryable], [false, 'provider_redirect', false]);

  const auth = await askJev({ state: {}, questions: {} },
    { env: { JEV_API_KEY: 'k' }, fetchImpl: async () => new Response('no', { status: 401 }) });
  assert.deepEqual([auth.error, auth.retryable], ['authentication', false], '設定の誤りは繰り返さない');

  const busy = await askJev({ state: {}, questions: {} },
    { env: { JEV_API_KEY: 'k' }, fetchImpl: async () => new Response('busy', { status: 503 }) });
  assert.deepEqual([busy.error, busy.retryable], ['provider_failure', true]);

  const broken = await askJev({ state: {}, questions: { a: { type: 'choice', criteria: { x: '' } } } },
    { env: { JEV_API_KEY: 'k' }, fetchImpl: async () => Response.json({ nope: true }) });
  assert.deepEqual([broken.error, broken.detail], ['invalid_provider_response', 'answers']);
});

test('鍵と教材の中身は要求の外へ出ない', async () => {
  const calls = [];
  await askJev({
    state: { candidates: { c0: { id: Q[0], evaluations: ['perfect'] } } },
    questions: { c0__x: { type: 'choice', instructions: 'i', criteria: { keep: '' } } },
  }, {
    env: { JEV_API_KEY: 'jev-key-TEST-ONLY' },
    fetchImpl: async (url, init) => { calls.push([url, init]); return Response.json({ answers: {} }); },
  });
  const [url, init] = calls[0];
  assert.equal(url, JEV_ENDPOINT);
  assert.equal(init.redirect, 'manual', 'Cloudflare Workers が受け付ける形であること');
  assert.equal(init.headers.authorization, 'Bearer jev-key-TEST-ONLY');
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
  assert.ok(!JSON.stringify(body).includes('jev-key-TEST-ONLY'), '鍵は本文に入れない');
});

/* ------------------------------------------------------------------ */
/* 方針（決定的な規則）                                                 */
/* ------------------------------------------------------------------ */

const features = (overrides = {}) => ({
  questionId: Q[0], evaluations: [], attemptCount: 0, perfectCount: 0, failureCount: 0,
  partialCount: 0, consecutiveFailures: 0, lastEvaluation: null, lastAttemptDate: null,
  daysSinceLastAttempt: null, difficulty: 3, estimateSeconds: 600, ...overrides,
});

test('Jevが使えないときは、説明できる規則へ戻す', () => {
  assert.equal(fallbackIntervalDays(features({ evaluations: ['wrong_approach'] })), 1);
  assert.equal(fallbackIntervalDays(features({ evaluations: ['calc_error'] })), 1);
  assert.equal(fallbackIntervalDays(features({ evaluations: ['weak_writing'] })), 3);
  assert.equal(fallbackIntervalDays(features({ evaluations: ['perfect'], perfectCount: 1 })), 7);
  assert.equal(fallbackIntervalDays(features({ evaluations: ['perfect', 'perfect'], perfectCount: 2 })), 14);
});

test('低確信度とunknownは採用せず、規則へ戻す', () => {
  const f = features({ evaluations: ['perfect'], perfectCount: 1 });
  assert.deepEqual(intervalDaysFrom({ value: 'day_30', confidence: 0.9 }, f), { days: 30, source: 'jev' });
  assert.deepEqual(intervalDaysFrom({ value: 'day_30', confidence: 0.1 }, f), { days: 7, source: 'policy_low_confidence' });
  assert.deepEqual(intervalDaysFrom({ value: 'unknown', confidence: 0.9 }, f), { days: 7, source: 'policy' });
  assert.deepEqual(intervalDaysFrom(null, f), { days: 7, source: 'policy' });
  assert.equal(reviewNeedFrom(null, features({ evaluations: ['wrong_approach'] })).need, 2);
});

test('並び順は期限・優先枠で決まり、AIの点数で制約を覆さない', () => {
  const base = {
    bucket: 3, goalPriority: 3, deferred: false, reviewNeed: 0, order: 1, dueDate: null,
    goalDeadline: null, questionId: 'b',
  };
  const urgent = { ...base, goalDeadline: '2026-09-20', reviewNeed: 0, questionId: 'a' };
  const scored = { ...base, reviewNeed: 2 };
  assert.ok(compareCandidates(urgent, scored, { today: '2026-09-12' }) < 0,
    '期限のある目標が、必要度の高さより先に来る');
  // 同じ入力なら、何度並べても同じ順になる。
  const list = [scored, urgent, { ...base, questionId: 'c' }];
  const once = [...list].sort((l, r) => compareCandidates(l, r, { today: '2026-09-12' })).map((c) => c.questionId);
  const twice = [...list].reverse().sort((l, r) => compareCandidates(l, r, { today: '2026-09-12' })).map((c) => c.questionId);
  assert.deepEqual(once, twice);
});

/* ------------------------------------------------------------------ */
/* 配分                                                                 */
/* ------------------------------------------------------------------ */

const day = (date, minutes, pendingItems = []) => ({
  date, revision: 1, capacity: { available: minutes }, pendingItems,
});

const candidate = (questionId, seconds, overrides = {}) => ({
  key: questionId, questionId, goalId: 'g1', estimateSeconds: seconds,
  desiredDate: '2026-09-12', goalDeadline: null, itemId: null, ...overrides,
});

test('枠は秒で数える。丸めた分だけ超過させない', () => {
  const slots = buildSlots([day('2026-09-12', 20)]);
  const { placements, unplaced } = allocate(
    [candidate('a', 700), candidate('b', 700)], slots, { today: '2026-09-12' },
  );
  assert.equal(placements.length, 1, '700秒×2は20分（1200秒）に入らない');
  assert.equal(unplaced[0].reason, 'time_shortage');
});

test('使える時間が未設定の日には置かない（0分とは違う）', () => {
  const slots = buildSlots([day('2026-09-12', null), day('2026-09-13', 60)]);
  const { placements } = allocate([candidate('a', 600)], slots, { today: '2026-09-12' });
  assert.equal(placements[0].date, '2026-09-13');
});

test('固定・実行中の予定の時間は先に引く', () => {
  const locked = { itemId: 'i1', questionId: Q[1], estimateSeconds: 1500, locked: true };
  const slots = buildSlots([day('2026-09-12', 30, [locked])]);
  assert.equal(slots[0].remainingSeconds, 300);
  const { placements, unplaced } = allocate([candidate('a', 600)], slots, { today: '2026-09-12' });
  assert.equal(placements.length, 0);
  assert.equal(unplaced[0].reason, 'time_shortage');
});

test('期限より後ろには置かず、置けない理由を残す', () => {
  const slots = buildSlots([day('2026-09-12', 5), day('2026-09-13', 60)]);
  const { placements, unplaced } = allocate(
    [candidate('a', 600, { goalDeadline: '2026-09-12' })], slots, { today: '2026-09-12' },
  );
  assert.equal(placements.length, 0);
  assert.equal(unplaced[0].reason, 'single_item_too_long');
});

test('1問だけで1日の枠を超える問題は置かない', () => {
  const slots = buildSlots([day('2026-09-12', 10)]);
  const { unplaced } = allocate([candidate('a', 3000)], slots, { today: '2026-09-12' });
  assert.equal(unplaced[0].reason, 'single_item_too_long');
});

test('望ましい間隔より前には置かない（復習を前倒ししない）', () => {
  const slots = buildSlots([day('2026-09-12', 60), day('2026-09-15', 60)]);
  const { placements } = allocate(
    [candidate('a', 600, { desiredDate: '2026-09-15' })], slots, { today: '2026-09-12' },
  );
  assert.equal(placements[0].date, '2026-09-15');
});

test('過ぎた予定は carryOver、これからの予定は move、新しい分だけ add', () => {
  const { changes, dates } = buildChanges([
    { questionId: Q[0], itemId: 'i1', taskId: 't1', fromDate: '2026-09-10', date: '2026-09-12' },
    { questionId: Q[1], itemId: 'i2', taskId: 't2', fromDate: '2026-09-13', date: '2026-09-14' },
    { questionId: Q[2], itemId: 'i3', taskId: 't3', fromDate: '2026-09-12', date: '2026-09-12' },
    { questionId: Q[2], goalId: 'g1', date: '2026-09-12' },
  ], { today: '2026-09-12', limits: { changesPerRequest: 50, datesPerRequest: 31 } });
  assert.deepEqual(changes.map((change) => change.op), ['carryOver', 'move', 'add']);
  assert.deepEqual(changes[0].itemIds, ['i1']);
  assert.deepEqual(changes[2].task, { questionIds: [Q[2]], kind: 'new', goalId: 'g1' });
  assert.ok(dates.includes('2026-09-10'), '移動元の日も版を確かめる対象になる');
});

test('1回で扱える数を超えた分は、消さずに次回へ回す', () => {
  const many = Array.from({ length: 60 }, (unused, index) => ({
    questionId: `q${index}`, goalId: 'g1', date: '2026-09-12',
  }));
  const { changes, skipped } = buildChanges(many, {
    today: '2026-09-12', limits: { changesPerRequest: 50, datesPerRequest: 31 },
  });
  assert.equal(changes.length, 50);
  assert.equal(skipped.length, 10);
});

/* ------------------------------------------------------------------ */
/* 特徴量と関連                                                         */
/* ------------------------------------------------------------------ */

test('特徴量は数えられることだけを持ち、原因を推測しない', () => {
  const history = [
    { evaluation: 'wrong_approach', timestamp: '2026-09-01T02:00:00Z', durationSeconds: 900 },
    { evaluation: 'calc_error', timestamp: '2026-09-05T02:00:00Z', durationSeconds: 700 },
  ];
  const f = featuresFor({
    questionId: Q[0], question: { difficulty: 4, type: '重要例題' }, attempts: [], history,
    estimate: { seconds: 800, source: 'history_blended', confidence: 'medium' }, today: '2026-09-12',
  });
  assert.deepEqual(f.evaluations, ['wrong_approach', 'calc_error']);
  assert.equal(f.consecutiveFailures, 2);
  assert.equal(f.failureCount, 2);
  assert.equal(f.daysSinceLastAttempt, 7);
  assert.equal(f.estimateSource, 'history_blended');
  assert.ok(!('cause' in f) && !('weakness' in f), '原因の断定は持たない');
});

test('復習予定日は最後に解いた日から数え、過去には置かない', () => {
  const f = featuresFor({
    questionId: Q[0], history: [{ evaluation: 'perfect', timestamp: '2026-09-01T02:00:00Z' }],
    attempts: [], estimate: { seconds: 600, source: 'history', confidence: 'high' }, today: '2026-09-12',
  });
  assert.equal(dueDateFor(f, 3, '2026-09-12'), '2026-09-12', '過ぎた分は今日へ寄せる');
  assert.equal(dueDateFor(f, 30, '2026-09-12'), '2026-10-01');
});

test('関連が保存されていなければ、基礎へは戻さない', () => {
  assert.equal(prerequisiteFor(Q[0], { relations: [], allowedQuestionIds: new Set(Q) }), null);
  const relations = [
    { fromQuestionId: Q[1], toQuestionId: Q[0], type: 'prerequisite', source: 'ai' },
    { fromQuestionId: Q[2], toQuestionId: Q[0], type: 'prerequisite', source: 'book' },
  ];
  const found = prerequisiteFor(Q[0], { relations, allowedQuestionIds: new Set(Q) });
  assert.equal(found.questionId, Q[2], '教材に書いてあるつながりを先に使う');
  assert.equal(prerequisiteFor(Q[0], { relations, allowedQuestionIds: new Set([Q[0]]) }), null,
    '対象の外の問題へは戻さない');
});

/* ------------------------------------------------------------------ */
/* 実行先の選択                                                         */
/* ------------------------------------------------------------------ */

test('実行先は設定で決まり、知らない値では既存の動きを変えない', () => {
  assert.equal(plannerProviderOf({}), 'claude_routine');
  assert.equal(plannerProviderOf({ PLANNER_PROVIDER: 'nonsense' }), 'claude_routine');
  assert.equal(plannerProviderOf(JEV_ENV), 'jev');
  assert.equal(plannerConfigurationError({ PLANNER_PROVIDER: 'jev' }), 'missing_secrets');
  assert.equal(plannerConfigurationError({ PLANNER_PROVIDER: 'off' }), 'planner_disabled');
  assert.equal(plannerConfigurationError(JEV_ENV), null);
});

/* ------------------------------------------------------------------ */
/* 通し（取得 → 判断 → 配分 → 検証 → 反映）                            */
/* ------------------------------------------------------------------ */

/** Jev の代わり。候補ごとに、決められた答えを返す。 */
function fakeJev({ interval = 'day_3', action = 'keep', need = 2, confidence = 0.9, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (status !== 200) return new Response('no', { status });
    const body = JSON.parse(init.body);
    const answers = {};
    for (const id of Object.keys(body.questions)) {
      if (id.endsWith('__review_need')) answers[id] = { score: need, confidence };
      if (id.endsWith('__next_action')) answers[id] = { choice: action, confidence };
      if (id.endsWith('__next_review_interval')) answers[id] = { choice: interval, confidence };
    }
    return Response.json({ answers, usage: { input_tokens: 1200, output_tokens: 0 } });
  };
  return { calls, fetchImpl };
}

async function plannerFixture({ env = {}, jev = fakeJev(), now = () => NOW } = {}) {
  const { createStudyTodoMcpApp } = await import('../server/app.js');
  const { createMemoryDriver } = await import('../server/storage/memory-driver.js');
  const app = createStudyTodoMcpApp({
    storage: createMemoryDriver(), now,
    env: { STUDY_TODO_OWNER_KEY: OWNER_KEY, ...JEV_ENV, ...env },
    plannerFetch: jev.fetchImpl,
  });
  const token = await enableAiLink(app);
  const device = await joinDevice(app);
  await call(app, '/api/sync/push', {
    method: 'POST', token: device.deviceKey, body: { questions: { questions: QUESTIONS } },
  });
  await callTool(app, token, 'updateStudyAvailability', {
    weekly: { mon: 120, tue: 120, wed: 120, thu: 120, fri: 120, sat: 120, sun: 120 },
  });
  return { app, token, device, jev };
}

const fire = (app, operationId = 'planner-run-0001') =>
  call(app, '/api/admin/replan/fire', { method: 'POST', token: OWNER_KEY, body: { operationId } });

test('未配置の目標が、使える時間の中へ自動で置かれる', async () => {
  const { app, token, jev } = await plannerFixture();
  const goal = await callTool(app, token, 'addGoal', {
    title: '1周目', questionIds: [Q[0], Q[1]], completion: { type: 'attempt' },
  });

  const result = await fire(app);
  assert.equal(result.body.replan.state, 'applied', JSON.stringify(result.body.replan));
  assert.equal(result.body.replan.provider, 'jev');
  assert.equal(result.body.replan.applied, 2);
  assert.equal(jev.calls.length, 0, '履歴の無い問題について、Jevへは尋ねない');

  const tasks = await callTool(app, token, 'getTodayTasks', {});
  assert.equal(tasks.tasks.length, 2, '1タスク1問で置く');
  assert.deepEqual(tasks.tasks.map((task) => task.questionIds.length), [1, 1]);
  assert.deepEqual(tasks.tasks.map((task) => task.goalId), [goal.goal.id, goal.goal.id]);
});

test('同じ問題を二重には置かない（2回目の実行で予定が増えない）', async () => {
  const { app, token } = await plannerFixture();
  await callTool(app, token, 'addGoal', { title: '1周目', questionIds: [Q[0]], completion: { type: 'attempt' } });

  assert.equal((await fire(app, 'run-0001')).body.replan.state, 'applied');
  const second = await fire(app, 'run-0002');
  assert.equal(second.body.replan.state, 'no_change', JSON.stringify(second.body.replan));
  const tasks = await callTool(app, token, 'getTodayTasks', {});
  assert.equal(tasks.tasks.length, 1);
});

test('同じ operationId の送り直しでは、予定が二重にならない', async () => {
  const { app, token } = await plannerFixture();
  await callTool(app, token, 'addGoal', { title: '1周目', questionIds: [Q[0]], completion: { type: 'attempt' } });
  await fire(app, 'retry-0001');
  const again = await fire(app, 'retry-0001');
  assert.equal(again.body.replan.state, 'applied');
  assert.equal((await callTool(app, token, 'getTodayTasks', {})).tasks.length, 1);
});

test('入りきらない分は、詰め込まずに不足として残す', async () => {
  const { app, token } = await plannerFixture();
  // 1日20分。1問がおよそ12分なので、1日に置けるのは1問だけ。
  await callTool(app, token, 'updateStudyAvailability', {
    weekly: { mon: 20, tue: 20, wed: 20, thu: 20, fri: 20, sat: 20, sun: 20 },
  });
  await callTool(app, token, 'addGoal', {
    title: '1周目', questionIds: [Q[0], Q[1], Q[2]], deadline: '2026-09-13', completion: { type: 'attempt' },
  });
  const replan = (await fire(app)).body.replan;
  assert.equal(replan.state, 'applied', JSON.stringify(replan));
  assert.equal(replan.applied, 2, '期限までの2日に1問ずつ');
  assert.equal(replan.unplaced.length, 1, '入らなかった分は理由つきで残る');
  assert.ok(['time_shortage', 'day_full', 'after_deadline'].includes(replan.unplaced[0].reason));

  // どの日も、使える時間を超えていない。
  const context = await callTool(app, token, 'getPlanningContext', {});
  for (const day of context.days) {
    if (day.capacity.available === null) assert.equal(day.pendingItems.length, 0, '未設定の日には置かない');
    else assert.ok(day.plannedMinutes <= day.capacity.available, `${day.date} が超過している`);
  }
});

test('shadow では案を作るだけで、予定は保存しない', async () => {
  const { app, token } = await plannerFixture({ env: { PLANNER_PROVIDER: 'jev_shadow' } });
  await callTool(app, token, 'addGoal', { title: '1周目', questionIds: [Q[0]], completion: { type: 'attempt' } });
  const result = await fire(app);
  assert.equal(result.body.replan.state, 'validated');
  assert.equal(result.body.replan.shadow, true);
  assert.equal(result.body.replan.applied, 0);
  assert.equal((await callTool(app, token, 'getTodayTasks', {})).tasks.length, 0, '保存はしない');
});

test('Jevが止まっても、決定的な規則で予定を作り、制約は守る', async () => {
  const { app, token } = await plannerFixture({ jev: fakeJev({ status: 503 }) });
  await callTool(app, token, 'addGoal', {
    title: '復習', questionIds: [Q[0]], completion: { type: 'mastery', mode: 'count', count: 2 },
  });
  const result = await fire(app);
  assert.equal(result.body.replan.state, 'applied');
  assert.equal(result.body.replan.provider, 'jev');
});

test('Jevの設定が無ければ、予定に触らずに設定の確認を促す', async () => {
  const { app, token } = await plannerFixture({ env: { JEV_API_KEY: '' } });
  await callTool(app, token, 'addGoal', { title: '1周目', questionIds: [Q[0]], completion: { type: 'attempt' } });
  const result = await fire(app);
  assert.equal(result.body.replan.state, 'failed');
  assert.equal(result.body.replan.error, 'missing_secrets');
  assert.equal((await callTool(app, token, 'getTodayTasks', {})).tasks.length, 0);
});

test('学習中の手動実行は、延期せずにはっきり断る', async () => {
  const { app, token, device } = await plannerFixture();
  await callTool(app, token, 'addGoal', { title: '1周目', questionIds: [Q[0]], completion: { type: 'attempt' } });
  await call(app, '/api/sync/activity', {
    method: 'POST', token: device.deviceKey,
    body: { date: '2026-09-12', sessionId: 'live-1', sessionActive: true, taskId: null },
  });
  const result = await fire(app);
  assert.equal(result.body.replan.error, 'study_in_progress');
  assert.equal((await callTool(app, token, 'getTodayTasks', {})).tasks.length, 0);
});

test('固定した予定と、その時間はプランナーが動かさない', async () => {
  const { app, token } = await plannerFixture();
  const goal = await callTool(app, token, 'addGoal', {
    title: '1周目', questionIds: [Q[0], Q[1]], completion: { type: 'attempt' },
  });
  const before = await callTool(app, token, 'getTodayTasks', {});
  await callTool(app, token, 'applyTaskChanges', {
    operationId: 'pin-1',
    expectedRevisions: [{ date: '2026-09-12', revision: before.revision }],
    changes: [{ op: 'add', date: '2026-09-12', task: { questionIds: [Q[0]], kind: 'new', goalId: goal.goal.id } }],
  });
  const added = await callTool(app, token, 'getTodayTasks', {});
  const pinned = added.tasks[0];
  await call(app, `/api/admin/tasks/${encodeURIComponent('2026-09-12')}/pin`, {
    method: 'POST', token: OWNER_KEY, body: { taskId: pinned.id, pinned: true },
  }).catch(() => null);

  const result = await fire(app);
  assert.equal(result.body.replan.state, 'applied');
  const after = await callTool(app, token, 'getTodayTasks', {});
  assert.ok(after.tasks.some((task) => task.id === pinned.id), '既存の予定は残る');
  assert.equal(after.tasks.filter((task) => task.questionIds[0] === Q[0]).length, 1, '同じ問題を足さない');
});

test('やり残した予定は、過去の日から今日以降へ繰り越される', async () => {
  const { app, token } = await plannerFixture({ now: () => Date.parse('2026-09-12T03:00:00Z') });
  const goal = await callTool(app, token, 'addGoal', {
    title: '1周目', questionIds: [Q[0]], completion: { type: 'attempt' },
  });
  await callTool(app, token, 'applyTaskChanges', {
    operationId: 'past-1',
    expectedRevisions: [{ date: '2026-09-10', revision: 0 }],
    changes: [{ op: 'add', date: '2026-09-10', task: { questionIds: [Q[0]], kind: 'new', goalId: goal.goal.id } }],
  });

  const result = await fire(app);
  assert.equal(result.body.replan.state, 'applied', JSON.stringify(result.body.replan));
  const left = await callTool(app, token, 'getTasksInRange', { from: '2026-09-10', to: '2026-09-10' });
  const stillThere = (left.days[0]?.tasks ?? []).flatMap((task) => task.items ?? []);
  assert.equal(stillThere.length, 0, '過去の日には残さない');
  const today = await callTool(app, token, 'getTodayTasks', {});
  assert.ok(today.tasks.some((task) => task.questionIds.includes(Q[0])));
});

test('Jevが選んだ間隔で復習日が決まる（置くのはアプリ）', async () => {
  const jev = fakeJev({ interval: 'day_7' });
  const { app, token, device } = await plannerFixture({ jev });
  const goal = await callTool(app, token, 'addGoal', {
    title: '習得', questionIds: [Q[0]],
    completion: { type: 'mastery', evaluations: ['perfect'], mode: 'count', count: 2 },
  });
  // 1回目は自動で置き、実際に解いたことにする。
  await fire(app, 'run-a0001');
  const placed = (await callTool(app, token, 'getTodayTasks', {})).tasks[0];
  await call(app, '/api/sync/push', {
    method: 'POST', token: device.deviceKey,
    body: {
      records: [{
        id: 'r1', questionId: Q[0], evaluation: 'perfect', durationSeconds: 600,
        timestamp: '2026-09-12T02:00:00Z', planItemId: placed.items[0].itemId,
      }],
    },
  });

  const replan = (await fire(app, 'run-b0001')).body.replan;
  assert.equal(replan.state, 'applied', JSON.stringify(replan));
  assert.ok(jev.calls.length >= 1, '履歴ができたので、今度はJevへ尋ねる');
  const asked = jev.calls.at(-1);
  assert.deepEqual(asked.state.candidates.c0.evaluations, ['perfect'], '送るのは評価履歴などの数えられることだけ');
  assert.equal(asked.state.candidates.c0.id, Q[0]);
  assert.ok(!JSON.stringify(asked).includes('r1'), '学習記録のIDは送らない');

  // 2026-09-12 に解いて day_7 なので、次は 2026-09-19。
  const range = await callTool(app, token, 'getTasksInRange', { from: '2026-09-13', to: '2026-09-26' });
  const dates = range.days.filter((entry) => (entry.tasks ?? []).some((task) => task.questionIds.includes(Q[0])));
  assert.deepEqual(dates.map((entry) => entry.date), ['2026-09-19']);
  assert.equal(goal.goal.completion.count, 2);
});

test('制約を破る案は、ok でも自動では保存しない', async () => {
  const { BLOCKING_WARNINGS, createPlannerRunner } = await import('../server/service/planner-runner.js');
  // 自動反映を止めるのは、validatePlanChanges が ok=true のまま返してくる警告ばかり。
  assert.deepEqual([...BLOCKING_WARNINGS].sort(),
    ['after_deadline', 'capacity_not_configured', 'over_capacity', 'single_item_too_long']);

  const applied = [];
  const service = {
    async getPlanningContext() {
      return {
        today: '2026-09-12', from: '2026-09-12', to: '2026-09-25',
        goals: [{ goalId: 'g1', unsatisfiedQuestionIds: [Q[0]] }],
        days: [{ date: '2026-09-12', revision: 3, capacity: { available: 120 }, pendingItems: [] }],
        unplanned: [{ goalId: 'g1', questionId: Q[0], estimateSeconds: 600 }],
        overdue: [],
        expectedContext: { goalsRevision: 1, availabilityRevision: 1, plannerSnapshotVersion: 'g1.a1.r0.t' },
      };
    },
    // ok=true だが、超過の警告が付いている。対話ならこのまま進められるが、自動では止める。
    async validatePlanChanges() { return { ok: true, warnings: [{ type: 'over_capacity', date: '2026-09-12' }] }; },
    async applyTaskChanges(request) { applied.push(request); return { ok: true }; },
  };
  const sync = {
    async readQuestions() { return { questions: QUESTIONS }; },
    async readAllRecords() { return []; },
    async readRelationEntries() { return {}; },
    async readGoals() { return [{ id: 'g1', status: 'active', questionIds: [Q[0]], priority: 3, deadline: '' }]; },
    async readTaskPlansInRange() { return []; },
  };
  const runner = createPlannerRunner({ service, sync, env: JEV_ENV, fetchImpl: fakeJev().fetchImpl });
  const result = await runner.run({ eventId: 'e1', trigger: 'manual' });
  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'blocking_warning');
  assert.equal(result.detail, 'over_capacity');
  assert.equal(applied.length, 0, '保存はしていない');
});
