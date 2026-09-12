// Node で動かすための入口。手元で試すときや、別のサーバーで動かすときに使う。
//
//   STUDY_TODO_OWNER_KEY=... node server/adapters/node.js
//
// 保存先はファイル（既定は .study-todo-data/）。

import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStudyTodoMcpApp } from "../app.js";
import { createFileDriver } from "../storage/file-driver.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../..");

export function createNodeApp(env = process.env) {
  const storage = createFileDriver(env.STUDY_TODO_DATA_DIR ?? path.join(repositoryRoot, ".study-todo-data"));
  return createStudyTodoMcpApp({ storage, env });
}

/** Node の要求・応答を、標準の Request / Response に橋渡しする。 */
export function createNodeServer(app) {
  return createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const host = incoming.headers.host ?? "localhost";
    const url = `http://${host}${incoming.url}`;
    const request = new Request(url, {
      method: incoming.method,
      headers: incoming.headers,
      body: ["GET", "HEAD"].includes(incoming.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await app.fetch(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  });
}

// 直接実行されたときだけ待ち受ける（読み込まれただけなら何もしない）。
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 8788);
  const app = createNodeApp();
  if (!app.auth.hasOwnerKey()) {
    console.warn("STUDY_TODO_OWNER_KEY が未設定です。管理APIは使えません。");
  }
  createNodeServer(app).listen(port, () => {
    console.log(`study-todo MCP Server: http://localhost:${port}/mcp`);
  });
}
