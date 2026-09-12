// テストと開発用の、その場かぎりの保存先。プロセスが終われば消える。

export function createMemoryDriver(initial = {}) {
  const store = new Map(Object.entries(structuredClone(initial)));
  return {
    name: "memory",
    async get(key) {
      const value = store.get(key);
      return value === undefined ? null : structuredClone(value);
    },
    async put(key, value) {
      store.set(key, structuredClone(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list(prefix = "") {
      return [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
  };
}
