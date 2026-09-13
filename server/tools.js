// study-todo がAIへ公開するMCP Tools。
//
// ここはプロトコルとサービス層をつなぐ薄い層に留める。
// 実際の処理は server/service/study-service.js にあり、
// 管理API（設定画面）からも同じ処理を使える。
//
// 学習実績の扱いについての決めごと（ここがこのサーバーの要）:
//
//   ・AIが実績を作れるのは、**本人が「やった」と言ったとき**の代理入力だけである。
//     予定が入っていること、時間の見積もり、AIの推測は、実績の根拠にならない。
//   ・実績を触るには records 権限が要る（予定を変える write とは別の権限）。
//     すでに配ってある read / write のトークンでは、実績は1件も変えられない。
//   ・分からない評価・時間は埋めない。未登録として保存する。
//   ・取り消しは消すのではなく、印をつけて集計から外す（履歴は残る）。
//   ・チャレンジ結果は、このサーバーからは作れない（実際に挑戦した端末だけが作る）。

import { toolResult } from "./core/mcp.js";
import { PermissionError, requireScope } from "./auth/tokens.js";
import { ValidationError } from "./core/validate.js";
import { SERVICE_LIMITS } from "./service/study-service.js";
import { EVALUATIONS, MISTAKE_EVALUATIONS, TASK_KINDS } from "./service/merge.js";
import { CHANGE_LIMITS } from "./service/task-changes.js";
import { GOAL_COMPLETION_TYPES, GOAL_STATUSES } from "../src/goals.js";
import { WEEKDAY_KEYS } from "../src/availability.js";
import { EVALUATION_VALUES } from "../src/records-model.js";

const TIMEZONE_PROPERTY = {
  type: "integer",
  minimum: -840,
  maximum: 840,
  description: "「今日」を判定する時間帯のずれ（分）。日本標準時は540で、省略したときも540として扱う。日本にいるなら指定しなくてよい。",
};

const DATE_PROPERTY = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "日付（YYYY-MM-DD）。日本時間での日付として扱う。",
};

/** 予定1件の形。updateTodayTasks と updateTasksForDate で共通。 */
const TASK_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description: "予定1件。「例題90〜92を解く」のようなまとまりを1件とする。",
  properties: {
    id: {
      type: "string",
      maxLength: 80,
      description: "すでにある予定を残すときは、その task.id をそのまま渡す。渡すとIDが保たれ、学習中の状態や固定も引き継がれる。新しく作る予定では渡さない。",
    },
    questionIds: {
      type: "array",
      items: { type: "string" },
      maxItems: SERVICE_LIMITS.questionIdsPerTask,
      description: "この予定で解く問題のID。listQuestions / searchQuestions が返す question.id をそのまま使う（「例題90」のような表示名ではない）。kind が challenge のときは、その回で挑戦する問題をすべて並べる。空にする場合は title が必要。",
    },
    kind: {
      type: "string",
      enum: [...TASK_KINDS],
      description: "予定の種類。new=初めて解く / review=復習 / challenge=制限時間つきの挑戦（まとめて解いて最後に評価する） / priority=優先して取り組む。省略すると new。",
    },
    title: {
      type: "string",
      maxLength: 120,
      description: "画面に出す見出し。省略すると問題名から作られる。問題IDを伴わない予定（「ノート整理」など）のときは必須。",
    },
    timeLimitSeconds: {
      type: "integer",
      minimum: 60,
      maximum: 21600,
      description: "制限時間（秒）。主に kind=challenge で使う。省略するとカウントアップ（制限なし）になる。",
    },
    order: { type: "integer", minimum: 0, maximum: 999, description: "並び順。渡された tasks の並びがそのまま順番になるので、ふつうは指定しなくてよい。" },
    completed: { type: "boolean", description: "指定できない。完了になるのは study-todo で実際に学習したときだけで、AIからは付けられない（true を渡すと断られる）。" },
  },
};

const REPLACE_NOTE = [
  "【古い形。ふつうは applyTaskChanges を使うこと】",
  "この操作は、その日の予定を **まるごと置き換える**（追加ではない）。",
  "いま入っている予定を残したい場合は、先に getTodayTasks / getTasksInRange で取得し、",
  "残す予定も含めた全体を tasks に渡すこと。tasks に空配列を渡すとその日の予定は空になる。",
  "渡された内容は中でタスク単位の変更へ直され、内容が同じタスクのIDは保たれる。",
  "完了済み・実行中・固定（locked が true）のタスクは、この操作でも変更・削除できず、そのまま残る。",
  "この操作で学習記録が消えることはない。変えられるのは「これからやる予定」だけ。",
].join("");

/** 変更の対象になる日と、その日の revision。 */
const EXPECTED_REVISIONS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: CHANGE_LIMITS.datesPerRequest,
  description: "変更する日すべての「今の revision」。移動するときは移動元と移動先の両方が必要。"
    + " getTodayTasks / getTasksInRange が返した revision をそのまま渡す。まだ予定が無い日は 0。"
    + " 1日でも食い違うと、1件も変更せずに競合として返す。",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["date", "revision"],
    properties: {
      date: DATE_PROPERTY,
      revision: { type: "integer", minimum: 0, description: "その日の予定の版。予定がまだ無い日は 0。" },
    },
  },
};

/** 計画のもとにした状態が、反映のときに変わっていないかを確かめるための版。 */
const EXPECTED_CONTEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  description: "getPlanningContext が返した expectedContext をそのまま渡す。"
    + " 目標や学習可能時間が、計画を作ってから変わっていた場合は、何も変えずに context_stale を返す。",
  properties: {
    goalsRevision: { type: "integer", minimum: 0, description: "目標全体の版。" },
    availabilityRevision: { type: "integer", minimum: 0, description: "学習可能時間の設定の版。" },
  },
};

const TASK_BODY_PROPERTIES = {
  questionIds: {
    type: "array",
    items: { type: "string" },
    maxItems: CHANGE_LIMITS.questionIdsPerTask,
    description: "この予定で解く問題のID（listQuestions が返す question.id）。空にする場合は title が必要。",
  },
  kind: { type: "string", enum: [...TASK_KINDS], description: "予定の種類。省略すると new。" },
  title: { type: "string", maxLength: 120, description: "画面に出す見出し。問題IDを伴わない予定では必須。" },
  timeLimitSeconds: { type: "integer", minimum: 60, maximum: 21600, description: "制限時間（秒）。主に kind=challenge で使う。" },
  position: { type: "integer", minimum: 0, maximum: CHANGE_LIMITS.tasksPerDay, description: "その日の中での位置（0が先頭）。省略すると最後。" },
  goalId: {
    type: "string",
    maxLength: 80,
    description: "どの目標のための予定か。渡すと、その予定から実施された取り組みが目標の実績として数えられる。"
      + " 目標に結び付けない予定なら渡さない（あとから目標の実績には数えられない）。",
  },
};

const CHANGE_SCHEMA = {
  type: "object",
  description: "変更1つ。op で何をするかを決め、必要な項目だけを渡す。",
  required: ["op"],
  properties: {
    op: {
      type: "string",
      enum: ["add", "update", "remove", "move", "reorder", "carryOver"],
      description: "add=タスクを足す / update=既存のタスクの項目を変える / remove=消す / move=タスクごと別の日へ移す（IDは変わらない） / reorder=その日の並びを決める / carryOver=まだ取り組んでいない分だけを別の日へ繰り越す。",
    },
    date: { ...DATE_PROPERTY, description: "add・reorder では必須。update・remove では省略でき、その場合は expectedRevisions の日から探す。" },
    taskId: { type: "string", maxLength: 80, description: "update・remove・move の対象。getTodayTasks が返す task.id。" },
    tempId: { type: "string", maxLength: 80, description: "add のときの目印。結果の created で、発行された本当のIDと対応が分かる。" },
    task: {
      type: "object",
      additionalProperties: false,
      description: "add で作る予定の中身。",
      properties: TASK_BODY_PROPERTIES,
    },
    patch: {
      type: "object",
      additionalProperties: false,
      description: "update で変える項目だけ。渡さなかった項目はそのまま残る。",
      properties: TASK_BODY_PROPERTIES,
    },
    fromDate: { ...DATE_PROPERTY, description: "move の移動元。省略すると expectedRevisions の日から探す。" },
    toDate: { ...DATE_PROPERTY, description: "move の移動先。必須。" },
    position: { type: "integer", minimum: 0, maximum: CHANGE_LIMITS.tasksPerDay, description: "move したあとの位置。省略すると最後。" },
    taskIds: {
      type: "array",
      items: { type: "string", maxLength: 80 },
      maxItems: CHANGE_LIMITS.tasksPerDay,
      description: "reorder のときの、その日のタスクIDを希望する順に並べたもの。過不足があると断られる。",
    },
    itemIds: {
      type: "array",
      items: { type: "string", maxLength: 120 },
      maxItems: CHANGE_LIMITS.questionIdsPerTask,
      description: "carryOver で動かす予定項目（1回の取り組み）のID。省略すると、そのタスクの未実施の分すべて。"
        + " すでに取り組んだ分を含めると断られる（実績は実施した日に残す）。",
    },
    kind: {
      type: "string",
      enum: ["carry_over", "reschedule"],
      description: "move / carryOver の種類。carry_over=やり残しの繰り越し / reschedule=事前の予定変更。",
    },
    reason: {
      type: "string",
      enum: ["time_shortage", "too_hard", "schedule_change", "other", "unspecified"],
      description: "移動の理由。**利用者が言ったときだけ**入れる。推測で埋めず、分からなければ渡さない（unspecified のまま残る）。",
    },
    reasonNote: { type: "string", maxLength: 200, description: "利用者の言葉をそのまま残したいときだけ。推測を書かない。" },
  },
};

/**
 * ツールを定義する。権限の確認と、失敗したときの伝え方をここで揃える。
 * 入力の誤りや権限不足は、プロトコルの誤りではなく「結果」として返す。
 * そうしないとAIが理由を読めず、同じ失敗を繰り返してしまう。
 */
function defineTool({ name, title, description, inputSchema, scope, annotations, run }) {
  return {
    name,
    title,
    description,
    scope,
    annotations,
    inputSchema: { type: "object", additionalProperties: false, ...inputSchema },
    async handler(args, context) {
      const actor = { ...context.actor, clientName: context.clientInfo?.name ?? context.actor?.clientName ?? null };
      try {
        if (scope) requireScope(actor, scope);
        return toolResult(await run(args, { ...context, actor }));
      } catch (error) {
        if (error instanceof ValidationError) {
          return toolResult(
            { ok: false, error: "invalid_input", field: error.field, message: error.message },
            { isError: true, text: `入力を確認してください: ${error.message}` },
          );
        }
        if (error instanceof PermissionError) {
          return toolResult(
            { ok: false, error: "permission_denied", requiredScope: error.scope, message: error.message },
            { isError: true, text: error.message },
          );
        }
        return toolResult(
          { ok: false, error: "server_error", message: error?.message ?? "不明な問題が起きました。" },
          { isError: true, text: `処理できませんでした: ${error?.message ?? "不明な問題"}` },
        );
      }
    },
  };
}

export function createTools() {
  return [
    defineTool({
      name: "getAppInfo",
      title: "study-todo の基本情報",
      description: "study-todo の構成・問題数・章と単元の一覧（教科書の掲載順、単元ごとの開始ページと問題数つき）・問題の種類と件数・難易度の意味・評価の5段階・今日の日付・同期している端末・データ形式の版を返す。最初にこれを呼ぶと、他のツールへ渡せる値（教科名・章名・単元名・種類・評価の値）が分かる。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { properties: { timezoneOffsetMinutes: TIMEZONE_PROPERTY } },
      run: (args, { service }) => service.getAppInfo(args),
    }),

    defineTool({
      name: "listQuestions",
      title: "問題を一覧",
      description: "青チャートの問題マスタを、教科・章・単元・種類・番号・難易度・ページで一覧する。返る問題は教科書の掲載順（教科→章→節→種類→番号）に並ぶ。「例題80〜100」は numberFrom / numberTo、「基本例題だけ」は types、「難しい問題を除く」は difficultyTo、「このページ付近」は pageFrom / pageTo を使う。返る件数に上限があるので、続きは nextOffset を offset に渡して読む。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          subject: { type: "string", description: "教科で絞る（例: 数学I / 数学A）。getAppInfo で一覧が分かる。数学Iと数学Aは例題番号が別々に振られているので、番号で絞るときは教科も指定すること。" },
          book: { type: "string", description: "冊で絞る（例: 青チャート数学I+A）。" },
          chapter: { type: "string", description: "章で絞る（例: 2次関数）。" },
          section: { type: "string", description: "単元で絞る（例: 2次関数の最大・最小と決定）。" },
          type: { type: "string", description: "問題の種類をひとつだけで絞る（例: 基本例題 / 重要例題 / 演習例題 / EXERCISES）。複数まとめたいときは types。" },
          types: {
            type: "array",
            items: { type: "string", maxLength: 40 },
            maxItems: 20,
            description: "問題の種類を複数まとめて絞る（例: [\"基本例題\",\"重要例題\"]）。getAppInfo の questionTypes に、この本にある種類と件数が入っている。",
          },
          numberFrom: { type: "integer", minimum: 0, description: "この番号以上の問題だけに絞る。番号は種類ごと（例題の通し番号 / EXERCISES の通し番号）。" },
          numberTo: { type: "integer", minimum: 0, description: "この番号以下の問題だけに絞る。" },
          difficultyFrom: { type: "integer", minimum: 1, maximum: 5, description: "難易度（青チャートのコンパスの数、1〜5）の下限。" },
          difficultyTo: { type: "integer", minimum: 1, maximum: 5, description: "難易度の上限。「難しい問題を抜きで」なら 3 などを渡す。難易度が不明な問題は除かれる。" },
          pageFrom: { type: "integer", minimum: 0, description: "掲載ページの下限。例題はページを持たないため、その単元の開始ページで判定する。" },
          pageTo: { type: "integer", minimum: 0, description: "掲載ページの上限。" },
          course: { type: "string", description: "SELECT STUDY のコースで絞る（基本定着 / 精選速習 / 実力錬成）。「基礎を短期間で」なら精選速習、「入試に向けて」なら実力錬成。EXERCISES はどのコースにも入っていない。" },
          needsReview: { type: "boolean", description: "true なら確認待ちの問題だけ、false なら確認済みの問題だけに絞る。確認待ちの問題は難易度など一部の項目が未確定（番号・章・単元・ページは確認済み）。" },
          limit: { type: "integer", minimum: 1, maximum: SERVICE_LIMITS.listLimitMax, description: `返す件数（既定 ${SERVICE_LIMITS.listLimitDefault}、最大 ${SERVICE_LIMITS.listLimitMax}）。` },
          offset: { type: "integer", minimum: 0, description: "続きを読むときの開始位置。前回の nextOffset を渡す。" },
        },
      },
      run: (args, { service }) => service.listQuestions(args),
    }),

    defineTool({
      name: "searchQuestions",
      title: "問題を検索",
      description: "キーワードで問題を探す。問題のタイトル（例:「2次関数の最大・最小」）・表示名・章・単元・教科・冊・種類・番号が検索対象。空白で区切るとすべてを含む問題だけに絞られる。章や単元の正確な名前が分からないときに使う。結果は掲載順に並ぶ。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          query: { type: "string", maxLength: 200, description: "検索語（例: 漸化式 例題）。" },
          limit: { type: "integer", minimum: 1, maximum: SERVICE_LIMITS.listLimitMax, description: "返す件数。" },
          offset: { type: "integer", minimum: 0, description: "続きを読むときの開始位置。" },
        },
        required: ["query"],
      },
      run: (args, { service }) => service.searchQuestions(args),
    }),

    defineTool({
      name: "getQuestion",
      title: "問題の詳細と履歴",
      description: "問題IDを指定して、その問題の情報（冊・章・単元・種類・番号・タイトル・難易度・ページ）と、これまでの学習履歴（日付・評価・所要時間）・平均所要時間・直近の評価を返す。「この問題は前どうだったか」を調べるときに使う。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: { id: { type: "string", description: "問題ID。listQuestions / searchQuestions が返す question.id。" } },
        required: ["id"],
      },
      run: (args, { service }) => service.getQuestion(args),
    }),

    defineTool({
      name: "getStudyHistory",
      title: "学習履歴",
      description: "1問ごとの学習記録（日時・問題・評価・所要時間）を新しい順に返す。期間は days（今日から何日ぶん）か、from / to（日付）で指定する。評価や章で絞ることもできる。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          days: { type: "integer", minimum: 1, maximum: 365, description: "今日から何日ぶんさかのぼるか（1なら今日だけ）。from / to を使うときは省略する。" },
          from: { ...DATE_PROPERTY, description: "この日以降（YYYY-MM-DD）。" },
          to: { ...DATE_PROPERTY, description: "この日以前（YYYY-MM-DD）。" },
          evaluation: { type: "string", enum: [...EVALUATIONS], description: "評価で絞る。perfect=◯完璧 / better_solution=解より良い解法があった / weak_writing=記記述が甘い / calc_error=△計算ミス / wrong_approach=✕方針が違った。" },
          chapter: { type: "string", description: "章で絞る。" },
          limit: { type: "integer", minimum: 1, maximum: SERVICE_LIMITS.historyLimitMax, description: `返す件数（既定 ${SERVICE_LIMITS.historyLimitDefault}）。` },
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
      },
      run: (args, { service }) => service.getStudyHistory(args),
    }),

    defineTool({
      name: "getRecentMistakes",
      title: "最近のミス",
      description: "最近ミスした問題（△計算ミス calc_error と ✕方針が違った wrong_approach）を新しい順に返す。calcErrors と wrongApproaches に種類ごとの件数が入るので、「計算ミスと方針ミスのどちらが多いか」もこれで分かる。片方だけ見たいときは evaluation を指定する。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          days: { type: "integer", minimum: 1, maximum: 365, description: "今日から何日ぶんさかのぼるか。既定は7。" },
          evaluation: { type: "string", enum: [...MISTAKE_EVALUATIONS], description: "calc_error（計算ミス）か wrong_approach（方針ミス）だけに絞る。省略すると両方。" },
          limit: { type: "integer", minimum: 1, maximum: SERVICE_LIMITS.historyLimitMax, description: "返す件数。既定は50。" },
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
      },
      run: (args, { service }) => service.getRecentMistakes(args),
    }),

    defineTool({
      name: "getStudyStats",
      title: "学習統計",
      description: "学習記録から数え直した統計を返す。全体の学習時間・問題数・評価ごとの回数、章ごとの内訳、直近の日ごとの学習量、ミス率の高い章（weakChapters）が分かる。「最近苦手な章は？」に答えるときはこれと getRecentMistakes を合わせて使う。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          recentDays: { type: "integer", minimum: 1, maximum: 90, description: "日ごとの学習量を何日ぶん返すか。既定は14。" },
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
      },
      run: (args, { service }) => service.getStudyStats(args),
    }),

    defineTool({
      name: "getRecentChallengeResult",
      title: "直近のチャレンジ結果",
      description: "いちばん新しいチャレンジ（制限時間つきでまとめて解く形式）の結果を返す。制限時間内に終えられたか・問題ごとのラップタイム・評価が分かる。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { properties: {} },
      run: (_args, { service }) => service.getRecentChallengeResult(),
    }),

    defineTool({
      name: "getChallengeResults",
      title: "チャレンジ結果の一覧",
      description: "チャレンジの結果を新しい順に返す。制限時間内に終えられた回の割合など、時間の使い方の変化を見るときに使う。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { properties: { limit: { type: "integer", minimum: 1, maximum: 100, description: "返す件数。既定は20。" } } },
      run: (args, { service }) => service.getChallengeResults(args),
    }),

    defineTool({
      name: "getTodayTasks",
      title: "その日の予定",
      description: "今日（date を渡せばその日）の予定を返す。tasks には問題ID・種類・並び順・制限時間・完了かどうかが入り、labels に「例題90」のような表示名が入る。予定を変更する前には必ずこれを呼び、いまの内容を確かめること。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          date: { ...DATE_PROPERTY, description: "見たい日（YYYY-MM-DD）。省略すると今日（日本時間）。" },
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
      },
      run: (args, { service }) => service.getTodayTasks(args),
    }),

    defineTool({
      name: "getTasksInRange",
      title: "期間の予定",
      description: "from から to までの各日の「予定」と「実際に取り組んだ記録」をまとめて返す。予定が無くても、その日に取り組んだ記録があれば日として返る。各タスクの items（1回の取り組み1件ずつ）に itemId があり、pendingItemIds がまだ取り組んでいない分。「今週の予定」「どこまで進んだか」を見るときや、繰り越しの前の下調べに使う。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          from: { ...DATE_PROPERTY, description: "開始日（YYYY-MM-DD）。省略すると今日。" },
          to: { ...DATE_PROPERTY, description: "終了日（YYYY-MM-DD）。省略すると今日。" },
          includeAttempts: { type: "boolean", description: "false にすると、その日に実際に取り組んだ記録（attempts）を省く。既定は true。" },
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
      },
      run: (args, { service }) => service.getTasksInRange(args),
    }),

    defineTool({
      name: "getGoals",
      title: "目標の一覧",
      description: "目標を、優先順位と期限の順に返す。目標は「何を（questionIds）・いつまでに（deadline）・どの状態まで（completion）」を持つ。needsScopeSetup が true の目標は、対象が文章だけの古いもので、計算には使えない（対象を推測して確定させず、利用者に選んでもらうこと）。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          includeInactive: { type: "boolean", description: "一時停止・取り消しの目標も含める。既定は false。" },
        },
      },
      run: (args, { service }) => service.getGoals(args),
    }),

    defineTool({
      name: "getRecentAiChanges",
      title: "最近のAI操作",
      description: "AIが予定や目標を変更した履歴（日時・どのAIか・ツール名・内容）を新しい順に返す。自分が前回どう変更したかを確かめるときに使う。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { properties: { limit: { type: "integer", minimum: 1, maximum: 100, description: "返す件数。既定は20。" } } },
      run: (args, { service }) => service.getOperationLog(args),
    }),

    defineTool({
      name: "getQuestionAttempts",
      title: "問題ごとの取り組み履歴",
      description: "1つの問題に取り組んだ回数と、その1回ずつ（日時・評価・所要時間・通常かチャレンジか・どの予定に対するものか）を古い順に返す。同じ問題を2周目に解けば2件、同じ日に2回解いても2件になる。件数が多いときは nextOffset で続きを読む（返った分だけで全部と決めつけない）。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          id: { type: "string", description: "問題ID。listQuestions / searchQuestions が返す question.id。" },
          limit: { type: "integer", minimum: 1, maximum: SERVICE_LIMITS.historyLimitMax, description: "返す件数。既定は50。" },
          offset: { type: "integer", minimum: 0, description: "続きを読むときの開始位置。前回の nextOffset を渡す。" },
        },
        required: ["id"],
      },
      run: (args, { service }) => service.getQuestionAttempts(args),
    }),

    defineTool({
      name: "getUnfinishedPlanItems",
      title: "まだ取り組んでいない予定",
      description: "期間の中で、予定したのにまだ取り組んでいない分（予定項目）を日ごとに返す。overdue が true の日は、過ぎたのに残っている分。繰り越すときは、ここで分かった itemId を applyTaskChanges の carryOver に渡す。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          from: { ...DATE_PROPERTY, description: "開始日。省略すると to の30日前。" },
          to: { ...DATE_PROPERTY, description: "終了日。省略すると今日。" },
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
      },
      run: (args, { service }) => service.getUnfinishedPlanItems(args),
    }),

    defineTool({
      name: "getPlanMoves",
      title: "繰り越し・予定変更の履歴",
      description: "予定を別の日へ動かした記録を新しい順に返す。いつ・誰が（本人かAIか）・どの予定項目を・どの日からどの日へ・どんな理由で動かしたか、当初の予定日（originalDate）と繰り越した回数（carriedCount）が分かる。件数が多いときは nextOffset で続きを読む。繰り越しても取り組み回数は増えない（実績は実施した日にだけ残る）。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          from: { ...DATE_PROPERTY, description: "この日以降に関わる移動だけ。" },
          to: { ...DATE_PROPERTY, description: "この日以前に関わる移動だけ。" },
          questionId: { type: "string", maxLength: 120, description: "その問題を含む移動だけに絞る。" },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "返す件数。既定は50。" },
          offset: { type: "integer", minimum: 0, description: "続きを読むときの開始位置。" },
        },
      },
      run: (args, { service }) => service.getPlanMoves(args),
    }),

    defineTool({
      name: "applyTaskChanges",
      title: "予定をタスク単位で変更",
      description: [
        "予定を、タスク単位で安全に変更する。予定を変えるときはこれを使う（updateTodayTasks は古い形）。",
        "流れは 1) getTodayTasks / getTasksInRange で今の予定・task.id・revision・locked を取る",
        "2) 変えたいタスクだけを changes に並べる 3) 変える日すべての revision を expectedRevisions に入れる。",
        "複数の日の変更（「今日から2件消して明日に足す」など）も1回で渡すこと。",
        "すべての確認を通ったときだけ適用され、1つでも通らなければ1件も変更しない。",
        "移動（move）ではタスクIDは変わらない。追加のときだけ新しいIDが発行される。",
        "完了済み・実行中・利用者が固定したタスク（locked が true）は変更・削除・移動できない。",
        "通信が切れて同じ要求を送り直すときは、同じ operationId を使えば二重に適用されない。",
        "保存の前に、日ごとの時間・重複・期限・目標や学習可能時間の版も確かめる（validatePlanChanges と同じ確認）。",
        "学習記録とチャレンジ結果はこの操作では一切変わらない。",
      ].join(""),
      scope: "write",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          operationId: {
            type: "string",
            maxLength: CHANGE_LIMITS.operationIdLength,
            description: "この一括変更を表す、自分で決める文字列。送り直すときは同じ値にする（同じ値・同じ内容なら前回の結果が返るだけで、二重に適用されない）。同じ値で内容が違うと断られる。",
          },
          expectedRevisions: EXPECTED_REVISIONS_SCHEMA,
          changes: {
            type: "array",
            minItems: 1,
            maxItems: CHANGE_LIMITS.changesPerRequest,
            description: "行う変更の並び。上から順に適用される。",
            items: CHANGE_SCHEMA,
          },
          reason: {
            type: "string",
            maxLength: CHANGE_LIMITS.reasonLength,
            description: "なぜこの変更をするか（例: 今日は30分しか時間が取れないため、2件を明日へ移した）。履歴に残り、利用者が画面で確認できる。",
          },
          expectedContext: EXPECTED_CONTEXT_SCHEMA,
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
        required: ["operationId", "expectedRevisions", "changes"],
      },
      run: (args, { service, actor }) => service.applyTaskChanges(args, actor),
    }),

    defineTool({
      name: "getPlanChanges",
      title: "予定の変更履歴",
      description: "予定の一括変更の履歴（いつ・誰が・どの日の・どのタスクを・なぜ変えたか）を新しい順に返す。changeId は undoTaskChanges に渡せる。学習記録は履歴の対象ではない。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, description: "返す件数。既定は10。" },
          includeDetail: { type: "boolean", description: "true にすると、変更前後の予定そのものも返す。" },
        },
      },
      run: (args, { service }) => service.getPlanChanges(args),
    }),

    defineTool({
      name: "undoTaskChanges",
      title: "予定の変更を取り消す",
      description: [
        "getPlanChanges で分かる変更を取り消す。changeId を省くといちばん新しい変更が対象。",
        "取り消しは履歴を消す操作ではなく、打ち消す変更を新しく1件作って記録する。",
        "その変更のあとに学習が進んだ・別の変更が入った・対象が固定されたなどで安全に戻せない場合は、",
        "何も変えずに undo_conflict を返す。学習記録とチャレンジ結果は取り消しの対象にならない。",
      ].join(""),
      scope: "write",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        properties: {
          changeId: { type: "string", maxLength: 80, description: "取り消す変更のID。省略するといちばん新しい変更。" },
          operationId: { type: "string", maxLength: CHANGE_LIMITS.operationIdLength, description: "送り直しても二重にならないようにするための、自分で決める文字列。" },
          reason: { type: "string", maxLength: CHANGE_LIMITS.reasonLength, description: "取り消す理由。履歴に残る。" },
        },
      },
      run: (args, { service, actor }) => service.undoTaskChanges(args, actor),
    }),

    defineTool({
      name: "updateTodayTasks",
      title: "今日の予定を変更",
      description: `今日（date を渡せばその日）の予定を書き換える。${REPLACE_NOTE} 「30分しかないから減らして」のような依頼では、先に getTodayTasks で今の予定を取り、残す問題だけを tasks に入れて渡す。`,
      scope: "write",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          tasks: {
            type: "array",
            maxItems: SERVICE_LIMITS.tasksPerDay,
            description: "その日の予定の全体。ここに渡した内容がそのまま、その日の予定になる。",
            items: TASK_ITEM_SCHEMA,
          },
          date: { ...DATE_PROPERTY, description: "変更する日。省略すると今日（日本時間 UTC+9 で判定）。" },
          expectedRevision: { type: "integer", minimum: 0, description: "この日の予定について、直前に読み取った revision。渡すと、その間に他の変更が入っていた場合は何も変えずに競合として返す。強く推奨。" },
          operationId: { type: "string", maxLength: CHANGE_LIMITS.operationIdLength, description: "送り直しても二重にならないようにするための、自分で決める文字列。" },
          reason: { type: "string", maxLength: CHANGE_LIMITS.reasonLength, description: "変更の理由。履歴に残る。" },
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
        required: ["tasks"],
      },
      run: (args, { service, actor }) => service.updateTodayTasks(args, actor),
    }),

    defineTool({
      name: "updateTasksForDate",
      title: "指定した日の予定を変更",
      description: `date で指定した日の予定を書き換える。${REPLACE_NOTE} 「例題50〜65を3日に分けて」のように複数日へ割り振るときは、日付ごとにこのツールを1回ずつ呼ぶ。`,
      scope: "write",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          date: { ...DATE_PROPERTY, description: "変更する日（YYYY-MM-DD、日本時間）。必須。" },
          expectedRevision: { type: "integer", minimum: 0, description: "この日の予定について、直前に読み取った revision。渡すと、その間に他の変更が入っていた場合は何も変えずに競合として返す。強く推奨。" },
          operationId: { type: "string", maxLength: CHANGE_LIMITS.operationIdLength, description: "送り直しても二重にならないようにするための、自分で決める文字列。" },
          reason: { type: "string", maxLength: CHANGE_LIMITS.reasonLength, description: "変更の理由。履歴に残る。" },

          tasks: {
            type: "array",
            maxItems: SERVICE_LIMITS.tasksPerDay,
            description: "その日の予定の全体。",
            items: TASK_ITEM_SCHEMA,
          },
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
        required: ["date", "tasks"],
      },
      run: (args, { service, actor }) => service.updateTasksForDate(args, actor),
    }),

    defineTool({
      name: "addStudyRecords",
      title: "本人が申告した学習を記録",
      description: [
        "利用者が「やったのに記録し忘れた」と言った学習を、実績としてまとめて記録する。",
        "**作ってよいのは、本人が実際に取り組んだと言ったものだけ**。予定が入っていることや、",
        "時間の見積もりを根拠に実績を作ってはいけない（予定の自動完了・評価の推測・見積もり時間の転記は禁止）。",
        "分からないことは埋めない。evaluation を渡さなければ「評価は未登録」、durationSeconds を渡さなければ「時間は未登録」として保存する。",
        "「解いた」というだけでは perfect にしないこと。評価がはっきりしなければ渡さない（未登録）。",
        "日付は date（YYYY-MM-DD）で渡す。「昨日」は getAppInfo の today（日本時間）から自分で年月日に直すこと。",
        "時刻が分かるときだけ time を渡す（分からないなら渡さない。架空の時刻を作らない）。",
        "同じ問題でも、同じ日に2回解くことはふつうにある。日付と問題が同じでも別の取り組みとして記録する。",
        "通信が切れて送り直すときは、同じ operationId を使えば二重に記録されない。",
      ].join(""),
      scope: "records",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          operationId: {
            type: "string",
            maxLength: 120,
            description: "この登録を表す、自分で決める文字列。送り直すときは同じ値にする（同じ値・同じ内容なら二重にならない）。",
          },
          records: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            description: "記録する取り組み。1件＝1回の取り組み。",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["questionId", "date"],
              properties: {
                questionId: {
                  type: "string",
                  maxLength: 120,
                  description: "問題ID。searchQuestions / listQuestions で確かめる。数学Iと数学Aで同じ例題番号があるので、教科まで合っているか必ず確かめること。",
                },
                date: { ...DATE_PROPERTY, description: "実施した日（日本時間）。未来の日付は入れられない。" },
                time: { type: "string", maxLength: 5, description: "実施した時刻（14:30 の形）。**分かるときだけ**渡す。" },
                evaluation: {
                  type: "string",
                  enum: [...EVALUATION_VALUES],
                  description: "その回の評価。本人がはっきり言ったときだけ渡す。渡さなければ「未登録」になる（正解にも不正解にも数えない）。",
                },
                durationSeconds: {
                  type: "integer",
                  minimum: 0,
                  maximum: 21600,
                  description: "かかった時間（秒）。本人が言ったときだけ渡す。渡さなければ「未登録」（0秒にはしない）。",
                },
                planItemId: {
                  type: "string",
                  maxLength: 120,
                  description: "本人が「この予定を終えた」と示したときだけ、その予定項目のID。曖昧なら渡さない（予定に結び付けずに保存される）。",
                },
                note: { type: "string", maxLength: 200, description: "その1件についての、本人の言葉の短い覚え書き。" },
              },
            },
          },
          totalDurationSeconds: {
            type: "integer",
            minimum: 0,
            maximum: 86400,
            description: "「4問で合計40分」のように、まとまりでしか時間が分からないときの合計（秒）。"
              + " 1問ずつに割り振らず、まとまりの申告時間として保存する（二重には数えない）。",
          },
          claimSummary: {
            type: "string",
            maxLength: 200,
            description: "本人の申告の短い要約（例: 「昨日、数学Iの例題50〜53を解いた」）。履歴に残る。会話の全文は入れない。",
          },
        },
        required: ["operationId", "records"],
      },
      run: (args, { service, actor }) => service.addStudyRecords(args, actor),
    }),

    defineTool({
      name: "updateStudyRecords",
      title: "記録した学習を訂正",
      description: [
        "すでにある実績を、本人の申告にもとづいて直す。渡した項目だけが変わり、記録ID（recordId）は変わらない。",
        "対象は getQuestionAttempts / getStudyHistory の recordId で指定する。候補が複数あるときは、",
        "勝手に選ばず、どれのことか利用者に確かめること。",
        "expectedRevision を渡すと、読み取ったあとに別の場所から変更されていた場合は何もせずに断る。",
        "評価や時間を「分からない」に戻したいときは null を渡す。",
        "チャレンジの中の記録は、ここからは直せない（チャレンジ結果と食い違うため断る）。",
      ].join(""),
      scope: "records",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          operationId: { type: "string", maxLength: 120, description: "送り直しても二重にならないようにするための、自分で決める文字列。" },
          updates: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            description: "直す内容。",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["recordId"],
              properties: {
                recordId: { type: "string", maxLength: 80, description: "直す記録のID。" },
                expectedRevision: { type: "integer", minimum: 0, description: "読み取ったときの revision。食い違えば何も変えずに断る。" },
                date: { ...DATE_PROPERTY, description: "実施日の訂正（「今日と入れたが本当は昨日」など）。" },
                time: { type: "string", maxLength: 5, description: "実施時刻の訂正（14:30 の形）。" },
                evaluation: { type: ["string", "null"], enum: [...EVALUATION_VALUES, null], description: "評価の訂正。null で「未登録」に戻す。" },
                durationSeconds: { type: ["integer", "null"], minimum: 0, maximum: 21600, description: "所要時間の訂正。null で「未登録」に戻す。" },
                questionId: { type: "string", maxLength: 120, description: "問題を取り違えていたときの訂正。" },
                planItemId: { type: ["string", "null"], maxLength: 120, description: "対応する予定の付け替え。null で結び付けを外す。" },
                reason: { type: "string", maxLength: 200, description: "この1件を直す理由。" },
              },
            },
          },
          reason: { type: "string", maxLength: 200, description: "訂正の理由（全体）。履歴に残る。" },
        },
        required: ["operationId", "updates"],
      },
      run: (args, { service, actor }) => service.updateStudyRecords(args, actor),
    }),

    defineTool({
      name: "voidStudyRecords",
      title: "記録した学習を取り消す",
      description: [
        "誤って入れた実績を取り消す。記録は消さずに「取り消した」印をつけ、ふだんの集計・カレンダー・統計から外す。",
        "履歴には残るので、あとから何を取り消したか確かめられる。",
        "同じ取り組みを二重に入れてしまったときは、**どちらを残すか**を利用者に確かめてから片方だけを取り消すこと。",
      ].join(""),
      scope: "records",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          operationId: { type: "string", maxLength: 120, description: "送り直しても二重にならないようにするための、自分で決める文字列。" },
          records: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            description: "取り消す記録。",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["recordId"],
              properties: {
                recordId: { type: "string", maxLength: 80 },
                expectedRevision: { type: "integer", minimum: 0, description: "読み取ったときの revision。食い違えば何も変えずに断る。" },
                reason: { type: "string", maxLength: 200 },
              },
            },
          },
          reason: { type: "string", maxLength: 200, description: "取り消す理由。履歴に残る。" },
        },
        required: ["operationId", "records"],
      },
      run: (args, { service, actor }) => service.voidStudyRecords(args, actor),
    }),

    defineTool({
      name: "getRecordChanges",
      title: "学習記録の追加・訂正の履歴",
      description: "本人の申告で足した記録や、訂正・取り消しの履歴を新しい順に返す。いつ・誰が・何を・なぜ変えたか（変更前後つき）が分かる。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: { limit: { type: "integer", minimum: 1, maximum: 100, description: "返す件数。既定は20。" } },
      },
      run: (args, { service }) => service.getRecordChanges(args),
    }),

    defineTool({
      name: "addGoal",
      title: "目標を追加",
      description: [
        "「何を・いつまでに・どの状態まで」を決めた目標を1件作る。対象は必ず問題IDの一覧として確定させる。",
        "questionIds を直接渡すか、scopeFilter（教科・章・単元・種類・番号・難易度・コース）で選ぶ。",
        "scopeFilter で選んだ場合も、保存されるのは選んだ結果のID一覧なので、あとで問題マスタが変わっても対象は動かない。",
        "達成条件は attempt（1回ずつ取り組めば達成。評価が不正解でも取り組みとして数える）か、",
        "mastery（この目標に結び付いた **最新** の取り組みが、指定した評価になっていれば達成。既定は perfect）。",
        "目標の実績として数えるのは、その目標に結び付いた予定（applyTaskChanges の task.goalId）から実施された取り組みだけ。",
        "だから2周目の目標を作っても、1周目の記録では達成にならない。",
      ].join(""),
      scope: "write",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        properties: {
          title: { type: "string", maxLength: 200, description: "目標の内容（例: 12月までに数学Iの基本例題を一通り解く）。" },
          startDate: { ...DATE_PROPERTY, description: "開始日。省略すると今日。" },
          deadline: { ...DATE_PROPERTY, description: "期限。省略すると期限なし。" },
          questionIds: {
            type: "array",
            items: { type: "string", maxLength: 120 },
            maxItems: 2000,
            description: "対象の問題ID。listQuestions が返す question.id をそのまま並べる。",
          },
          scopeFilter: {
            type: "object",
            additionalProperties: false,
            description: "条件で対象を選ぶ（questionIds を渡さないときに使う）。選んだ結果はID一覧として確定する。",
            properties: {
              subject: { type: "string", maxLength: 60 },
              chapter: { type: "string", maxLength: 80 },
              section: { type: "string", maxLength: 80 },
              course: { type: "string", maxLength: 20 },
              types: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 20 },
              numberFrom: { type: "integer", minimum: 0 },
              numberTo: { type: "integer", minimum: 0 },
              difficultyFrom: { type: "integer", minimum: 1, maximum: 5 },
              difficultyTo: { type: "integer", minimum: 1, maximum: 5 },
            },
          },
          completion: {
            type: "object",
            additionalProperties: false,
            description: "達成条件。省略すると attempt（1回ずつ取り組む）。",
            properties: {
              type: { type: "string", enum: [...GOAL_COMPLETION_TYPES], description: "attempt=取り組む / mastery=習得する。" },
              evaluations: {
                type: "array",
                items: { type: "string", enum: [...EVALUATIONS] },
                maxItems: 5,
                description: "mastery のとき、合格とする評価。省略すると perfect だけ。",
              },
              mode: {
                type: "string",
                enum: ["latest", "ever"],
                description: "latest（既定）=この目標に結び付いた最新の取り組みで判定 / ever=一度でも条件を満たせば達成。",
              },
            },
          },
          priority: { type: "integer", minimum: 1, maximum: 5, description: "優先順位（1がいちばん高い）。省略すると3。" },
          scope: { type: "string", maxLength: 400, description: "対象の説明（人が読むための覚え書き。計算には使わない）。" },
        },
        required: ["title"],
      },
      run: (args, { service, actor }) => service.addGoal(args, actor),
    }),

    defineTool({
      name: "updateGoal",
      title: "目標を変更",
      description: "既存の目標を書き換える。変えたい項目だけを渡せば、ほかはそのまま残る。達成数は学習記録から数えるものなので、ここからは書き換えられない。目標の削除はAIからはできない（study-todo の画面から行う）。",
      scope: "write",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          id: { type: "string", description: "変更する目標のID。getGoals で分かる。" },
          title: { type: "string", maxLength: 200, description: "新しい内容。" },
          startDate: { ...DATE_PROPERTY, description: "新しい開始日。" },
          deadline: { ...DATE_PROPERTY, description: "新しい期限。空文字を渡すと期限なしになる。時間が足りないことを理由に、利用者に断りなく延ばさないこと。" },
          questionIds: { type: "array", items: { type: "string", maxLength: 120 }, maxItems: 2000, description: "新しい対象（問題IDの一覧）。" },
          completion: {
            type: "object",
            additionalProperties: false,
            description: "新しい達成条件。",
            properties: {
              type: { type: "string", enum: [...GOAL_COMPLETION_TYPES] },
              evaluations: { type: "array", items: { type: "string", enum: [...EVALUATIONS] }, maxItems: 5 },
              mode: { type: "string", enum: ["latest", "ever"] },
            },
          },
          priority: { type: "integer", minimum: 1, maximum: 5, description: "新しい優先順位。" },
          status: { type: "string", enum: [...GOAL_STATUSES], description: "進行中 active / 達成 achieved / 一時停止 paused / 取り消し cancelled。" },
          scope: { type: "string", maxLength: 400, description: "対象の説明（覚え書き）。" },
        },
        required: ["id"],
      },
      run: (args, { service, actor }) => service.updateGoal(args, actor),
    }),

    defineTool({
      name: "getGoalProgress",
      title: "目標の進み具合",
      description: [
        "目標ごとの、対象数・達成数・未達成の問題・すでに予定に入っている分・まだ予定に入っていない分・",
        "残りの見積もり時間・期限までの日数を返す。達成数は学習記録から数え直した値で、AIからは書き換えられない。",
        "「取り組む目標」は remainingIsComplete が true で、残量がそのまま残り時間になる。",
        "「習得する目標」は false で、remainingSeconds は「未達成の問題にあと1回ずつ」ぶんにすぎない",
        "（何回で習得できるかは分からないので、達成までの総時間はこれ以上になりうる）。",
      ].join(""),
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          goalIds: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 50, description: "絞りたい目標ID。省略すると進行中のものすべて。" },
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
      },
      run: (args, { service }) => service.getGoalProgress(args),
    }),

    defineTool({
      name: "getStudyAvailability",
      title: "学習に使える時間",
      description: [
        "1日に study-todo の学習へ使える時間の設定と、日ごとの「使える分数」を返す。",
        "available が null の日は **未設定** で、0分とは違う。未設定の日に予定を置かないこと（利用者に設定を促す）。",
        "source が today_remaining の日は「今日はあと○分」と指定された日で、そこから実施済みの時間を引いてはいけない（すでに引かれている）。",
        "この時間は study-todo で管理する学習の枠であって、学校や他教科を含む生活全体の空き時間ではない。",
      ].join(""),
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          from: { ...DATE_PROPERTY, description: "開始日。省略すると今日。" },
          to: { ...DATE_PROPERTY, description: "終了日。省略すると今日から2週間。" },
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
      },
      run: (args, { service }) => service.getStudyAvailability(args),
    }),

    defineTool({
      name: "updateStudyAvailability",
      title: "学習に使える時間を変更",
      description: "曜日別の標準時間・日付ごとの上書き・「今日はあと○分」・予備時間を変える。利用者が言ったとおりに設定すること。時間が足りないことを理由に、断りなく増やさないこと。",
      scope: "write",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          weekly: {
            type: "object",
            additionalProperties: false,
            description: "曜日別の標準（分）。null を渡すと未設定に戻る。",
            properties: Object.fromEntries(WEEKDAY_KEYS.map((key) => [key, { type: ["integer", "null"], minimum: 0, maximum: 1440 }])),
          },
          overrides: {
            type: "object",
            description: "日付ごとの上書き（YYYY-MM-DD をキーに分数）。0分の日も指定できる。null を渡すと上書きを消す。",
            additionalProperties: { type: ["integer", "null"], minimum: 0, maximum: 1440 },
          },
          todayRemainingMinutes: { type: ["integer", "null"], minimum: 0, maximum: 1440, description: "「今日はあと○分」。null で取り消し。" },
          todayRemainingDate: { ...DATE_PROPERTY, description: "上の指定がどの日のものか。省略すると今日。" },
          reserveMinutes: { type: "integer", minimum: 0, maximum: 240, description: "予備として空けておく分数（1日につき1回だけ引かれる）。" },
          timerIncludesReview: { type: "boolean", description: "アプリのタイマーが答え合わせまで含んでいるか。既定は true（含む）。" },
          reviewOverheadSeconds: { type: "integer", minimum: 0, maximum: 1800, description: "タイマーに含まれないときの、1問あたりの答え合わせ時間（秒）。" },
        },
      },
      run: (args, { service, actor }) => service.updateStudyAvailability(args, actor),
    }),

    defineTool({
      name: "getQuestionEstimates",
      title: "問題ごとの所要時間の見積もり",
      description: [
        "問題IDをまとめて渡すと、1問あたりの見積もり時間（秒）と、その根拠を返す。",
        "source は manual（利用者が指定）/ history（本人の実績）/ history_blended（少ない実績と既定値を合わせた値）/",
        "similar（似た問題の実績）/ ai_estimate（教材をもとにした仮の値）/ default（種類と難易度からの仮の値）。",
        "confidence が low のものは仮の値なので、それに合わせて計画の確からしさも伝えること。",
        "初見と復習、通常とチャレンジは分けて見積もっている。",
      ].join(""),
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          questionIds: { type: "array", items: { type: "string", maxLength: 120 }, minItems: 1, maxItems: 200, description: "見積もりたい問題ID。" },
          inChallenge: { type: "boolean", description: "制限時間つきのチャレンジとして解く場合は true。" },
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
        required: ["questionIds"],
      },
      run: (args, { service }) => service.getQuestionEstimates(args),
    }),

    defineTool({
      name: "saveQuestionEstimates",
      title: "仮の見積もりを保存",
      description: [
        "教材を見て作った「この問題はこれくらいかかりそう」という **仮の** 見積もりを、問題IDに結び付けて保存する。",
        "これは実績ではない。学習記録にはならないし、利用者が自分で指定した時間を上書きすることもない。",
        "本人の実績がたまれば、そちらが優先される。推測であることが分かるよう note に根拠を書いておくとよい。",
      ].join(""),
      scope: "write",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          estimates: {
            type: "array",
            minItems: 1,
            maxItems: 200,
            description: "仮見積もりの一覧。",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["questionId", "seconds"],
              properties: {
                questionId: { type: "string", maxLength: 120 },
                seconds: { type: "integer", minimum: 30, maximum: 7200, description: "1回解くのにかかりそうな秒数。" },
                note: { type: "string", maxLength: 200, description: "そう考えた理由（推測であることが分かるように）。" },
              },
            },
          },
        },
        required: ["estimates"],
      },
      run: (args, { service, actor }) => service.saveQuestionEstimates(args, actor),
    }),

    defineTool({
      name: "getPlanningContext",
      title: "計画に必要な情報をまとめて取得",
      description: [
        "予定を組む・組み直すときに、まずこれを呼ぶ。指定した期間について、次をまとめて返す。",
        "日本時間の今／最終同期時刻／目標と残量／日ごとの予定と使える時間／未実施の予定と見積もり／",
        "まだ予定に入っていない分／過ぎた日に残っている分／繰り越しの履歴／保護されている予定／",
        "反映のときに使う版情報（expectedRevisions と expectedContext）。",
        "全問題・全履歴は返さない。期間と目標で絞った分だけで、省略があるときは *Truncated で知らせる。",
      ].join(""),
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          from: { ...DATE_PROPERTY, description: "開始日。省略すると今日。" },
          to: { ...DATE_PROPERTY, description: "終了日。省略すると今日から2週間。最大60日。" },
          goalIds: { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 50, description: "対象の目標。省略すると進行中のものすべて。" },
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
      },
      run: (args, { service }) => service.getPlanningContext(args),
    }),

    defineTool({
      name: "validatePlanChanges",
      title: "配分案を保存前に確かめる",
      description: [
        "applyTaskChanges と同じ形の配分案を渡すと、保存せずに確かめた結果だけを返す。",
        "問題ID・目標ID・タスクIDの確認、同じ取り組みの重複、日ごとの時間、保護された予定、期限、",
        "対象日の revision、下見のときから目標や学習可能時間が変わっていないか（expectedContext）を見る。",
        "days に日ごとの「予定○分／使える○分」、warnings に足りない時間や未設定の日、",
        "unplaced にまだ置けていない分が入る。ここで ok でも、反映のときにもう一度確かめる。",
      ].join(""),
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          operationId: { type: "string", maxLength: CHANGE_LIMITS.operationIdLength, description: "反映のときに使う予定の操作ID。" },
          expectedRevisions: EXPECTED_REVISIONS_SCHEMA,
          changes: {
            type: "array",
            minItems: 1,
            maxItems: CHANGE_LIMITS.changesPerRequest,
            description: "確かめたい変更の並び（applyTaskChanges と同じ形）。",
            items: CHANGE_SCHEMA,
          },
          reason: { type: "string", maxLength: CHANGE_LIMITS.reasonLength, description: "変更の理由。" },
          expectedContext: EXPECTED_CONTEXT_SCHEMA,
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
        required: ["operationId", "expectedRevisions", "changes"],
      },
      run: (args, { service, actor }) => service.validatePlanChanges(args, actor),
    }),
  ];
}

/** AIへ渡す、このサーバーの使い方の説明。 */
export const SERVER_INSTRUCTIONS = `study-todo は、青チャート（数学の問題集）の学習を記録・管理するアプリです。
このサーバーからは、学習状況を読み取り、これからの予定と目標を変更できます。

使うときの目安:
- まず getAppInfo を呼ぶと、教科・章・単元の一覧（教科書の掲載順）、問題の種類、
  評価の5段階、今日の日付が分かります。日付はすべて日本時間（UTC+9）で扱います。
- 問題マスタは青チャート数学I+A です。教科は「数学I」と「数学A」に分かれ、
  例題の番号はそれぞれ別に 1 から振られています（数学I 例題1 と 数学A 例題1 は別の問題）。
  番号で範囲を指定するときは、必ず subject も一緒に渡してください。
- 種類は 基本例題 / 重要例題 / 演習例題 / EXERCISES です。「基本例題だけ」のような
  条件は listQuestions の types で、「難しいものを除く」は difficultyTo で指定できます。
  難易度は青チャートのコンパスの数（1〜5、小さいほどやさしい）です。
- 各例題には SELECT STUDY のコース（基本定着 / 精選速習 / 実力錬成）が入っています。
  「基礎を固めたい」「短期間で仕上げたい」といった相談には listQuestions の course が使えます。
  ただし EXERCISES の難易度は読み取りが未確認で、needsReview が true になっています。
  難易度で厳密に絞りたいときは例題を対象にしてください。
- 「今日やる予定」は getTodayTasks、別の日や期間は getTasksInRange です。
  どちらも「予定（tasks）」と「実際に取り組んだ記録（attempts）」の両方を返します。
- 予定と実績は別のものです。
  ・予定の中の1回の取り組みは items の1件で、itemId が安定した識別子です。
  ・学習記録は「実際に取り組んだ1回」で、planItemId でどの予定に対する分かが分かります。
  ・同じ問題を2周目に解けば記録は2件になります。同じ日に2回解いても2件です。
  ・やらなかった予定を別の日へ繰り越しても、取り組み回数は増えません。
  ・1つの問題の全部の取り組みは getQuestionAttempts（区切って返るので nextOffset を追う）。
- やり残しを別の日へ動かすときは、getUnfinishedPlanItems で未実施の itemId を確かめ、
  applyTaskChanges の carryOver に渡してください（実施済みの分は動かせません。実績はその日に残します）。
  理由（reason）は**利用者が言ったときだけ**入れてください。推測した理由を事実として保存しないでください。
  過去の移動は getPlanMoves で分かります（当初の予定日と繰り越した回数つき）。
- 評価は5段階です。perfect(◯完璧) / better_solution(解もっと良い解法) /
  weak_writing(記記述が甘い) / calc_error(△計算ミス) / wrong_approach(✕方針が違った)。
  「弱点」を聞かれたら getRecentMistakes と getStudyStats の weakChapters を見てください。
- 予定を変えるときは、必ず先に getTodayTasks / getTasksInRange で、いまの予定・
  各タスクの task.id・その日の revision・locked（変更できないタスク）を取得してください。
  そのうえで applyTaskChanges に「変えたいタスクだけ」を渡します。全体を組み直す必要はありません。

    1. getTasksInRange で today と tomorrow の tasks と revision を取る
    2. changes に、移したいタスクの { op: "move", taskId, fromDate, toDate } などを並べる
    3. expectedRevisions に、変える日すべての { date, revision } を入れる
    4. operationId（自分で決める文字列）と reason（変更の理由）を付けて呼ぶ

  複数の日にまたがる変更も、1回の applyTaskChanges にまとめて渡してください。
  すべての確認を通ったときだけ適用され、1つでも通らなければ1件も変わりません。
  通信が切れて送り直すときは、同じ operationId を使えば二重になりません。
- 変更が断られたときは error を見て次を決めます。
  revision_conflict＝誰かが先に変更した（取り直してやり直す） /
  protected_task＝完了済み・実行中・利用者が固定したタスク（触らずに他で調整する） /
  task_not_found＝IDが古い（取り直す） / unknown_question＝問題IDが違う（listQuestions で確かめる） /
  operation_conflict＝同じ operationId で違う内容（新しい operationId を付ける） /
  permission_denied＝利用者が権限を許していない（設定を促す） /
  storage_not_atomic＝サーバーの保存先の設定が古い（利用者に更新を促す）。
- 変更したあとは、何をなぜ変えたかを利用者に伝えてください。結果には changeId・
  確定した内容・更新後の revision が入っています。過去の変更は getPlanChanges で見られ、
  undoTaskChanges で取り消せます（取り消しも新しい変更として記録されます）。
- updateTodayTasks / updateTasksForDate は古い形（その日の全置き換え）です。
  中ではタスク単位の変更へ直され、同じ保護と競合の確認を通りますが、
  IDや並びを確実に保ちたいときは applyTaskChanges を使ってください。
- 問題は questionIds に問題ID（listQuestions が返す id）で指定します。「例題90」という
  表示名ではありません。
- 完了済み・実行中・利用者が固定したタスクは変更できません（locked が true）。
  固定の付け外しができるのは利用者だけで、AIからは外せません。
  「実行中」はアプリが知らせてきた範囲でしか分からないため、圏外の端末で解いている
  タスクまでは守れません。時間帯によっては、利用者に確認してから変えてください。
- 予定を組む・組み直すときの流れは決まっています。

    1. getPlanningContext（期間と目標を指定）で、今の状態をまとめて受け取る
       … 目標と残量・日ごとの予定と使える時間・未実施の予定と見積もり・未配置分・
         繰り越し履歴・保護された予定・反映に使う版（expectedRevisions と expectedContext）
    2. 受け取った見積もり（estimateSeconds）と使える時間（availableMinutes）をもとに配分案を作る
    3. validatePlanChanges で確かめる（保存はされません）
    4. applyTaskChanges に、同じ changes と expectedRevisions・expectedContext を付けて反映する

  数えられること（実績・残量・見積もり・時間の過不足）はサーバーが出します。推測しないでください。
  何を優先するか、どう配るか、なぜそうしたかの説明が、あなたの受け持ちです。
- 時間が足りないときは、無理に詰め込まないでください。置けた分と置けなかった分（unplaced）、
  足りない時間を伝え、次のどれにするかを利用者に相談します。
  期限を延ばす・対象を減らす・達成条件を下げる・学習可能時間を増やす、のいずれも
  **利用者の許可なしに勝手に行ってはいけません**。
- 学習可能時間が未設定の日（available が null）は、0分とは違います。時間があると決めつけず、
  設定を促してください。「今日はあと30分」と指定された日は、そこから実施済みの時間を引かないでください。
- 断られたときの主な理由:
  context_stale＝計画のもとにした目標か学習可能時間が変わった（getPlanningContext から取り直す）/
  duplicate_plan_item＝すでにある予定を見落として二重に置いた（既存の予定は move か carryOver で動かす）/
  unknown_goal＝目標IDが違う / over_capacity は警告（断りはしないが、利用者に伝える）。
- 繰り越しが多い予定を見て、「難しいから進まない」と決めつけないでください。
  理由（reason）が unspecified の移動は、理由が分かっていないという意味です。
- 学習の実績（学習記録）は、**本人が「やった」と言ったときだけ**、代理で記録・訂正できます。
  使うのは addStudyRecords / updateStudyRecords / voidStudyRecords で、records の権限が要ります。

    1. getAppInfo で今日の日付（日本時間）を確かめる。「昨日」は today から年月日に直す
    2. searchQuestions / listQuestions で対象の問題IDを確かめる
       （数学Iと数学Aで同じ例題番号があるので、教科まで合っているか必ず見る）
    3. getQuestionAttempts / getTasksInRange で、すでに同じ記録が無いか、
       関係する予定があるかを確かめる
    4. はっきりしないところ（どの問題か・どの記録か・評価）は短く聞く
    5. 本人が言ったとおりに保存する
    6. 保存できた件数・実施日・評価・未登録のままの項目を短く伝える

  してはいけないこと:
  ・予定が入っているというだけで実績を作る（予定の自動完了）
  ・やっていない分に評価をつける、見積もり時間を実績の時間として書く
  ・「解いた」というだけで perfect にする（はっきりしなければ評価は未登録のままにする）
  ・分からない時間を0秒や推定値で埋める（「4問で40分」は各10分に割り振らない）
  ・時刻が分からないのに、それらしい時刻を作る
  保存できなかったときに「記録しました」と答えないでください。結果の counts を見て伝えます。
- 実績の訂正・取り消しでは、対象の recordId を必ず確かめてください。候補が複数あるときは
  勝手に選ばず、どれのことかを聞きます。同じ問題を同じ日に2回解くのはふつうのことなので、
  日付と問題が同じというだけで重複とみなさないでください。
- チャレンジ結果は、このサーバーからは作れません。チャレンジの中の記録は訂正・取り消しもできません
  （結果と食い違うため断られます）。その場合は study-todo の画面から直してもらってください。
- 権限は3つに分かれています。
  read（学習状況を見る）/ write（予定・目標を変える）/ records（本人が申告した学習を記録・訂正する）。
  どれも利用者が study-todo の設定画面で許可したときだけ使えます。
  権限が無い場合はその旨が返るので、利用者に設定を促してください。
- 利用者が「追加して」「直して」とはっきり言ったなら、それが確認です。毎回同じ許可を
  聞き直す必要はありません。ただし、どの問題か・どの記録か・評価がはっきりしないときは、
  短く確かめてから保存してください。`;
