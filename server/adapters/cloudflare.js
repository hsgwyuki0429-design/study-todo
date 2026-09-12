// Cloudflare Workers 用の入口。
//
//   wrangler.toml で KV を "STUDY_TODO_KV" という名前で結び付け、
//   秘密（STUDY_TODO_OWNER_KEY）は `wrangler secret put` で入れる。
//   デプロイ: npx wrangler deploy

import { createStudyTodoMcpApp } from "../app.js";
import { createKvDriver } from "../storage/kv-driver.js";

let app;

export default {
  async fetch(request, env) {
    // Worker は呼び出しをまたいで生き続けることがあるので、組み立ては一度だけ。
    if (!app) app = createStudyTodoMcpApp({ storage: createKvDriver(env.STUDY_TODO_KV), env });
    return app.fetch(request);
  },
};
