// study-todo がAIへ公開するMCP Tools。
//
// ここはプロトコルとサービス層をつなぐ薄い層に留める。
// 実際の処理は server/service/study-service.js にあり、
// 管理API（設定画面）からも同じ処理を使える。
//
// このサーバーからは、学習記録（StudyRecord）とチャレンジ結果を
// 「作る」ツールを一切公開しない。実績を作れるのは、実際に学習した
// study-todo のPWAだけである。

import { toolResult } from "./core/mcp.js";
import { PermissionError, requireScope } from "./auth/tokens.js";
import { ValidationError } from "./core/validate.js";
import { SERVICE_LIMITS } from "./service/study-service.js";
import { EVALUATIONS, MISTAKE_EVALUATIONS, TASK_KINDS } from "./service/merge.js";

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
    order: { type: "integer", minimum: 0, maximum: 999, description: "並び順。省略すると配列の順番になる。" },
    completed: { type: "boolean", description: "すでに終わったものとして置く場合だけ true。ふつうは指定しない（学習の実績は study-todo 本体が記録する）。" },
  },
};

const REPLACE_NOTE = [
  "この操作は、その日の予定を **まるごと置き換える**（追加ではない）。",
  "いま入っている予定を残したい場合は、先に getTodayTasks / getTasksInRange で取得し、",
  "残す予定も含めた全体を tasks に渡すこと。tasks に空配列を渡すとその日の予定は空になる。",
  "この操作で学習記録が消えることはない。変えられるのは「これからやる予定」だけ。",
].join("");

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
      description: "study-todo の構成・問題数・章と単元の一覧・評価の5段階・今日の日付・同期している端末・データ形式の版を返す。最初にこれを呼ぶと、他のツールへ渡せる値（章名・単元名・評価の値）が分かる。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { properties: { timezoneOffsetMinutes: TIMEZONE_PROPERTY } },
      run: (args, { service }) => service.getAppInfo(args),
    }),

    defineTool({
      name: "listQuestions",
      title: "問題を一覧",
      description: "青チャートの問題マスタを、教科・章・単元・種類・番号の範囲で一覧する。「例題80〜100」のように番号で範囲を取りたいときは numberFrom / numberTo を使う。返る件数に上限があるので、続きは nextOffset を offset に渡して読む。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          subject: { type: "string", description: "教科で絞る（例: 数学I+A）。getAppInfo で一覧が分かる。" },
          chapter: { type: "string", description: "章で絞る（例: 数列）。" },
          section: { type: "string", description: "単元で絞る（例: 漸化式）。" },
          type: { type: "string", description: "問題の種類で絞る（例: 例題 / 練習 / EXERCISES）。" },
          numberFrom: { type: "integer", minimum: 0, description: "この番号以上の問題だけに絞る。" },
          numberTo: { type: "integer", minimum: 0, description: "この番号以下の問題だけに絞る。" },
          limit: { type: "integer", minimum: 1, maximum: SERVICE_LIMITS.listLimitMax, description: `返す件数（既定 ${SERVICE_LIMITS.listLimitDefault}、最大 ${SERVICE_LIMITS.listLimitMax}）。` },
          offset: { type: "integer", minimum: 0, description: "続きを読むときの開始位置。前回の nextOffset を渡す。" },
        },
      },
      run: (args, { service }) => service.listQuestions(args),
    }),

    defineTool({
      name: "searchQuestions",
      title: "問題を検索",
      description: "キーワードで問題を探す。問題名・章・単元・種類・番号が検索対象。空白で区切るとすべてを含む問題だけに絞られる。章の正確な名前が分からないときに使う。",
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
      description: "問題IDを指定して、その問題の情報と、これまでの学習履歴（日付・評価・所要時間）・平均所要時間・直近の評価を返す。「この問題は前どうだったか」を調べるときに使う。",
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
      description: "from から to までの各日の予定をまとめて返す。「今週の予定」「来週どこまで進む予定か」を見るときや、複数日へ問題を割り振る前の下調べに使う。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          from: { ...DATE_PROPERTY, description: "開始日（YYYY-MM-DD）。省略すると今日。" },
          to: { ...DATE_PROPERTY, description: "終了日（YYYY-MM-DD）。省略すると今日。" },
          timezoneOffsetMinutes: TIMEZONE_PROPERTY,
        },
      },
      run: (args, { service }) => service.getTasksInRange(args),
    }),

    defineTool({
      name: "getGoals",
      title: "目標の一覧",
      description: "「12月までに青チャートI+Aを終える」のような長期の目標を、期限の近い順に返す。",
      scope: "read",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: { properties: {} },
      run: (_args, { service }) => service.getGoals(),
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
      name: "addGoal",
      title: "目標を追加",
      description: "長期の目標を1件追加する（例: 「12月までに青チャートI+Aの例題を終える」）。日々の予定は updateTodayTasks / updateTasksForDate で、ここは月単位の目標だけに使う。",
      scope: "write",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        properties: {
          title: { type: "string", maxLength: 200, description: "目標の内容。" },
          deadline: { ...DATE_PROPERTY, description: "期限（YYYY-MM-DD）。省略可。" },
          scope: { type: "string", maxLength: 400, description: "対象の範囲（例: 数学I+A 例題1〜200）。省略可。" },
        },
        required: ["title"],
      },
      run: (args, { service, actor }) => service.addGoal(args, actor),
    }),

    defineTool({
      name: "updateGoal",
      title: "目標を変更",
      description: "既存の目標を書き換える。変えたい項目（title / deadline / scope）だけを渡せば、ほかはそのまま残る。目標の削除はAIからはできない（study-todo の画面から行う）。",
      scope: "write",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        properties: {
          id: { type: "string", description: "変更する目標のID。getGoals で分かる。" },
          title: { type: "string", maxLength: 200, description: "新しい内容。" },
          deadline: { ...DATE_PROPERTY, description: "新しい期限。空文字を渡すと期限なしになる。" },
          scope: { type: "string", maxLength: 400, description: "新しい範囲。" },
        },
        required: ["id"],
      },
      run: (args, { service, actor }) => service.updateGoal(args, actor),
    }),
  ];
}

/** AIへ渡す、このサーバーの使い方の説明。 */
export const SERVER_INSTRUCTIONS = `study-todo は、青チャート（数学の問題集）の学習を記録・管理するアプリです。
このサーバーからは、学習状況を読み取り、これからの予定と目標を変更できます。

使うときの目安:
- まず getAppInfo を呼ぶと、章・単元の一覧、評価の5段階、今日の日付が分かります。
  日付はすべて日本時間（UTC+9）で扱います。
- 「今日やる予定」は getTodayTasks、別の日や期間は getTasksInRange です。
- 評価は5段階です。perfect(◯完璧) / better_solution(解もっと良い解法) /
  weak_writing(記記述が甘い) / calc_error(△計算ミス) / wrong_approach(✕方針が違った)。
  「弱点」を聞かれたら getRecentMistakes と getStudyStats の weakChapters を見てください。
- 予定を変えるときは、必ず先に getTodayTasks / getTasksInRange でいまの予定を取得してから、
  残す予定も含めた全体を updateTodayTasks / updateTasksForDate に渡してください。
  これらは「置き換え」であり、追加ではありません。
- 問題は questionIds に問題ID（listQuestions が返す id）で指定します。「例題90」という
  表示名ではありません。
- 学習記録とチャレンジ結果は、このサーバーからは作れません。実際に study-todo で
  学習したときだけ記録されます。実績を推測で書き込むことはできません。
- 予定・目標の変更は、利用者が study-todo の設定画面で「予定を変更する」権限を
  許可したときだけ行えます。権限が無い場合はその旨が返るので、利用者に設定を促してください。`;
