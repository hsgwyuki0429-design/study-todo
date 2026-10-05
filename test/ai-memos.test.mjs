// AIメモ。AIが予定を組み直したときの気づきを残し、次のAIと利用者が読めること。
//
// 確かめたいのは次の点。
//   ・addAiMemo → getAiMemos で読める。同じ operationId では1件のまま
//   ・revision が食い違えば、update / delete は何も変えずに競合を返す
//   ・存在しない問題ID・目標IDは断る
//   ・getPlanningContext に memos が入る（0件なら空配列）
//   ・applyTaskChanges の memo は changeId つきで作られ、予定の変更が失敗したときは作られない
//   ・端末の同期で配られ、端末で消した・解決済みにした分がクラウドへ戻る

import { test } from "node:test";
import assert from "node:assert/strict";

import { DATA_VERSION } from "../server/service/study-service.js";
import { QUESTIONS, call, callTool, createTestApp, enableAiLink, joinDevice } from "./helpers.mjs";

const Q = QUESTIONS.map((question) => question.id);
const NOW = Date.parse("2026-09-12T03:00:00Z");

async function setup({ now = () => NOW } = {}) {
  const { app, storage } = createTestApp({ now });
  const token = await enableAiLink(app);
  const device = await joinDevice(app);
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: { questions: { questions: QUESTIONS } },
  });
  return { app, storage, token, device };
}

const pull = (app, device, since = null) => call(app, `/api/sync/pull${since ? `?since=${since}` : ""}`, { token: device.deviceKey });
const push = (app, device, body) => call(app, "/api/sync/push", { method: "POST", token: device.deviceKey, body });

async function add(app, token, args = {}) {
  return callTool(app, token, "addAiMemo", {
    operationId: `op-${Math.random().toString(36).slice(2)}`,
    category: "trend",
    body: "直近14日で学習記録があるのは10/2と10/5のみ",
    ...args,
  });
}

test("addAiMemo で足したメモが getAiMemos で読める", async () => {
  const { app, token } = await setup();
  const added = await add(app, token, { questionIds: [Q[0]], pinned: false });
  assert.equal(added.ok, true);
  assert.match(added.memo.id, /^memo_/);
  assert.equal(added.memo.revision, 1);
  assert.equal(added.memo.status, "active");
  assert.equal(added.memo.pinned, false);
  assert.equal(added.memo.author.kind, "ai");
  assert.deepEqual(added.memo.questionIds, [Q[0]]);

  const read = await callTool(app, token, "getAiMemos", {});
  assert.equal(read.memos.length, 1);
  assert.equal(read.memos[0].id, added.memo.id);
  assert.equal(read.memos[0].body, "直近14日で学習記録があるのは10/2と10/5のみ");
});

test("同じ operationId で2回送っても1件だけ。内容が違えば断る", async () => {
  const { app, token } = await setup();
  const args = { operationId: "memo-op-1", category: "handoff", body: "次回は微分の復習から" };
  const first = await callTool(app, token, "addAiMemo", args);
  const second = await callTool(app, token, "addAiMemo", args);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.replayed, true);
  assert.equal(second.memo.id, first.memo.id);
  assert.equal((await callTool(app, token, "getAiMemos", {})).total, 1);

  const different = await callTool(app, token, "addAiMemo", { ...args, body: "別の内容" });
  assert.equal(different.ok, false);
  assert.equal(different.error, "operation_conflict");
  assert.equal((await callTool(app, token, "getAiMemos", {})).total, 1);
});

test("存在しない問題ID・目標IDは、何も保存せずに断る", async () => {
  const { app, token } = await setup();
  const unknownQuestion = await add(app, token, { questionIds: [Q[0], "no-such-question"] });
  assert.equal(unknownQuestion.ok, false);
  assert.equal(unknownQuestion.error, "unknown_question");
  assert.deepEqual(unknownQuestion.unknownQuestionIds, ["no-such-question"]);

  const unknownGoal = await add(app, token, { goalId: "goal_nope" });
  assert.equal(unknownGoal.ok, false);
  assert.equal(unknownGoal.error, "unknown_goal");

  assert.equal((await callTool(app, token, "getAiMemos", {})).total, 0);

  const goal = await callTool(app, token, "addGoal", { title: "1周目", questionIds: [Q[0]] });
  const withGoal = await add(app, token, { goalId: goal.goal.id });
  assert.equal(withGoal.ok, true);
  assert.equal(withGoal.memo.goalId, goal.goal.id);
});

test("本文は1000文字まで。種類は決まった値だけ", async () => {
  const { app, token } = await setup();
  const long = await add(app, token, { body: "あ".repeat(1001) });
  assert.equal(long.ok, false);
  assert.equal(long.error, "invalid_input");
  const edge = await add(app, token, { body: "あ".repeat(1000) });
  assert.equal(edge.ok, true);
  const badCategory = await add(app, token, { category: "gossip" });
  assert.equal(badCategory.error, "invalid_input");
});

test("getAiMemos は pinned を先頭に、残りは更新の新しい順。絞り込みもできる", async () => {
  let clock = NOW;
  const { app, token } = await setup({ now: () => clock });
  const old = await add(app, token, { body: "最初のメモ", category: "decision", questionIds: [Q[1]] });
  clock += 60_000;
  const middle = await add(app, token, { body: "2番目のメモ", category: "handoff" });
  clock += 60_000;
  const pinned = await add(app, token, { body: "重要", category: "other", pinned: true });
  clock += 60_000;
  const latest = await add(app, token, { body: "いちばん新しい", category: "trend" });

  const all = await callTool(app, token, "getAiMemos", {});
  assert.deepEqual(all.memos.map((memo) => memo.id), [pinned.memo.id, latest.memo.id, middle.memo.id, old.memo.id]);

  // 更新すると新しい順の中で先頭に来る（pinned は常に先頭のまま）。
  clock += 60_000;
  await callTool(app, token, "updateAiMemo", { id: old.memo.id, expectedRevision: 1, patch: { body: "書き直した" } });
  const after = await callTool(app, token, "getAiMemos", {});
  assert.deepEqual(after.memos.map((memo) => memo.id), [pinned.memo.id, old.memo.id, latest.memo.id, middle.memo.id]);

  assert.equal((await callTool(app, token, "getAiMemos", { category: "handoff" })).memos.length, 1);
  assert.equal((await callTool(app, token, "getAiMemos", { questionId: Q[1] })).memos[0].id, old.memo.id);
  assert.equal((await callTool(app, token, "getAiMemos", { limit: 2 })).memos.length, 2);
  assert.equal((await callTool(app, token, "getAiMemos", { limit: 2 })).truncated, true);
});

test("status の既定は active。resolved にしたものは status を指定すると読める", async () => {
  const { app, token } = await setup();
  const memo = await add(app, token);
  const resolved = await callTool(app, token, "updateAiMemo", {
    id: memo.memo.id, expectedRevision: 1, patch: { status: "resolved" },
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.memo.revision, 2);
  assert.equal((await callTool(app, token, "getAiMemos", {})).total, 0);
  assert.equal((await callTool(app, token, "getAiMemos", { status: "resolved" })).total, 1);
});

test("revision が食い違うと updateAiMemo は何も変えずに競合を返す", async () => {
  const { app, token } = await setup();
  const memo = await add(app, token);
  await callTool(app, token, "updateAiMemo", { id: memo.memo.id, expectedRevision: 1, patch: { pinned: true } });

  const stale = await callTool(app, token, "updateAiMemo", {
    id: memo.memo.id, expectedRevision: 1, patch: { body: "古い版からの書き換え", status: "archived" },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "revision_conflict");
  assert.equal(stale.currentRevision, 2);
  assert.equal(stale.memo.pinned, true);

  const current = (await callTool(app, token, "getAiMemos", {})).memos[0];
  assert.equal(current.body, "直近14日で学習記録があるのは10/2と10/5のみ");
  assert.equal(current.status, "active");
  assert.equal(current.revision, 2);

  const missing = await callTool(app, token, "updateAiMemo", { id: "memo_none", expectedRevision: 1, patch: { pinned: true } });
  assert.equal(missing.error, "memo_not_found");
});

test("updateAiMemo の patch は、知らない項目・空の patch・存在しない問題IDを断る", async () => {
  const { app, token } = await setup();
  const memo = await add(app, token);
  const unknownKey = await callTool(app, token, "updateAiMemo", { id: memo.memo.id, expectedRevision: 1, patch: { author: "x" } });
  assert.equal(unknownKey.error, "invalid_input");
  const empty = await callTool(app, token, "updateAiMemo", { id: memo.memo.id, expectedRevision: 1, patch: {} });
  assert.equal(empty.error, "invalid_input");
  const unknownQuestion = await callTool(app, token, "updateAiMemo", {
    id: memo.memo.id, expectedRevision: 1, patch: { questionIds: ["no-such-question"] },
  });
  assert.equal(unknownQuestion.error, "unknown_question");
  assert.equal((await callTool(app, token, "getAiMemos", {})).memos[0].revision, 1, "どれも何も変えていない");

  const cleared = await callTool(app, token, "updateAiMemo", {
    id: memo.memo.id, expectedRevision: 1, patch: { questionIds: [Q[0], Q[1]] },
  });
  assert.deepEqual(cleared.memo.questionIds, [Q[0], Q[1]]);
  const removed = await callTool(app, token, "updateAiMemo", {
    id: memo.memo.id, expectedRevision: 2, patch: { questionIds: [] },
  });
  assert.equal(removed.memo.questionIds, undefined);
});

test("revision が食い違うと deleteAiMemo は何も消さずに競合を返す", async () => {
  const { app, token } = await setup();
  const memo = await add(app, token);
  await callTool(app, token, "updateAiMemo", { id: memo.memo.id, expectedRevision: 1, patch: { pinned: true } });

  const stale = await callTool(app, token, "deleteAiMemo", { id: memo.memo.id, expectedRevision: 1 });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, "revision_conflict");
  assert.equal((await callTool(app, token, "getAiMemos", {})).total, 1);

  const deleted = await callTool(app, token, "deleteAiMemo", { id: memo.memo.id, expectedRevision: 2 });
  assert.equal(deleted.ok, true);
  assert.equal((await callTool(app, token, "getAiMemos", {})).total, 0);
  assert.equal((await callTool(app, token, "deleteAiMemo", { id: memo.memo.id, expectedRevision: 2 })).error, "memo_not_found");
});

test("メモを読む権限だけの接続では、書き換えられない", async () => {
  const { app } = await setup();
  const readOnly = await enableAiLink(app, { write: false });
  for (const [name, args] of [
    ["addAiMemo", { operationId: "x", category: "trend", body: "x" }],
    ["updateAiMemo", { id: "memo_x", expectedRevision: 1, patch: { pinned: true } }],
    ["deleteAiMemo", { id: "memo_x", expectedRevision: 1 }],
  ]) {
    const result = await callTool(app, readOnly, name, args);
    assert.equal(result.error, "permission_denied", name);
  }
  assert.equal((await callTool(app, readOnly, "getAiMemos", {})).ok, true);
});

test("getPlanningContext の memos: 0件なら空配列、あれば pinned と直近の handoff / trend だけ", async () => {
  let clock = NOW;
  const { app, token } = await setup({ now: () => clock });
  const empty = await callTool(app, token, "getPlanningContext", { from: "2026-09-12", to: "2026-09-12" });
  assert.deepEqual(empty.memos, []);
  assert.equal(empty.memosTruncated, false);

  const oldHandoff = await add(app, token, { category: "handoff", body: "40日前の申し送り" });
  const oldPinned = await add(app, token, { category: "decision", body: "昔からの重要メモ", pinned: true });
  const resolvedPinned = await add(app, token, { category: "other", body: "解決済みの重要メモ", pinned: true });
  await callTool(app, token, "updateAiMemo", { id: resolvedPinned.memo.id, expectedRevision: 1, patch: { status: "resolved" } });
  clock += 40 * 86_400_000;
  const recentHandoff = await add(app, token, { category: "handoff", body: "最近の申し送り" });
  // 更新時刻が同じだと並びがIDで決まるので、1分ずつ進めて新しい順を決める。
  clock += 60_000;
  const recentTrend = await add(app, token, { category: "trend", body: "最近の傾向" });
  clock += 60_000;
  await add(app, token, { category: "decision", body: "最近の判断（pinned でないので入らない）" });
  await add(app, token, { category: "question", body: "最近の確認事項（入らない）" });

  const context = await callTool(app, token, "getPlanningContext", { from: "2026-10-22", to: "2026-10-22" });
  const ids = context.memos.map((memo) => memo.id);
  assert.deepEqual(ids, [oldPinned.memo.id, recentTrend.memo.id, recentHandoff.memo.id]);
  assert.ok(!ids.includes(oldHandoff.memo.id), "30日より前の handoff は入らない");
  assert.ok(!ids.includes(resolvedPinned.memo.id), "resolved は入らない");
});

test("getPlanningContext の memos は最大10件で、あふれたことを知らせる", async () => {
  const { app, token } = await setup();
  for (let index = 0; index < 12; index += 1) await add(app, token, { category: "handoff", body: `申し送り ${index}` });
  const context = await callTool(app, token, "getPlanningContext", { from: "2026-09-12", to: "2026-09-12" });
  assert.equal(context.memos.length, 10);
  assert.equal(context.memosTruncated, true);
});

async function planFixture(app, token, operationId, memo) {
  const before = await callTool(app, token, "getTasksInRange", { from: "2026-09-12", to: "2026-09-12" });
  const revision = before.days?.[0]?.revision ?? before.revisions?.["2026-09-12"] ?? 0;
  return callTool(app, token, "applyTaskChanges", {
    operationId,
    reason: "今日は30分しか取れないため",
    expectedRevisions: [{ date: "2026-09-12", revision }],
    changes: [{ op: "add", date: "2026-09-12", task: { questionIds: [Q[0]], kind: "new" } }],
    ...(memo ? { memo } : {}),
  });
}

test("applyTaskChanges に memo を渡すと、changeId が紐づいたメモが1件できる", async () => {
  const { app, token } = await setup();
  const applied = await planFixture(app, token, "plan-1", { category: "decision", body: "今日は時間が短いので例題90だけにした" });
  assert.equal(applied.ok, true);
  assert.ok(applied.changeId);
  assert.equal(applied.memo.relatedChangeId, applied.changeId);
  assert.equal(applied.memo.category, "decision");
  assert.equal(applied.memo.author.kind, "ai");

  const memos = (await callTool(app, token, "getAiMemos", {})).memos;
  assert.equal(memos.length, 1);
  assert.equal(memos[0].relatedChangeId, applied.changeId);
  assert.equal(memos[0].id, applied.memo.id);
});

test("同じ operationId で applyTaskChanges を送り直しても、メモは1件のまま", async () => {
  const { app, token } = await setup();
  const memo = { category: "decision", body: "例題90を追加した" };
  const first = await planFixture(app, token, "plan-retry", memo);
  const again = await callTool(app, token, "applyTaskChanges", {
    operationId: "plan-retry",
    reason: "今日は30分しか取れないため",
    expectedRevisions: [{ date: "2026-09-12", revision: 0 }],
    changes: [{ op: "add", date: "2026-09-12", task: { questionIds: [Q[0]], kind: "new" } }],
    memo,
  });
  assert.equal(again.replayed, true);
  assert.equal(again.memo.id, first.memo.id);
  assert.equal((await callTool(app, token, "getAiMemos", {})).total, 1);

  const different = await callTool(app, token, "applyTaskChanges", {
    operationId: "plan-retry",
    reason: "今日は30分しか取れないため",
    expectedRevisions: [{ date: "2026-09-12", revision: 0 }],
    changes: [{ op: "add", date: "2026-09-12", task: { questionIds: [Q[0]], kind: "new" } }],
    memo: { category: "decision", body: "別のメモ" },
  });
  assert.equal(different.error, "operation_conflict");
  assert.equal((await callTool(app, token, "getAiMemos", {})).total, 1);
});

test("予定の変更が失敗したときは、メモも作られない", async () => {
  const { app, token } = await setup();
  // revision が合わない（競合）。
  const conflict = await callTool(app, token, "applyTaskChanges", {
    operationId: "plan-bad-rev",
    expectedRevisions: [{ date: "2026-09-12", revision: 99 }],
    changes: [{ op: "add", date: "2026-09-12", task: { questionIds: [Q[0]], kind: "new" } }],
    memo: { category: "decision", body: "作られてはいけないメモ" },
  });
  assert.equal(conflict.ok, false);
  // 存在しない問題ID。
  const unknown = await callTool(app, token, "applyTaskChanges", {
    operationId: "plan-bad-q",
    expectedRevisions: [{ date: "2026-09-12", revision: 0 }],
    changes: [{ op: "add", date: "2026-09-12", task: { questionIds: ["no-such-question"], kind: "new" } }],
    memo: { category: "decision", body: "作られてはいけないメモ" },
  });
  assert.equal(unknown.ok, false);
  // memo の形が悪い。予定も変わらない。
  const badMemo = await callTool(app, token, "applyTaskChanges", {
    operationId: "plan-bad-memo",
    expectedRevisions: [{ date: "2026-09-12", revision: 0 }],
    changes: [{ op: "add", date: "2026-09-12", task: { questionIds: [Q[0]], kind: "new" } }],
    memo: { category: "decision", body: "あ".repeat(1001) },
  });
  assert.equal(badMemo.error, "invalid_input");
  const extra = await callTool(app, token, "applyTaskChanges", {
    operationId: "plan-extra-memo",
    expectedRevisions: [{ date: "2026-09-12", revision: 0 }],
    changes: [{ op: "add", date: "2026-09-12", task: { questionIds: [Q[0]], kind: "new" } }],
    memo: { category: "decision", body: "x", pinned: true },
  });
  assert.equal(extra.error, "invalid_input");

  assert.equal((await callTool(app, token, "getAiMemos", {})).total, 0);
  const tasks = await callTool(app, token, "getTodayTasks", { date: "2026-09-12" });
  assert.equal(tasks.tasks.length, 0, "予定も変わっていない");
});

test("メモは同期で別の端末へ配られ、端末で消した・解決済みにした分がクラウドへ戻る", async () => {
  const { app, token, device } = await setup();
  const other = await joinDevice(app, "iPad");
  const memo = await add(app, token, { category: "question", body: "平日の学習時間を教えてください" });

  const seen = await pull(app, other);
  assert.equal(seen.body.memos.length, 1);
  assert.equal(seen.body.memos[0].id, memo.memo.id);

  // 端末で「解決済みにする」（revision が1つ上がった版を送る）。
  const resolved = { ...memo.memo, status: "resolved", revision: 2, updatedAt: "2026-09-12T04:00:00.000Z" };
  const pushed = await push(app, other, { memos: [resolved] });
  assert.equal(pushed.body.accepted.memos.stored, 1);
  assert.equal((await callTool(app, token, "getAiMemos", {})).total, 0);
  assert.equal((await callTool(app, token, "getAiMemos", { status: "resolved" })).memos[0].revision, 2);

  // 古い版（revision 1）を持った端末が送り直しても、新しい版は巻き戻らない。
  await push(app, device, { memos: [memo.memo] });
  assert.equal((await callTool(app, token, "getAiMemos", { status: "resolved" })).total, 1);

  // 端末で消す → クラウドからも、ほかの端末からも消える。復活しない。
  const gone = await push(app, other, { memoDeletions: [memo.memo.id] });
  assert.equal(gone.body.accepted.memos.deleted, 1);
  await push(app, device, { memos: [memo.memo] });
  assert.equal((await callTool(app, token, "getAiMemos", { status: "resolved" })).total, 0);
  const afterDelete = await pull(app, device);
  assert.deepEqual(afterDelete.body.memos, []);
  assert.deepEqual(afterDelete.body.memoDeletions, [memo.memo.id]);
});

test("形の悪いメモが同期で届いても、保存されない", async () => {
  const { app, token, device } = await setup();
  const pushed = await push(app, device, {
    memos: [
      { id: "memo_ok1", category: "trend", body: "ok", author: { kind: "user", name: "本人" }, revision: 1 },
      { id: "bad id", category: "trend", body: "ID が不正" },
      { id: "memo_bad2", category: "gossip", body: "種類が不正" },
      { id: "memo_bad3", category: "trend", body: "" },
      "not-an-object",
    ],
  });
  assert.equal(pushed.body.accepted.memos.stored, 1);
  assert.equal(pushed.body.accepted.memos.ignored, 4);
  assert.equal((await callTool(app, token, "getAiMemos", {})).total, 1);
});

test("データ形式の版が上がっている", async () => {
  const { app, token } = await setup();
  assert.equal(DATA_VERSION, "1.6.0");
  const info = await callTool(app, token, "getAppInfo", {});
  assert.equal(info.dataVersion, "1.6.0");
  assert.equal(info.aiMemos.count, 0);
});

test("既存のデータ（メモの保存領域が無い状態）でも、そのまま読める", async () => {
  const { app, token, storage } = await setup();
  assert.equal(await storage.get("studytodo:memos"), null);
  const read = await callTool(app, token, "getAiMemos", {});
  assert.deepEqual(read.memos, []);
  const context = await callTool(app, token, "getPlanningContext", { from: "2026-09-12", to: "2026-09-12" });
  assert.deepEqual(context.memos, []);
  const synced = await call(app, "/api/sync/pull", { token: (await joinDevice(app, "iPad")).deviceKey });
  assert.deepEqual(synced.body.memos, []);
});
