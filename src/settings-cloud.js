// 設定タブの「AI連携 / 同期」カード。
//
// ここは画面の組み立てだけを受け持ち、通信と保存は src/cloud-sync.js に任せる。
// 管理キー（オーナーキー）と端末キーはこの端末の中だけに置き、画面には全文を出さない。

import * as cloud from './cloud-sync.js';
import * as api from './api.js';
import { state, loadTasks, refreshToday } from './state.js';
import { el, row } from './ui.js';

// 発行した直後の接続トークンだけ、画面が再描画されるまで覚えておく。
// サーバーには残らないので、ここで控えてもらう。
let issuedToken = null;
let lastMessage = null;
// プランナーの起動中は、描き直してもボタンを押せないままにする。
let firingPlanner = false;
// 通信が切れて結果が分からなかった一押しの目印。
// 押し直したときに同じ目印で聞き直せば、サーバーは二重に起動しない。
let unsettledOperationId = null;
// プランナーの結果は、共有の lastMessage ではなくボタンのすぐそばに出す。
// カード上端のメッセージ行は、ボタンまでスクロールした画面からは見えず、
// 「起動中…」が消えて元に戻っただけに見えてしまうため。
// 次に押すまで残す（同期などの描き直しで消えないように）。
let plannerResult = null;

/**
 * サーバーが返す起動できなかった理由を、画面に出す日本語へ直す。
 * 技術的なコードはそのまま見せない。
 */
const PLANNER_ERRORS = {
  ai_disabled: 'AI連携がオフになっています',
  read_permission_required: 'AI連携の「学習状況を見る」権限を許可してください',
  write_permission_required: 'AI連携の「予定を変更する」権限を許可してください',
  study_in_progress: '現在学習中のため実行できません。学習終了後にもう一度押してください',
  missing_secrets: 'サーバーにRoutineの設定がありません',
  invalid_configuration: 'Routineの設定が正しくありません',
  storage_not_atomic: 'サーバーの保存先が古い設定です（docs/mcp.md の「保存先の移行」）',
  invalid_request: 'Routineが要求を受け付けませんでした',
  authentication: 'RoutineのAPIトークンが使えません',
  permission: 'RoutineのAPIトークンに権限がありません',
  routine_not_found: 'Routineが見つかりません',
  rate_limit: '回数の制限に達しました。しばらくしてからもう一度押してください',
  provider_failure: 'Claude側で問題が起きています。しばらくしてからもう一度押してください',
  provider_http_error: 'Claudeから正しい応答がありませんでした',
  provider_redirect: 'Claudeの宛先が転送されました。Fire URLの設定を確認してください',
  // 下の3つは「届いたかどうか分からない」失敗。起動している可能性があるので、
  // 自動では送り直さず、Routineの履歴で確かめてもらう。見分けが付くよう文面を分ける。
  timeout: 'Claudeから時間内に応答がありませんでした。起動しているかもしれないので、'
    + 'Routineの履歴を確認してください（自動では送り直しません）',
  provider_transport: 'Claudeへつながりませんでした。起動しているかもしれないので、'
    + 'Routineの履歴を確認してください（自動では送り直しません）',
  invalid_provider_response: 'Claudeの応答を読み取れませんでした。起動しているかもしれないので、'
    + 'Routineの履歴を確認してください（自動では送り直しません）',
};

function plannerMessage(replan) {
  if (replan?.state === 'triggered') return 'プランナーを起動しました。';
  // 送信の結果が保存前に途切れた場合。押し直しはせず、履歴で確かめてもらう。
  if (replan?.state === 'pending') return 'プランナーへ起動を伝えましたが、結果を確認できませんでした。Routineの履歴を確認してください。';
  const reason = PLANNER_ERRORS[replan?.error] ?? '原因が分かりませんでした';
  // detail はサーバー側の検査項目の名前（固定の語）。原因を追うときだけ役に立つ。
  return `プランナーを起動できませんでした：${reason}${replan?.detail ? `［${replan.detail}］` : ''}`;
}

/** 同期で入ってきた内容を、画面が使っている状態へ読み込み直す。 */
async function reloadFromLocal() {
  const questions = await api.listQuestions();
  state.questions = new Map(questions.map((question) => [question.id, question]));
  await loadTasks();
  await refreshToday();
}

const mask = (value) => (value ? `${String(value).slice(0, 6)}…` : '—');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('ja-JP') : '—');

function field(labelText, input) {
  const wrap = el('div', 'setting');
  const head = el('div', 'setting-head');
  head.append(el('div', 'row-title', labelText));
  wrap.append(head, input);
  return wrap;
}

function textInput({ value = '', placeholder = '', type = 'text' }) {
  const input = el('input', 'cloud-input');
  input.type = type;
  input.value = value ?? '';
  input.placeholder = placeholder;
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  return input;
}

function actions(...buttons) {
  const wrap = el('div', 'setting-actions');
  wrap.append(...buttons);
  return wrap;
}

function button(label, onClick, cls = 'btn') {
  const node = el('button', cls, label);
  node.onclick = onClick;
  return node;
}

// サーバーの状態は、一度取れたら次の描画まで覚えておく。
// 画面を組み立てるたびに通信の返事を待っていると、押しても動かないように見えるため。
let cachedStatus = { key: null, status: null, error: null, pending: false, settled: false };

/** いま見に行くべきサーバーを表す合言葉。URLか管理キーが変われば取り直す。 */
const statusKeyOf = (config) => `${config.serverUrl}|${config.ownerKey}`;

/**
 * サーバーの状態を、画面を止めずに取りに行く。取れたら描き直す。
 * 同じ相手にはすでに取れていれば何もしない（描き直しが堂々巡りにならないようにする）。
 */
function refreshStatus(config, rerender) {
  const key = statusKeyOf(config);
  if (cachedStatus.key === key && (cachedStatus.pending || cachedStatus.settled)) return;
  cachedStatus = { key, status: null, error: null, pending: true, settled: false };
  cloud.admin.status(config).then(
    (status) => { cachedStatus = { key, status, error: null, pending: false, settled: true }; },
    (error) => { cachedStatus = { key, status: null, error: error.message, pending: false, settled: true }; },
  ).then(() => {
    // 設定画面から離れていたら描き直さない（入力中の欄を消さないため）。
    if (state.tab === 'settings') rerender();
  });
}

/** 次に描くときは、サーバーの状態を取り直す（設定や権限を変えた直後など）。 */
function invalidateStatus() {
  cachedStatus = { key: null, status: null, error: null, pending: false, settled: false };
}

/**
 * 「AI連携 / 同期」カードを組み立てて list に足す。
 * rerender は設定画面をもう一度描き直すための関数。
 */
export async function renderCloudCard(list, rerender) {
  const config = await cloud.getCloudConfig();

  // 管理キーがあり、オンラインならサーバーの状態も見に行く。
  // ただし返事は待たない。待つと、サーバーが応じないあいだ設定画面ぜんぶが
  // 組み上がらず、どこを押しても反応しないように見えてしまう。
  let status = null;
  let statusError = null;
  let checking = false;
  if (config.serverUrl && config.ownerKey) {
    const key = statusKeyOf(config);
    const usable = cachedStatus.key === key && cachedStatus.settled;
    status = usable ? cachedStatus.status : null;
    statusError = usable ? cachedStatus.error : null;
    checking = !usable;
    refreshStatus(config, rerender);
  }

  const state = cloud.connectionState(config, { serverEnabled: status?.enabled ?? null });

  list.append(el('div', 'section-head', 'AI連携 / 同期'));

  const pill = el('span', `state-pill${state.key === 'linked' ? ' active' : ''}`, state.label);
  list.append(row({
    title: '接続状態',
    sub: [
      `最終同期: ${fmtDateTime(config.lastSyncedAt)}`,
      config.lastError ? `直前の問題: ${config.lastError}` : null,
      checking ? 'サーバーを確認中…' : null,
      statusError ? `サーバー: ${statusError}` : null,
    ].filter(Boolean).join(' / '),
    right: pill,
  }));

  if (lastMessage) {
    list.append(row({ title: lastMessage, classes: ['row-indent'] }));
    lastMessage = null;
  }

  list.append(row({
    title: 'MCP Server URL',
    sub: config.serverUrl ? cloud.mcpUrlFor(config) : '未設定',
  }));

  const urlInput = textInput({ value: config.serverUrl, placeholder: 'https://study-todo-mcp.xxx.workers.dev' });
  const keyInput = textInput({ value: '', placeholder: config.ownerKey ? '保存済み（変更するときだけ入力）' : '管理キー', type: 'password' });
  list.append(field('サーバーのURL', urlInput));
  list.append(field('管理キー（この端末の中だけに保存）', keyInput));
  list.append(actions(button('保存', async () => {
    await cloud.saveCloudConfig({
      serverUrl: urlInput.value,
      ...(keyInput.value ? { ownerKey: keyInput.value } : {}),
    });
    lastMessage = '保存しました。';
    invalidateStatus();
    rerender();
  }, 'btn btn-primary')));

  // ----- 端末の登録 -----
  const nameInput = textInput({ value: config.deviceName, placeholder: 'iPhone / iPad / PC など' });
  if (!cloud.isLinked(config)) {
    const codeInput = textInput({ value: '', placeholder: 'STUDY-XXXX-XXXX' });
    list.append(field('この端末の名前', nameInput));
    list.append(field('同期コード', codeInput));
    list.append(actions(button('この端末を登録', async () => {
      try {
        await cloud.joinDevice({
          serverUrl: urlInput.value || config.serverUrl,
          code: codeInput.value,
          deviceName: nameInput.value || '端末',
        });
        lastMessage = '登録しました。「いますぐ同期」を押すと学習データが行き来します。';
      } catch (error) {
        lastMessage = `登録できませんでした: ${error.message}`;
      }
      rerender();
    }, 'btn btn-primary')));
  } else {
    list.append(row({ title: '端末', sub: `${config.deviceName || '端末'}（${config.deviceId}）` }));
    list.append(actions(
      button('いますぐ同期', async () => {
        const result = await cloud.syncNow({ force: true });
        // 受け取った内容を画面へ反映する（問題マスタ・今日のTODO・今日の集計）。
        if (result.ok) await reloadFromLocal();
        lastMessage = result.ok
          ? `同期しました（受け取り: 記録${result.applied.records}件 / 予定${result.applied.plans}日ぶん${result.remaining ? ` ・ 未送信 ${result.remaining}件が残っています` : ''}）`
          : `同期できませんでした: ${result.message ?? result.reason}`;
        rerender();
      }, 'btn btn-primary'),
      button('同期を解除', async () => {
        if (!confirm('この端末の同期を解除します。クラウドとこの端末の学習記録は消えません。よろしいですか？')) return;
        await cloud.leaveDevice();
        lastMessage = '同期を解除しました。';
        rerender();
      }, 'btn btn-danger'),
    ));
  }

  if (config.ownerKey) {
    list.append(actions(button('同期コードを発行（他の端末を追加するとき）', async () => {
      try {
        const issued = await cloud.admin.issueSyncCode(config);
        lastMessage = `同期コード: ${issued.syncCode}（他の端末でこれを入力してください。次の画面では二度と表示されません）`;
      } catch (error) {
        lastMessage = `発行できませんでした: ${error.message}`;
      }
      rerender();
    })));
  }

  // ----- サーバー側の設定（管理キーが要る） -----
  if (status) {
    list.append(row({
      title: 'AI連携',
      sub: status.enabled ? 'AIからの接続を受け付けています' : 'AIからは接続できません',
      right: button(status.enabled ? 'オフにする' : 'オンにする', async () => {
        await cloud.admin.updateSettings(config, { enabled: !status.enabled });
        invalidateStatus();
        rerender();
      }, 'link-btn'),
    }));

    list.append(row({
      title: '権限：学習状況を見る',
      sub: 'AI連携を使うときは常に必要',
      right: el('span', 'state-pill active', '許可'),
    }));
    list.append(row({
      title: '権限：予定を変更する',
      sub: 'AIが今日のTODOや目標を書き換えられるようにする',
      right: button(status.permissions.write ? '許可中' : '許可しない', async () => {
        await cloud.admin.updateSettings(config, { permissions: { write: !status.permissions.write } });
        invalidateStatus();
        rerender();
      }, 'link-btn'),
    }));

    list.append(row({
      title: '権限：学習の記録を代理入力する',
      sub: '「昨日の分を記録し忘れた」と伝えたときに、AIが実績を足したり直したりできるようにする。'
        + ' 予定を変える権限とは別で、許していなければ実績は1件も変わりません。',
      right: button(status.permissions.records ? '許可中' : '許可しない', async () => {
        await cloud.admin.updateSettings(config, { permissions: { records: !status.permissions.records } });
        invalidateStatus();
        rerender();
      }, 'link-btn'),
    }));
    if (status.permissions.records) {
      list.append(row({
        title: 'AIが作れるのは「本人が言った分」だけ',
        sub: '予定が入っているだけでは実績になりません。評価や時間が分からないときは、'
          + '埋めずに「未登録」で保存されます。取り消した記録も消えず、履歴に残ります。',
        classes: ['row-indent'],
      }));
    }

    // ----- プランナーの手動起動（03:00の自動再計画と同じ経路を1回だけ通す） -----
    if (status.enabled) {
      list.append(row({
        title: 'プランナー',
        sub: '現在の学習状況を読み取り、予定を今すぐ組み直します（毎日03:00の自動再計画と同じ処理）',
      }));
      if (plannerResult) {
        list.append(row({ title: plannerResult, classes: ['row-indent'] }));
      }
      const fire = button(firingPlanner ? 'プランナーを起動中…' : 'プランナーを今すぐ実行', async () => {
        if (firingPlanner) return;
        firingPlanner = true;
        plannerResult = null;
        fire.disabled = true;
        fire.textContent = 'プランナーを起動中…';
        const operationId = unsettledOperationId ?? cloud.newOperationId();
        unsettledOperationId = operationId;
        try {
          const result = await cloud.admin.firePlanner(config, operationId);
          unsettledOperationId = null;
          plannerResult = plannerMessage(result.replan);
        } catch (error) {
          // サーバーが答えを返したのなら、その一押しは終わっている。
          // 届いたかどうか分からないとき（切断・時間切れ）だけ目印を残す。
          if (error.status) unsettledOperationId = null;
          plannerResult = `プランナーを起動できませんでした：${error.message}`;
        } finally {
          firingPlanner = false;
        }
        rerender();
      }, 'btn btn-primary');
      fire.disabled = firingPlanner;
      list.append(actions(fire));
    }

    list.append(row({
      title: '接続トークン（AIへ渡す鍵）',
      sub: status.token
        ? `${status.token.preview} ・ 権限 ${status.token.scopes.join(' / ')} ・ 最終利用 ${fmtDateTime(status.token.lastUsedAt)}`
        : 'まだ発行していません',
    }));
    if (issuedToken) {
      list.append(row({
        title: issuedToken,
        sub: '今だけ表示されます。AIのMCP設定へ貼り付けてください。',
        classes: ['row-indent'],
      }));
    }
    list.append(actions(
      button(status.token ? 'トークンを再発行' : 'トークンを発行', async () => {
        const scopes = ['read'];
        if (status.permissions.write) scopes.push('write');
        if (status.permissions.records) scopes.push('records');
        try {
          const issued = await cloud.admin.issueToken(config, scopes);
          issuedToken = issued.token;
          lastMessage = '発行しました。前のトークンは使えなくなります。';
        } catch (error) {
          lastMessage = `発行できませんでした: ${error.message}`;
        }
        invalidateStatus();
        rerender();
      }, 'btn btn-primary'),
      ...(status.token ? [button('トークンを失効', async () => {
        if (!confirm('いま発行されている接続トークンを使えなくします。よろしいですか？')) return;
        await cloud.admin.revokeToken(config);
        issuedToken = null;
        lastMessage = '失効しました。';
        invalidateStatus();
        rerender();
      }, 'btn btn-danger')] : []),
    ));

    list.append(row({
      title: 'クラウドの内容',
      sub: `学習記録 ${status.sync.records}件 ・ 問題 ${status.sync.questions}問 ・ 端末 ${status.sync.devices.length}台`,
    }));

    // ----- 予定の変更履歴と取り消し -----
    list.append(el('div', 'section-head', '最近の予定の変更'));
    let changes = { entries: [] };
    try {
      changes = await cloud.fetchPlanChanges(5);
    } catch (error) {
      list.append(row({ title: '変更履歴を読めませんでした', sub: error.message, classes: ['row-indent'] }));
    }
    if (!changes.entries.length) {
      list.append(row({ title: 'まだありません', classes: ['row-indent'] }));
    } else {
      for (const entry of changes.entries) {
        const parts = [];
        if (entry.summary?.created?.length) parts.push(`追加${entry.summary.created.length}件`);
        if (entry.summary?.removed?.length) parts.push(`削除${entry.summary.removed.length}件`);
        if (entry.summary?.moved?.length) parts.push(`移動${entry.summary.moved.length}件`);
        if (entry.summary?.updated?.length) parts.push(`変更${entry.summary.updated.length}件`);
        const who = entry.actorKind === 'ai' ? `AI（${entry.actorName ?? '不明'}）` : (entry.actorName ?? 'この端末');
        list.append(row({
          title: `${(entry.dates ?? []).join('・')} ${parts.join('・') || '変更なし'}`,
          sub: [
            `${fmtDateTime(entry.at)} ・ ${who}`,
            entry.reason ? `理由: ${entry.reason}` : null,
            entry.undoneBy ? '取り消し済み' : null,
            entry.undoOf ? '（取り消しの操作）' : null,
          ].filter(Boolean).join(' ・ '),
          classes: ['row-indent'],
          right: entry.undoneBy || entry.undoOf ? null : button('取り消す', async () => {
            if (!confirm('この変更を取り消します。学習の記録は変わりません。よろしいですか？')) return;
            try {
              const result = await cloud.undoPlanChange(entry.changeId);
              lastMessage = result.ok
                ? '取り消しました（取り消しも新しい変更として記録されます）。'
                : `取り消せませんでした: ${result.message ?? ''}`;
              await cloud.syncNow({ force: true });
              await reloadFromLocal();
            } catch (error) {
              lastMessage = `取り消せませんでした: ${error.message}`;
            }
            rerender();
          }, 'link-btn'),
        }));
      }
    }
    if (status.storage && status.storage.atomicBatchUpdates === false) {
      list.append(row({
        title: 'サーバーの保存先が古い設定です',
        sub: 'いまの設定（KVのみ）では、AIからの予定の変更を安全に行えないため断っています。'
          + ' docs/mcp.md の「保存先の移行」に従って Durable Object を有効にしてください。',
        classes: ['row-indent'],
      }));
    }

    list.append(el('div', 'section-head', '最近のAI操作'));
    if (!status.log.length) {
      list.append(row({ title: 'まだありません', classes: ['row-indent'] }));
    } else {
      for (const entry of status.log.slice(0, 10)) {
        list.append(row({
          title: entry.summary,
          sub: `${fmtDateTime(entry.timestamp)} ・ ${entry.clientName ?? 'AI'} ・ ${entry.tool}`,
          classes: ['row-indent'],
        }));
      }
    }
  } else if (config.serverUrl && !config.ownerKey) {
    list.append(row({
      title: 'AI連携の設定には管理キーが必要です',
      sub: 'Cloudflare に登録した STUDY_TODO_OWNER_KEY を上の欄へ入力してください。',
      classes: ['row-indent'],
    }));
  }

  list.append(row({
    title: 'この端末の鍵',
    sub: `管理キー ${config.ownerKey ? mask(config.ownerKey) : '未設定'} ・ 端末キー ${config.deviceKey ? '保存済み' : '未取得'}（どちらもバックアップJSONには入りません）`,
    classes: ['row-indent'],
  }));
}
