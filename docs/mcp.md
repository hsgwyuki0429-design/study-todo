# クラウド同期と MCP 連携の手引き

study-todo の学習データを Cloudflare に預けて、Claude などの MCP 対応AIから
「今日の予定」を読み書きできるようにするための手順です。

```
study-todo（PWA・IndexedDB）
      ↓↑  端末キーで守られた同期
Cloudflare Worker + KV
      ↓↑  接続トークン（read / write）
MCP Server（/mcp）
      ↓↑
Claude などの MCP 対応AI
```

大事な前提が2つあります。

- **クラウドは追加の機能です。** 設定しなければ今までどおり、ブラウザの中だけで動きます。
  サーバーが落ちていても、圏外でも、学習の記録・タイマー・カレンダーはすべて使えます。
- **AIは学習実績を作れません。** MCPから公開しているのは「読む」ツールと、
  「これからの予定・目標を変える」ツールだけです。学習記録とチャレンジ結果を作れるのは、
  実際に学習した study-todo のPWAだけです。

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
3. 「トークンを発行」を押す

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
| `getTodayTasks` | 今日（または指定日）の予定 |
| `getTasksInRange` | 期間の予定 |
| `getGoals` | 長期の目標 |
| `getRecentAiChanges` | AIが行った変更の記録 |

### 変える（`write` の権限が要る）

| Tool | 何をするか |
|---|---|
| `updateTodayTasks` | 今日の予定を**置き換える** |
| `updateTasksForDate` | 指定した日の予定を**置き換える** |
| `addGoal` | 長期の目標を足す |
| `updateGoal` | 長期の目標を書き換える |

`updateTodayTasks` / `updateTasksForDate` は追加ではなく置き換えです。
残したい予定がある場合は、先に `getTodayTasks` で取得して、残す分も含めて渡します。

### 同期されるもの・されないもの

| 種類 | 同期 | やり方 |
|---|---|---|
| 学習記録（StudyRecord） | する | 追加専用イベント。`id` で重複排除。合計はサーバーで数え直す |
| チャレンジ結果 | する | 追加専用イベント。`id` で重複排除 |
| その日の予定（TaskPlan） | する | 日付ごとに `revision` と `updatedAt` で新しいほうを採る |
| 目標（Goal） | する | `id` ごとに `updatedAt` が新しいほうを採る |
| 問題マスタ | する | 指紋（hash）が変わったときだけ送り直す |
| セッション状態（タイマー） | **しない** | 計測中の状態はその端末だけのもの |
| 表示設定（テーマ・カレンダー） | **しない** | 端末ごとの好み |
| 管理キー・端末キー・接続トークン | **しない** | 端末の中だけ。バックアップJSONにも入らない |

---

## 会話の例

- 「今日の青チャートは何をやる予定？」 → `getTodayTasks`
- 「最近の△と✕を見て弱点を教えて」 → `getRecentMistakes` ＋ `getStudyStats`
- 「今日30分しかないから、やる問題を減らして」 → `getTodayTasks` → `updateTodayTasks`
- 「例題50〜65を3日間に分けて」 → `listQuestions` → `updateTasksForDate` を3回
- 「最近、計算ミスと方針ミスはどちらが多い？」 → `getRecentMistakes`（`calcErrors` / `wrongApproaches`）
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
npm test        # = node --test
```

## 困ったとき

| 症状 | 見るところ |
|---|---|
| 設定画面が「エラー」になる | サーバーのURL、管理キー、Worker がデプロイ済みか |
| AIが「接続トークンが正しくありません」と言う | 設定画面でトークンを再発行して入れ直す |
| AIが「権限がありません」と言う | 設定画面の「権限：予定を変更する」を許可する |
| 予定を変えたのに端末へ反映されない | その端末で「いますぐ同期」を押す（起動時とオンライン復帰時にも同期します） |
| 端末を無くした | 設定画面で同期コードを発行しなおし、接続トークンも再発行する |
| Claude.ai で「認証に失敗しました」と出る | Worker を最新版にデプロイし直す（claude.ai からの呼び出しを許可し、`/mcp` 付きの案内と `resource` に対応したのは新しい版）。そのうえで、コネクタを一度削除してから登録しなおす |
