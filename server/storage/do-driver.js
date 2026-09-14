// Cloudflare Durable Object の中の保存先。
//
// なぜこれが要るのか:
//   Cloudflare KV は「最後に書いた人が勝つ」保存先で、
//   「読んだときから変わっていなければ書く」（compare-and-swap）ができない。
//   さらに世界中に配られるまでに少し時間がかかる（結果整合）。
//   そのため、予定の部分更新のように「今の版を確かめてから書く」処理を
//   KV だけで正しく行うことはできない。
//
//   Durable Object は1つだけ存在するオブジェクトで、その中の保存先は
//   トランザクションに対応している。study-todo は1人で使うので、
//   オブジェクトを1つ（名前 "study-todo"）だけ作り、そこへ読み書きを集める。
//
// KV からの引っ越し:
//   すでに KV にデータがある場合は、初回アクセスのときに一度だけ
//   Durable Object の保存先へ写す（migrateFromKv）。写し終えるまで消さないので、
//   もし失敗しても KV 側のデータは残る。

const MIGRATION_FLAG = "__migratedFromKv";

/** Durable Object の storage を、study-todo のドライバの形にする。 */
export function createDurableObjectDriver(storage) {
  const wrap = (target) => ({
    getAlarm: () => target.getAlarm(),
    setAlarm: (at) => target.setAlarm(at),
    async get(key) {
      const value = await target.get(key);
      return value === undefined ? null : value;
    },
    async put(key, value) { await target.put(key, value); },
    async delete(key) { await target.delete(key); },
    async list(prefix = "") {
      const map = await target.list({ prefix });
      return [...map.keys()].sort();
    },
  });

  return {
    name: "durable-object",
    ...wrap(storage),
    /** Durable Object の transaction をそのまま使う。中の読み書きは他と混ざらない。 */
    transaction(mutate) {
      return storage.transaction((tx) => mutate(wrap(tx)));
    },
  };
}

/**
 * KV にあるデータを Durable Object へ写す（初回だけ）。
 * 写し終えた印を残し、2回目からは何もしない。
 */
export async function migrateFromKv(storage, namespace, { prefixes = ["studytodo:"] } = {}) {
  if (!namespace) return { migrated: false, reason: "no-kv" };
  const done = await storage.get(MIGRATION_FLAG);
  if (done) return { migrated: false, reason: "already" };

  let copied = 0;
  for (const prefix of prefixes) {
    let cursor;
    do {
      const page = await namespace.list({ prefix, cursor });
      for (const entry of page.keys) {
        // Durable Object 側に既にあるものは、新しいほうなので触らない。
        if ((await storage.get(entry.name)) !== undefined) continue;
        const raw = await namespace.get(entry.name, { type: "text" });
        if (raw === null || raw === undefined) continue;
        try {
          await storage.put(entry.name, JSON.parse(raw));
          copied += 1;
        } catch {
          // 読めない値は写さずに残す（KV 側に原本がある）。
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  await storage.put(MIGRATION_FLAG, { at: new Date().toISOString(), copied });
  return { migrated: true, copied };
}
