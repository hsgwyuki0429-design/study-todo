# 毎日03:00 JSTのClaude Auto Planner

PR #5のRoutine adapter、Worker Secrets、DO ledger、transaction、attemptedAt、waitUntil、
MCP / validation / revision / atomic updateを再利用し、自動起動を`daily_3am`へ変更した。
このファイル名は既存リンクとの互換性のため維持する。

## 現状構成と今回の変更

PWAはGitHub Pagesで動き、IndexedDBにsession・本人の学習記録・同期outboxを保存する。
`src/home.js`の終了処理は進行中の評価保存を待ち、既存タイマーを止め、
`api.finishStudySession`でsession終了と終了通知を同一IndexedDB transactionに保存する。
計測・途中再開は[学習sessionの仕様](./study-session.md)を参照。
`durationSeconds`の合計を維持し、新しい計測では解答／採点・暗記の内訳も保存する。
未入力の評価・学習実績は生成しない。

通常終了の通知は`type: session_end`、keyは`session_end:<sessionId>`。
記録・予定などの同期を先に完了してから、端末認証付き`POST /api/sync/study-end`を送る。
サーバーの`ok:true, studyEnd:"success"`で通知をackする。再計画の失敗はackを妨げない。
PR #5の未送信`type: replan`通知も終了通知として受理し、新たな再計画を作らない。

`StudyTodoStore`は既存と同じ`study-todo`という名前の単一DO。
記録保存、MCP権限、`getPlanningContext`、`validatePlanChanges`、`applyTaskChanges`、
予定revision、operationId、変更履歴、atomic updateの契約は変更していない。

## 新しい処理フロー

1. Cloudflare Cron `0 18 * * *`が毎日18:00 UTCに実行される。
2. `scheduledTime`を明示的なJST（UTC+540分）で日付に変換する。
   例：2026-09-14 18:00 UTC → planning date `2026-09-15`。
   Workerの処理が遅れても、実行時刻ではなくScheduled Eventの時刻から日付を決める。
3. Worker内部から同じDOへ日次イベントを渡す。
   `/__internal/daily-replan`はDO内部用で、公開Workerのfetchは認証ヘッダーに関係なく404を返す。
4. DO transactionで日次ledger、既存AI read/write設定、session leaseを確認する。
5. 学習中なら`deferred`を保存してDO alarmを設定する。
6. 学習中でなければHTTPより先に`attemptedAt`を永続化し、`waitUntil`でRoutineへPOSTする。
7. Claudeは既存MCPから最新contextを取得し、検証成功時のみatomic apply、再取得を行う。
8. PWAは次の同期・スケジュール再表示で新しい予定を受け取る。

Routineへ渡すのはmetadataだけ。学習記録、予定、目標、Planning Contextのsnapshotは渡さない。

```text
trigger=daily_3am eventId=daily_replan_2026-09-15 date=2026-09-15
```

学習記録が0件でも日次処理を実行する。Workerは再計画内容を判断しない。
通常の学習終了、問題終了、評価入力、同期、アプリ起動、画面表示、pull-forward、
期限やavailabilityの変更を即時Claude triggerにはしない。

## 手動実行（設定 → AI連携 / 同期 → プランナーを今すぐ実行）

03:00を待たずに同じプランナーを起動したいときの入口。Cron・daily ledger・DO alarm・
延期処理には一切触らず、設定・権限・Secretの確認、claim、Routine Fire、結果分類は共有する。

```text
PWA（設定画面）→ POST /api/admin/replan/fire（owner認証）→ DO → Claude Routine Fire API
```

`ownerGuard`（`STUDY_TODO_OWNER_KEY`）で守る。接続トークン・端末キーでは通らない。
要求本文は`operationId`だけで、`CLAUDE_ROUTINE_API_TOKEN`と`CLAUDE_ROUTINE_FIRE_URL`は
これまでどおりWorker Secretからしか読まず、PWAへは返さない。
応答は`{ ok, replan }`で、`publicReplan`（eventId / trigger / date / operationId / state /
error / retryable / outcomeUnknown）だけを返す。providerのsession ID / URLはDOの中だけに残す。

| 項目 | daily_3am | manual |
| --- | --- | --- |
| 入口 | Cron `0 18 * * *` → `/__internal/daily-replan` | `POST /api/admin/replan/fire` |
| 台帳 | `studytodo:replan:daily:<date>` | `studytodo:replan:manual:<operationId>` |
| 冪等性 | 学習日ごとに最大1回 | 同じ`operationId`につき最大1回（押し直すたびに新しい実行） |
| eventId | `daily_replan_YYYY-MM-DD` | `manual_replan_<operationId>` |
| 学習中 | `deferred`にしてalarmで再開 | `study_in_progress`で明確に断る（「今すぐ」の意味を曖昧にしない） |
| 応答 | POSTを待たない | 押した人へ結果を返すため送信結果を待つ（`waitUntil`にも渡す） |

`date`は03:00 JST区切りの学習日で、`src/datetime.js`の`studyDateKeyOf`をdailyと同じに使う。
手動実行はその日のdailyの記録・`attemptedAt`・`deferred`索引を読み書きしないので、
dailyが未実行・failed・triggeredのいずれでも実行でき、翌日のCronも通常どおり動く。
学習実績は作らない。triggerは再計画を始める理由にすぎない。

Logsには`manual_replan`として`eventId` / `trigger` / `date` / `operationId` / `state` / `error`
だけを出す（`publicReplan`の許可した項目のみ）。

## 学習中の延期と異常終了

既存の`/api/sync/activity`と端末台帳を利用する。
端末の`activeSession`にsessionIdと期限を保存し、新しい別sessionストアは設けない。
従来のtask activityも古いPWAとの互換性のため判定に含める。

PWAは開始時、起動時、オンライン復帰、画面復帰、学習中の1分間隔でactivityを更新する。
問題を選んでいない状態・評価入力中・一時停止中もsessionがactiveなら更新する。
leaseは既存の15分。定期heartbeatで長時間の学習を継続できる。

終了時はローカル保存と記録同期を先に行い、`study-end`の受理transactionで該当sessionを解除する。
その後、**すでにdeferredのdaily eventだけ**を再開する。通常終了から新規daily eventは作らない。
閉じたsessionの受理記録を残し、遅れて届いたheartbeatでは復活させない。
他の端末がactiveなら引き続き延期する。

DO alarmはlease期限を再確認し、heartbeatで延長されていれば次の期限へ設定し直す。
異常終了などで更新が止まれば期限後に延期イベントを再開する。
終了受理後に再計画処理が失敗してもalarmが再開を担当する。

**観測の限界：**スマホOSがPWAを停止した場合やオフライン状態ではheartbeatを送れない。
最後の通知から15分以上経つと、学習継続とアプリ異常終了をサーバーは区別できず、期限切れとして扱う。
03:00をまたぐ学習ではPWAをオンライン・表示中に保つ。
オフラインの記録を待ち続ける保証はないが、端末の記録は保持し、復帰後に同期する。
期限切れを禁止すると異常終了で永久延期となるため、この制限を明示する。

## 日次ledgerとat-most-once

保存キーは`studytodo:replan:daily:YYYY-MM-DD`、eventIdは`daily_replan_YYYY-MM-DD`。
`studytodo:replan:deferred`は延期中の日付だけの索引。
旧`studytodo:replan:study_end:<sessionId>`は閉じたsessionの受理記録として保持し、再fireしない。

| state | 意味 |
| --- | --- |
| deferred | active sessionの終了またはlease期限待ち。HTTP未送信 |
| pending | attemptedAt保存済み。HTTP処理中、または結果保存前に停止 |
| triggered | Routine Fire APIがsessionを返した。再計画完了を意味しない |
| failed | 設定・権限・providerエラー |

`attemptedAt`がある日付は、Cron20並列、Worker/DO再生成、alarm重複、終了通知再送でもPOSTを増やさない。
provider HTTPはtransactionの外で行い、transactionの再実行でHTTPを再送しない。
ledgerのclaimはTTLで消さない。

APIにidempotency keyがないため、**最大1回**と、障害時も必ず起動する保証は両立しない。
claim直後の停止・timeout・応答保存失敗では実行されたか不明になるが、再送しない。
`outcomeUnknown:true`や長時間pendingならRoutine履歴を確認する。ledgerを削除して再送しない。

## Failure handlingと安全な状態確認

| error | 意味 |
| --- | --- |
| missing_secrets / invalid_configuration | 設定不足・不正。HTTPなし |
| ai_disabled | AI連携が無効（dailyはread/write無効もここに含める）。HTTPなし |
| read_permission_required / write_permission_required | 手動実行で権限が足りない。HTTPなし |
| study_in_progress | 手動実行で学習セッションがactive。HTTPなし（延期もしない） |
| storage_not_atomic | transaction対応DOがない。HTTPなし |
| invalid_request / authentication / permission / routine_not_found | HTTP 400 / 401 / 403 / 404 |
| rate_limit | HTTP 429 |
| provider_failure | HTTP 5xx（500 / 503を含む） |
| timeout / provider_transport | timeoutまたは通信障害。結果不明 |
| invalid_provider_response | JSON不正または期待するsession情報なし。結果不明。`detail` に外れた検査項目（`json` / `type` / `session_id` / `session_url`）だけを付ける |

外部APIのtimeoutは25秒。Fire APIはsessionが作られてから返るため、
短く切ると実際には起動しているのに結果不明となり、その回は送り直せない。
429/5xxはtemporaryだが同一eventのHTTP再送はしない。
HTTP未送信の設定失敗だけは、設定修正後に同じCronが再配信された場合にclaim可能。
PWAの同期や終了から失敗したdailyを再試行することはない。次の日は新しいdaily eventになる。

provider障害では記録・予定・終了をrollbackしない。
終了受理そのものの保存に失敗した場合のみHTTP503とし、PWAの通知を残して再送する。
終了が保存でき、その後の延期再開だけ失敗した場合はHTTP200でackできる。

`GET /api/sync/replan?date=YYYY-MM-DD`は端末認証必須。eventId、state、安全なerror分類等だけを返す。
providerのsession ID/URLはDO内部で保持し、状態API・ログへは返さない。
通常UIに長いreasoningや、起動受付だけで「予定を更新しました」は表示しない。
running/applied/no_changeのcallbackや完了件数表示は追加していない。

## Cloudflare設定

`wrangler.toml`のCron・Observability設定はWrangler 4.131.1のローカルschemaとdry-runで検証した。
DO bindingとmigrationは従来どおり。新しいDO migrationは不要。

Logsは有効、query stringはredactする。アプリログはallowlistで抽出した日次stateだけ。
Token、Authorization、Fire URL、providerの自由記述本文・例外は記録しない。

Tracesは無効にする。[Cloudflare公式仕様](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/)
では自動fetch spanに`url.full`と`url.path`が含まれ、query stringのredactだけでは秘密のFire URLを保護できないため。
Dashboardで手動ONにしていたTracesも、この設定での配備後はOFFになる。

既存の以下のWorker Secretsをそのまま使う。設定済みなら再登録不要。
不足時のみ、ユーザー自身のローカルターミナルで実行し、値を入力プロンプトへ渡す。
値をチャット、GitHub、コマンド引数に貼らない。

```powershell
npx wrangler secret put CLAUDE_ROUTINE_FIRE_URL
npx wrangler secret put CLAUDE_ROUTINE_API_TOKEN
```

MCPコネクタはread/writeのみ。records権限は不要で、今回付与しない。
`CLAUDE_ROUTINE_TEST_MODE`は既存の任意設定としてdry_run/write_testを維持する。
本番の通常運用では未設定にする。production codeにwrite_testは固定しない。
本作業では本番deploy・Secret操作・外部Routine設定変更を行わない。

## 検証・配備前の作業

```powershell
npm run test:all
npm run build:questions -- --check
npx wrangler deploy --dry-run
```

テストでは模擬Claude API、実MCP validate/apply、実Chromium、DO storage test doubleを使う。
本番CloudflareのScheduled Event配信や実Claudeの推論結果は下記の疎通確認で検証する。
dry-runはbundle検証のみで配備しない。

Draft PRをレビューし、ユーザーが配備を承認してからmainへ反映する。
既存main workflowはWorkerを配備するため、mergeも本番変更として扱う。
PWAとWorkerを同じ版へ更新し、Service Worker `aochart-v12`が反映された状態で確認する。

## スマホだけで行う最終疎通確認

1. 配備後、スマホPWAを開き直して最新版を読み込み、同期接続とAI read/writeを確認する。
   Cloudflare DashboardでCron `0 18 * * *`も確認する。
2. 03:00より前に実際の学習を2〜3回開始・終了する。記録が保存・同期され、
   ClaudeのRoutine履歴にその終了を理由にしたsessionが増えないことを確認する。
3. 通常日の03:00後、Routine履歴で`trigger=daily_3am`、JST当日のeventIdが1件だけあることを確認する。
   学習0件の日にも同じ確認ができる。
4. Routine内で最新context取得、validate、必要な場合のapply、再取得を確認する。
   PWAのスケジュールを開き直し、変更がある場合に新しい予定が届くことを確認する。
5. 別の日に03:00をまたいでPWAをオンライン・表示中のまま学習する。
   DashboardのWorker Logsで`daily_replan`の当日eventIdが`deferred`、Routine未起動を確認する。
6. 学習終了後、記録同期が済むと同じdaily eventIdで1件だけ起動することを確認する。
   終了の再タップ、再同期、再読込でも増えないことを確認する。
7. 必要な初回確認だけ、ユーザーがDashboardで既存テスト設定を`write_test`にする。
   次の03:00で最大2件モードを確認し、通常運用前にその設定を解除する。
   日付を偽装する公開endpointや、dailyイベントを再fireするボタンは設けていない。
8. 設定 → AI連携 / 同期 →「プランナーを今すぐ実行」を押し、「プランナーを起動しました。」
   を確認する。Routine履歴に`trigger=manual`が1件だけ増え、当日のdailyの記録が
   変わらないこと、学習中は「現在学習中のため実行できません」と断ることを確認する。

## Claude Routine側の最小プロンプト差分

外部プロンプトはこの作業では取得・変更していない。study_end専用の起動条件が残っている場合のみ、
以下に置き換える。既存の計画ルール・評価・教材順・期限・Challengeの制約は維持する。

```text
通常の自動起動triggerはdaily_3amです。dateは03:00 JSTの日次再計画のplanning date、
eventIdはdaily_replan_YYYY-MM-DDです。active study sessionのため遅れて起動する場合も、
同じ日次イベントです。sessionIdは必須ではありません。
trigger=manual は、利用者が設定画面の「プランナーを今すぐ実行」を押したときの正式な
起動理由です（eventIdはmanual_replan_<operationId>）。daily_3amとまったく同じ計画処理を、
その時点のdateについて1回だけ行ってください。triggerは起動の理由にすぎず、
学習実績・完了扱いを生成する根拠にはなりません。
入力はイベントmetadataのみです。必ずStudyToDo MCPから最新の状態とPlanning Contextを
取得し、実際の現在日付と学習履歴・未完了・評価・目標・期限・availabilityを確認してください。
学習0件を苦手の証拠にしないでください。既存Auto Plannerルールに従って必要な場合のみ
再計画し、validatePlanChanges成功時だけapplyTaskChangesを行い、再取得で検証してください。
学習実績を生成しないでください。records権限は使いません。
mode=dry_runは書き込み禁止、mode=write_testは最大2件変更という既存制限を維持します。
```

## 今回の対象外

Challenge human-in-the-loop、pull-forward新規実装、solve/review時間migration、review timer、
AIチャットUI、大規模UI変更、期限・availability変更時の即時起動は追加していない。
03:00 Cronとactive-session deferred/alarmは今回の対象として実装した。
