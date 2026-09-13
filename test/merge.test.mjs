// 合わせる処理そのものの確認（HTTPを通さない単体の確認）。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeStats,
  mergeEvents,
  mergeGoals,
  mergeTaskPlan,
  normalizeRecord,
  normalizeTask,
  normalizeTaskPlan,
} from "../server/service/merge.js";

test("壊れた学習記録は受け取らない", () => {
  assert.equal(normalizeRecord(null), null);
  // 日付も時刻も無いものは、いつの記録か決められないので受け取らない。
  assert.equal(normalizeRecord({ id: "a", questionId: "q", timestamp: "だめ" }), null);
  assert.equal(normalizeRecord({ id: "a", questionId: "q" }), null);
  assert.equal(normalizeRecord({ questionId: "q", date: "2026-09-12" }), null);

  const ok = normalizeRecord({ id: "a", questionId: "q", timestamp: "2026-09-12T00:00:00Z", evaluation: "perfect", durationSeconds: 12.6 });
  assert.equal(ok.durationSeconds, 13);
  assert.equal(ok.date, "2026-09-12", "古い記録でも timestamp から実施日を出す");
  assert.equal(ok.source, "timer", "古い記録はアプリで計測したものとして扱う");
  assert.equal(ok.revision, 0);
});

test("評価と所要時間は「分からない」を保てる", () => {
  const unknown = normalizeRecord({ id: "a", questionId: "q", date: "2026-09-12" });
  assert.equal(unknown.evaluation, null, "知らない評価は null（正解にも不正解にもしない）");
  assert.equal(unknown.durationSeconds, null, "分からない時間を0秒で埋めない");
  assert.equal(unknown.datePrecision, "date", "時刻が分からなければ日付だけの記録として扱う");

  // 知らない評価の値は受け取らず、未登録として扱う。
  assert.equal(normalizeRecord({ id: "a", questionId: "q", date: "2026-09-12", evaluation: "だいたい合ってた" }).evaluation, null);
});

test("イベントはIDで重複を除き、既にある分を消さない", () => {
  const stored = { a: { id: "a" } };
  const { merged, added } = mergeEvents(stored, [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(Object.keys(merged).sort(), ["a", "b"]);
  assert.equal(added, 1);
});

test("予定は版が同じなら受け入れ、古ければサーバーを残す", () => {
  const stored = normalizeTaskPlan({ date: "2026-09-12", tasks: [], updatedAt: "2026-09-12T02:00:00Z", revision: 3 });
  const same = mergeTaskPlan(stored, { ...stored, revision: 3, updatedAt: "2026-09-12T02:30:00Z" });
  assert.equal(same.outcome, "applied");
  assert.equal(same.plan.revision, 4);

  const old = mergeTaskPlan(stored, { ...stored, revision: 1, updatedAt: "2026-09-12T01:00:00Z" });
  assert.equal(old.outcome, "kept-server");
  assert.equal(old.plan.updatedAt, "2026-09-12T02:00:00Z");
});

test("目標は更新時刻が新しいほうを採る", () => {
  const stored = [{ id: "g1", title: "古い", updatedAt: "2026-09-01T00:00:00Z" }];
  const merged = mergeGoals(stored, [
    { id: "g1", title: "新しい", updatedAt: "2026-09-05T00:00:00Z" },
    { id: "g2", title: "追加", updatedAt: "2026-09-02T00:00:00Z" },
  ]);
  assert.equal(merged.find((g) => g.id === "g1").title, "新しい");
  assert.equal(merged.length, 2);
});

test("統計はイベントから数え直す", () => {
  const records = [
    { id: "1", questionId: "q1", evaluation: "perfect", durationSeconds: 60, timestamp: "2026-09-11T15:30:00Z" },
    { id: "2", questionId: "q1", evaluation: "calc_error", durationSeconds: 120, timestamp: "2026-09-12T02:00:00Z" },
  ];
  const stats = computeStats(records, [{ id: "q1", chapter: "数列" }]);
  assert.equal(stats.totalSeconds, 180);
  assert.equal(stats.uniqueQuestions, 1);
  assert.equal(stats.byChapter["数列"].count, 2);
  // どちらも日本時間では 2026-09-12 の学習。
  assert.equal(stats.byDate["2026-09-12"].count, 2);
});

test("タスクのIDは作り直さず、古いデータには pinned を補う", () => {
  const plan = normalizeTaskPlan({
    date: "2026-09-12",
    // pinned も createdAt も無い、古い形のデータ。
    tasks: [{ id: "t1", questionIds: ["q1"], kind: "new", order: 0 }],
  });
  assert.equal(plan.tasks[0].id, "t1");
  assert.equal(plan.tasks[0].pinned, false);
  assert.ok(plan.tasks[0].createdAt);
});

test("同期で受け入れるときも、サーバー側の固定は消えない", () => {
  const stored = normalizeTaskPlan({
    date: "2026-09-12",
    tasks: [{ id: "t1", questionIds: ["q1"], kind: "new", pinned: true }],
    updatedAt: "2026-09-12T02:00:00Z",
    revision: 3,
  });
  // 固定を知らない端末が、同じ版から送ってくる。
  const incoming = normalizeTaskPlan({
    date: "2026-09-12",
    tasks: [{ id: "t1", questionIds: ["q1"], kind: "review" }],
    updatedAt: "2026-09-12T02:30:00Z",
    revision: 3,
  });
  const merged = mergeTaskPlan(stored, incoming);
  assert.equal(merged.outcome, "applied");
  assert.equal(merged.plan.tasks[0].kind, "review", "端末の変更自体は入る");
  assert.equal(merged.plan.tasks[0].pinned, true, "固定は消えない");
});

test("移動を知らない端末の予定からは、移したタスクが落ちる", () => {
  const stored = normalizeTaskPlan({
    date: "2026-09-12",
    tasks: [{ id: "keep", questionIds: ["q1"], kind: "new" }],
    updatedAt: "2026-09-12T03:00:00Z",
    revision: 5,
  });
  const incoming = normalizeTaskPlan({
    date: "2026-09-12",
    tasks: [
      { id: "keep", questionIds: ["q1"], kind: "new" },
      { id: "moved", questionIds: ["q2"], kind: "new" },
    ],
    updatedAt: "2026-09-12T04:00:00Z",
    revision: 4,
  });
  const placements = { moved: { date: "2026-09-13", at: "2026-09-12T03:00:00Z" } };
  const merged = mergeTaskPlan(stored, incoming, { placements });
  assert.deepEqual(merged.plan.tasks.map((task) => task.id), ["keep"]);
  assert.equal(merged.droppedTasks, 1);

  // 最新の版を見ている端末なら、そのまま受け入れる（移動を知ったうえでの操作）。
  const aware = mergeTaskPlan(stored, { ...incoming, revision: 5 }, { placements });
  assert.deepEqual(aware.plan.tasks.map((task) => task.id), ["keep", "moved"]);
});
