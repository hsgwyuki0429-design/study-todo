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

/** 保存する文書に付ける版番号。読み書きの競合を見つけるために使う。 */
export const DOCUMENT_REVISION_KEY = "revision";

/**
 * 読み込み→書き換え→保存をまとめて行う。
 * 途中で他の書き込みが入った場合は revision が変わるので、その場合だけやり直す。
 */
export async function updateDocument(driver, key, mutate, { defaults = {}, retries = 3 } = {}) {
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
