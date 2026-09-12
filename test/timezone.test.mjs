// 日付と時間帯の確認。日本時間の深夜〜朝に日付がずれないこと。

import { test } from "node:test";
import assert from "node:assert/strict";

import { dateKeyOf, isDateKey, shiftDateKey, startOfDayMs, todayKeyOf } from "../src/datetime.js";
import { QUESTIONS, call, callTool, createTestApp, enableAiLink, joinDevice, record } from "./helpers.mjs";

test("日本時間 00:30 は、その日の日付になる", () => {
  // JST 2026-09-12 00:30 = UTC 2026-09-11 15:30
  assert.equal(dateKeyOf("2026-09-11T15:30:00Z"), "2026-09-12");
  // UTC日付をそのまま使うと 2026-09-11 になってしまう（これが直したかった不具合）。
  assert.notEqual(dateKeyOf("2026-09-11T15:30:00Z"), "2026-09-11T15:30:00Z".slice(0, 10));
});

test("日本時間 08:00 も同じ日付になる", () => {
  assert.equal(dateKeyOf("2026-09-11T23:00:00Z"), "2026-09-12");
});

test("日付の境目（JST 23:59 と 00:00）", () => {
  assert.equal(dateKeyOf("2026-09-12T14:59:59Z"), "2026-09-12");
  assert.equal(dateKeyOf("2026-09-12T15:00:00Z"), "2026-09-13");
});

test("時間帯を変えればその土地の日付になる", () => {
  assert.equal(dateKeyOf("2026-09-11T15:30:00Z", 0), "2026-09-11");
  assert.equal(dateKeyOf("2026-09-11T15:30:00Z", -300), "2026-09-11");
  // 範囲外の値は既定（日本時間）に戻す。
  assert.equal(dateKeyOf("2026-09-11T15:30:00Z", 9999), "2026-09-12");
});

test("日付の形の確認と前後の移動", () => {
  assert.equal(isDateKey("2026-09-12"), true);
  assert.equal(isDateKey("2026-02-30"), false);
  assert.equal(isDateKey("2026/09/12"), false);
  assert.equal(shiftDateKey("2026-09-30", 1), "2026-10-01");
  assert.equal(shiftDateKey("2026-01-01", -1), "2025-12-31");
  assert.equal(startOfDayMs("2026-09-12"), Date.parse("2026-09-11T15:00:00Z"));
});

test("todayKeyOf は日本時間で今日を返す", () => {
  assert.equal(todayKeyOf(540, Date.parse("2026-09-11T16:00:00Z")), "2026-09-12");
});

test("サーバーも日本時間で『今日』を判断する", async () => {
  // UTC では 2026-09-11 だが、日本時間ではもう 2026-09-12。
  const { app } = createTestApp({ now: () => Date.parse("2026-09-11T16:00:00Z") });
  const token = await enableAiLink(app);
  const device = await joinDevice(app);
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      questions: { questions: QUESTIONS },
      records: [record("rec1", { timestamp: "2026-09-11T15:30:00Z" })],
      taskPlans: [{ date: "2026-09-12", tasks: [{ id: "t1", questionIds: ["数学I+A-例題-90"], kind: "new" }], updatedAt: "2026-09-11T16:00:00Z", revision: 0 }],
    },
  });

  const info = await callTool(app, token, "getAppInfo");
  assert.equal(info.today, "2026-09-12");

  const today = await callTool(app, token, "getTodayTasks");
  assert.equal(today.date, "2026-09-12");
  assert.equal(today.tasks.length, 1);

  const history = await callTool(app, token, "getStudyHistory", { days: 1 });
  assert.equal(history.records.length, 1);
  assert.equal(history.records[0].date, "2026-09-12");

  const stats = await callTool(app, token, "getStudyStats", { recentDays: 2 });
  assert.equal(stats.recentDays.at(-1).date, "2026-09-12");
  assert.equal(stats.recentDays.at(-1).count, 1);
});
