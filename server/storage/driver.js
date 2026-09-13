// ストレージドライバの共通仕様。
//
// study-todo のMCPサーバーは特定のホスティングに依存しないよう、保存先を
// 「キーとJSON値のとても小さな倉庫」としてだけ扱う。Cloudflare KV でも、
// Nodeのファイルでも、テスト用のメモリでも、同じ4つの操作さえあれば動く。
//
//   get(key)            … 値を読む。無ければ null。
//   put(key, value)     … 値を書く。
//   delete(key)         … 値を消す。
//   list(prefix)        … 先頭が prefix のキーを並べる。
//
// 値は必ずJSONにできるものだけを入れる。
//
// これに加えて、予定の部分更新のように「複数のキーを、途中を見せずに、
// まとめて書き換える」必要がある操作のために、任意の5つめの操作がある。
//
//   transaction(fn)     … fn の中の読み書きを、他の書き込みと混ざらないように行う。
//
// transaction を持たないドライバ（Cloudflare KV 単体）では、
// 読んでから書くまでの間に別の更新が入っても気づけない。KV は「最後に書いた人が勝つ」
// 保存先で、比較して書き込む（compare-and-swap）仕組みを持たないためである。
// そのため、正しさを保証できない操作は黙って実行せず、StorageCapabilityError で断る。
// Cloudflare では Durable Object（server/storage/do-driver.js）を使うとこの操作ができる。

/** 保存する文書に付ける版番号。読み書きの競合を見つけるために使う。 */
export const DOCUMENT_REVISION_KEY = "revision";

/** 保存先が、その操作を正しく行えないことを表す誤り。 */
export class StorageCapabilityError extends Error {
  constructor(message, { capability = "transaction" } = {}) {
    super(message);
    this.name = "StorageCapabilityError";
    this.capability = capability;
  }
}

/** このドライバが、まとめ書き（transaction）を正しく行えるか。 */
export function supportsTransactions(driver) {
  return typeof driver?.transaction === "function";
}

/**
 * 複数のキーをまとめて読み書きする。
 * 途中で他の書き込みが割り込まないことを、保存先の仕組みで保証する。
 * 保証できない保存先では実行せずに断る（黙って壊れるより良い）。
 */
export async function runTransaction(driver, mutate) {
  if (!supportsTransactions(driver)) {
    throw new StorageCapabilityError(
      "この保存先（Cloudflare KV 単体）では、複数の日の予定をまとめて安全に書き換えられません。"
      + " Durable Object を有効にしてデプロイしなおしてください（docs/mcp.md の「保存先の移行」を参照）。",
    );
  }
  return driver.transaction(mutate);
}

/**
 * 読み込み→書き換え→保存をまとめて行う。
 * transaction を持つ保存先ではその中で行い、
 * 持たない保存先では revision を見て、変わっていたらやり直す。
 */
export async function updateDocument(driver, key, mutate, { defaults = {}, retries = 3 } = {}) {
  if (supportsTransactions(driver)) {
    return driver.transaction(async (tx) => {
      const current = (await tx.get(key)) ?? { ...structuredClone(defaults), [DOCUMENT_REVISION_KEY]: 0 };
      const draft = structuredClone(current);
      const result = await mutate(draft);
      draft[DOCUMENT_REVISION_KEY] = Number(current[DOCUMENT_REVISION_KEY] ?? 0) + 1;
      await tx.put(key, draft);
      return { document: draft, result };
    });
  }
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const current = (await driver.get(key)) ?? { ...defaults, [DOCUMENT_REVISION_KEY]: 0 };
    const revision = Number(current[DOCUMENT_REVISION_KEY] ?? 0);
    const draft = structuredClone(current);
    const result = await mutate(draft);
    draft[DOCUMENT_REVISION_KEY] = revision + 1;
    const latest = await driver.get(key);
    const latestRevision = Number(latest?.[DOCUMENT_REVISION_KEY] ?? 0);
    if (latestRevision !== revision) continue;
    await driver.put(key, draft);
    return { document: draft, result };
  }
  throw new Error("保存が他の操作と競合しました。少し待ってからもう一度お試しください。");
}

/** 追記していく記録を、新しい順・上限つきで保つ。 */
export function pushCapped(list, entry, limit) {
  const next = [entry, ...(Array.isArray(list) ? list : [])];
  return next.slice(0, Math.max(1, limit));
}
