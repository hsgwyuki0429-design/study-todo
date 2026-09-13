// タスク単位の部分更新の確認。
//
// ここで確かめたいのは「壊さないこと」。
//   ・指定しなかったタスクと項目が、そのまま残ること
//   ・古い予定で新しい予定を上書きできないこと
//   ・途中で失敗したときに、中途半端な状態が残らないこと
//   ・完了済み・実行中・固定のタスクを、AIが動かせないこと

import { test } from "node:test";
import assert from "node:assert/strict";

import { QUESTIONS, call, callTool, createTestApp, enableAiLink, joinDevice, record } from "./helpers.mjs";

const Q = QUESTIONS.map((question) => question.id);

async function setup({ write = true, tasks = null } = {}) {
  const { app, storage } = createTestApp();
  const token = await enableAiLink(app, { write });
  const device = await joinDevice(app);
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      questions: { questions: QUESTIONS },
      taskPlans: [{
        date: "2026-09-12",
        tasks: tasks ?? [
          { id: "t1", questionIds: [Q[0]], kind: "new", order: 0 },
          { id: "t2", questionIds: [Q[1]], kind: "new", order: 1 },
          { id: "t3", questionIds: [Q[2]], kind: "review", order: 2, title: "復習" },
        ],
        updatedAt: "2026-09-12T01:00:00Z",
        revision: 0,
      }],
    },
  });
  return { app, storage, token, device };
}

const revisionOf = async (app, token, date) => (await callTool(app, token, "getTodayTasks", { date })).revision;

/** 変更を1回投げる小道具。 */
async function change(app, token, { operationId, dates, changes, reason = "テスト" }) {
  const expectedRevisions = [];
  for (const date of dates) expectedRevisions.push({ date, revision: await revisionOf(app, token, date) });
  return callTool(app, token, "applyTaskChanges", { operationId, expectedRevisions, changes, reason });
}

test("一部だけ直しても、IDとほかの項目・ほかのタスクは変わらない", async () => {
  const { app, token } = await setup();
  const before = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });

  const result = await change(app, token, {
    operationId: "op-edit-1",
    dates: ["2026-09-12"],
    changes: [{ op: "update", taskId: "t2", patch: { kind: "priority" } }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.revisions["2026-09-12"], before.revision + 1);

  const after = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.deepEqual(after.tasks.map((task) => task.id), ["t1", "t2", "t3"]);
  const edited = after.tasks.find((task) => task.id === "t2");
  assert.equal(edited.kind, "priority");
  // 指定しなかった項目はそのまま。
  assert.deepEqual(edited.questionIds, [Q[1]]);
  // ほかのタスクも変わらない。
  assert.deepEqual(after.tasks.find((task) => task.id === "t3").questionIds, before.tasks.find((task) => task.id === "t3").questionIds);
  assert.equal(after.tasks.find((task) => task.id === "t3").title, "復習");
});

test("ほかのタスクを残したまま、追加・移動・削除ができる（IDは移しても変わらない）", async () => {
  const { app, token } = await setup();
  const result = await change(app, token, {
    operationId: "op-mix-1",
    dates: ["2026-09-12", "2026-09-13"],
    changes: [
      { op: "remove", taskId: "t1" },
      { op: "move", taskId: "t2", fromDate: "2026-09-12", toDate: "2026-09-13" },
      { op: "add", date: "2026-09-13", tempId: "new1", task: { questionIds: [Q[0]], kind: "review", title: "明日の復習" } },
    ],
    reason: "今日は30分しかないため",
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.moved[0].taskId, "t2");
  assert.equal(result.summary.created[0].tempId, "new1");

  const today = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.deepEqual(today.tasks.map((task) => task.id), ["t3"]);
  const tomorrow = await callTool(app, token, "getTodayTasks", { date: "2026-09-13" });
  // 移動してもIDは変わらない。
  assert.equal(tomorrow.tasks[0].id, "t2");
  assert.deepEqual(tomorrow.tasks[0].questionIds, [Q[1]]);
  assert.equal(tomorrow.tasks.length, 2);
});

test("並べ替えができる", async () => {
  const { app, token } = await setup();
  await change(app, token, {
    operationId: "op-order-1",
    dates: ["2026-09-12"],
    changes: [{ op: "reorder", date: "2026-09-12", taskIds: ["t3", "t1", "t2"] }],
  });
  const after = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.deepEqual(after.tasks.map((task) => task.id), ["t3", "t1", "t2"]);
  assert.deepEqual(after.tasks.map((task) => task.order), [0, 1, 2]);
});

test("古い revision では1件も変わらない", async () => {
  const { app, token } = await setup();
  const stale = await revisionOf(app, token, "2026-09-12");
  // 先に別の変更が入る。
  await change(app, token, {
    operationId: "op-first",
    dates: ["2026-09-12"],
    changes: [{ op: "remove", taskId: "t1" }],
  });

  const result = await callTool(app, token, "applyTaskChanges", {
    operationId: "op-stale",
    expectedRevisions: [{ date: "2026-09-12", revision: stale }],
    changes: [{ op: "remove", taskId: "t2" }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "revision_conflict");
  assert.equal(result.conflicts[0].date, "2026-09-12");
  assert.ok(result.nextAction);

  const after = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  // t2 は消えていない。
  assert.deepEqual(after.tasks.map((task) => task.id), ["t2", "t3"]);
});

test("同時に変更しても、片方の変更が黙って消えない", async () => {
  const { app, token } = await setup();
  const revision = await revisionOf(app, token, "2026-09-12");
  const send = (operationId, taskId) => callTool(app, token, "applyTaskChanges", {
    operationId,
    expectedRevisions: [{ date: "2026-09-12", revision }],
    changes: [{ op: "remove", taskId }],
  });
  const [left, right] = await Promise.all([send("op-a", "t1"), send("op-b", "t2")]);
  const results = [left, right];
  assert.equal(results.filter((result) => result.ok).length, 1, "同じ版からの変更は片方だけ通る");
  const rejected = results.find((result) => !result.ok);
  assert.equal(rejected.error, "revision_conflict");

  const after = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.equal(after.tasks.length, 2, "通ったほうの変更だけが反映される");
});

test("別の日どうしの同時変更は、どちらも残る", async () => {
  const { app, token } = await setup();
  const send = (operationId, date) => callTool(app, token, "applyTaskChanges", {
    operationId,
    expectedRevisions: [{ date, revision: 0 }],
    changes: [{ op: "add", date, task: { questionIds: [Q[0]], kind: "new" } }],
  });
  const [left, right] = await Promise.all([send("op-x", "2026-09-20"), send("op-y", "2026-09-21")]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  const range = await callTool(app, token, "getTasksInRange", { from: "2026-09-20", to: "2026-09-21" });
  assert.deepEqual(range.days.map((day) => day.taskCount), [1, 1]);
});

test("複数日の変更は、1つでも通らなければ1件も反映されない", async () => {
  const { app, token } = await setup();
  const revision = await revisionOf(app, token, "2026-09-12");
  const result = await callTool(app, token, "applyTaskChanges", {
    operationId: "op-atomic",
    expectedRevisions: [{ date: "2026-09-12", revision }, { date: "2026-09-13", revision: 0 }],
    changes: [
      { op: "remove", taskId: "t1" },
      { op: "add", date: "2026-09-13", task: { questionIds: [Q[1]], kind: "new" } },
      // 存在しないタスク。ここで断られる。
      { op: "remove", taskId: "t-nothing" },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "task_not_found");

  const today = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.equal(today.tasks.length, 3, "先に並んでいた削除も反映されない");
  const tomorrow = await callTool(app, token, "getTodayTasks", { date: "2026-09-13" });
  assert.equal(tomorrow.tasks.length, 0, "先に並んでいた追加も反映されない");
});

test("問題IDが間違っていれば、変更前に断られる", async () => {
  const { app, token } = await setup();
  const result = await change(app, token, {
    operationId: "op-unknown",
    dates: ["2026-09-13"],
    changes: [{ op: "add", date: "2026-09-13", task: { questionIds: ["存在しない問題"], kind: "new" } }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "unknown_question");
  const tomorrow = await callTool(app, token, "getTodayTasks", { date: "2026-09-13" });
  assert.equal(tomorrow.tasks.length, 0);
});

test("同じ要求を送り直しても、二重にならない", async () => {
  const { app, token } = await setup();
  const revision = await revisionOf(app, token, "2026-09-12");
  const args = {
    operationId: "op-retry",
    expectedRevisions: [{ date: "2026-09-12", revision }],
    changes: [{ op: "add", date: "2026-09-12", task: { questionIds: [Q[0]], kind: "review", title: "追加" } }],
  };
  const first = await callTool(app, token, "applyTaskChanges", args);
  const second = await callTool(app, token, "applyTaskChanges", args);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(second.changeId, first.changeId);

  const after = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.equal(after.tasks.length, 4, "同じ操作IDでは1回しか足されない");
});

test("同じ操作IDで内容だけ違う要求は断る", async () => {
  const { app, token } = await setup();
  const revision = await revisionOf(app, token, "2026-09-12");
  await callTool(app, token, "applyTaskChanges", {
    operationId: "op-same",
    expectedRevisions: [{ date: "2026-09-12", revision }],
    changes: [{ op: "remove", taskId: "t1" }],
  });
  const second = await callTool(app, token, "applyTaskChanges", {
    operationId: "op-same",
    expectedRevisions: [{ date: "2026-09-12", revision: revision + 1 }],
    changes: [{ op: "remove", taskId: "t2" }],
  });
  assert.equal(second.ok, false);
  assert.equal(second.error, "operation_conflict");
  const after = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.equal(after.tasks.length, 2);
});

test("完了済み・固定・実行中のタスクは、AIからは変えられない", async () => {
  const { app, token, device } = await setup({
    tasks: [
      { id: "done", questionIds: [Q[0]], kind: "new", order: 0, completed: true },
      { id: "free", questionIds: [Q[1]], kind: "new", order: 1 },
      { id: "pin", questionIds: [Q[2]], kind: "new", order: 2 },
    ],
  });

  // 固定はアプリからだけ付けられる。
  const pinned = await call(app, "/api/sync/pin", {
    method: "POST",
    token: device.deviceKey,
    body: { date: "2026-09-12", taskId: "pin", pinned: true },
  });
  assert.equal(pinned.body.ok, true);

  // 実行中の知らせもアプリから。
  await call(app, "/api/sync/activity", {
    method: "POST",
    token: device.deviceKey,
    body: { date: "2026-09-12", taskId: "free", questionId: Q[1] },
  });

  const view = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.deepEqual(view.lockedTaskIds.sort(), ["done", "free", "pin"]);
  assert.equal(view.tasks.find((task) => task.id === "free").lockedReason, "running");

  for (const [taskId, reason] of [["done", "completed"], ["pin", "pinned"], ["free", "running"]]) {
    const result = await change(app, token, {
      operationId: `op-protect-${taskId}`,
      dates: ["2026-09-12"],
      changes: [{ op: "remove", taskId }],
    });
    assert.equal(result.ok, false, `${taskId} を消せてしまった`);
    assert.equal(result.error, "protected_task");
    assert.equal(result.protection, reason);
  }

  // 固定を外すのもアプリだけ。AIには外すツールが無い。
  const after = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.equal(after.tasks.length, 3);
  assert.equal(after.tasks.find((task) => task.id === "pin").pinned, true);
});

test("実行中の知らせは期限が切れたら効かなくなる", async () => {
  let clock = Date.parse("2026-09-12T03:00:00Z");
  const { app } = createTestApp({ now: () => clock });
  const token = await enableAiLink(app);
  const device = await joinDevice(app);
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      questions: { questions: QUESTIONS },
      taskPlans: [{ date: "2026-09-12", tasks: [{ id: "t1", questionIds: [Q[0]], kind: "new" }], updatedAt: "2026-09-12T01:00:00Z", revision: 0 }],
    },
  });
  await call(app, "/api/sync/activity", {
    method: "POST", token: device.deviceKey,
    body: { date: "2026-09-12", taskId: "t1", ttlSeconds: 300 },
  });
  assert.equal((await callTool(app, token, "getTodayTasks", { date: "2026-09-12" })).tasks[0].locked, true);
  clock += 301 * 1000;
  assert.equal((await callTool(app, token, "getTodayTasks", { date: "2026-09-12" })).tasks[0].locked, false);
});

test("取り消しは新しい変更として記録され、学習記録は変わらない", async () => {
  const { app, token, device } = await setup();
  await call(app, "/api/sync/push", {
    method: "POST", token: device.deviceKey,
    body: { records: [record("rec1"), record("rec2", { questionId: Q[1] })] },
  });

  const applied = await change(app, token, {
    operationId: "op-undo-target",
    dates: ["2026-09-12", "2026-09-13"],
    changes: [
      { op: "move", taskId: "t2", fromDate: "2026-09-12", toDate: "2026-09-13" },
      { op: "remove", taskId: "t1" },
    ],
  });
  assert.equal(applied.ok, true);

  const history = await callTool(app, token, "getPlanChanges", { limit: 5 });
  assert.equal(history.changes[0].changeId, applied.changeId);
  assert.equal(history.changes[0].actorKind, "ai");

  const undone = await callTool(app, token, "undoTaskChanges", { changeId: applied.changeId, operationId: "op-undo-1" });
  assert.equal(undone.ok, true);

  const today = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  // 移したタスクは元の日へ戻り、IDも保たれる。
  assert.ok(today.tasks.some((task) => task.id === "t2"));
  // 消したタスクは作り直される（IDは新しくなる）。
  assert.equal(today.tasks.length, 3);
  assert.equal((await callTool(app, token, "getTodayTasks", { date: "2026-09-13" })).tasks.length, 0);

  // 履歴は消えず、取り消しも1件として残る。
  const after = await callTool(app, token, "getPlanChanges", { limit: 5 });
  assert.equal(after.changes[0].undoOf, applied.changeId);
  assert.equal(after.changes.find((entry) => entry.changeId === applied.changeId).undoneBy, after.changes[0].changeId);

  // 学習記録は1件も変わらない。
  assert.equal((await callTool(app, token, "getStudyStats")).totalRecords, 2);
});

test("取り消しは、あとの変更や学習が進んだタスクを壊さない", async () => {
  const { app, token, device } = await setup();
  const applied = await change(app, token, {
    operationId: "op-undo-target-2",
    dates: ["2026-09-12", "2026-09-13"],
    changes: [{ op: "move", taskId: "t2", fromDate: "2026-09-12", toDate: "2026-09-13" }],
  });

  // そのあと、利用者がそのタスクを終わらせた（アプリからの同期）。
  const tomorrow = await callTool(app, token, "getTodayTasks", { date: "2026-09-13" });
  await call(app, "/api/sync/push", {
    method: "POST", token: device.deviceKey,
    body: {
      taskPlans: [{
        date: "2026-09-13",
        tasks: tomorrow.tasks.map((task) => ({ ...task, completed: true })),
        updatedAt: "2026-09-12T05:00:00Z",
        revision: tomorrow.revision,
      }],
    },
  });

  const undone = await callTool(app, token, "undoTaskChanges", { changeId: applied.changeId, operationId: "op-undo-2" });
  assert.equal(undone.ok, false);
  assert.equal(undone.error, "undo_conflict");
  assert.equal(undone.blocked[0].reason, "completed");

  // 何も変わっていない。
  assert.equal((await callTool(app, token, "getTodayTasks", { date: "2026-09-13" })).tasks.length, 1);
  assert.equal((await callTool(app, token, "getTodayTasks", { date: "2026-09-12" })).tasks.length, 2);
});

test("移動を知らない端末が同期しても、移動前の日へ戻らない", async () => {
  const { app, token, device } = await setup();
  const before = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });

  await change(app, token, {
    operationId: "op-move-offline",
    dates: ["2026-09-12", "2026-09-13"],
    changes: [{ op: "move", taskId: "t2", fromDate: "2026-09-12", toDate: "2026-09-13" }],
  });

  // 圏外だった端末が、移動前の内容（t2 を含む）をあとから送ってくる。
  const stale = await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      taskPlans: [{
        date: "2026-09-12",
        tasks: before.tasks.map(({ id, questionIds, kind, order }) => ({ id, questionIds, kind, order })),
        updatedAt: "2026-09-12T04:00:00Z",
        revision: before.revision,
      }],
    },
  });
  assert.equal(stale.status, 200);

  const today = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.ok(!today.tasks.some((task) => task.id === "t2"), "移動したタスクが元の日に戻ってしまった");
  const tomorrow = await callTool(app, token, "getTodayTasks", { date: "2026-09-13" });
  assert.ok(tomorrow.tasks.some((task) => task.id === "t2"));
});

test("旧い形の updateTasksForDate でも、IDが保たれ保護が効く", async () => {
  const { app, token, device } = await setup();
  await call(app, "/api/sync/pin", {
    method: "POST", token: device.deviceKey,
    body: { date: "2026-09-12", taskId: "t3", pinned: true },
  });

  // 全置き換えで t1 だけを残そうとする（t2 は消え、t3 は固定なので残る）。
  const result = await callTool(app, token, "updateTasksForDate", {
    date: "2026-09-12",
    tasks: [{ questionIds: [Q[0]], kind: "new" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.keptProtectedTasks[0].taskId, "t3");

  const after = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  const ids = after.tasks.map((task) => task.id).sort();
  assert.deepEqual(ids, ["t1", "t3"], "内容が同じタスクのIDは保たれ、固定は残る");
});

test("旧い形でも expectedRevision を渡せば、古い内容では上書きできない", async () => {
  const { app, token } = await setup();
  const stale = await revisionOf(app, token, "2026-09-12");
  await change(app, token, {
    operationId: "op-before-legacy",
    dates: ["2026-09-12"],
    changes: [{ op: "remove", taskId: "t1" }],
  });
  const result = await callTool(app, token, "updateTasksForDate", {
    date: "2026-09-12",
    tasks: [],
    expectedRevision: stale,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "revision_conflict");
  assert.equal((await callTool(app, token, "getTodayTasks", { date: "2026-09-12" })).tasks.length, 2);
});

test("読み取りだけの接続では、変更も取り消しもできない", async () => {
  const { app, token } = await setup({ write: false });
  const denied = await callTool(app, token, "applyTaskChanges", {
    operationId: "op-denied",
    expectedRevisions: [{ date: "2026-09-12", revision: 1 }],
    changes: [{ op: "remove", taskId: "t1" }],
  });
  assert.equal(denied.error, "permission_denied");
  const undo = await callTool(app, token, "undoTaskChanges", {});
  assert.equal(undo.error, "permission_denied");
});

test("古い形のデータ（pinned も createdAt も無い）でも、変更と既存機能が壊れない", async () => {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  const device = await joinDevice(app);

  // 以前の版の study-todo が送ってきた形をそのまま入れる。
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      questions: { questions: QUESTIONS },
      records: [record("old1"), record("old2", { questionId: Q[1], evaluation: "calc_error" })],
      challenges: [{
        id: "chl1",
        timestamp: "2026-09-11T10:00:00Z",
        timeLimitSeconds: 720,
        totalElapsedSeconds: 700,
        succeeded: true,
        laps: [{ questionId: Q[0], durationSeconds: 350, evaluation: "perfect" }],
      }],
      goals: [{ id: "g1", title: "12月までに終える", deadline: "2026-12-31", updatedAt: "2026-09-01T00:00:00Z" }],
      taskPlans: [{
        date: "2026-09-12",
        tasks: [{ id: "legacy1", questionIds: [Q[0]], kind: "new", order: 0 }],
        updatedAt: "2026-09-12T01:00:00Z",
        revision: 0,
      }],
    },
  });

  // 既存の読み取りはそのまま動く。
  assert.equal((await callTool(app, token, "getStudyStats")).totalRecords, 2);
  assert.equal((await callTool(app, token, "getRecentChallengeResult")).result.id, "chl1");
  assert.equal((await callTool(app, token, "getGoals")).total, 1);

  const view = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.equal(view.tasks[0].id, "legacy1");
  assert.equal(view.tasks[0].pinned, false, "古いデータにも既定値が入る");

  // 古いデータのタスクも、IDを保ったまま部分更新できる。
  const changed = await change(app, token, {
    operationId: "op-legacy",
    dates: ["2026-09-12"],
    changes: [{ op: "update", taskId: "legacy1", patch: { kind: "review" } }],
  });
  assert.equal(changed.ok, true);
  const after = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.equal(after.tasks[0].id, "legacy1");
  assert.equal(after.tasks[0].kind, "review");
  // 学習記録とチャレンジ結果は変わらない。
  assert.equal((await callTool(app, token, "getStudyStats")).totalRecords, 2);
  assert.equal((await callTool(app, token, "getChallengeResults")).total, 1);
});

test("固定を解除するツールはAIに公開されていない", async () => {
  const { app, token } = await setup();
  const list = await call(app, "/mcp", {
    method: "POST",
    token,
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  const names = list.body.result.tools.map((tool) => tool.name);
  assert.ok(!names.some((name) => /(^|[a-z])(pin|unpin)([A-Z]|$)|固定/.test(name)));
  // 予定の変更ツールの入力に、pinned や completed を混ぜ込めないことも確かめる。
  const applyTool = list.body.result.tools.find((tool) => tool.name === "applyTaskChanges");
  const body = applyTool.inputSchema.properties.changes.items.properties.task;
  assert.ok(!("pinned" in body.properties));
  assert.ok(!("completed" in body.properties));
  assert.equal(body.additionalProperties, false);
});

test("守られているタスクは、並べ替えでも動かせない", async () => {
  const { app, token, device } = await setup();
  await call(app, "/api/sync/pin", {
    method: "POST", token: device.deviceKey,
    body: { date: "2026-09-12", taskId: "t1", pinned: true },
  });
  const denied = await change(app, token, {
    operationId: "op-reorder-pinned",
    dates: ["2026-09-12"],
    changes: [{ op: "reorder", date: "2026-09-12", taskIds: ["t2", "t1", "t3"] }],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "protected_task");

  // 固定したタスクの位置を変えない並べ替えなら通る。
  const allowed = await change(app, token, {
    operationId: "op-reorder-ok",
    dates: ["2026-09-12"],
    changes: [{ op: "reorder", date: "2026-09-12", taskIds: ["t1", "t3", "t2"] }],
  });
  assert.equal(allowed.ok, true);
});

test("同じ要求の中で、移したタスクをさらに編集できる", async () => {
  const { app, token } = await setup();
  const result = await change(app, token, {
    operationId: "op-move-then-edit",
    dates: ["2026-09-12", "2026-09-13"],
    changes: [
      { op: "move", taskId: "t2", fromDate: "2026-09-12", toDate: "2026-09-13" },
      { op: "update", taskId: "t2", date: "2026-09-13", patch: { kind: "review", title: "明日に回した分" } },
    ],
  });
  assert.equal(result.ok, true);
  const tomorrow = await callTool(app, token, "getTodayTasks", { date: "2026-09-13" });
  assert.equal(tomorrow.tasks[0].id, "t2");
  assert.equal(tomorrow.tasks[0].kind, "review");
  assert.equal(tomorrow.tasks[0].title, "明日に回した分");
});

test("足したタスクを、同じ要求の中で消しても矛盾しない", async () => {
  const { app, token } = await setup();
  const before = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  const result = await change(app, token, {
    operationId: "op-add-then-remove",
    dates: ["2026-09-12"],
    changes: [
      { op: "add", date: "2026-09-12", task: { questionIds: [Q[0]], kind: "new" } },
      { op: "remove", taskId: "t1" },
    ],
  });
  assert.equal(result.ok, true);
  const after = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.equal(after.tasks.length, before.tasks.length);
  assert.ok(!after.tasks.some((task) => task.id === "t1"));
});
