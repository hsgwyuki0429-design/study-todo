// 同期の確認。いちばん大事なのは「データが消えないこと」。

import { test } from "node:test";
import assert from "node:assert/strict";

import { OWNER_KEY, QUESTIONS, call, createTestApp, joinDevice, record } from "./helpers.mjs";

const push = (app, key, body) => call(app, "/api/sync/push", { method: "POST", token: key, body });
const pull = (app, key, query = "") => call(app, `/api/sync/pull${query}`, { token: key });

test("初回pushでローカルの記録がすべてクラウドへ入る", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const records = Array.from({ length: 5 }, (_, i) => record(`rec${i}`));
  const response = await push(app, device.deviceKey, { records, questions: { questions: QUESTIONS } });
  assert.equal(response.status, 200);
  assert.equal(response.body.accepted.records, 5);
  assert.equal(response.body.questionsStored, true);
  assert.equal(response.body.snapshot.totalRecords, 5);
});

test("初回pullでクラウドの記録をすべて受け取れる", async () => {
  const { app } = createTestApp();
  const first = await joinDevice(app, "iPhone");
  await push(app, first.deviceKey, { records: [record("rec1"), record("rec2")] });

  const second = await joinDevice(app, "iPad");
  const snapshot = await pull(app, second.deviceKey);
  assert.equal(snapshot.body.records.length, 2);
});

test("同じ記録を2回送っても増えない", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  await push(app, device.deviceKey, { records: [record("rec1")] });
  const again = await push(app, device.deviceKey, { records: [record("rec1")] });
  assert.equal(again.body.accepted.records, 0);
  assert.equal(again.body.accepted.duplicatedRecords, 1);
  assert.equal(again.body.snapshot.totalRecords, 1);
});

test("オフラインで貯めた分をまとめて送れる", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  await push(app, device.deviceKey, { records: [record("rec1")] });
  const batch = Array.from({ length: 30 }, (_, i) => record(`offline${i}`, { timestamp: "2026-09-11T22:00:00Z" }));
  const response = await push(app, device.deviceKey, { records: [record("rec1"), ...batch] });
  assert.equal(response.body.accepted.records, 30);
  assert.equal(response.body.snapshot.totalRecords, 31);
});

test("2台から別々の記録を送っても、どちらも消えない", async () => {
  const { app } = createTestApp();
  const phone = await joinDevice(app, "iPhone");
  const pc = await joinDevice(app, "PC");
  await push(app, phone.deviceKey, { records: [record("phone1"), record("phone2")] });
  await push(app, pc.deviceKey, { records: [record("pc1")] });

  const snapshot = await pull(app, phone.deviceKey);
  const ids = snapshot.body.records.map((r) => r.id).sort();
  assert.deepEqual(ids, ["pc1", "phone1", "phone2"]);
});

test("クラウドに多く、端末に少なくても、どちらも消さない", async () => {
  const { app } = createTestApp();
  const phone = await joinDevice(app, "iPhone");
  // クラウド側に500件
  for (let chunk = 0; chunk < 2; chunk += 1) {
    await push(app, phone.deviceKey, {
      records: Array.from({ length: 250 }, (_, i) => record(`cloud${chunk}-${i}`)),
    });
  }
  // あとから参加した端末が450件を持ち込む
  const pad = await joinDevice(app, "iPad");
  const response = await push(app, pad.deviceKey, {
    records: Array.from({ length: 450 }, (_, i) => record(`local${i}`)),
  });
  assert.equal(response.body.accepted.records, 450);
  assert.equal(response.body.snapshot.totalRecords, 950);
});

test("同じ日の予定がぶつかったら、新しいほうが残る", async () => {
  const { app } = createTestApp();
  const phone = await joinDevice(app, "iPhone");
  const pad = await joinDevice(app, "iPad");
  const plan = (tasks, updatedAt, revision) => ({
    date: "2026-09-12", tasks, updatedAt, revision,
  });

  await push(app, phone.deviceKey, {
    taskPlans: [plan([{ id: "t1", questionIds: ["q1"], kind: "new" }], "2026-09-12T01:00:00Z", 0)],
  });

  // 古い版のまま、古い更新時刻で送ってきた端末はサーバーの内容に負ける。
  const stale = await push(app, pad.deviceKey, {
    taskPlans: [plan([{ id: "t0", questionIds: ["q0"], kind: "new" }], "2026-09-12T00:30:00Z", 0)],
  });
  assert.equal(stale.body.accepted.taskPlans[0].outcome, "kept-server");
  const kept = stale.body.snapshot.taskPlans.find((p) => p.date === "2026-09-12");
  assert.equal(kept.tasks[0].questionIds[0], "q1");

  // 新しい更新時刻なら受け入れる。
  const newer = await push(app, pad.deviceKey, {
    taskPlans: [plan([{ id: "t2", questionIds: ["q2"], kind: "new" }], "2026-09-12T02:00:00Z", 0)],
  });
  assert.equal(newer.body.accepted.taskPlans[0].outcome, "applied-newer");
});

test("問題マスタは中身が変わったときだけ送り直す", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const first = await push(app, device.deviceKey, { questions: { questions: QUESTIONS } });
  assert.equal(first.body.questionsStored, true);
  const hash = first.body.snapshot.questions.hash;

  const same = await push(app, device.deviceKey, { questions: { hash, questions: QUESTIONS } });
  assert.equal(same.body.questionsStored, false);
  // 端末が同じ指紋を持っているので、中身は返さない（通信量を無駄にしない）。
  assert.equal(same.body.snapshot.questions.questions, null);
  assert.equal(same.body.snapshot.questions.count, 3);

  const pulled = await pull(app, device.deviceKey, "?questionsHash=ちがう指紋".replace("ちがう指紋", "0000"));
  assert.equal(pulled.body.questions.questions.length, 3);
});

test("since を渡すと、それ以降に届いた記録だけ返る", async () => {
  let clock = Date.parse("2026-09-12T03:00:00Z");
  const { app } = createTestApp({ now: () => clock });
  const device = await joinDevice(app);
  await push(app, device.deviceKey, { records: [record("old")] });
  const marker = clock;
  clock += 60000;
  await push(app, device.deviceKey, { records: [record("new")] });

  const snapshot = await pull(app, device.deviceKey, `?since=${marker}`);
  assert.deepEqual(snapshot.body.records.map((r) => r.id), ["new"]);
  assert.equal(snapshot.body.totalRecords, 2);
});

test("端末キーが無ければ同期できず、解除すると使えなくなる", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const anonymous = await push(app, null, { records: [] });
  assert.equal(anonymous.status, 401);

  await call(app, "/api/sync/leave", { method: "POST", token: device.deviceKey, body: {} });
  const after = await push(app, device.deviceKey, { records: [] });
  assert.equal(after.status, 401);

  // 解除しても、預かっている記録は消えない。
  const status = await call(app, "/api/admin/devices", { token: OWNER_KEY });
  assert.equal(status.status, 200);
});

test("同期コードが違えば端末を登録できない", async () => {
  const { app } = createTestApp();
  await joinDevice(app);
  const denied = await call(app, "/api/sync/join", {
    method: "POST",
    body: { code: "STUDY-0000-0000", deviceName: "偽端末" },
  });
  assert.equal(denied.status, 400);
});

/* ------------------------------------------------------------------ */
/* すべて削除したことが、ほかの端末へ伝わる                            */
/* ------------------------------------------------------------------ */

test("すべて削除したことが、印として他の端末へ届く", async () => {
  const { app } = createTestApp();
  const first = await joinDevice(app, "iPhone");
  const second = await joinDevice(app, "PC");

  await push(app, first.deviceKey, {
    questions: { questions: QUESTIONS, masterVersion: 1 },
    records: [record("r1")],
    taskPlans: [{
      date: "2026-09-12",
      tasks: [{ id: "t1", questionIds: [QUESTIONS[0].id], kind: "new", order: 0 }],
      updatedAt: "2026-09-12T01:00:00Z",
      revision: 0,
    }],
    goals: [{ id: "g1", title: "目標", questionIds: [QUESTIONS[0].id], updatedAt: "2026-09-12T01:00:00Z" }],
  });

  const before = await call(app, "/api/sync/pull", { token: second.deviceKey });
  assert.equal(before.body.taskPlans.length, 1);
  assert.equal(before.body.records.length, 1);
  assert.equal(before.body.purge, null);

  const purged = await call(app, "/api/admin/data", {
    method: "DELETE",
    token: OWNER_KEY,
    body: { confirm: "DELETE" },
  });
  assert.equal(purged.body.ok, true);
  assert.ok(purged.body.purgedAtMs > 0, "消した日時が返っていない");

  // 全部消すと配るものが無くなるので、印が無いと端末には
  // 「空が返ってきた」としか見えない。印で消したことが伝わる。
  const after = await call(app, "/api/sync/pull", { token: second.deviceKey });
  assert.equal(after.body.taskPlans.length, 0);
  assert.equal(after.body.records.length, 0);
  assert.equal(after.body.purge?.atMs, purged.body.purgedAtMs, "消した印が配られていない");

  // 印は消えずに残る（久しぶりに開いた端末にも伝わるように）。
  const later = await call(app, "/api/sync/pull", { token: first.deviceKey });
  assert.equal(later.body.purge?.atMs, purged.body.purgedAtMs);
});

test("削除を知らない端末が送ってきたものは、1つも受け取らない", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app, "iPhone");
  await push(app, device.deviceKey, {
    questions: { questions: QUESTIONS, masterVersion: 1 },
    records: [record("r1")],
    goals: [{ id: "g1", title: "目標", questionIds: [QUESTIONS[0].id], updatedAt: "2026-09-12T01:00:00Z" }],
  });
  const purged = await call(app, "/api/admin/data", {
    method: "DELETE",
    token: OWNER_KEY,
    body: { confirm: "DELETE" },
  });

  // 端末は、消すより先に「手元にあるもの」を送る。
  // ここで受け取ってしまうと、消したばかりのものがそのまま戻ってきてしまう。
  const resent = await push(app, device.deviceKey, {
    records: [record("r1")],
    goals: [{ id: "g1", title: "目標", questionIds: [QUESTIONS[0].id], updatedAt: "2026-09-12T01:00:00Z" }],
    taskPlans: [{
      date: "2026-09-12",
      tasks: [{ id: "t1", questionIds: [QUESTIONS[0].id], kind: "new", order: 0 }],
      updatedAt: "2026-09-12T01:00:00Z",
      revision: 0,
    }],
  });
  assert.equal(resent.status, 200);
  assert.equal(resent.body.ignored?.reason, "purged");
  assert.deepEqual(resent.body.accepted, { records: 0, challenges: 0, taskPlans: 0, goals: 0, moves: 0 });

  const after = await call(app, "/api/sync/pull", { token: device.deviceKey });
  assert.equal(after.body.records.length, 0, "消したはずの記録が戻った");
  assert.equal(after.body.goals.length, 0, "消したはずの目標が戻った");
  assert.equal(after.body.taskPlans.length, 0, "消したはずの予定が戻った");
  assert.equal(after.body.purge?.atMs, purged.body.purgedAtMs);
});

test("削除を知った端末は、そのあとの分をふつうに送れる", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app, "iPhone");
  await push(app, device.deviceKey, { questions: { questions: QUESTIONS, masterVersion: 1 } });
  const purged = await call(app, "/api/admin/data", {
    method: "DELETE",
    token: OWNER_KEY,
    body: { confirm: "DELETE" },
  });

  // 印を受け取ったことを伝えれば、そのあとの記録はふつうに預かる。
  const sent = await push(app, device.deviceKey, {
    knownPurgeAtMs: purged.body.purgedAtMs,
    records: [record("r2")],
  });
  assert.equal(sent.body.ignored, undefined);
  assert.equal(sent.body.accepted.records, 1);

  const after = await call(app, "/api/sync/pull", { token: device.deviceKey });
  assert.equal(after.body.records.length, 1);
});

test("あとから参加した端末は、昔の削除に巻き込まれない", async () => {
  const { app } = createTestApp();
  const first = await joinDevice(app, "iPhone");
  await push(app, first.deviceKey, {
    questions: { questions: QUESTIONS, masterVersion: 1 },
    records: [record("r1")],
  });
  await call(app, "/api/admin/data", { method: "DELETE", token: OWNER_KEY, body: { confirm: "DELETE" } });

  // 削除のあとに参加した端末。手元に自分の記録を持っている。
  const later = await joinDevice(app, "あとから来たPC");
  assert.ok(later.purgedAtMs > 0, "参加のときに削除の印を渡していない");

  // 参加した時点の印を知っているものとして送れば、ふつうに預かる。
  const sent = await push(app, later.deviceKey, {
    knownPurgeAtMs: later.purgedAtMs,
    records: [record("r9")],
  });
  assert.equal(sent.body.ignored, undefined, "あとから来た端末の記録が捨てられた");
  assert.equal(sent.body.accepted.records, 1);
});
