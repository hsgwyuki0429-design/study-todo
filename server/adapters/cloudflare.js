// Cloudflare Workers 用の入口。
//
//   wrangler.toml で Durable Object を "STUDY_TODO_STORE" という名前で結び付け、
//   秘密（STUDY_TODO_OWNER_KEY）は `wrangler secret put` で入れる。
//   デプロイ: npx wrangler deploy
//
// なぜ Durable Object を通すのか:
//   予定の部分更新は「今の版を確かめてから書く」処理で、KV だけでは
//   同時更新のときに片方の変更が失われる（KV は compare-and-swap を持たない）。
//   Durable Object は1つだけ存在し、その中の保存先はトランザクションに対応している。
//   study-todo は1人で使うので、オブジェクトを1つだけ作り、
//   すべての読み書きをそこへ集める。
//
//   KV しか結び付いていない古い設定でも動くが、そのときは
//   「まとめて安全に書き換える」操作だけが使えない（理由を返して断る）。
//   引っ越しの手順は docs/mcp.md の「保存先の移行」にある。

import { createStudyTodoMcpApp } from "../app.js";
import { createKvDriver } from "../storage/kv-driver.js";
import { createDurableObjectDriver, migrateFromKv } from "../storage/do-driver.js";

/** 1人ぶんのデータを預かる唯一のオブジェクト。 */
export class StudyTodoStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.app = null;
    // 初回だけ KV からデータを写す。写し終わるまで他の要求は待つ。
    this.state.blockConcurrencyWhile(async () => {
      await migrateFromKv(this.state.storage, env.STUDY_TODO_KV);
    });
  }

  async fetch(request) {
    if (!this.app) {
      this.app = createStudyTodoMcpApp({
        storage: createDurableObjectDriver(this.state.storage),
        env: this.env,
      });
    }
    return this.app.fetch(request);
  }
}

let fallbackApp;

export default {
  async fetch(request, env) {
    if (env.STUDY_TODO_STORE) {
      // 1人ぶんなので、名前を固定して常に同じオブジェクトへ届ける。
      const id = env.STUDY_TODO_STORE.idFromName("study-todo");
      return env.STUDY_TODO_STORE.get(id).fetch(request);
    }
    // Durable Object がまだ結び付いていない古い設定。読み取りと同期は動く。
    if (!fallbackApp) {
      fallbackApp = createStudyTodoMcpApp({ storage: createKvDriver(env.STUDY_TODO_KV), env });
    }
    return fallbackApp.fetch(request);
  },
};
