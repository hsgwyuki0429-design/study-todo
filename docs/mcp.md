# クラウド同期と MCP 連携の手引き

study-todo の学習データを Cloudflare に預けて、Claude などの MCP 対応AIから
「今日の予定」を読み書きできるようにするための手順です。

```
study-todo（PWA・IndexedDB）
      ↓↑  端末キーで守られた同期
Cloudflare Worker + Durable Object（+ KV は引っ越し元として残る）
      ↓↑  接続トークン（read / write / records）
MCP Server（/mcp）
      ↓↑
Claude などの MCP 対応AI
```

大事な前提が2つあります。

- **クラウドは追加の機能です。** 設定しなければ今までどおり、ブラウザの中だけで動きます。
  サーバーが落ちていても、圏外でも、学習の記録・タイマー・カレンダーはすべて使えます。
- **AIが実績を作れるのは、本人が「やった」と言ったときだけです。**
  `records` の権限を許可すると、「昨日の例題50〜53を記録し忘れた」のような**申告**を
  もとに、AIが学習記録を足したり直したり取り消したりできます。
  予定や推測だけを根拠に実績を作ることはできません。評価・所要時間・時刻は、
  本人が言わなければ**未登録**のまま保存されます（AIが埋めることはありません）。
  チャレンジ結果を**作る**ことは今もできません（PWAで実際に解いたときだけ）。
  ただし「間違って始めた回を履歴から消したい」ときは、1回ぶんまるごと取り消せます。

---

## 1. Cloudflare の KV を作る

Cloudflare のアカウントを作り、パソコンのターミナルでこのリポジトリのフォルダへ移動します。

```sh
npx wrangler login
npx wrangler kv namespace create STUDY_TODO_KV
```

最後に `id = "..."` という行が表示されます。その値を `wrangler.toml` の

```toml
[[kv_namespaces]]
binding = "STUDY_TODO_KV"
id = "ここに貼る"
```

へ貼り付けます。

## 2. 管理キー（オーナーキー）を作る

自分だけが持つ鍵です。長いランダムな文字列にします。

```sh
openssl rand -hex 24
```

表示された文字列を控えます。**この値は絶対に GitHub へコミットしないでください。**
`wrangler.toml` にも書きません。AIにも渡しません。

## 3. 秘密として登録する

```sh
npx wrangler secret put STUDY_TODO_OWNER_KEY
# 聞かれたら、2で作った文字列を貼り付ける
```

## 4. デプロイする

```sh
npx wrangler deploy
```

`https://study-todo-mcp.＜あなたのアカウント名＞.workers.dev` のようなURLが表示されます。
ブラウザで開いて案内ページが出れば成功です。`/health` を開くと `{"ok":true,...}` が返ります。

## 5. 2回目からは GitHub に任せる（任意）

`main` へ push すると、テストが通ったときだけ自動でデプロイされる仕組みを
`.github/workflows/deploy.yml` に置いてあります。使うには、GitHub のリポジトリで
Settings → Secrets and variables → Actions を開き、次を登録します。

| 名前 | 中身 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare の API トークン。テンプレート「Edit Cloudflare Workers」で作る |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare ダッシュボードの右側に出ているアカウントID |
| `STUDY_TODO_KV_ID` | `wrangler.toml` の id を伏せたままにする場合だけ。実際の id を書いてコミットするなら不要 |

管理キー（`STUDY_TODO_OWNER_KEY`）はここには入れません。3 で Cloudflare 側へ
入れたものがそのまま使われます。GitHub には渡りません。

デプロイが走るのは `server/` など、サーバーに関わるファイルを変えたときだけです。
PWA だけ直したときは走りません。手で動かしたいときは、GitHub の Actions タブから
`deploy` を選んで「Run workflow」を押します。

うまくいったかは、こう確かめられます。

```sh
curl -s https://＜あなたのWorkerのURL＞/health
```

## 5. study-todo の設定画面へURLと管理キーを入れる

study-todo を開き、**設定 → AI連携 / 同期** で次を入力して「保存」を押します。

- サーバーのURL … 4で表示されたURL（`/mcp` は付けなくて構いません）
- 管理キー … 2で作った文字列

管理キーはこの端末の中（IndexedDB）にだけ保存され、バックアップJSONにも入りません。

## 6. 同期の設定（1台目）

1. 「同期コードを発行」を押します。`STUDY-XXXX-XXXX` の形のコードが一度だけ表示されます。
2. 「この端末の名前」（iPhone など）と、そのコードを入れて「この端末を登録」を押します。
3. 「いますぐ同期」を押します。1台目の学習履歴と問題マスタがクラウドへ入ります。

**2台目以降**（iPad・PC）も同じ手順です。同期コードは1台目の設定画面から発行し、
2台目の「同期コード」欄へ入力します。登録が済むと、以後は長い端末キーで自動的に同期します。

初回同期でローカルのデータが消えることはありません。学習記録は `id` で重ね合わせるだけで、
「クラウドのほうが件数が多い／少ない」を理由に片方を消すことはしません。

## 7. MCP の接続トークンを発行する

同じ設定画面で、

1. 「AI連携」を **オンにする**
2. AIに予定を変更させたいなら「権限：予定を変更する」を **許可中** にする
3. AIに「やった分を記録しておいて」と頼みたいなら
   「権限：学習の記録を代理入力する」を **許可中** にする
4. 「トークンを発行」を押す

権限は3つに分かれています。

| 権限 | できること |
|---|---|
| `read` | 学習状況を見る（常に必要） |
| `write` | これからの予定・目標・学習可能時間を変える |
| `records` | 本人が申告した学習を、実績として記録・訂正・取り消しする |

`records` は `write` とは**別**です。すでに発行してある read / write のトークンに、
黙って実績を触る力が付くことはありません。実績も任せたいときは、権限を許可したうえで
トークンを発行しなおしてください。

発行した接続トークンは **そのときだけ** 表示されます（サーバーにはハッシュしか残りません）。
控えそこねたら、もう一度「トークンを再発行」してください（前のトークンは使えなくなります）。

## 8. Claude Code へ登録する

```sh
claude mcp add --transport http study-todo https://study-todo-mcp.xxx.workers.dev/mcp \
  --header "Authorization: Bearer ＜7で発行した接続トークン＞"
```

## 9. Claude.ai（コネクタ）へ登録する

1. Claude.ai の設定 → コネクタ → カスタムコネクタを追加
2. URL に `https://study-todo-mcp.xxx.workers.dev/mcp` を入れる
3. 接続すると同意の画面が出るので、7で発行した接続トークンを貼り付けて「許可する」

OAuth 2.1 + PKCE（S256）に対応しているので、Bearer を直接設定できないクライアントでも接続できます。
対応している仕様は次のとおりです。

- RFC 9728 Protected Resource Metadata … `/.well-known/oauth-protected-resource`（`/mcp` 付きも可）
- RFC 8414 Authorization Server Metadata … `/.well-known/oauth-authorization-server`（`/mcp` 付きも可）
- RFC 7591 動的クライアント登録 … `/oauth/register`
- RFC 8707 resource（宛先）の指定 … `/oauth/authorize` と `/oauth/token` の `resource`
  認可のときと引き換えのときで宛先が違えば拒み、アクセストークンはこのサーバー専用として発行します
- RFC 9207 `iss` の付与、更新トークン（`grant_type=refresh_token`）

---

## 使える MCP Tool

### 読む

| Tool | 何をするか |
|---|---|
| `getAppInfo` | 章・単元の一覧、評価の5段階、今日の日付、同期の状況 |
| `listQuestions` | 問題マスタの一覧（章・単元・番号の範囲で絞る） |
| `searchQuestions` | キーワードで問題を探す |
| `getQuestion` | 1問の詳細と、その問題の学習履歴 |
| `getStudyHistory` | 1問ごとの学習記録（日時・評価・所要時間） |
| `getRecentMistakes` | 最近の △計算ミス と ✕方針ミス（種類ごとの件数つき） |
| `getStudyStats` | 学習時間・評価別・章別の統計、ミス率の高い章 |
| `getRecentChallengeResult` | 直近のチャレンジ結果 |
| `getChallengeResults` | チャレンジ結果の一覧 |
| `getTodayTasks` | 今日（または指定日）の予定と、その日に実際に取り組んだ記録 |
| `getTasksInRange` | 期間の予定と実績（日ごと） |
| `getQuestionAttempts` | 1つの問題への取り組みを1回ずつ（古い順・ページングあり） |
| `getUnfinishedPlanItems` | まだ取り組んでいない予定（繰り越しの相談に使う） |
| `getPlanMoves` | 繰り越し・予定変更の履歴（当初の予定日と回数つき） |
| `getGoalProgress` | 目標ごとの達成数・残量・未配置分・残り時間 |
| `getStudyAvailability` | 1日に使える学習時間（曜日別・日付ごと・今日の残り） |
| `getQuestionEstimates` | 問題ごとの所要時間の見積もりと、その根拠 |
| `getPlanningContext` | **計画を組むときの入口**。期間ぶんの状態をまとめて返す |
| `validatePlanChanges` | 配分案を保存せずに確かめる |
| `getGoals` | 長期の目標 |
| `getRecentAiChanges` | AIが行った変更の記録 |

| `getPlanChanges` | 予定の変更履歴（いつ・誰が・どの日の・どのタスクを・なぜ） |

### 変える（`write` の権限が要る）

| Tool | 何をするか |
|---|---|
| `applyTaskChanges` | 予定を**タスク単位で**変える（追加・編集・削除・並べ替え・別の日へ移動） |
| `undoTaskChanges` | 予定の変更を取り消す（取り消しも新しい変更として記録される） |
| `updateTodayTasks` | 【古い形】今日の予定を置き換える |
| `updateTasksForDate` | 【古い形】指定した日の予定を置き換える |
| `updateStudyAvailability` | 学習可能時間を変える |
| `saveQuestionEstimates` | 教材をもとにした**仮の**見積もりを保存する（実績にはならない） |
| `addGoal` | 長期の目標を足す |
| `updateGoal` | 長期の目標を書き換える |

### 実績を記録・訂正する（`records` の権限が要る）

| Tool | 何をするか |
|---|---|
| `addStudyRecords` | 本人が「やった」と言った学習を、実績として足す |
| `updateStudyRecords` | すでにある記録の一部（日付・評価・所要時間など）を直す |
| `deleteStudyRecords` | 記録を削除する（本当に消す。戻せない） |
| `deleteChallengeResults` | チャレンジ1回ぶんを削除する（結果と中の記録をまとめて） |
| `getRecordChanges` | 記録の追加・訂正・取り消しの履歴（`read` で読める） |

---

## 実績の代理入力

### 考え方

**本人が実施したと申告した学習だけ**、AIが代わりに記録できます。次のことは禁止です。

- 予定を「たぶんやっただろう」と自動で実績にすること
- 言われていない評価を埋めること（「解いた」だけで `perfect` にしない）
- 見積もりの所要時間を実績の所要時間として書くこと

分からないことは**分からないまま**保存します。評価が無ければ `evaluation: null`、
所要時間が無ければ `durationSeconds: null`、時刻が無ければ `datePrecision: "date"`（日付だけ）です。
アプリの画面では「未登録」と表示され、集計では件数から除かれます
（`getStudyStats` の `durationUnknownCount` / `evaluationUnknownCount` で何件不明かが分かります）。

### 日付の扱い

| 何 | どこに入るか |
|---|---|
| 実施日 | `date`（`YYYY-MM-DD`、日本時間）。集計・カレンダーはこれで並ぶ |
| 実施時刻 | `time`（`HH:MM`、任意）。あれば `datePrecision: "datetime"` |
| 登録日時 | `enteredAt`（サーバーが付ける。実施日とは別物） |
| 訂正日時 | `corrections[].at`（直すたびに増える） |

未来の日付は受け付けません。日付を直すと、その記録は新しい日の集計へ移ります。

### 手順

1. `getAppInfo` で今日の日付を確かめる
2. `searchQuestions` / `listQuestions` で問題IDを確定させる（番号だけで推測しない）
3. `getTodayTasks` / `getQuestionAttempts` で、すでに記録が無いか・対応する予定が無いかを見る
4. 分からないことだけ本人に聞く（聞けないならその項目は空のまま）
5. `addStudyRecords` に `operationId` を付けて保存する
6. 何件入ったか、何が未登録かを本人に伝える

```json
{
  "operationId": "self-report-2026-09-12-01",
  "claimSummary": "昨日、数学Iの例題50〜53を解いた",
  "records": [
    { "questionId": "数学I+A-例題-50", "date": "2026-09-12", "evaluation": "perfect" },
    { "questionId": "数学I+A-例題-51", "date": "2026-09-12", "evaluation": "calc_error" }
  ]
}
```

- 同じ `operationId` で送り直しても二重になりません（中身が違えば `operation_conflict`）。
  「同じ問題・同じ日」というだけでは重複と決めつけず、`possibleDuplicates` として**知らせるだけ**です
  （同じ日に2回解くことは普通にあるため）。
- 「4問で合計40分」のように、まとめてしか分からない時間は `durationGroup` に入ります。
  1問あたりへ勝手に割り振ることはしません。
- 予定と結びつけるときは `planItemId` を渡します。別の問題の予定や、すでに実施済みの予定には結べません。
- 1件でも通らなければ**1件も保存されません**。保存に失敗したときは「記録した」と答えないでください。

### 直す・取り消す

```json
{ "operationId": "fix-01", "updates": [
  { "recordId": "rec_...", "expectedRevision": 0, "date": "2026-09-12", "reason": "本当は昨日だった" }
] }
```

- 記録のIDは変わりません。渡した項目だけが変わります。
- `expectedRevision` が古ければ断られます（他の端末の変更を踏み潰しません）。
- `deleteStudyRecords` は**本当に消します**。戻せません。
  「何を消したか」だけは `getRecordChanges` に残りますが、中身は残りません。
  消したIDはサーバーが覚えているので、削除を知らない端末が同じものを送り直しても復活しません。
  どれを消すかが少しでも曖昧なときは、必ず先に本人へ確かめてください。

### チャレンジの履歴

チャレンジは「制限時間つきの通し」なので、中の1問だけを抜くと合計時間と食い違います。
そのため扱いを分けてあります。

| したいこと | できるか |
|---|---|
| チャレンジ結果を作る | **できません**（実際に挑戦した端末だけが作ります） |
| 1回ぶんを履歴から消す | `deleteChallengeResults`（結果と中の記録をまとめて） |
| 中の1問だけ消す | `deleteStudyRecords`。チャレンジの回そのものは残り、その1問だけが集計から外れます |
| 中の1問の評価を直す | `updateStudyRecords`（評価だけ） |
| 中の1問の日付・所要時間を直す | できません（`challenge_record` で断ります） |
| 消したものを戻す | **できません**（削除は本当に消すため） |

測った合計時間は、1問を消しても変えません（測った事実だからです）。

アプリからも同じことができます。スケジュールで日付を押すと、

- チャレンジの行の「削除」… その回ぶんを消す
- 中の1問を押して「この1問の記録を削除」… その1問だけ消す（回は残る）

### 同期と削除

端末で消したものは、次の同期でクラウドからも消えます。
サーバーは消したIDを覚えていて、削除を知らない端末が同じものを送ってきても受け取りません。
他の端末には「消したID」が配られ、その端末からも消えます。

### すべて消す

設定 → **データの削除** →「学習データをすべて削除」で、学習記録・チャレンジ・予定・目標・
繰り越しの記録・学習可能時間・見積もりの指定を、この端末とクラウドの両方から消します。
問題マスタと同期の鍵は残ります。二段階（確認 →「削除」と入力）で、戻せません。
先に 設定 → バックアップ → JSONで書き出す をしておくと、あとから見返せます。

クラウドと同期している端末でこれを行うには、その端末に管理キーが入っている必要があります
（端末だけ消しても、次の同期でクラウドから戻ってきてしまうため）。
AIからは、まとめて消す操作は一切できません（1件ずつの削除だけです）。

**ほかの端末は、次に同期したときに同じように消えます。** その端末で操作する必要はありません。
全部消すと配るものが無くなり、端末からは「空が返ってきた」としか見えないので、
サーバーは消した日時を印として残し、端末はそれを見て自分の手元も消します。

- 削除を知らない端末が送ってきた内容は、サーバーが1件も受け取りません
  （受け取ると、消したばかりのものがその端末から戻ってきてしまうため）。
- 印は1回しか効きません。消したあとにその端末で入れた分は消えません。
- 削除のあとに参加した端末は、昔の削除に巻き込まれません
  （参加した時点の印を、知っているものとして覚えるため）。

---

## 目標と再計画

### 役割の分け方

| だれが | 何を |
|---|---|
| アプリ・サーバー | 実績の集計、残りの量、時間の見積もり、制約の確認、安全な保存 |
| Claude | 目標や事情をふまえた優先順位、日々の配分案、変更理由の説明 |

数えられること（実績・残量・見積もり・時間の過不足）はサーバーが返します。推測しないでください。

### 計画の流れ

```
1. getPlanningContext（期間・目標を指定）
      ↓  今の状態（目標と残量／日ごとの予定と使える時間／見積もり／未配置／版）
2. 配分案を changes にまとめる
      ↓
3. validatePlanChanges           ← 保存はされない。時間・重複・期限・保護を確かめる
      ↓
4. applyTaskChanges（expectedRevisions ＋ expectedContext）
      ↓  反映のときにもう一度確かめてから保存
5. 何をなぜ変えたかを利用者に伝える
```

`expectedContext` は `getPlanningContext` が返した値をそのまま渡します。
計画を作ってから反映するまでに目標や学習可能時間が変わっていた場合は、
何も変えずに `context_stale` を返すので、取り直してやり直してください。

### 目標

目標は「何を・いつまでに・どの状態まで」を持ちます。

| 項目 | 内容 |
|---|---|
| `questionIds` | 対象の問題ID（**確定した一覧**）。`scopeFilter` で選んでも、保存されるのは結果のID一覧 |
| `startDate` / `deadline` | 開始日と期限（期限なしも可） |
| `completion` | `attempt`（1回ずつ取り組めば達成）か `mastery`（評価の条件を満たせば達成） |
| `priority` | 1〜5（1がいちばん高い） |
| `status` | `active` / `achieved` / `paused` / `cancelled` |
| `revision` | 競合の確認に使う版 |

**達成の数え方**

- 数えるのは「その目標に結び付いた予定から実施された取り組み」だけです。
  予定を作るときに `task.goalId` を渡すと、そこから実施された記録が目標の実績になります。
- だから**2周目の目標を作っても、1周目の記録では達成になりません**。
- 同じ問題が複数の目標に入っていても、実績が自動で流用されることはありません
  （予定を1つ置いただけなら、予定時間も1回ぶんしか数えません）。
- `mastery` は既定で **latest 方式**です。その目標に結び付いた**最新**の取り組みが
  `perfect` であれば達成で、あとで △ を取れば未達成に戻ります（`mode: "ever"` も選べます）。
- `attempt` の残量は確定値（`remainingIsComplete: true`）ですが、
  `mastery` は何回で習得できるか分からないので、返る残り時間は
  「未達成の問題にあと1回ずつ」ぶんにすぎません（`remainingIsComplete: false`）。
- 達成数はサーバーが学習記録から数え直します。AIからは書き換えられません。
- 対象が文章だけの古い目標は `needsScopeSetup: true` で返ります。
  文章から問題IDを推測して確定させないでください。

### 学習に使える時間

時刻の入った時間割ではなく、**1日あたりの分数**で決めます。

| 決め方 | 内容 |
|---|---|
| 曜日別（`weekly`） | 平日60分・休日120分 のような標準 |
| 日付ごと（`overrides`） | その日だけ 0分 や 180分 にする |
| 今日の残り（`todayRemaining`） | 「今日はあと30分」 |
| 予備（`reserveMinutes`） | 詰めすぎないための余白。**1日につき1回だけ**引かれる |

- `available` が `null` の日は**未設定**で、0分とは違います。時間があると決めつけないでください。
- 「今日はあと30分」と指定された日は、そこから実施済みの時間を**引きません**（二重控除の防止）。
  標準の枠から計算する日だけ、その日にアプリで計測できた学習時間を引きます。
  アプリの外で解いた分は分からないので、正確にしたいときは「あと○分」を指定してもらいます。
- ここでいう時間は study-todo で管理する学習の枠であって、
  学校や他教科を含む生活全体の空き時間ではありません。

### 所要時間の見積もり

毎回教材を読み直さずに、保存済みの情報だけで見積もります。優先順位は次のとおりです。

1. `manual` … 利用者が指定した時間（AIは上書きしない）
2. `history` … 同じ問題の、近い条件での本人の実績（中央値）
3. `history_blended` … 実績が少ないとき、既定値・仮見積もりと合わせた値
4. `similar` … 同じ単元・種類・難易度の問題での実績
5. `ai_estimate` … 教材をもとにした仮の値（`saveQuestionEstimates` で保存）
6. `default` … 種類と難易度から決めた仮の値

- 初見と復習、通常とチャレンジは分けて見積もります。
- 30秒未満（計測忘れ）と60分超（中断）の記録、制限時間で打ち切られたチャレンジの記録は
  見積もりの計算から外します。**学習記録そのものは消しません**。
- 平均ではなく中央値を使い、実績が少ないときは既定値と混ぜます。
- 返り値には `source` / `sampleCount` / `confidence`（high / medium / low）/ `method` が付きます。
  根拠のない精密な数字（信頼区間など）は出しません。

**答え合わせの時間**：アプリのタイマーは「問題を始めてから評価を記録するまで」を計っているので、
既定では答え合わせも含まれているものとして扱い、**上乗せしません**（`reviewSeconds: 0`）。
含まれていない使い方をしている場合は、設定で `timerIncludesReview: false` にすると
1問あたりの補助時間（`reviewOverheadSeconds`）を足します。予備時間（1日につき1回）とは別物で、
二重には加算しません。以前の記録は計測範囲が分からないため、そのまま実績として扱います。

### 入りきらないとき

無理に詰め込みません。`validatePlanChanges` / `applyTaskChanges` は次を返します。

- `days[]` … 日ごとの「予定○分／使える○分」
- `warnings[]` … `over_capacity`（何分足りないか）/ `capacity_not_configured`（未設定の日）/
  `after_deadline`（期限より後ろ）/ `single_item_too_long`（1問だけで枠を超える）
- `unplaced[]` … まだ置けていない分（目標の対象として残り、消えません）

足りないときは、**期限を延ばす・対象を減らす・達成条件を下げる・使える時間を増やす**の
どれにするかを利用者に相談してください。AIが黙って変えてはいけません。

## 予定と実績の考え方

3つを区別しています。

| ことば | 何か | 識別子 |
|---|---|---|
| 問題 | 例題50 のような、問題マスタ上の対象 | `question.id` |
| 予定項目 | 「その問題に今回取り組む」1件の予定 | `item.itemId` |
| 学習記録 | 「実際に今回取り組んだ」1件の結果 | `record.id` |

**1回の取り組み＝1件の学習記録**です。

- 同じ問題を2周目に解けば記録は2件。同じ日に2回解いても2件です（上書きしません）。
- やらなかった予定を別の日へ繰り越しても、**取り組み回数は増えません**。
- 学習記録の `planItemId` で、どの予定に対する取り組みだったかが分かります。
  この仕組みより前の記録には入っていないので `legacy: true` で返ります。
  同じ問題・同じ日というだけで対応付けを作ることはしません。

`getTodayTasks` / `getTasksInRange` は、この両方を返します。

```jsonc
{
  "date": "2026-09-12",
  "tasks": [{
    "id": "task_ab12",
    "kind": "new",
    "items": [
      { "itemId": "task_ab12#0", "questionId": "数学I-例題-90", "label": "基本例題 90",
        "originalDate": "2026-09-11", "carriedCount": 1, "carriedOver": true },
      { "itemId": "task_ab12#1", "questionId": "数学I-例題-91", "label": "基本例題 91",
        "originalDate": "2026-09-12", "carriedCount": 0, "carriedOver": false }
    ],
    "doneItemIds": ["task_ab12#0"],
    "pendingItemIds": ["task_ab12#1"],
    "locked": false
  }],
  "attempts": [
    { "recordId": "rec_1", "questionId": "数学I-例題-90", "evaluation": "perfect",
      "durationSeconds": 320, "inChallenge": false, "planItemId": "task_ab12#0", "legacy": false }
  ],
  "attemptCount": 1,
  "pendingItemCount": 1,
  "revision": 7
}
```

## 繰り越し（やり残しを別の日へ）

1. `getUnfinishedPlanItems` で、まだ取り組んでいない `itemId` を確かめる
2. `applyTaskChanges` の `carryOver` で動かす

```jsonc
{
  "operationId": "2026-09-12-carry-over",
  "expectedRevisions": [
    { "date": "2026-09-12", "revision": 7 },
    { "date": "2026-09-13", "revision": 2 }
  ],
  "changes": [
    { "op": "carryOver", "taskId": "task_ab12", "fromDate": "2026-09-12", "toDate": "2026-09-13",
      "itemIds": ["task_ab12#1"], "reason": "time_shortage" }
  ]
}
```

- `itemIds` を省くと、そのタスクの**未実施の分すべて**が動きます。
- すでに取り組んだ分を混ぜると `already_done` で断られます（実績は実施した日に残します）。
- 予定項目のID（`itemId`）は動かしても変わりません。`originalDate`（当初の予定日）も変わらず、
  `carriedCount` が1つ増えます。
- **理由（`reason`）は、利用者が言ったときだけ**入れてください。
  `time_shortage`（時間不足）/ `too_hard`（難しかった）/ `schedule_change`（予定変更）/
  `other` / `unspecified`（未入力）。推測した理由を事実として保存してはいけません。
- 動かしたことは追加専用の記録として残り、`getPlanMoves` で読めます。
  同じ `operationId` の再送でも、記録は重複しません。

アプリ側でも、スケジュールの日別の詳細から、理由をワンタップで選んで繰り越せます。

## 予定の変え方（applyTaskChanges）

AIが予定を変えるときの流れは、いつも同じ4段です。

1. `getTodayTasks` / `getTasksInRange` で、**いまの予定・`task.id`・`revision`・`locked`** を取る
2. 変えたい**タスクだけ**を `changes` に並べる
3. 変える**すべての日**（移動元と移動先の両方）の `revision` を `expectedRevisions` に入れる
4. `operationId`（自分で決める文字列）と `reason`（理由）を付けて呼ぶ

```jsonc
{
  "operationId": "2026-09-12-shorten-today",
  "reason": "今日は30分しか取れないため、2件を明日へ移した",
  "expectedRevisions": [
    { "date": "2026-09-12", "revision": 7 },
    { "date": "2026-09-13", "revision": 2 }
  ],
  "changes": [
    { "op": "move", "taskId": "task_ab12", "fromDate": "2026-09-12", "toDate": "2026-09-13" },
    { "op": "move", "taskId": "task_cd34", "fromDate": "2026-09-12", "toDate": "2026-09-13" },
    { "op": "update", "taskId": "task_ef56", "patch": { "questionIds": ["数学I-例題-90"] } },
    { "op": "add", "date": "2026-09-13", "tempId": "review1",
      "task": { "questionIds": ["数学I-例題-88"], "kind": "review", "title": "復習" } },
    { "op": "reorder", "date": "2026-09-13", "taskIds": ["task_ab12", "task_cd34"] }
  ]
}
```

成功すると、変更ID・確定した内容・更新後の revision が返ります。

```jsonc
{
  "ok": true,
  "changeId": "chg_...",
  "revisions": { "2026-09-12": 8, "2026-09-13": 3 },
  "summary": {
    "dates": ["2026-09-12", "2026-09-13"],
    "moved": [{ "taskId": "task_ab12", "from": "2026-09-12", "to": "2026-09-13" }],
    "created": [{ "date": "2026-09-13", "taskId": "task_9xyz", "tempId": "review1" }],
    "removed": [], "updated": [{ "date": "2026-09-12", "taskId": "task_ef56" }]
  },
  "days": [ /* 変更後のその日の予定 */ ]
}
```

決めごとは次のとおりです。

- **IDは作るときだけ発行**します。編集しても、別の日へ移しても `task.id` は変わりません。
- **指定しなかったタスクと項目はそのまま**残ります（`patch` に入れた項目だけが変わります）。
- **全部成功か、全部未反映か**のどちらかです。1つでも通らなければ1件も変わりません。
- **同じ `operationId` を送り直しても二重になりません**（前回と同じ結果が `replayed: true` で返ります）。
  同じ `operationId` で内容だけ違う要求は断られます。
- 存在しないタスクID・問題ID・不正な操作は、**変更を始める前に**確かめて断ります。

### 断られたときの読み方

| `error` | 意味 | 次にすること |
|---|---|---|
| `revision_conflict` | ほかの端末かAIが先に変更した | `getTasksInRange` で取り直して組み立て直す |
| `missing_revision` | 変える日の revision が渡されていない | その日を `expectedRevisions` に足す |
| `task_not_found` | タスクIDが古い／その日にない | 取り直す |
| `protected_task` | 完了済み・実行中・固定のタスク | 触らずに、ほかのタスクで調整する |
| `unknown_question` | 問題IDが問題マスタにない | `listQuestions` で確かめる |
| `operation_conflict` | 同じ `operationId` で内容が違う | 新しい `operationId` を付ける |
| `invalid_input` | 形が正しくない | メッセージの `field` を直す |
| `permission_denied` | 利用者が「予定を変更する」を許可していない | 設定画面での許可を促す |
| `storage_not_atomic` | サーバーの保存先の設定が古い | 下の「保存先の移行」を利用者に伝える |

### 古い形（updateTodayTasks / updateTasksForDate）

残してありますが、**その日の全置き換え**です。いまは中でタスク単位の変更へ直されるので、

- 内容が同じタスクのIDは保たれます（`id` を渡せば確実です）
- 完了済み・実行中・固定のタスクは、この経路でも消えず・変わりません
- `expectedRevision` を渡せば、古い内容で新しい内容を上書きしません（強く推奨）
- `completed: true` は渡せません（完了になるのは実際に学習したときだけ）

新しく書くときは `applyTaskChanges` を使ってください。

---

## 守られるタスク（AIが動かせないもの）

`getTodayTasks` / `getTasksInRange` が返すタスクには `locked` と `lockedReason` が付きます。

| `lockedReason` | 何か | 解除できる人 |
|---|---|---|
| `completed` | もう終わったタスク | （学習の結果なので解除しない） |
| `running` | いま解いているタスク | 端末が知らせるのをやめれば自然に外れる |
| `pinned` | 利用者が固定したタスク | **利用者だけ**（study-todo のホーム画面の「固定」ボタン） |

固定の付け外しは `/api/sync/pin`（端末キーが要る）だけで行えます。MCPには固定を付けるツールも
外すツールもないので、AIが自分で保護を外すことはできません。

### 「実行中」の限界（できていないこと）

実行中かどうかは、**アプリがオンラインのときに知らせてきた範囲**でしか分かりません。

- 端末は学習を始めたとき・問題を切り替えたとき、それに5分ごとに知らせます（期限つき・既定15分）。
- **圏外・機内モード・アプリを閉じている**あいだは知らせが届かないので、
  その端末で解いているタスクをAIが移したり消したりできてしまいます。
- ただし、そのときも**学習記録・チャレンジ結果・タイマーは壊れません**。
  記録は追加専用のイベントで、予定の変更とは別に `id` で重ね合わされます。
  端末のタイマーはその端末の中だけで動いていて、同期で止まることも消えることもありません。
  予定から消えたタスクの問題を解いた記録も、そのまま残ります。

つまり「実行中の保護」は**完全ではありません**。確実に守りたいタスクは「固定」を使ってください。

---

## 変更履歴と取り消し

一括変更ごとに、変更前後・対象のタスク・対象の日・実行者・日時・理由を残しています。

- AIからは `getPlanChanges`（`includeDetail: true` で変更前後の中身も）
- アプリからは **設定 → AI連携 / 同期 → 最近の予定の変更**
- 取り消しは、アプリの「取り消す」ボタンか、AIの `undoTaskChanges`

取り消しは履歴を消す操作ではなく、**打ち消す変更を新しく1件作って記録**します。
次のときは何も変えずに `undo_conflict` を返します。

- そのあとに学習が進んだ（完了になった）
- そのあとに別の変更が入って、対象のタスクの中身が変わった
- 対象のタスクが固定された／いま解かれている

学習記録とチャレンジ結果は取り消しの対象になりません（予定だけが戻ります）。

### 同期されるもの・されないもの

| 種類 | 同期 | やり方 |
|---|---|---|
| 学習記録（StudyRecord） | する | 追加専用イベント。`id` で重複排除。合計はサーバーで数え直す |
| チャレンジ結果 | する | 追加専用イベント。`id` で重複排除 |
| その日の予定（TaskPlan） | する | 日付ごとに `revision` と `updatedAt` で新しいほうを採る。別の日へ移したタスクは、移動を知らない端末が送ってきても元の日へ戻さない |
| 固定（pinned） | する | サーバー側の固定は、端末の同期では消えない（`/api/sync/pin` だけが付け外しできる） |
| 実行中の知らせ | する（片道・期限つき） | 端末 → サーバーのみ。オフラインの端末のぶんは分からない |
| 予定の変更履歴 | する | 直近50件。取り消しに使う |
| 目標（Goal） | する | `id` ごとに `updatedAt` が新しいほうを採る |
| 繰り越しの記録（move） | する | 追加専用イベント。`id` で重複排除。再送しても増えない |
| 目標（構造つき） | する | `id` ごとに `updatedAt` が新しいほうを採る。対象のID一覧も含む |
| 学習可能時間 | する | 1つの文書。更新時刻が新しいほうを採る |
| 見積もりの指定 | する | 問題ごとに「本人の指定」と「AIの仮値」を別々に、新しいほうを採る |
| 見積もりの計算結果 | **しない** | 学習記録から計算し直せるので保存しない |
| 問題マスタ | する | 指紋（hash）が変わったときだけ送り直す |
| セッション状態（タイマー） | **しない** | 計測中の状態はその端末だけのもの |
| 表示設定（テーマ・カレンダー） | **しない** | 端末ごとの好み |
| 管理キー・端末キー・接続トークン | **しない** | 端末の中だけ。バックアップJSONにも入らない |

---

## 保存先の移行（KV → Durable Object）

**なぜ必要か。** Cloudflare KV は「最後に書いた人が勝つ」保存先で、
「読んだときから変わっていなければ書く」（compare-and-swap）ができません。
世界中に配られるまでの遅れもあります。そのため、

- 期待した revision を確かめてから書く
- 複数の日を、途中を見せずにまとめて書く

という処理を KV **だけ**では正しく行えません。Durable Object は1つだけ存在する
オブジェクトで、その中の保存先はトランザクションに対応しているため、
study-todo（利用者は1人）は Durable Object を1つ（名前 `study-todo`）作り、
すべての読み書きをそこへ集めます。

**手順。** `wrangler.toml` には設定済みなので、デプロイし直すだけです。

```sh
npx wrangler deploy
```

`main` へ push して GitHub Actions に配らせる場合も同じです（`wrangler.toml` に
`[[migrations]]` が入っているので、Durable Object は配るときに自動で用意されます）。

- 初回アクセスのときに、KV にあった `studytodo:` で始まるデータが
  自動で Durable Object へ写されます（一度だけ。`server/storage/do-driver.js`）。
- 写し終えても **KV のデータは消しません**。元の設定に戻すこともできます。
- 移行できたかは `/health` で分かります。

```sh
curl -s https://＜あなたのWorkerのURL＞/health
# {"ok":true,...,"storage":{"driver":"durable-object","atomicBatchUpdates":true,...}}
```

**移行前（KVのみ）はどうなるか。** 読み取り・端末どうしの同期・目標の変更は
これまでどおり動きます。予定の変更（`applyTaskChanges` / `updateTodayTasks` /
`updateTasksForDate` / 取り消し）は、**黙って書かずに** `storage_not_atomic` を返し、
AIが利用者へ更新を促します。設定画面にも同じ案内が出ます。

手元（Node）で動かすときの保存先はファイルで、1つのプロセスの中で順番待ちをするので
まとめ書きができます。同じフォルダを複数のプロセスから同時に書く使い方は想定していません。

---

## 会話の例

- 「今日の青チャートは何をやる予定？」 → `getTodayTasks`
- 「最近の△と✕を見て弱点を教えて」 → `getRecentMistakes` ＋ `getStudyStats`
- 「今日30分しかないから、一部を明日に回して」 → `getTasksInRange`（今日・明日）→ `applyTaskChanges`（`move` を並べる）
- 「例題50〜65を3日間に分けて」 → `listQuestions` → `applyTaskChanges` 1回（3日ぶんの `add`）
- 「さっきの変更を取り消して」 → `getPlanChanges` → `undoTaskChanges`
- 「最近、計算ミスと方針ミスはどちらが多い？」 → `getRecentMistakes`（`calcErrors` / `wrongApproaches`）
- 「昨日やり残した分を今日に回して」 → `getUnfinishedPlanItems` → `applyTaskChanges`（`carryOver`）
- 「例題90は何回解いた？」 → `getQuestionAttempts`（`totalAttempts` と1回ずつの評価）
- 「何回繰り越した？」 → `getPlanMoves`（`carriedCount` と当初の予定日）
- 「12月までに2次関数の基本例題を一通り終える目標を作って」 → `addGoal`（`scopeFilter` で対象を確定）
- 「今週の予定を組んで」 → `getPlanningContext` → `validatePlanChanges` → `applyTaskChanges`
- 「今日はあと30分。今週を組み直して」 → `updateStudyAvailability`（todayRemainingMinutes）
  → `getPlanningContext` → `applyTaskChanges`（`carryOver` と `move`）
- 「目標にどれくらい届いてる？」 → `getGoalProgress`
- 「明日は例題84〜92と復習3問に変更して」 → `listQuestions` → `updateTasksForDate`

AIが予定を変えると、次に study-todo を開いて同期したときに、ホーム画面のTODOと
カレンダーへ反映されます。

---

## 手元で動かす（任意）

Cloudflare を使わず、自分のパソコンで試すこともできます。

```sh
cp .env.example .env     # STUDY_TODO_OWNER_KEY を自分の値に書き換える
node --env-file=.env server/adapters/node.js
# → http://localhost:8788/mcp
```

保存先は `.study-todo-data/`（`.gitignore` 済み）です。

## テスト

```sh
npm test          # 判定のしかた（Node標準のテスト）
npm run test:e2e  # 実ブラウザでの通し確認（Playwright が要る）
npm run test:all  # 両方
```

## 困ったとき

| 症状 | 見るところ |
|---|---|
| 設定画面が「エラー」になる | サーバーのURL、管理キー、Worker がデプロイ済みか |
| AIが「接続トークンが正しくありません」と言う | 設定画面でトークンを再発行して入れ直す |
| AIが「権限がありません」と言う | 設定画面の「権限：予定を変更する」、実績なら「権限：学習の記録を代理入力する」を許可し、トークンを発行しなおす |
| AIが入れた記録の評価が「未登録」 | 言っていないことは埋めない決まりです。評価を伝えれば `updateStudyRecords` で入ります |
| 間違った記録が入った | AIに削除を頼む（`deleteStudyRecords`）か、アプリでその記録を押して「削除」。戻せないので、どれを消すかを先に確かめてください |
| 消したのに次の同期で戻ってくる | クラウドを使っている端末で「学習データをすべて削除」を押すには管理キーが必要です。1件ずつの削除なら、同期が通っていれば戻りません |
| 予定を変えたのに端末へ反映されない | その端末で「いますぐ同期」を押す（起動時とオンライン復帰時にも同期します） |
| AIが「storage_not_atomic」と言う | 「保存先の移行」に従って `npx wrangler deploy` をやり直す |
| AIが「このタスクは変更できません」と言う | 完了済み・実行中・固定のタスク。固定はホーム画面の「固定」ボタンで外せる |
| AIが予定を変えすぎた | 設定 → AI連携 / 同期 → 最近の予定の変更 → 「取り消す」 |
| 端末を無くした | 設定画面で同期コードを発行しなおし、接続トークンも再発行する |
| Claude.ai で「認証に失敗しました」と出る | Worker を最新版にデプロイし直す（claude.ai からの呼び出しを許可し、`/mcp` 付きの案内と `resource` に対応したのは新しい版）。そのうえで、コネクタを一度削除してから登録しなおす |
