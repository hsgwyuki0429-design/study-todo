// Node で動かすときの保存先。1つのキーを1つのJSONファイルにする。
// 書き込みは一時ファイルへ書いてから置き換えるので、途中で止まっても壊れない。
//
// まとめ書き（transaction）は、このプロセスの中での順番待ちで直列にする。
// 同じフォルダを複数のプロセスから同時に書く使い方は想定していない
// （手元で試すときと、1台のサーバーで動かすときのための保存先）。

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { createMutex } from "./mutex.js";

function fileNameFor(key) {
  // キーには ":" や "/" が入るため、ファイル名に使える形へ置き換える。
  return `${encodeURIComponent(key)}.json`;
}

function keyFor(fileName) {
  return decodeURIComponent(fileName.replace(/\.json$/, ""));
}

export function createFileDriver(directory) {
  const root = path.resolve(directory);
  const ensure = mkdir(root, { recursive: true });
  const runExclusive = createMutex();
  const driver = {
    name: "file",
    async get(key) {
      await ensure;
      try {
        return JSON.parse(await readFile(path.join(root, fileNameFor(key)), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async put(key, value) {
      await ensure;
      const target = path.join(root, fileNameFor(key));
      const temporary = `${target}.${Date.now()}.tmp`;
      await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
      await rename(temporary, target);
    },
    async delete(key) {
      await ensure;
      try {
        await unlink(path.join(root, fileNameFor(key)));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
    async list(prefix = "") {
      await ensure;
      const names = await readdir(root);
      return names
        .filter((name) => name.endsWith(".json"))
        .map(keyFor)
        .filter((key) => key.startsWith(prefix))
        .sort();
    },
    transaction(mutate) {
      return runExclusive(async () => {
        const pending = new Map();
        const removed = new Set();
        const tx = {
          async get(key) {
            if (removed.has(key)) return null;
            if (pending.has(key)) return structuredClone(pending.get(key));
            return driver.get(key);
          },
          async put(key, value) { removed.delete(key); pending.set(key, structuredClone(value)); },
          async delete(key) { pending.delete(key); removed.add(key); },
          async list(prefix = "") {
            const all = new Set(await driver.list(prefix));
            pending.forEach((_value, key) => { if (key.startsWith(prefix)) all.add(key); });
            removed.forEach((key) => all.delete(key));
            return [...all].sort();
          },
        };
        const result = await mutate(tx);
        for (const key of removed) await driver.delete(key);
        for (const [key, value] of pending) await driver.put(key, value);
        return result;
      });
    },
  };
  return driver;
}
