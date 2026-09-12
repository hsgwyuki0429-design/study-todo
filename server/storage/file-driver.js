// Node で動かすときの保存先。1つのキーを1つのJSONファイルにする。
// 書き込みは一時ファイルへ書いてから置き換えるので、途中で止まっても壊れない。

import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

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
  return {
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
  };
}
