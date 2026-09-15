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

const DAILY_ROUTE = '/__internal/daily-replan';

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

  getApp() {
    if (!this.app) {
      this.app = createStudyTodoMcpApp({
        storage: createDurableObjectDriver(this.state.storage),
        env: this.env,
        waitUntil: (promise) => this.state.waitUntil(promise),
        // 秘密は publicReplan で除いてある（eventId / trigger / date / state / error だけ）。
        onReplan: (summary) => console.info(summary.trigger === 'manual' ? 'manual_replan' : 'daily_replan', summary),
      });
    }
    return this.app;
  }

  async fetch(request) {
    const app = this.getApp();
    if (new URL(request.url).pathname === DAILY_ROUTE && request.method === 'POST') {
      const { scheduledTime } = await request.json();
      return Response.json(await app.replans.daily(scheduledTime));
    }
    return app.fetch(request);
  }

  async alarm() {
    await this.getApp().replans.resumeDeferred();
  }
}

let fallbackApp;

export default {
  async scheduled(event, env, ctx) {
    if (event.cron !== '0 18 * * *') return;
    if (!env.STUDY_TODO_STORE) throw new Error('daily_replan_requires_durable_object');
    const id = env.STUDY_TODO_STORE.idFromName('study-todo');
    ctx.waitUntil((async () => {
      const response = await env.STUDY_TODO_STORE.get(id).fetch(new Request(`https://internal${DAILY_ROUTE}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scheduledTime: event.scheduledTime }),
      }));
      if (!response.ok) throw new Error('daily_replan_delivery_failed');
    })());
  },
  async fetch(request, env) {
    // No external header/token can enter the internal scheduling path.
    if (new URL(request.url).pathname.startsWith('/__internal/')) return new Response(null, { status: 404 });
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
