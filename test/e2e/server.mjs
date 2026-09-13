// E2E 用の土台。PWA の静的ファイルと、本物の同期サーバーを同じオリジンで出す。
//
// 同じオリジンにするのは、Service Worker が同一オリジンでしか働かないため。
// 保存先はメモリなので、1回のテストごとにまっさらから始まる。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createStudyTodoMcpApp } from "../../server/app.js";
import { createMemoryDriver } from "../../server/storage/memory-driver.js";

export const OWNER_KEY = "owner-key-for-e2e-0123456789";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const isApi = (pathname) => pathname === "/mcp"
  || pathname.startsWith("/api/")
  || pathname.startsWith("/oauth/")
  || pathname.startsWith("/.well-known/");

/**
 * テスト用のサーバーを立てる。
 * offline を true にすると、静的ファイルもAPIも返さなくなる（機内モードの代わり）。
 */
export async function startTestServer() {
  const app = createStudyTodoMcpApp({
    storage: createMemoryDriver(),
    env: { STUDY_TODO_OWNER_KEY: OWNER_KEY },
  });
  const state = { offline: false };

  const server = http.createServer(async (request, response) => {
    if (state.offline) {
      request.socket.destroy();
      return;
    }
    const url = new URL(request.url, "http://localhost");
    if (isApi(url.pathname)) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const proxied = await app.fetch(new Request(`https://e2e.test${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      }));
      const body = await proxied.text();
      const headers = {};
      proxied.headers.forEach((value, key) => { headers[key] = value; });
      response.writeHead(proxied.status, headers);
      response.end(body);
      return;
    }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    const file = path.join(ROOT, pathname);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      // Service Worker の更新をテストで確かめられるよう、キャッシュはブラウザに任せない。
      "cache-control": "no-cache",
    });
    fs.createReadStream(file).pipe(response);
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return {
    origin: `http://localhost:${port}`,
    goOffline() { state.offline = true; },
    goOnline() { state.offline = false; },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

/**
 * Playwright を読む。入っていない環境では null を返し、E2E を飛ばす
 *（npm test はこれまでどおり動き続ける）。
 *
 * ブラウザの実体が入っている版を選ぶ。Playwright 本体だけあって
 * ブラウザが落ちていない、という組み合わせがあるため。
 */
export async function loadPlaywright() {
  const candidates = ["playwright", "/opt/node22/lib/node_modules/playwright/index.mjs"];
  let lastResort = null;
  for (const specifier of candidates) {
    let module = null;
    try {
      module = await import(specifier);
    } catch {
      continue;
    }
    lastResort ??= module;
    try {
      if (fs.existsSync(module.chromium.executablePath())) return module;
    } catch {
      // 実体の場所を聞けない版。次を試す。
    }
  }
  return lastResort;
}
