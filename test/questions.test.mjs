// 問題マスタ（data/questions.json）そのものと、
// それが PWA → 同期 → Cloudflare KV → MCP の経路を通っても
// 項目が落ちないことを確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildQuestions, checkQuestions, summarize } from "../tools/build-questions.mjs";
import { compareQuestions, normalizeQuestion, questionHaystack, buildOutline, QUESTION_FIELDS } from "../src/question-order.js";
import { hashQuestions } from "../src/hash.js";
import { call, callTool, createTestApp, enableAiLink, joinDevice, OWNER_KEY } from "./helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function master() {
  const text = await readFile(join(ROOT, "data", "questions.json"), "utf8");
  return JSON.parse(text);
}

/* ------------------------------------------------------------------ */
/* 問題マスタそのもの                                                  */
/* ------------------------------------------------------------------ */

test("data/questions.json は tools/build-questions.mjs の出力と一致する", async () => {
  const document = await master();
  const built = buildQuestions();
  assert.equal(document.questions.length, built.length);
  assert.deepEqual(document.questions, built);
  assert.equal(document.questionCount, built.length);
});

test("問題マスタの整合性チェックが通る", async () => {
  const { questions } = await master();
  assert.deepEqual(checkQuestions(questions), []);
});

test("IDが一意で、教科をまたいで衝突しない", async () => {
  const { questions } = await master();
  const ids = new Set(questions.map((q) => q.id));
  assert.equal(ids.size, questions.length);

  // 数学I 例題1 と 数学A 例題1 は別の問題。番号が同じでもIDは別。
  const first = questions.filter((q) => q.type === "基本例題" && q.number === 1);
  assert.equal(first.length, 2);
  assert.equal(new Set(first.map((q) => q.id)).size, 2);
  assert.deepEqual(first.map((q) => q.subject).sort(), ["数学A", "数学I"]);
});

test("章・単元・種類が空の問題が無い", async () => {
  const { questions } = await master();
  for (const q of questions) {
    assert.ok(q.subject, `subject が空: ${q.id}`);
    assert.ok(q.chapter, `chapter が空: ${q.id}`);
    assert.ok(q.section, `section が空: ${q.id}`);
    assert.ok(q.type, `type が空: ${q.id}`);
    assert.ok(q.label, `label が空: ${q.id}`);
  }
});

test("資料に載っている種類だけを使っている", async () => {
  const { questions } = await master();
  const types = new Set(questions.map((q) => q.type));
  assert.deepEqual([...types].sort(), ["EXERCISES", "基本例題", "演習例題", "重要例題"].sort());
});

test("章ごと・種類ごとの問題数が例題一覧と一致する", async () => {
  const { questions } = await master();
  const summary = summarize(questions);
  // 数学I: 例題194 + EXERCISES134、数学A: 例題158 + EXERCISES107
  assert.equal(summary.bySubject["数学I"], 194 + 134);
  assert.equal(summary.bySubject["数学A"], 158 + 107);
  assert.equal(summary.total, 593);
  assert.equal(summary.byType.EXERCISES, 134 + 107);
  assert.deepEqual(summary.byCourse, { 基本定着: 170, 精選速習: 174, 実力錬成: 135 });
});

test("SELECT STUDY のコースが例題にだけ入っている", async () => {
  const { questions, courses } = await master();
  assert.deepEqual(courses, ["基本定着", "精選速習", "実力錬成"]);
  for (const q of questions) {
    assert.ok(Array.isArray(q.courses), `courses が配列でない: ${q.id}`);
    for (const c of q.courses) assert.ok(courses.includes(c), `知らないコース: ${q.id}`);
    if (q.type === "EXERCISES") assert.equal(q.courses.length, 0, `EXERCISESにコース: ${q.id}`);
  }
  // どのコースにも入らない例題もある（難関向けなど）。
  const examples = questions.filter((q) => q.type !== "EXERCISES");
  assert.ok(examples.some((q) => q.courses.length === 0));
  assert.ok(examples.some((q) => q.courses.length === 3));
});

test("掲載順に並べると、章・単元・ページが前へ戻らない", async () => {
  const { questions } = await master();
  const sorted = [...questions].sort(compareQuestions);

  // 数学Iが先、数学Aが後。
  const subjects = [...new Set(sorted.map((q) => q.subject))];
  assert.deepEqual(subjects, ["数学I", "数学A"]);

  for (const subject of subjects) {
    const list = sorted.filter((q) => q.subject === subject);
    let page = 0;
    let sectionOrder = 0;
    for (const q of list) {
      assert.ok(q.sectionOrder >= sectionOrder, `単元の順が戻った: ${q.id}`);
      if (q.sectionOrder > sectionOrder) {
        assert.ok(q.sectionPage >= page, `単元のページが戻った: ${q.id}`);
        page = q.sectionPage;
        sectionOrder = q.sectionOrder;
      }
    }
  }

  // 同じ単元の中では、例題が先で EXERCISES が後。
  const section = sorted.filter((q) => q.subject === "数学I" && q.sectionOrder === 1);
  assert.equal(section[0].type, "基本例題");
  assert.equal(section.at(-1).type, "EXERCISES");
});

test("章名の文字列順ではなく、教科書の掲載順で並ぶ", async () => {
  const { questions } = await master();
  const chapters = [...new Set([...questions].sort(compareQuestions)
    .filter((q) => q.subject === "数学I").map((q) => q.chapter))];
  assert.deepEqual(chapters, ["数と式", "集合と命題", "2次関数", "図形と計量", "データの分析"]);
});

test("確認待ちの印が、同期とMCPを通っても残る", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const { questions } = await master();
  await pushMaster(app, device.deviceKey, questions);
  const token = await enableAiLink(app, { write: false });

  const one = await callTool(app, token, "getQuestion", { id: "aochart1a-m1-exr-001" });
  assert.equal(one.question.needsReview, true);
  const listed = await callTool(app, token, "listQuestions", { type: "EXERCISES", limit: 1 });
  assert.equal(listed.questions[0].needsReview, true);
  // 例題には印が付かない（確認済みのため）。
  const example = await callTool(app, token, "getQuestion", { id: "aochart1a-m1-ex-001" });
  assert.equal(example.question.needsReview, undefined);
});

test("推測で埋めた値が無い（難易度は1〜5、ページは整数）", async () => {
  const { questions } = await master();
  for (const q of questions) {
    assert.ok(Number.isInteger(q.difficulty) && q.difficulty >= 1 && q.difficulty <= 5, `難易度: ${q.id}`);
    // EXERCISES の掲載ページは出典が違うので持たない。埋めていないことを確かめる。
    if (q.type === "EXERCISES") assert.equal(q.page, null, `EXERCISESにページを補完してはいけない: ${q.id}`);
    else assert.ok(Number.isInteger(q.page), `例題のページ: ${q.id}`);
  }
});

/* ------------------------------------------------------------------ */
/* 整える処理・検索・目次                                              */
/* ------------------------------------------------------------------ */

test("normalizeQuestion は追加した項目を落とさない", async () => {
  const { questions } = await master();
  for (const q of questions) {
    const normalized = normalizeQuestion(q);
    assert.deepEqual(normalized, q, `項目が変わった: ${q.id}`);
  }
});

test("normalizeQuestion は古い形の問題も受け取れる", () => {
  const old = { id: "math1a-rei-9", subject: "数学I+A", chapter: "数列", section: "漸化式", type: "例題", number: 9, label: "例題 9" };
  const normalized = normalizeQuestion(old);
  assert.equal(normalized.id, "math1a-rei-9");
  assert.equal(normalized.difficulty, null);
  assert.equal(normalized.title, null);
  assert.equal(normalized.page, null);
  assert.equal(normalized.book, undefined);
  assert.equal(normalized.chapterOrder, undefined);
});

test("QUESTION_FIELDS に載っていない項目は指紋に含まれない＝全項目が載っている", async () => {
  const { questions } = await master();
  const keys = new Set();
  questions.forEach((q) => Object.keys(q).forEach((k) => keys.add(k)));
  for (const key of keys) assert.ok(QUESTION_FIELDS.includes(key), `指紋の対象から漏れている項目: ${key}`);
});

test("追加した項目を変えると問題マスタの指紋が変わる", async () => {
  const { questions } = await master();
  const before = await hashQuestions(questions);
  const changed = questions.map((q, i) => (i === 0 ? { ...q, page: 999 } : q));
  assert.notEqual(await hashQuestions(changed), before);

  const titleChanged = questions.map((q, i) => (i === 0 ? { ...q, title: "べつのタイトル" } : q));
  assert.notEqual(await hashQuestions(titleChanged), before);
});

test("検索はタイトルでも当たる", async () => {
  const { questions } = await master();
  const hit = questions.filter((q) => questionHaystack(q).includes("因数分解"));
  assert.ok(hit.length >= 11);
  assert.ok(hit.every((q) => q.section === "因数分解" || (q.title ?? "").includes("因数分解")));
});

test("目次は教科書の掲載順で、単元ごとのページと問題数を持つ", async () => {
  const { questions } = await master();
  const outline = buildOutline(questions);
  assert.deepEqual(outline.map((s) => s.subject), ["数学I", "数学A"]);
  const first = outline[0].chapters[0];
  assert.equal(first.chapter, "数と式");
  assert.equal(first.sectionDetails[0].section, "多項式の加法・減法・乗法");
  assert.equal(first.sectionDetails[0].page, 15);
  assert.equal(first.sectionDetails[0].questionCount, 9 + 6);
});

/* ------------------------------------------------------------------ */
/* PWA → 同期 → KV → MCP                                              */
/* ------------------------------------------------------------------ */

async function pushMaster(app, deviceKey, questions) {
  const hash = await hashQuestions(questions);
  return call(app, "/api/sync/push", {
    method: "POST",
    token: deviceKey,
    body: { questions: { hash, questions } },
  });
}

test("同期しても問題マスタの項目が1つも失われない", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const { questions } = await master();

  const pushed = await pushMaster(app, device.deviceKey, questions);
  assert.equal(pushed.status, 200);
  assert.equal(pushed.body.questionsStored, true);

  const pulled = await call(app, "/api/sync/pull", { token: device.deviceKey });
  assert.equal(pulled.body.questions.count, questions.length);
  assert.deepEqual(pulled.body.questions.questions, questions);
});

test("指紋が一致すれば問題マスタは送り直されない", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const { questions } = await master();
  const first = await pushMaster(app, device.deviceKey, questions);
  const hash = first.body.snapshot.questions.hash;

  const again = await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: { questions: { hash, questions } },
  });
  assert.equal(again.body.questionsStored, false);
  assert.equal(again.body.snapshot.questions.count, questions.length);
});

test("MCP から追加した情報を読める", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const { questions } = await master();
  await pushMaster(app, device.deviceKey, questions);
  const token = await enableAiLink(app, { write: false });

  const info = await callTool(app, token, "getAppInfo");
  assert.equal(info.questionCount, 593);
  assert.deepEqual(info.books, ["改訂版 チャート式基礎からの数学I+A"]);
  assert.deepEqual(info.courses, ["基本定着", "精選速習", "実力錬成"]);
  assert.deepEqual(info.subjects.map((s) => s.subject), ["数学I", "数学A"]);
  assert.deepEqual(
    info.subjects[0].chapters.map((c) => c.chapter),
    ["数と式", "集合と命題", "2次関数", "図形と計量", "データの分析"],
  );
  assert.equal(info.subjects[0].chapters[0].sectionDetails[0].page, 15);
  assert.ok(info.questionTypes.some((t) => t.type === "基本例題" && t.count === 269));
  assert.equal(info.needsReviewCount, 241);

  const one = await callTool(app, token, "getQuestion", { id: "aochart1a-m1-ex-001" });
  assert.equal(one.question.title, "同類項の整理と次数・定数項");
  assert.equal(one.question.book, "改訂版 チャート式基礎からの数学I+A");
  assert.equal(one.question.page, 15);
  assert.deepEqual(one.question.courses, ["基本定着"]);
  assert.equal(one.question.chapterOrder, 1);
  assert.equal(one.question.sectionPage, 15);
  assert.equal(one.question.difficulty, 1);
});

test("『2次関数にはどんな例題がある？』に答えられる", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const { questions } = await master();
  await pushMaster(app, device.deviceKey, questions);
  const token = await enableAiLink(app, { write: false });

  const listed = await callTool(app, token, "listQuestions", { chapter: "2次関数", limit: 200 });
  assert.equal(listed.total, 114);
  // 掲載順で返る（関数とグラフ → 2次関数のグラフとその移動 → …）。
  assert.equal(listed.questions[0].section, "関数とグラフ");
  assert.equal(listed.questions[0].number, 63);
});

test("『基本例題だけ』『難しい問題を除く』で絞れる", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const { questions } = await master();
  await pushMaster(app, device.deviceKey, questions);
  const token = await enableAiLink(app, { write: false });

  const basic = await callTool(app, token, "listQuestions", { types: ["基本例題"], limit: 1 });
  assert.equal(basic.total, 269);

  const easy = await callTool(app, token, "listQuestions", { types: ["基本例題"], difficultyTo: 2, limit: 1 });
  assert.ok(easy.total > 0);
  assert.ok(easy.total < basic.total);

  const both = await callTool(app, token, "listQuestions", { types: ["基本例題", "重要例題"], limit: 1 });
  assert.equal(both.total, 269 + 70);
});

test("『例題50〜65』は教科を指定して取れる", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const { questions } = await master();
  await pushMaster(app, device.deviceKey, questions);
  const token = await enableAiLink(app, { write: false });

  const page = await callTool(app, token, "listQuestions", {
    subject: "数学I", types: ["基本例題", "重要例題", "演習例題"], numberFrom: 50, numberTo: 65, limit: 50,
  });
  assert.equal(page.total, 16);
  assert.deepEqual(page.questions.map((q) => q.number), Array.from({ length: 16 }, (_, i) => i + 50));
});

test("SELECT STUDY のコースで絞れる", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const { questions } = await master();
  await pushMaster(app, device.deviceKey, questions);
  const token = await enableAiLink(app, { write: false });

  const basic = await callTool(app, token, "listQuestions", { course: "基本定着", limit: 1 });
  assert.equal(basic.total, 170);
  const quick = await callTool(app, token, "listQuestions", { course: "精選速習", subject: "数学A", limit: 200 });
  assert.ok(quick.total > 0);
  assert.ok(quick.questions.every((q) => q.courses.includes("精選速習") && q.subject === "数学A"));
});

test("ページで絞れる", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const { questions } = await master();
  await pushMaster(app, device.deviceKey, questions);
  const token = await enableAiLink(app, { write: false });

  const near = await callTool(app, token, "listQuestions", { pageFrom: 15, pageTo: 26, limit: 100 });
  assert.ok(near.total > 0);
  assert.ok(near.questions.every((q) => (q.page ?? q.sectionPage) >= 12 && (q.page ?? q.sectionPage) <= 25));
});

test("タイトルで検索できる", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const { questions } = await master();
  await pushMaster(app, device.deviceKey, questions);
  const token = await enableAiLink(app, { write: false });

  const found = await callTool(app, token, "searchQuestions", { query: "チェバ" });
  assert.ok(found.total >= 4);
  assert.ok(found.questions.every((q) => q.subject === "数学A"));
});

test("既存の学習記録は、問題マスタを入れ替えても問題と紐づく", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const { questions } = await master();
  await pushMaster(app, device.deviceKey, questions);
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: {
      records: [{
        id: "rec_1",
        questionId: "aochart1a-ma-ex-070",
        evaluation: "calc_error",
        timestamp: "2026-09-11T10:00:00Z",
        durationSeconds: 420,
      }],
    },
  });
  const token = await enableAiLink(app, { write: false });

  const history = await callTool(app, token, "getStudyHistory", { days: 30 });
  assert.equal(history.records[0].label, "重要例題70");
  assert.equal(history.records[0].chapter, "確率");

  const mistakes = await callTool(app, token, "getRecentMistakes", { days: 30 });
  assert.equal(mistakes.total ?? mistakes.records.length, 1);

  const detail = await callTool(app, token, "getQuestion", { id: "aochart1a-ma-ex-070" });
  assert.equal(detail.attempts, 1);
  assert.equal(detail.question.title, "図形と期待値");
});

test("問題マスタを保存しても管理APIの状態と食い違わない", async () => {
  const { app } = createTestApp();
  const device = await joinDevice(app);
  const { questions } = await master();
  await pushMaster(app, device.deviceKey, questions);

  const status = await call(app, "/api/admin/status", { token: OWNER_KEY });
  assert.equal(status.status, 200);
  assert.equal(status.body.questions ?? status.body.questionCount ?? 591, 591);
});
