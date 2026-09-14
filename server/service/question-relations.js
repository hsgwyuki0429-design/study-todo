// 問題どうしの関連（前提・発展・同系統・演習）。
//
// 青チャートには「この応用例題は、あの基本例題が土台になっている」という
// つながりがあるが、問題マスタ（data/questions.json）はそれを持っていない。
// ここは、そのつながりだけを別に覚えておくための層である。
//
// 覚え方の決まりは3つ。
//
//   1. 向きは1つだけ覚える。逆向き（発展先）は読むときに作る。
//      両方を覚えると、片方だけ直したときに食い違うため。
//   2. extends（発展）は prerequisite の裏返しなので、保存するときに
//      from と to を入れ替えて prerequisite に直す。
//   3. same_theme（同系統）は向きが無いので、ID の小さいほうを from にそろえる。
//
// 出どころ（source）は book（教材に書いてある）と ai（AIの推測）を分ける。
// 見積もりと同じで、推測を実績のように扱わないため。あとから人が確かめられるよう、
// getQuestionRelations は source で絞れるようにしてある。

/** 保存する関連の種類。extends は保存しない（prerequisite に直す）。 */
export const STORED_RELATION_TYPES = Object.freeze(["prerequisite", "same_theme", "exercise_of"]);

/** 入力で受け付ける種類。 */
export const RELATION_TYPES = Object.freeze(["prerequisite", "extends", "same_theme", "exercise_of"]);

export const RELATION_SOURCES = Object.freeze(["book", "ai"]);

export const RELATION_TYPE_LABELS = Object.freeze({
  prerequisite: "from が to の前提（土台）",
  extends: "from は to の発展（保存時は prerequisite に直す）",
  same_theme: "同じ解法テーマを共有する（向きなし）",
  exercise_of: "to（EXERCISES など）は from（例題）の演習",
});

/** 向きの無い種類（保存するとき from / to をそろえる）。 */
const SYMMETRIC_TYPES = new Set(["same_theme"]);

/** 読むときに使う名前。forward は保存した向き、reverse は裏返した向き。 */
export const RELATION_BUCKETS = Object.freeze({
  prerequisite: { forward: "extendsTo", reverse: "prerequisites" },
  same_theme: { forward: "sameTheme", reverse: "sameTheme" },
  exercise_of: { forward: "exercises", reverse: "exerciseOf" },
});

export function relationKeyOf({ fromQuestionId, toQuestionId, type }) {
  return `${fromQuestionId}|${type}|${toQuestionId}`;
}

export function relationIdOf(key) {
  return `rel_${key.replace(/\|/g, "__")}`;
}

/**
 * 入力の1件を、保存する形にそろえる。
 * extends は裏返して prerequisite に、same_theme は ID 順にそろえる。
 * 呼ぶ側で項目の確かめ（型・長さ）は済ませておくこと。
 */
export function normalizeRelationInput({ fromQuestionId, toQuestionId, type, strength, source, note }) {
  let from = fromQuestionId;
  let to = toQuestionId;
  let storedType = type;
  let normalized = null;
  if (type === "extends") {
    // 「A は B の発展」＝「B は A の前提」。覚えるのは前提のほうだけ。
    from = toQuestionId;
    to = fromQuestionId;
    storedType = "prerequisite";
    normalized = "extends→prerequisite（from と to を入れ替えました）";
  } else if (SYMMETRIC_TYPES.has(type) && fromQuestionId > toQuestionId) {
    from = toQuestionId;
    to = fromQuestionId;
    normalized = "same_theme は向きが無いのでID順にそろえました";
  }
  const key = relationKeyOf({ fromQuestionId: from, toQuestionId: to, type: storedType });
  return {
    key,
    normalized,
    entry: {
      id: relationIdOf(key),
      fromQuestionId: from,
      toQuestionId: to,
      type: storedType,
      strength,
      source,
      note: note ?? null,
    },
  };
}

/**
 * 保存してあるものに、新しいものを重ねる。
 * 同じ from / to / type は上書きする（createdAt は最初のものを残す）。
 */
export function mergeRelationEntries(stored = {}, incoming = {}, { at = new Date().toISOString() } = {}) {
  const merged = { ...stored };
  for (const [key, entry] of Object.entries(incoming)) {
    if (!entry || typeof entry !== "object") continue;
    const current = merged[key] ?? null;
    merged[key] = {
      ...entry,
      createdAt: current?.createdAt ?? entry.createdAt ?? at,
      updatedAt: entry.updatedAt ?? at,
    };
  }
  return merged;
}

/**
 * 1つの問題から見た関連を、向きごとに分けて返す。
 * 保存してあるのは片方向だけなので、逆向きはここで作る。
 */
export function relationsForQuestion(entries, questionId) {
  const buckets = { prerequisites: [], extendsTo: [], sameTheme: [], exercises: [], exerciseOf: [] };
  for (const entry of entries) {
    const names = RELATION_BUCKETS[entry.type];
    if (!names) continue;
    if (entry.fromQuestionId === questionId) {
      buckets[names.forward].push({ ...entry, questionId: entry.toQuestionId, direction: "from" });
    }
    if (entry.toQuestionId === questionId) {
      buckets[names.reverse].push({ ...entry, questionId: entry.fromQuestionId, direction: "to" });
    }
  }
  return buckets;
}
