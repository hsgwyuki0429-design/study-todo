// AIメモ。AIが予定を組み直すときに気づいたこと（学習の傾向・判断の理由・申し送り）を残し、
// 次に呼ばれたAIが読んで判断を引き継ぐための覚え書き。利用者も画面で読める・消せる。
//
// サーバー（MCP）と画面（PWA）で同じ決まりを使うので、ここに1つだけ置いて共有する。
//
// 覚え方の決まり:
//   ・revision は書き換えるたびに1つ上がる。古い版を知ったまま書こうとしたら断る（楽観ロック）。
//   ・端末どうしの同期では、revision の大きいほう（同じなら updatedAt の新しいほう）を残す。
//   ・消したメモは、サーバーが墓標（IDだけ）を覚えておき、ほかの端末からも消す。

export const MEMO_CATEGORIES = Object.freeze(["trend", "decision", "handoff", "question", "other"]);
export const MEMO_STATUSES = Object.freeze(["active", "resolved", "archived"]);
export const MEMO_AUTHOR_KINDS = Object.freeze(["ai", "user"]);

export const MEMO_CATEGORY_LABELS = Object.freeze({
  trend: "傾向",
  decision: "判断",
  handoff: "申し送り",
  question: "確認",
  other: "その他",
});

export const MEMO_CATEGORY_HINTS = Object.freeze({
  trend: "学習傾向の観察",
  decision: "予定変更の判断理由",
  handoff: "次回のAIへの申し送り",
  question: "利用者への確認事項",
  other: "その他",
});

export const MEMO_STATUS_LABELS = Object.freeze({
  active: "有効",
  resolved: "解決済み",
  archived: "保管",
});

export const MEMO_LIMITS = Object.freeze({
  bodyLength: 1000,
  questionIds: 50,
  idLength: 80,
  nameLength: 80,
  // getAiMemos の件数。
  listDefault: 20,
  listMax: 100,
  // サーバーに持っておく上限。超えたら足せない（黙って古いものを消さない）。
  stored: 1000,
  // 同期で端末へ配る件数と、1回の同期で受け取る件数。
  perPull: 500,
  perPush: 200,
  // 墓標・操作IDの控えを何件残すか。
  tombstones: 2000,
  operations: 500,
  // getPlanningContext に入れる件数と、「直近」の日数。
  contextMax: 10,
  contextRecentDays: 30,
});

const DAY_MS = 86_400_000;

const timeOf = (iso) => Date.parse(iso ?? "") || 0;

/** `memo_` + ランダムな文字列。 */
export function newMemoId() {
  return `memo_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** pinned を先頭に、残りは updatedAt の新しい順。 */
export function sortMemos(list) {
  return [...list].sort((left, right) => (
    Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
    || timeOf(right.updatedAt) - timeOf(left.updatedAt)
    || String(right.id).localeCompare(String(left.id))
  ));
}

/**
 * 同じIDのメモが2つあるとき、残すほうを返す。
 * revision の大きいほう。同じなら updatedAt の新しいほう。まだ無ければ incoming。
 */
export function pickNewerMemo(current, incoming) {
  if (!current) return incoming;
  const currentRevision = Number(current.revision ?? 0);
  const incomingRevision = Number(incoming.revision ?? 0);
  if (incomingRevision !== currentRevision) return incomingRevision > currentRevision ? incoming : current;
  return timeOf(incoming.updatedAt) > timeOf(current.updatedAt) ? incoming : current;
}

/** getPlanningContext に入れるメモか（active で、pinned または直近の handoff / trend）。 */
export function isContextMemo(memo, nowMs) {
  if (memo.status !== "active") return false;
  if (memo.pinned) return true;
  if (memo.category !== "handoff" && memo.category !== "trend") return false;
  return nowMs - timeOf(memo.updatedAt) <= MEMO_LIMITS.contextRecentDays * DAY_MS;
}

/**
 * 保存してあるメモ（または同期で届いたメモ）を、保存する形にそろえる。
 * 形が合わないものは null（捨てる）。入力を信用しないための入口。
 */
export function normalizeStoredMemo(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!/^memo_[A-Za-z0-9]{1,72}$/.test(id)) return null;
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!body || body.length > MEMO_LIMITS.bodyLength) return null;
  if (!MEMO_CATEGORIES.includes(raw.category)) return null;
  const at = new Date(now).toISOString();
  const createdAt = Number.isNaN(Date.parse(raw.createdAt)) ? at : new Date(Date.parse(raw.createdAt)).toISOString();
  const updatedAt = Number.isNaN(Date.parse(raw.updatedAt)) ? createdAt : new Date(Date.parse(raw.updatedAt)).toISOString();
  const kind = MEMO_AUTHOR_KINDS.includes(raw.author?.kind) ? raw.author.kind : "ai";
  const name = typeof raw.author?.name === "string" && raw.author.name.trim()
    ? raw.author.name.trim().slice(0, MEMO_LIMITS.nameLength)
    : (kind === "ai" ? "AI" : "利用者");
  const questionIds = Array.isArray(raw.questionIds)
    ? [...new Set(raw.questionIds.filter((value) => typeof value === "string" && value && value.length <= MEMO_LIMITS.idLength))]
      .slice(0, MEMO_LIMITS.questionIds)
    : [];
  const memo = {
    id,
    createdAt,
    updatedAt,
    author: { kind, name },
    category: raw.category,
    body,
    pinned: raw.pinned === true,
    status: MEMO_STATUSES.includes(raw.status) ? raw.status : "active",
    revision: Math.max(1, Math.floor(Number(raw.revision) || 1)),
  };
  if (questionIds.length) memo.questionIds = questionIds;
  if (typeof raw.goalId === "string" && raw.goalId && raw.goalId.length <= MEMO_LIMITS.idLength) memo.goalId = raw.goalId;
  if (typeof raw.relatedChangeId === "string" && raw.relatedChangeId && raw.relatedChangeId.length <= MEMO_LIMITS.idLength) {
    memo.relatedChangeId = raw.relatedChangeId;
  }
  return memo;
}
