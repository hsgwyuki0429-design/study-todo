# 学習終了から Claude Routine を起動する

対象は `study_end` のみ。Routine「Study To Do Auto Planner」と既存の StudyToDo MCP を使う。
03:00 JST Cron、active-session の deferred 処理、Challenge、人間との相談、pull-forward は追加しない。

## 現状の設計と接続箇所

- PWA は IndexedDB に記録・session・同期outboxを保存する。
- `src/home.js` の `recordEvaluation` が本人の評価を `api.addStudyRecord` へ渡す。
  終了ボタンの `endSession` は進行中の評価保存を待ち、タイマーを止める。
  未入力の評価や解答実績を終了時に自動生成しない。
- 現在の記録時間は `durationSeconds`。独立した `solveSeconds` / `reviewSeconds` や
  review timer はこの版にはない。この連携のためのmigrationは行わない。
- `server/app.js` が端末認証、MCP、同期HTTPを扱う。
- `StudyTodoStore` DO の既存storage driver / transactionを再利用する。
- `getPlanningContext` / `validatePlanChanges` / `applyTaskChanges`、予定のrevision、
  operationId、atomic update、保護されたタスクの検証は既存実装を使う。

## 処理の順序

1. 開始時にsessionIdを作り保存。既存の実行中sessionも一度だけIDを補完する。
2. 終了時、`study_end_<sessionId>` をeventIdとし、session終了とreplan outboxを
   **同じIndexedDB transaction** で確定。二重タップや同一DBの同時終了では1件となる。
3. UIは終了状態へ戻る。以降の通信やRoutine完了を待たない。
4. 既存同期で記録・チャレンジ結果などを送る。分割送信の未送信分はoutboxへ残し、
   すべて送るまでreplanを送らない。進行中の同期があれば、その完了後にも同期する。
5. `POST /api/sync/study-end` を端末キーで呼ぶ。本文は
   `eventId`, `sessionId`, `date`（JST）, `endedAt` のみ。
6. DO transaction内で終了イベントを保存し、そのsessionのactive表示を解除する。
   日付をまたいだsessionも対象。別のsession/端末のactive表示は保持する。
   遅れて到着した同じsessionのheartbeatも再有効化しない。
7. DOに送信権取得済みの `attemptedAt` を永続化してから、`state.waitUntil` でfireする。
8. Claude はMCPから最新状態を取得し、推論、validate、apply、再取得を行う。
9. PWAの次回同期・スケジュールタブ表示で更新済み予定を取得する。

RoutineにPOSTする本文は次の形。Planning Contextや記録のsnapshotは含まない。

```text
trigger=study_end eventId=study_end_<sessionId> date=YYYY-MM-DD sessionId=<sessionId>
```

## 重複排除の保証と限界

DOの `studytodo:replan:study_end:<sessionId>` に専用の台帳を置く。
予定変更のoperationId履歴は件数上限があるため、fireの重複排除には流用しない。
**同じeventIdへの外部POSTは最大1回（at-most-once）**。transactionの再実行中に外部HTTPは呼ばない。

台帳の主な情報は、イベントメタデータ、端末ID、state、revision、attemptedAt、
安全なエラーコード、および成功時のproviderSessionId/providerSessionUrl。
Fire URL・token・Authorization・providerの自由記述本文は保存しない。
台帳は期限切れや履歴件数制限で消さず、通常の学習データ削除でも残す。
DOデータそのものの削除や古いbackupへの復元を行うと、この保証は維持できない。

| state | 意味 |
| --- | --- |
| `pending` | 送信権を確定済み。バックグラウンド処理中、または結果不明 |
| `triggered` | Fire APIがsession作成を返した。予定反映完了の意味ではない |
| `failed` | 設定、保存先、認証、provider等で起動に失敗 |

送信権の確定直後にプロセスが終了した場合、実際にはPOSTされていない可能性もある。
またHTTP timeoutでは、Claudeが受理済みか分からない。
API自体にidempotency keyがないため、**再試行による確実な起動と重複ゼロを同時には保証できない**。
ここでは重複ゼロを優先し、attemptedAtがあるイベントを再fireしない。
長くpendingのままなら結果不明としてRoutine側の履歴を確認する。

`running / applied / no_change` の自動追跡は今回は実装しない。
Routineの完了callbackも追加しない。通常UIに長いreasoningは表示せず、
起動受付だけで「予定を更新しました」と表示しない。
予定変更の理由・provenanceは既存のapplyTaskChangesの変更履歴に残る。

## 失敗時の扱い

終了記録の受理は `ok:true, studyEnd:"success"` とし、再計画結果を `replan` へ分離する。
既に保存した学習記録・予定をRoutine失敗のために取り消さない。

| error | 意味 | 同一eventの自動再fire |
| --- | --- | --- |
| `missing_secrets` / `invalid_configuration` | 設定不足・不正 | HTTP未送信なので、設定修正後の再同期で試せる |
| `ai_disabled` | 既存AI連携が無効、またはread/writeを許可していない | HTTP未送信。再有効化後の同期で試せる |
| `storage_not_atomic` | DO未設定のKV fallback | HTTP未送信。DO有効化後に試せる |
| `planning_storage` | 受付中の保存エラー | 同じeventで受付を再送。既存claimがあれば送信しない |
| `authentication` (401) | token / auth | しない |
| `permission` (403) | permission | しない |
| `routine_not_found` (404) | URL / Routine | しない |
| `rate_limit` (429) | usage / Routine limit | しない |
| `provider_failure` (500/503) | 一時的provider障害 | しない |
| `timeout` / `provider_transport` / `invalid_provider_response` | 受理結果不明 | しない |

外部APIは10秒でtimeout。redirectを追わず、Fire URLは公式HTTPS endpointだけ許可する。
401等の本文はログにもレスポンスにも転記しない。
429/5xxは `temporary:true` で区別するが、二重fireを防ぐため `retryable:false`。
再計画が必要な場合も、同じイベントを削除して再fireせず、Routine履歴と現状を確認する。

## Cloudflare設定と配備

リポジトリのルートで、利用者自身のローカルターミナルから実行する。
入力プロンプトへ手元の値を入れる。値をチャット・コマンド引数・wrangler.toml・GitHubへ貼らない。

```powershell
npx wrangler secret put CLAUDE_ROUTINE_FIRE_URL
npx wrangler secret put CLAUDE_ROUTINE_API_TOKEN
```

既存の `STUDY_TODO_OWNER_KEY`、KV、DO bindingは維持する。DO migrationは追加不要。
Auto Planner用MCPコネクタは **read / write のみ**、recordsを付けない。
コードからMCP権限を拡張したり、tokenを再発行したりはしない。

```powershell
npm test
npm run test:e2e
npx wrangler deploy --dry-run
npx wrangler deploy
```

GitHubの既存main配備workflowを使う場合は、そのworkflowでWorkerを更新する。
PWAもGitHub Pagesに同じ変更を反映し、更新済みService Worker（aochart-v11）を読み込む。
`--dry-run` はbundle検証だけで、Cloudflareへの配備・secret確認・Claude起動は行わない。

## 初回のPWA → Routine → MCP実書き込み確認

1. 最初はWorker側の任意テスト設定を有効にする。
   `npx wrangler secret put CLAUDE_ROUTINE_TEST_MODE` の入力へ `write_test` を指定する。
   必要なら読み取り確認用に `dry_run` も指定できる。
   PWAからmodeを変更することはできない。
2. PWAとWorkerが更新され、PWA同期が接続済み、AI連携のread/writeが有効であることを確認。
3. PWAで実際の学習を開始し、本人の評価を記録して「終了」を押す。
   終了後すぐ通常画面に戻り、記録が残ることを確認。
4. ClaudeのRoutine履歴で、`mode=write_test trigger=study_end eventId=...` に対応する
   sessionが1件だけ作られたことを確認。
5. そのsessionで最新状態取得、validate、最大2件のapply、再取得が成功したことを確認。
   アプリのスケジュールタブを開き直し、変更された予定を見る。
6. 再同期・ページ再読込を行い、同じeventIdのRoutineが増えないことを確認。
7. 初回確認後、`npx wrangler secret delete CLAUDE_ROUTINE_TEST_MODE` を実行。
   以降の新しい学習sessionはmodeなしで起動する。終了済みeventの再送では新規fireしない。

必要ならPWA自身の開発者コンソールで、秘密値を表示せず状態だけ確認できる。

```javascript
const { idb, STORES } = await import('./src/idb.js');
const last = (await idb.get(STORES.meta, 'lastReplan'))?.value;
const status = last?.sessionId
  ? await (await import('./src/cloud-sync.js')).getReplanStatus(last.sessionId)
  : null;
console.log(status); // eventId/state/error/retryable等のみ。tokenやFire URLは含まない。
```

`GET /api/sync/replan?sessionId=...` は元の端末キーが必要。
providerのsession ID/URLはDO内部にのみ保存し、このAPIへは返さない。
実際のClaude sessionはRoutineの管理画面から確認する。

## 自動テストの範囲

`test/routine.test.mjs` は並列再送、再生成、HTTP分類、秘密未設定、timeout、
保存失敗、DO adapter、設定権限、MCP validate/apply/再取得を検証する。
`test/e2e/routine.e2e.mjs` は実ChromiumでUI終了・IndexedDB・オフライン復帰・
分割同期・進行中の評価保存・二重タップ・予定更新取得を検証する。

```powershell
# Playwrightが未導入の検証環境でのみ（依存関係のコミットは不要）
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:all
```

自動テストのClaude APIは模擬応答。実課金・実Claude実行・本番DOへの書き込みは行わない。
DO adapterテストのstorageもtest double。本番CloudflareからClaudeへの疎通と実Routineの
推論結果は上記の実機確認で検証する必要がある。

<!-- trigger Cloudflare preview build -->
