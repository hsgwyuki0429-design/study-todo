// オフライン起動と、配る対象の確認。
//
// ここで守りたいのは2つ。
//   ・Service Worker のアプリシェルに、実際に読み込むファイルが全部入っていること
//     （1つ欠けると、オフラインのときその画面だけ開けない）
//   ・Cloudflare Worker が使っている共有コードを直したら、Worker も配り直されること
//     （配り直されないと、ブラウザ側が新しくサーバー側が古い、という食い違いが起きる）

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

test("Service Worker のシェルに src の JS が全部入っている", () => {
  const sw = read("sw.js");
  const shell = new Set([...sw.matchAll(/'\.\/(src\/[\w-]+\.js)'/g)].map((m) => m[1]));
  const files = readdirSync(path.join(root, "src")).filter((name) => name.endsWith(".js"));
  const missing = files.filter((name) => !shell.has(`src/${name}`));
  assert.deepEqual(missing, [], `sw.js の SHELL に入っていない: ${missing.join(", ")}`);

  // 逆に、消したファイルが残っていると install が丸ごと失敗する。
  const stale = [...shell].filter((entry) => !files.includes(path.basename(entry)));
  assert.deepEqual(stale, [], `sw.js の SHELL に実在しないファイルがある: ${stale.join(", ")}`);
});

test("オフラインで見つからないJSに、index.html を代わりに返さない", () => {
  const sw = read("sw.js");
  // 画面の読み込み（navigate）のときだけ index.html を返す作りになっていること。
  assert.match(sw, /isNavigation/);
  assert.match(sw, /if \(isNavigation\) \{[\s\S]*?index\.html/);
});

test("Worker が使う src の共有コードは、すべてデプロイ条件に入っている", () => {
  const workflow = read(".github/workflows/deploy.yml");
  const paths = [...workflow.matchAll(/^\s+- '([^']+)'$/gm)].map((m) => m[1]);

  // server/ から辿れる src/ のファイルを集める。
  const seen = new Set();
  const shared = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = read(path.relative(root, file));
    for (const match of source.matchAll(/from\s+"([^"]+)"|from\s+'([^']+)'/g)) {
      const target = match[1] ?? match[2];
      if (!target.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), target);
      if (resolved.startsWith(path.join(root, "src"))) shared.add(path.relative(root, resolved).split(path.sep).join("/"));
      walk(resolved);
    }
  };
  const serverDir = path.join(root, "server");
  const listJs = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? listJs(path.join(dir, entry.name))
      : entry.name.endsWith(".js") ? [path.join(dir, entry.name)] : []
  ));
  for (const file of listJs(serverDir)) walk(file);

  const covered = (file) => paths.some((pattern) => (
    pattern === file || (pattern.endsWith("/**") && file.startsWith(pattern.slice(0, -2)))
  ));
  const uncovered = [...shared].filter((file) => !covered(file)).sort();
  assert.deepEqual(uncovered, [],
    `Worker が使っているのに deploy.yml の paths に無い: ${uncovered.join(", ")}`);
});
