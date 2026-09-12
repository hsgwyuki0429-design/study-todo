// 合わせる処理そのものの確認（HTTPを通さない単体の確認）。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeStats,
  mergeEvents,
  mergeGoals,
  mergeTaskPlan,
  normalizeRecord,
  normalizeTaskPlan,
} from "../server/service/merge.js";

test("壊れた学習記録は受け取らない", () => {
  assert.equal(normalizeRecord(null), null);
  assert.equal(normalizeRecord({ id: "a", questionId: "q", timestamp: "だめ", evaluation: "perfect" }), null);
  assert.equal(normalizeRecord({ id: "a", questionId: "q", timestamp: "2026-09-12T00:00:00Z", evaluation: "unknown" }), null);
  const ok = normalizeRecord({ id: "a", questionId: "q", timestamp: "2026-09-12T00:00:00Z", evaluation: "perfect", durationSeconds: 12.6 });
  assert.equal(ok.durationSeconds, 13);
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
