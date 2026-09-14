// 問題どうしの関連（前提・発展・同系統・演習）の登録と読み取り。
//
// 確かめたいのは3つ。
//   ・覚えるのは片方向だけで、逆向きは読むときに作られること
//   ・出どころ（book / ai）が混ざらず、あとから絞れること
//   ・問題マスタに無いIDは、1件も保存されないこと

import { test } from "node:test";
import assert from "node:assert/strict";

import { QUESTIONS, call, callTool, createTestApp, enableAiLink, joinDevice } from "./helpers.mjs";

const Q = QUESTIONS.map((question) => question.id);

async function setup() {
  const { app } = createTestApp();
  const token = await enableAiLink(app);
  const device = await joinDevice(app);
  await call(app, "/api/sync/push", {
    method: "POST",
    token: device.deviceKey,
    body: { questions: { questions: QUESTIONS } },
  });
  return { app, token };
}

test("前提関係を登録すると、土台側からは発展先として読める", async () => {
  const { app, token } = await setup();
  const saved = await callTool(app, token, "saveQuestionRelations", {
    relations: [{
      fromQuestionId: Q[0],
      toQuestionId: Q[1],
      type: "prerequisite",
      strength: 3,
      source: "book",
      note: "漸化式の基本手順が共通",
    }],
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.saved, 1);
  assert.equal(saved.created, 1);

  // 発展のほうから見ると「土台」。
  const applied = await callTool(app, token, "getQuestion", { id: Q[1] });
  assert.equal(applied.relations.prerequisites.length, 1);
  assert.equal(applied.relations.prerequisites[0].questionId, Q[0]);
  assert.equal(applied.relations.prerequisites[0].label, "例題 90");
  assert.equal(applied.relations.extendsTo.length, 0);

  // 土台のほうから見ると「発展先」。保存してあるのは1件だけ。
  const base = await callTool(app, token, "getQuestion", { id: Q[0] });
  assert.equal(base.relations.extendsTo.length, 1);
  assert.equal(base.relations.extendsTo[0].questionId, Q[1]);
  assert.equal(base.relations.prerequisites.length, 0);
});

test("extends は prerequisite の裏返しとして覚え直され、二重にならない", async () => {
  const { app, token } = await setup();
  const saved = await callTool(app, token, "saveQuestionRelations", {
    relations: [{ fromQuestionId: Q[1], toQuestionId: Q[0], type: "extends", source: "ai", note: "置き換えの発想を広げたもの" }],
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.normalized.length, 1);
  assert.equal(saved.relations[0].fromQuestionId, Q[0]);
  assert.equal(saved.relations[0].type, "prerequisite");

  // 同じ内容を prerequisite で入れ直しても、件数は増えず上書きになる。
  const again = await callTool(app, token, "saveQuestionRelations", {
    relations: [{ fromQuestionId: Q[0], toQuestionId: Q[1], type: "prerequisite", source: "book", strength: 3 }],
  });
  assert.equal(again.updated, 1);
  assert.equal(again.created, 0);

  const all = await callTool(app, token, "getQuestionRelations", { questionIds: [Q[0], Q[1]] });
  assert.equal(all.total, 1);
  assert.equal(all.relations[0].source, "book");
  assert.equal(all.relations[0].strength, 3);
});

test("same_theme は向きが無く、どちら側から引いても同じ1件になる", async () => {
  const { app, token } = await setup();
  await callTool(app, token, "saveQuestionRelations", {
    relations: [{ fromQuestionId: Q[2], toQuestionId: Q[0], type: "same_theme", source: "ai", note: "同じ置き換えの発想" }],
  });
  const one = await callTool(app, token, "getQuestionRelations", { questionIds: [Q[2]], direction: "from" });
  assert.equal(one.total, 1);
  assert.equal(one.byQuestion[Q[2]].sameTheme.length, 1);
  assert.equal(one.byQuestion[Q[2]].sameTheme[0].questionId, Q[0]);

  const other = await callTool(app, token, "getQuestionRelations", { questionIds: [Q[0]], direction: "from" });
  assert.equal(other.total, 1);
  assert.equal(other.byQuestion[Q[0]].sameTheme[0].questionId, Q[2]);
});

test("source で絞れる（AIの推測だけを見直せる）", async () => {
  const { app, token } = await setup();
  await callTool(app, token, "saveQuestionRelations", {
    relations: [
      { fromQuestionId: Q[0], toQuestionId: Q[1], type: "prerequisite", source: "book" },
      { fromQuestionId: Q[0], toQuestionId: Q[2], type: "prerequisite", source: "ai", note: "章の構成からの推測" },
    ],
  });
  const guessed = await callTool(app, token, "getQuestionRelations", { questionIds: [Q[0]], source: "ai" });
  assert.equal(guessed.total, 1);
  assert.equal(guessed.relations[0].toQuestionId, Q[2]);

  // 推測が違っていたら消せる。教材由来のほうは残る。
  const deleted = await callTool(app, token, "deleteQuestionRelations", {
    relations: [{ fromQuestionId: Q[0], toQuestionId: Q[2], type: "prerequisite" }],
  });
  assert.equal(deleted.deleted, 1);
  const rest = await callTool(app, token, "getQuestionRelations", { questionIds: [Q[0]] });
  assert.equal(rest.total, 1);
  assert.equal(rest.relations[0].source, "book");
});

test("問題マスタに無いIDや、同じ問題どうしの関連は保存されない", async () => {
  const { app, token } = await setup();
  const unknown = await callTool(app, token, "saveQuestionRelations", {
    relations: [
      { fromQuestionId: Q[0], toQuestionId: Q[1], type: "prerequisite", source: "book" },
      { fromQuestionId: Q[0], toQuestionId: "そんな問題は無い", type: "prerequisite", source: "ai" },
    ],
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, "unknown_question");
  // 1件でも駄目なら、ぜんぶ保存しない。
  const none = await callTool(app, token, "getQuestionRelations", { questionIds: [Q[0]] });
  assert.equal(none.total, 0);

  const same = await callTool(app, token, "saveQuestionRelations", {
    relations: [{ fromQuestionId: Q[0], toQuestionId: Q[0], type: "same_theme", source: "ai" }],
  });
  assert.equal(same.ok, false);
});

test("関連の登録には write の権限が要る", async () => {
  const { app } = createTestApp();
  const readOnly = await enableAiLink(app, { write: false });
  const result = await callTool(app, readOnly, "saveQuestionRelations", {
    relations: [{ fromQuestionId: Q[0], toQuestionId: Q[1], type: "prerequisite", source: "ai" }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "permission_denied");
});
