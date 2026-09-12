// Cloudflare Workers KV / Deno KV など「キーと文字列」の保存先に合わせるドライバ。
// Cloudflare KV の API（get・put・delete・list）をそのまま使う。

export function createKvDriver(namespace) {
  if (!namespace) throw new Error("KVネームスペースが渡されていません");
  return {
    name: "kv",
    async get(key) {
      // type: "json" を使うと、壊れた値のときに例外ではなく null が返る実装がある。
      // 保存時の不具合に気づけるよう、文字列で読んで自分で解釈する。
      const raw = await namespace.get(key, { type: "text" });
      if (raw === null || raw === undefined) return null;
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`保存されている ${key} を読み取れませんでした`);
      }
    },
    async put(key, value) {
      await namespace.put(key, JSON.stringify(value));
    },
    async delete(key) {
      await namespace.delete(key);
    },
    async list(prefix = "") {
      const keys = [];
      let cursor;
      // KV の一覧は1回で返りきらないことがあるので、続きが無くなるまで読む。
      do {
        const page = await namespace.list({ prefix, cursor });
        page.keys.forEach((entry) => keys.push(entry.name));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return keys.sort();
    },
  };
}
