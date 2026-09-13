// 実ブラウザでの通し確認。
//
// Node のテストは「判定のしかた」を確かめるもので、
// タップ → IndexedDB → Service Worker → 再起動 → オフライン → 同期 までは通っていない。
// ここはその1本を、本物のブラウザと本物の同期サーバーで通す。
//
//   npm run test:e2e
//
// Playwright が無い環境では、何も落とさずに飛ばす。

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { OWNER_KEY, loadPlaywright, startTestServer } from "./server.mjs";

const playwright = await loadPlaywright();
const options = playwright ? {} : { skip: "Playwright が無いので飛ばします" };

let server = null;
let browser = null;

before(async () => {
  if (!playwright) return;
  browser = await playwright.chromium.launch();
});

after(async () => {
  await browser?.close();
});

// サーバーは1つのテストにつき1つ立てる。保存先はメモリなので、
// 前のテストが入れたものが次のテストに混ざらない。
beforeEach(async () => {
  if (!playwright) return;
  server = await startTestServer();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

/** 新しい端末を1台ぶん開く。ブラウザのプロファイルが分かれる＝別の端末。 */
async function openDevice() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`${server.origin}/index.html`);
  await page.waitForFunction(() => document.querySelectorAll(".tabbar button").length > 0);
  // 問題マスタの投入が終わるまで待つ。
  await page.waitForFunction(async () => {
    const api = await import("./src/api.js");
    return (await api.listQuestions()).length > 0;
  });
  return { page, context, errors };
}

const read = (page, fn) => page.evaluate(fn);

/** この端末をクラウドへ参加させる。 */
async function link(page) {
  await page.evaluate(async (ownerKey) => {
    const cloud = await import("./src/cloud-sync.js");
    await cloud.saveCloudConfig({ serverUrl: location.origin, ownerKey });
    const config = await cloud.getCloudConfig();
    const issued = await cloud.admin.issueSyncCode(config);
    await cloud.joinDevice({ serverUrl: location.origin, code: issued.syncCode, deviceName: "e2e" });
  }, OWNER_KEY);
}

const syncNow = (page) => page.evaluate(async () => {
  const cloud = await import("./src/cloud-sync.js");
  const result = await cloud.syncNow({ force: true });
  return result.ok ? "ok" : (result.message ?? result.reason);
});

const counts = (page) => page.evaluate(async () => {
  const api = await import("./src/api.js");
  return {
    records: (await api.listRecords()).length,
    questions: (await api.listQuestions()).length,
    masterVersion: await api.getQuestionMasterVersion(),
  };
});

test("記録をつけて、閉じて開いても残っている", options, async () => {
  const { page, context, errors } = await openDevice();
  const before = await counts(page);
  assert.ok(before.questions > 0, "問題マスタが入っていない");
  assert.equal(before.records, 0);

  await page.evaluate(async () => {
    const api = await import("./src/api.js");
    const [question] = await api.listQuestions();
    await api.addStudyRecord({ questionId: question.id, evaluation: "perfect", durationSeconds: 180 });
  });

  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".tabbar button").length > 0);
  assert.equal((await counts(page)).records, 1, "再起動で記録が消えた");
  assert.deepEqual(errors, []);
  await context.close();
});

test("オフラインでも起動でき、記録をつけられる", options, async () => {
  const { page, context, errors } = await openDevice();
  // Service Worker がアプリシェルを取り込むまで待つ。
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => (await caches.keys()).length > 0);

  server.goOffline();
  try {
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll(".tabbar button").length > 0, null, { timeout: 15000 });
    // 画面が組み上がる＝ src/*.js がキャッシュから全部取れている。
    for (const tab of ["記録", "スケジュール", "設定"]) {
      await page.locator(".tabbar button", { hasText: tab }).click();
      await page.waitForTimeout(400);
    }
    await page.evaluate(async () => {
      const api = await import("./src/api.js");
      const [question] = await api.listQuestions();
      await api.addStudyRecord({ questionId: question.id, evaluation: "calc_error", durationSeconds: 120 });
    });
    assert.equal((await counts(page)).records, 1, "オフラインで記録できなかった");
  } finally {
    server.goOnline();
  }
  assert.deepEqual(errors.filter((text) => !/Failed to fetch|net::ERR|504/.test(text)), []);
  await context.close();
});

test("オフラインで貯めた記録が、オンラインに戻ると届く", options, async () => {
  const { page, context } = await openDevice();
  await link(page);
  assert.equal(await syncNow(page), "ok");

  server.goOffline();
  await page.evaluate(async () => {
    const api = await import("./src/api.js");
    const [question] = await api.listQuestions();
    await api.addStudyRecord({ questionId: question.id, evaluation: "perfect", durationSeconds: 300 });
  });
  // オフラインのあいだは送れない。
  assert.notEqual(await syncNow(page), "ok");
  server.goOnline();

  assert.equal(await syncNow(page), "ok");
  const status = await fetch(`${server.origin}/api/admin/status`, {
    headers: { authorization: `Bearer ${OWNER_KEY}` },
  }).then((response) => response.json());
  assert.equal(status.sync.records, 1, "オンラインに戻っても届いていない");
  await context.close();
});

test("2台目に記録が届き、消したものは戻らない", options, async () => {
  const first = await openDevice();
  await link(first.page);
  const recordId = await first.page.evaluate(async () => {
    const api = await import("./src/api.js");
    const [question] = await api.listQuestions();
    const record = await api.addStudyRecord({ questionId: question.id, evaluation: "perfect", durationSeconds: 240 });
    return record.id;
  });
  assert.equal(await syncNow(first.page), "ok");

  const second = await openDevice();
  await link(second.page);
  assert.equal(await syncNow(second.page), "ok");
  assert.equal((await counts(second.page)).records, 1, "2台目に届いていない");

  // 1台目で消す → 2台目でも消える。
  await first.page.evaluate(async (id) => {
    const api = await import("./src/api.js");
    await api.deleteStudyRecord(id);
  }, recordId);
  assert.equal(await syncNow(first.page), "ok");
  assert.equal(await syncNow(second.page), "ok");
  assert.equal((await counts(second.page)).records, 0, "消したのに2台目に残っている");

  // 消したことを知らないまま、2台目がもう一度送っても戻らない。
  assert.equal(await syncNow(second.page), "ok");
  assert.equal((await counts(first.page)).records, 0);
  await first.context.close();
  await second.context.close();
});

test("古い問題マスタを持った端末が、新しいマスタを巻き戻さない", options, async () => {
  const fresh = await openDevice();
  await link(fresh.page);
  assert.equal(await syncNow(fresh.page), "ok");
  const master = await counts(fresh.page);

  const old = await openDevice();
  await link(old.page);
  // 問題を減らし、版を知らない状態に戻す（この仕組みより前の端末）。
  await old.page.evaluate(async () => {
    const api = await import("./src/api.js");
    const { idb, STORES } = await import("./src/idb.js");
    const all = await api.listQuestions();
    await idb.clear(STORES.questions);
    await idb.putAll(STORES.questions, all.slice(0, all.length - 3));
    await idb.del(STORES.meta, "questionMaster");
    const cloud = await import("./src/cloud-sync.js");
    await cloud.saveCloudConfig({ questionsHash: null, lastPulledAtMs: null });
  });
  assert.equal((await counts(old.page)).questions, master.questions - 3);

  assert.equal(await syncNow(old.page), "ok");
  // 古い端末のほうが新しいマスタを受け取る。クラウドは巻き戻らない。
  assert.equal((await counts(old.page)).questions, master.questions, "古いマスタのままになった");
  assert.equal(await syncNow(fresh.page), "ok");
  assert.equal((await counts(fresh.page)).questions, master.questions, "新しい端末が巻き戻された");
  await fresh.context.close();
  await old.context.close();
});

test("片方の端末で「すべて削除」すると、もう片方からも消える", options, async () => {
  const first = await openDevice();
  const second = await openDevice();
  await link(first.page);
  await link(second.page);

  // 1台目で、記録・予定・目標を作って同期する。
  await first.page.evaluate(async () => {
    const api = await import("./src/api.js");
    const [q1, q2] = await api.listQuestions();
    await api.addStudyRecord({ questionId: q1.id, evaluation: "perfect", durationSeconds: 200 });
    await api.updateTodayTasks(
      [{ id: "task-e2e", kind: "new", questionIds: [q2.id], order: 0 }],
      api.todayKey(),
    );
    await api.addGoal({ title: "E2Eの目標", questionIds: [q1.id] });
  });
  assert.equal(await syncNow(first.page), "ok");

  // 2台目が受け取る。
  assert.equal(await syncNow(second.page), "ok");
  const shared = await second.page.evaluate(async () => {
    const api = await import("./src/api.js");
    return {
      records: (await api.listRecords()).length,
      tasks: (await api.getTasksInRange(api.todayKey(), api.todayKey())).length,
      goals: (await api.getGoals()).length,
    };
  });
  assert.deepEqual(shared, { records: 1, tasks: 1, goals: 1 }, "2台目に届いていない");

  // 1台目で「学習データをすべて削除」（クラウドの分も消す）。
  await first.page.evaluate(async () => {
    const api = await import("./src/api.js");
    const cloud = await import("./src/cloud-sync.js");
    const config = await cloud.getCloudConfig();
    const result = await cloud.admin.purgeData(config);
    await cloud.saveCloudConfig({ lastPurgeAtMs: Number(result?.purgedAtMs) || Date.now() });
    await api.purgeStudyData();
    await cloud.resetSyncCursor();
  });

  // 2台目は、同期しただけで消える（ここが抜けていた）。
  assert.equal(await syncNow(second.page), "ok");
  const after = await second.page.evaluate(async () => {
    const api = await import("./src/api.js");
    return {
      records: (await api.listRecords()).length,
      tasks: (await api.getTasksInRange(api.todayKey(), api.todayKey())).length,
      goals: (await api.getGoals()).length,
      questions: (await api.listQuestions()).length,
    };
  });
  assert.equal(after.records, 0, "2台目に記録が残っている");
  assert.equal(after.tasks, 0, "2台目に予定が残っている");
  assert.equal(after.goals, 0, "2台目に目標が残っている");
  assert.ok(after.questions > 0, "問題マスタまで消えてしまった");

  // 2台目がそのあと入れた記録は、もう消されない（印は1回しか効かない）。
  await second.page.evaluate(async () => {
    const api = await import("./src/api.js");
    const [question] = await api.listQuestions();
    await api.addStudyRecord({ questionId: question.id, evaluation: "perfect", durationSeconds: 60 });
  });
  assert.equal(await syncNow(second.page), "ok");
  assert.equal(await syncNow(second.page), "ok");
  assert.equal((await counts(second.page)).records, 1, "消したあとに入れた記録まで消えた");

  // 1台目にも、その新しい記録が届く。
  assert.equal(await syncNow(first.page), "ok");
  assert.equal((await counts(first.page)).records, 1);

  await first.context.close();
  await second.context.close();
});
