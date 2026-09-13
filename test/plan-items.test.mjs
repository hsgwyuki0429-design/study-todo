// 予定と実績の結び付け方、カレンダーに何を出すかの確認（画面に依らない部分）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { itemsOf, reconcileItems, splitPlanItems, normalizeMove } from "../src/plan-items.js";
import { buildDay } from "../src/day-model.js";
import { startOfWeekKey, dateKeyOf } from "../src/datetime.js";

const task = (overrides = {}) => ({
  id: "t1",
  date: "2026-09-12",
  kind: "new",
  questionIds: ["q1", "q2"],
  ...overrides,
});

const record = (overrides = {}) => ({
  id: `rec_${Math.random().toString(36).slice(2, 8)}`,
  questionId: "q1",
  timestamp: "2026-09-12T03:00:00Z",
  evaluation: "perfect",
  durationSeconds: 300,
  ...overrides,
});

test("古い予定からも、決め打ちの itemId が読める", () => {
  const items = itemsOf(task());
  assert.deepEqual(items.map((item) => item.itemId), ["t1#0", "t1#1"]);
  // 何度読んでも同じIDになる（画面とサーバーで同じ予定を指せる）。
  assert.deepEqual(itemsOf(task()).map((item) => item.itemId), items.map((item) => item.itemId));
  assert.equal(items[0].originalDate, "2026-09-12");
});

test("同じ問題が2つ入っていても、1回ぶんずつ別の予定項目になる", () => {
  const items = itemsOf(task({ questionIds: ["q1", "q1"] }));
  assert.equal(items.length, 2);
  assert.notEqual(items[0].itemId, items[1].itemId);
});

test("問題を入れ替えても、残る問題の itemId は変わらない", () => {
  const before = itemsOf(task());
  const after = reconcileItems(task(), ["q2", "q3"]);
  assert.equal(after[0].itemId, before[1].itemId, "q2 のIDは引き継がれる");
  assert.notEqual(after[1].itemId, before[0].itemId, "新しく入れた q3 は新しいID");
});

test("1回目を実施しても、同じ問題の2回目の予定は残る", () => {
  const twice = task({ questionIds: ["q1", "q1"] });
  const items = itemsOf(twice);
  const split = splitPlanItems(twice, [record({ planItemId: items[0].itemId })], { date: "2026-09-12" });
  assert.deepEqual(split.done.map((item) => item.itemId), [items[0].itemId]);
  assert.deepEqual(split.pending.map((item) => item.itemId), [items[1].itemId]);
});

test("予定と結び付いていない古い記録は、対応を作らずに表示だけ伏せる", () => {
  const legacy = record();   // planItemId が無い
  const split = splitPlanItems(task(), [legacy], { date: "2026-09-12" });
  assert.equal(split.legacyCovered.length, 1, "同じ日・同じ問題の1件ぶんだけ伏せる");
  assert.deepEqual(split.pending.map((item) => item.questionId), ["q2"]);
  assert.equal(split.done.length, 0, "確かな対応としては数えない");

  // 対応を確かめたい場面（サーバーの判定）では、この救済を使わない。
  const strict = splitPlanItems(task(), [legacy], { date: "2026-09-12", allowLegacyMatch: false });
  assert.equal(strict.pending.length, 2);
});

test("今日は、実績と残りの予定が二重にならない", () => {
  const items = itemsOf(task());
  const day = buildDay("2026-09-12", {
    today: "2026-09-12",
    tasks: [task()],
    records: [record({ planItemId: items[0].itemId })],
  });
  assert.equal(day.attempts.example.length, 1);
  assert.deepEqual(day.planned.example.map((entry) => entry.item.questionId), ["q2"]);
});

test("過ぎた日は、実際に取り組んだ記録だけを出す（予定にない分も出す）", () => {
  const day = buildDay("2026-09-11", {
    today: "2026-09-12",
    tasks: [task({ date: "2026-09-11" })],
    records: [record({ questionId: "q9", timestamp: "2026-09-11T03:00:00Z" })],
  });
  assert.deepEqual(day.attempts.example.map((entry) => entry.questionId), ["q9"], "予定に無かった問題も出る");
  assert.equal(day.plannedCount, 0, "過ぎた日の未実施は実績マスに混ぜない");
});

test("これからの日は、予定だけを出す", () => {
  const day = buildDay("2026-09-13", {
    today: "2026-09-12",
    tasks: [task({ date: "2026-09-13" })],
    records: [],
  });
  assert.equal(day.attemptCount, 0);
  assert.equal(day.planned.example.length, 2);
  assert.equal(day.isFuture, true);
});

test("段は「例題」と「エクササイズ」に分かれる", () => {
  const type = (id) => (id.startsWith("ex") ? "EXERCISES" : "基本例題");
  const mixed = task({ questionIds: ["q1", "ex1", "ex2"] });
  const day = buildDay("2026-09-13", {
    today: "2026-09-12",
    tasks: [mixed],
    records: [],
    questionType: type,
  });
  assert.deepEqual(day.planned.example.map((entry) => entry.item.questionId), ["q1"]);
  assert.deepEqual(day.planned.exercise.map((entry) => entry.item.questionId), ["ex1", "ex2"]);
});

test("チャレンジで解いた分も、1問ずつエクササイズの段に並ぶ", () => {
  const type = (id) => (id.startsWith("ex") ? "EXERCISES" : "基本例題");
  const challengeTask = task({ id: "c1", kind: "challenge", questionIds: ["ex1", "ex2"], title: "10分チャレンジ", completed: true });
  const day = buildDay("2026-09-12", {
    today: "2026-09-12",
    tasks: [challengeTask],
    records: [
      record({ questionId: "ex1", challengeId: "chl1" }),
      record({ questionId: "ex2", challengeId: "chl1", evaluation: "calc_error" }),
    ],
    questionType: type,
  });
  assert.equal(day.attempts.exercise.length, 2, "チャレンジは1マスにまとめず、問題の数だけ並べる");
  assert.equal(day.attempts.example.length, 0);
  assert.equal(day.plannedCount, 0, "終わったチャレンジは予定として残らない");
});

test("週は月曜はじまり", () => {
  assert.equal(startOfWeekKey("2026-09-12"), "2026-09-07");   // 土曜 → その週の月曜
  assert.equal(startOfWeekKey("2026-09-07"), "2026-09-07");   // 月曜
  assert.equal(startOfWeekKey("2026-09-13"), "2026-09-07");   // 日曜
  assert.equal(startOfWeekKey("2026-09-14"), "2026-09-14");
});

test("日本時間の日付境界でも、正しい日の記録になる", () => {
  // 日本時間 2026-09-13 の午前0時30分（UTC では前日の15:30）。
  assert.equal(dateKeyOf("2026-09-12T15:30:00Z"), "2026-09-13");
  const day = buildDay("2026-09-13", {
    today: "2026-09-13",
    tasks: [],
    records: [record({ timestamp: "2026-09-12T15:30:00Z" })],
  });
  assert.equal(day.attemptCount, 1);
});

test("移動の記録は、理由が渡されなければ未入力のまま残る", () => {
  const move = normalizeMove({ id: "mv1", fromDate: "2026-09-12", toDate: "2026-09-13", items: [{ itemId: "t1#0", questionId: "q1" }] });
  assert.equal(move.reason, "unspecified", "推測した理由を入れない");
  assert.equal(move.kind, "reschedule");
  assert.equal(move.items[0].itemId, "t1#0");
  // 知らない理由の値は、そのまま保存せず「未入力」に落とす。
  const odd = normalizeMove({ id: "mv2", fromDate: "2026-09-12", toDate: "2026-09-13", reason: "でっちあげ" });
  assert.equal(odd.reason, "unspecified");
  // 日付が無いものは記録として受け取らない。
  assert.equal(normalizeMove({ id: "mv3" }), null);
});
