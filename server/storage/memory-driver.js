// テストと開発用の、その場かぎりの保存先。プロセスが終われば消える。
//
// 1つのプロセスの中だけで動くので、まとめ書き（transaction）は
// 順番待ち（mutex）で直列にすれば正しく行える。

import { createMutex } from "./mutex.js";

export function createMemoryDriver(initial = {}) {
  const store = new Map(Object.entries(structuredClone(initial)));
  const runExclusive = createMutex();

  const read = async (key) => {
    const value = store.get(key);
    return value === undefined ? null : structuredClone(value);
  };
  const write = async (key, value) => { store.set(key, structuredClone(value)); };
  const remove = async (key) => { store.delete(key); };
  const keys = async (prefix = "") => [...store.keys()].filter((key) => key.startsWith(prefix)).sort();

  return {
    name: "memory",
    get: read,
    put: write,
    delete: remove,
    list: keys,
    /** 中の読み書きが、ほかの transaction と混ざらないようにする。 */
    transaction(mutate) {
      return runExclusive(async () => {
        // 書き込みは最後にまとめて反映する。途中で失敗したら何も書かない。
        const pending = new Map();
        const removed = new Set();
        const tx = {
          async get(key) {
            if (removed.has(key)) return null;
            if (pending.has(key)) return structuredClone(pending.get(key));
            return read(key);
          },
          async put(key, value) { removed.delete(key); pending.set(key, structuredClone(value)); },
          async delete(key) { pending.delete(key); removed.add(key); },
          async list(prefix = "") {
            const all = new Set(await keys(prefix));
            pending.forEach((_value, key) => { if (key.startsWith(prefix)) all.add(key); });
            removed.forEach((key) => all.delete(key));
            return [...all].sort();
          },
        };
        const result = await mutate(tx);
        for (const key of removed) await remove(key);
        for (const [key, value] of pending) await write(key, value);
        return result;
      });
    },
  };
}
