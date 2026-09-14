// クラウド同期（AI連携）のクライアント側。
//
// study-todo 本体は、今までどおり IndexedDB だけで完結して動く。
// この同期は「追加の機能」であり、次のことが常に成り立つ。
//
//   ・同期が無効でも、サーバーが落ちていても、圏外でも、学習はいつもどおりできる
//   ・同期でローカルの学習履歴を消すことは決してない（IDで重ね合わせるだけ）
//   ・送れなかった分は控え（outbox）に残り、オンラインに戻ったときに送り直す
//
// 鍵の置き場所:
//   オーナーキー・端末キーは、この端末の IndexedDB の中だけに持つ。
//   バックアップJSONにも、画面にも、ログにも全文は出さない。

import { idb, STORES } from './idb.js';
import * as api from './api.js';
import { hashQuestions } from './hash.js';

export const CLOUD_META_KEY = 'cloud';

export const DEFAULT_CLOUD = Object.freeze({
  enabled: false,
  serverUrl: '',
  ownerKey: '',
  deviceId: null,
  deviceKey: null,
  deviceName: '',
  lastSyncedAt: null,
  lastPulledAtMs: null,
  questionsHash: null,
  // 最後に受け取った「すべて削除」の印。これより新しい印が来たときだけ、手元も消す。
  lastPurgeAtMs: 0,
  lastError: null,
});

/** 一度に送る学習記録の数。サーバー側の上限に合わせる。 */
const PUSH_CHUNK = 400;
/** 開いたままの別端末も、変更をこの時間以内に取り込む。非表示中は通信しない。 */
export const DEVICE_SYNC_INTERVAL_MS = 15000;

export function normalizeCloudConfig(raw = {}) {
  const stored = raw && typeof raw === 'object' ? raw : {};
  const serverUrl = String(stored.serverUrl ?? '').trim().replace(/\/+$/, '').replace(/\/mcp$/, '');
  return {
    ...DEFAULT_CLOUD,
    ...stored,
    serverUrl,
    ownerKey: String(stored.ownerKey ?? '').trim(),
    enabled: stored.enabled === true,
  };
}

export async function getCloudConfig() {
  const row = await idb.get(STORES.meta, CLOUD_META_KEY);
  return normalizeCloudConfig(row?.value ?? {});
}

export async function saveCloudConfig(patch) {
  const next = normalizeCloudConfig({ ...(await getCloudConfig()), ...patch });
  await idb.put(STORES.meta, { key: CLOUD_META_KEY, value: next });
  return next;
}

export const mcpUrlFor = (config) => (config?.serverUrl ? `${config.serverUrl}/mcp` : '');
export const isConfigured = (config) => Boolean(config?.serverUrl);
export const isLinked = (config) => Boolean(config?.serverUrl && config?.deviceKey);
export const isActive = (config) => Boolean(config?.enabled && isLinked(config));

export class CloudError extends Error {
  constructor(message, status = null, offline = false) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    this.offline = offline;
  }
}

/**
 * 応答が返らないまま待ち続けないための待ち時間の上限。
 *
 * これが無いと、URLの打ち間違いやVPN・プロキシで接続が吸い込まれたときに、
 * ブラウザがあきらめるまで（環境によっては数十秒）画面が固まったように見える。
 * 設定画面はこの応答を待って組み立てるので、待たせないことが特に大事である。
 */
const REQUEST_TIMEOUT_MS = 15000;

/** 呼び出し側の signal と、待ち時間の上限を1つにまとめる。 */
function withTimeout(signal, timeoutMs) {
  if (!timeoutMs) return { signal, done: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const abort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
    },
    timedOut: () => controller.signal.aborted && !signal?.aborted,
  };
}

async function request(config, path, {
  method = 'GET', body = null, token = null, signal, timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (!config?.serverUrl) throw new CloudError('同期サーバーのURLが設定されていません。');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new CloudError('オフラインです。オンラインに戻ったときに同期します。', null, true);
  }
  const limit = withTimeout(signal, timeoutMs);
  let response;
  try {
    response = await fetch(`${config.serverUrl}${path}`, {
      method,
      signal: limit.signal,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === null ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (limit.timedOut?.()) {
      throw new CloudError(`サーバーから${Math.round(timeoutMs / 1000)}秒以内に返事がありませんでした。URLとネットワークを確認してください。`, null, true);
    }
    throw new CloudError(`サーバーへつながりませんでした（${error.message}）。URLとネットワークを確認してください。`, null, true);
  } finally {
    limit.done();
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new CloudError(`サーバーの応答を読み取れませんでした（${response.status}）。`, response.status);
  }
  if (!response.ok) {
    const message = response.status === 401
      ? (payload?.message ?? '鍵が正しくありません。')
      : (payload?.message ?? `サーバーが${response.status}を返しました。`);
    throw new CloudError(message, response.status);
  }
  return payload;
}

/* ------------------------------------------------------------------ */
/* 管理API（オーナーキーが要る。AIへは渡らない）                        */
/* ------------------------------------------------------------------ */

export const admin = {
  // 設定画面はこの返事を待たずに組み立てる。待つと、応じないサーバーのせいで
  // 画面ぜんぶが出てこず、どこも押せないように見えてしまう。
  status: (config, signal) => request(config, '/api/admin/status', { token: config.ownerKey, signal, timeoutMs: 8000 }),
  updateSettings: (config, changes) =>
    request(config, '/api/admin/settings', { method: 'POST', body: changes, token: config.ownerKey }),
  issueToken: (config, scopes) =>
    request(config, '/api/admin/token', { method: 'POST', body: { scopes }, token: config.ownerKey }),
  revokeToken: (config) => request(config, '/api/admin/token', { method: 'DELETE', token: config.ownerKey }),
  issueSyncCode: (config) => request(config, '/api/admin/sync-code', { method: 'POST', body: {}, token: config.ownerKey }),
  log: (config) => request(config, '/api/admin/log', { token: config.ownerKey }),
  releaseDevice: (config, deviceId) =>
    request(config, '/api/admin/devices', { method: 'DELETE', body: { deviceId }, token: config.ownerKey }),
  // クラウドに預けてある学習データをすべて消す。戻せないので合言葉つきで呼ぶ。
  purgeData: (config) =>
    request(config, '/api/admin/data', {
      method: 'DELETE',
      body: { confirm: 'DELETE' },
      token: config.ownerKey,
      timeoutMs: 60000,
    }),
};

/* ------------------------------------------------------------------ */
/* 端末の登録                                                          */
/* ------------------------------------------------------------------ */

/** 同期コードを入れて、この端末を登録する。以後は端末キーで同期する。 */
export async function joinDevice({ serverUrl, code, deviceName }) {
  const config = await saveCloudConfig({ serverUrl });
  const joined = await request(config, '/api/sync/join', {
    method: 'POST',
    body: { code, deviceName },
  });
  return saveCloudConfig({
    deviceId: joined.deviceId,
    deviceKey: joined.deviceKey,
    deviceName: joined.deviceName ?? deviceName ?? '端末',
    enabled: true,
    lastError: null,
    // 参加した時点の「すべて削除」の印を、知っているものとして覚えておく。
    // 昔の削除の巻き添えで、この端末が持ち込んだ記録を消さないため。
    lastPurgeAtMs: Number(joined.purgedAtMs) || 0,
    // 登録直後は「まだ何も受け取っていない」状態から始める。
    lastPulledAtMs: null,
  });
}

/** この端末の同期をやめる。クラウドにある記録は消さない。 */
export async function leaveDevice() {
  const config = await getCloudConfig();
  if (config.deviceKey) {
    try {
      await request(config, '/api/sync/leave', { method: 'POST', body: {}, token: config.deviceKey });
    } catch {
      // サーバーへ届かなくても、この端末からは鍵を消す。
    }
  }
  return saveCloudConfig({ deviceKey: null, deviceId: null, enabled: false, lastPulledAtMs: null });
}

/* ------------------------------------------------------------------ */
/* 予定まわりの個別の操作（端末キーで呼ぶ）                            */
/* ------------------------------------------------------------------ */

/**
 * 固定（ピン留め）をサーバーへも伝える。
 * 固定はAIから外せない印なので、付け外しはこの端末からの操作でしか起きない。
 * 同期していない・オフラインのときは、ローカルの印だけが残り、次の同期で送られる。
 */
export async function pushPin(date, taskId, pinned) {
  const config = await getCloudConfig();
  if (!isActive(config)) return { ok: false, reason: 'disabled' };
  try {
    return await request(config, '/api/sync/pin', {
      method: 'POST',
      body: { date, taskId, pinned },
      token: config.deviceKey,
    });
  } catch (error) {
    return { ok: false, reason: 'error', message: error.message };
  }
}

/**
 * 「いまこのタスクを解いている」ことをサーバーへ知らせる。
 *
 * これはAIが実行中のタスクを動かさないようにするための情報で、
 * 期限つき（既定15分）で預けられる。圏外のときは届かないので、
 * サーバーが知っている実行中の状態は「オンラインの端末のぶんだけ」である。
 * 届かなくても学習は止めないし、ローカルのタイマーも記録も一切変わらない。
 */
export async function reportActivity(date, taskId, questionId = null, sessionId = null, sessionActive = false) {
  const config = await getCloudConfig();
  if (!isActive(config)) return { ok: false, reason: 'disabled' };
  try {
    return await request(config, '/api/sync/activity', {
      method: 'POST',
      body: { date, taskId, questionId, sessionId, sessionActive },
      token: config.deviceKey,
    });
  } catch {
    // 知らせられなくても学習は続く（保護が効かないだけ）。
    return { ok: false, reason: 'offline' };
  }
}

/** 予定の変更履歴を取る（設定画面の「最近の予定の変更」に出す）。 */
export async function fetchPlanChanges(limit = 10) {
  const config = await getCloudConfig();
  if (!isLinked(config)) return { entries: [] };
  // 設定画面を組み立てる途中で読むので、待たされすぎないよう短めに切る。
  return request(config, `/api/sync/changes?limit=${limit}`, { token: config.deviceKey, timeoutMs: 8000 });
}

/** 変更を取り消す。安全に戻せないときはサーバーが断り、何も変わらない。 */
export async function undoPlanChange(changeId) {
  const config = await getCloudConfig();
  if (!isLinked(config)) throw new CloudError('この端末はまだ同期に参加していません。');
  return request(config, '/api/sync/undo', {
    method: 'POST',
    body: { changeId, operationId: `undo_${changeId}_${Date.now().toString(36)}` },
    token: config.deviceKey,
  });
}

/* ------------------------------------------------------------------ */
/* 同期                                                                */
/* ------------------------------------------------------------------ */

/**
 * 同期の「どこまで受け取ったか」を初期状態へ戻す。
 * 学習データをすべて消したあとに呼ぶ。次の同期を初回と同じ扱いにするため。
 */
export async function resetSyncCursor() {
  await saveCloudConfig({ lastPulledAtMs: null, questionsHash: null, lastSyncedAt: null, lastError: null });
}

/** 送るものを組み立てる。初回（lastPulledAtMs が無い）はローカルの全部を送る。 */
async function buildPayload(config) {
  const first = !config.lastPulledAtMs;
  const [records, challenges, goals, questions, outbox, planMeta, moves] = await Promise.all([
    idb.all(STORES.records),
    idb.all(STORES.challenges),
    api.getGoals({ includeDeleted: true }),
    idb.all(STORES.questions),
    api.listOutbox(),
    api.getPlanMeta(),
    idb.all(STORES.moves),
  ]);
  const [availability, estimateEntries] = await Promise.all([api.getAvailability(), api.getEstimateEntries()]);

  const queuedRecordIds = new Set(outbox.filter((e) => e.type === 'record').map((e) => e.id));
  const queuedChallengeIds = new Set(outbox.filter((e) => e.type === 'challenge').map((e) => e.id));
  const queuedMoveIds = new Set(outbox.filter((e) => e.type === 'move').map((e) => e.id));
  // この端末で消したもの。送るまで覚えておく（送らないと次の同期で戻ってくる）。
  const deletedRecordIds = [...new Set(outbox.filter((e) => e.type === 'record_deleted').map((e) => e.id))];
  const deletedChallengeIds = [...new Set(outbox.filter((e) => e.type === 'challenge_deleted').map((e) => e.id))];

  // 初回はローカルにあるものを全部送る（クラウドが空でも消えないように）。
  const recordsToSend = first ? records : records.filter((r) => queuedRecordIds.has(r.id));
  const challengesToSend = first ? challenges : challenges.filter((c) => queuedChallengeIds.has(c.id));
  // 繰り越しの記録も追加専用。同じ id を何度送っても増えない。
  const movesToSend = first ? moves : moves.filter((m) => queuedMoveIds.has(m.id));
  // First-sync overflow must survive after lastPulledAtMs advances.
  // Only acknowledged chunks may be removed from the outbox.
  if (first) {
    for (const [type, entries, limit] of [
      ['record', recordsToSend, PUSH_CHUNK], ['challenge', challengesToSend, 100], ['move', movesToSend, 200],
    ]) {
      await idb.putAll(STORES.outbox, entries.slice(limit).map((entry) => ({
        key: `${type}:${entry.id}`, type, id: entry.id, queuedAt: Date.now(),
      })));
    }
  }
  const sentKeys = new Set([
    ...recordsToSend.slice(0, PUSH_CHUNK).map((r) => `record:${r.id}`),
    ...challengesToSend.slice(0, 100).map((r) => `challenge:${r.id}`),
    ...movesToSend.slice(0, 200).map((r) => `move:${r.id}`),
    ...deletedRecordIds.slice(0, 200).map((id) => `record_deleted:${id}`),
    ...deletedChallengeIds.slice(0, 200).map((id) => `challenge_deleted:${id}`),
  ]);

  // 予定は、この端末で変更した日ぶん（初回はローカルにある全日ぶん）。
  const tasks = await idb.all(STORES.tasks);
  const byDate = new Map();
  for (const task of tasks) {
    if (!byDate.has(task.date)) byDate.set(task.date, []);
    byDate.get(task.date).push(task);
  }
  const dirtyDates = first
    ? [...byDate.keys()]
    : Object.entries(planMeta).filter(([, meta]) => meta?.dirty).map(([date]) => date);
  const taskPlans = dirtyDates.map((date) => ({
    date,
    tasks: (byDate.get(date) ?? []).sort((a, b) => a.order - b.order),
    updatedAt: planMeta[date]?.updatedAt ?? new Date().toISOString(),
    revision: planMeta[date]?.revision ?? 0,
    updatedBy: planMeta[date]?.updatedBy ?? 'app',
  }));

  const localHash = questions.length ? await hashQuestions(questions) : null;
  // 問題マスタは版を添えて送る。サーバーは版が今より大きいときだけ受け取るので、
  // 古いマスタを持ったままの端末が、新しいマスタを巻き戻すことはない。
  const masterVersion = await api.getQuestionMasterVersion();
  return {
    first,
    localHash,
    outboxEntries: outbox.filter((e) => sentKeys.has(e.key)),
    // PR #5 offline outboxes are accepted as end notifications, never as fire requests.
    sessionEnds: outbox.filter((e) => e.type === 'session_end' || e.type === 'replan'),
    pushedDates: dirtyDates,
    payload: {
      since: config.lastPulledAtMs ?? null,
      // この端末が知っている「すべて削除」の印。サーバーはこれより新しい削除が
      // あれば、送ったものを1つも受け取らない（消したものが戻らないように）。
      knownPurgeAtMs: Number(config.lastPurgeAtMs) || 0,
      records: recordsToSend.slice(0, PUSH_CHUNK),
      challenges: challengesToSend.slice(0, 100),
      // 消したもののID。サーバーは先にこれを消してから、送った中身を重ねる。
      deletions: {
        records: deletedRecordIds.slice(0, 200),
        challenges: deletedChallengeIds.slice(0, 200),
      },
      moves: movesToSend.slice(0, 200),
      // 学習可能時間と見積もりの指定も送る（どちらも消さずに重ねられる）。
      availability,
      estimates: estimateEntries,
      taskPlans: taskPlans.slice(0, 120),
      goals,
      questions: questions.length && localHash !== config.questionsHash
        ? { hash: localHash, masterVersion, questions }
        : { hash: localHash, masterVersion },
    },
    remainingRecords: Math.max(0, recordsToSend.length - PUSH_CHUNK)
      + Math.max(0, challengesToSend.length - 100) + Math.max(0, movesToSend.length - 200)
      + Math.max(0, deletedRecordIds.length - 200) + Math.max(0, deletedChallengeIds.length - 200)
      + Math.max(0, taskPlans.length - 120),
  };
}

/** 受け取った内容をローカルへ重ねる。ここでも消す操作は一切しない。 */
async function applySnapshot(snapshot) {
  const applied = { records: 0, challenges: 0, deleted: 0, plans: 0, goals: 0, questions: 0, moves: 0, availability: 0, estimates: 0, purged: false };

  // ほかの端末で「学習データをすべて削除」が行われていたら、まずこの端末も消す。
  //
  // 全部消すと配るものが無くなるので、端末からは「空が返ってきた」としか見えない。
  // 同期は届いたものを重ねるだけなので、それだけでは手元の予定や記録が残り続ける。
  // そこでサーバーは消した日時を印として残し、端末はそれを見て自分の手元も消す。
  //
  // 消すのを先にやるのは、このあとに続くサーバーの内容（消したあとに入ったもの）を
  // そのまま重ねられるようにするため。
  const config = await getCloudConfig();
  const purgeAt = Number(snapshot.purge?.atMs) || 0;
  if (purgeAt > (Number(config.lastPurgeAtMs) || 0)) {
    await api.purgeStudyData();
    await saveCloudConfig({
      lastPurgeAtMs: purgeAt,
      // 次の同期は最初から取り直す（消したあとの状態を丸ごと受け取る）。
      lastPulledAtMs: null,
      questionsHash: null,
    });
    applied.purged = true;
  }

  // 他の端末で消されたものは、この端末からも消す。
  // 重ねるより先に消しておかないと、同じ同期の中で入り直してしまう。
  for (const id of snapshot.deletions?.records ?? []) {
    await idb.del(STORES.records, id).catch(() => {});
  }
  for (const id of snapshot.deletions?.challenges ?? []) {
    await idb.del(STORES.challenges, id).catch(() => {});
  }
  const deletedHere = {
    records: new Set(snapshot.deletions?.records ?? []),
    challenges: new Set(snapshot.deletions?.challenges ?? []),
  };
  applied.deleted = deletedHere.records.size + deletedHere.challenges.size;

  // 学習記録は「追加専用」ではなくなった（本人の申告で足したり、訂正・削除ができる）。
  // 同じ id が来たら、revision の大きいほう（新しいほう）を残す。
  // これで、訂正を知らない端末の内容で古い状態に戻ることがない。
  const localRecords = new Map((await idb.all(STORES.records)).map((r) => [r.id, r]));
  const recordsToSave = [];
  for (const incoming of snapshot.records ?? []) {
    if (!incoming || !incoming.id || deletedHere.records.has(incoming.id)) continue;
    const { syncedAt, ...record } = incoming;
    const current = localRecords.get(record.id);
    if (!current) {
      recordsToSave.push(record);
      continue;
    }
    if (api.mergeStudyRecord(current, record) === record) recordsToSave.push(record);
  }
  if (recordsToSave.length) {
    await idb.putAll(STORES.records, recordsToSave);
    applied.records = recordsToSave.length;
  }

  // チャレンジ結果も版で重ね合わせる（古い内容で新しい内容を上書きしない）。
  const localChallenges = new Map((await idb.all(STORES.challenges)).map((c) => [c.id, c]));
  const challengesToSave = [];
  for (const incoming of snapshot.challenges ?? []) {
    if (!incoming || !incoming.id || deletedHere.challenges.has(incoming.id)) continue;
    const { syncedAt, ...result } = incoming;
    const current = localChallenges.get(result.id);
    if (!current) {
      challengesToSave.push(result);
      continue;
    }
    const currentRevision = Number(current.revision ?? 0);
    const incomingRevision = Number(result.revision ?? 0);
    if (incomingRevision > currentRevision
      || (incomingRevision === currentRevision
        && String(result.updatedAt ?? '') > String(current.updatedAt ?? ''))) {
      challengesToSave.push(result);
    }
  }
  if (challengesToSave.length) {
    await idb.putAll(STORES.challenges, challengesToSave);
    applied.challenges = challengesToSave.length;
  }

  // 学習可能時間は、新しいほうを採る（サーバー側で突き合わせ済み）。
  if (snapshot.availability) {
    const local = await api.getAvailability();
    const incomingAt = Date.parse(snapshot.availability.updatedAt ?? '') || 0;
    const localAt = Date.parse(local.updatedAt ?? '') || 0;
    if (incomingAt > localAt) {
      await idb.put(STORES.meta, { key: api.AVAILABILITY_KEY, value: snapshot.availability });
      applied.availability = 1;
    }
  }

  // 見積もりの指定は、項目ごとに新しいほうを採る（本人の指定を仮の値で消さない）。
  if (snapshot.estimates && typeof snapshot.estimates === 'object') {
    const local = await api.getEstimateEntries();
    const merged = { ...local };
    for (const [questionId, entry] of Object.entries(snapshot.estimates)) {
      const current = merged[questionId] ?? {};
      const newer = (key, atKey) => ((Date.parse(entry[atKey] ?? '') || 0) >= (Date.parse(current[atKey] ?? '') || 0)
        ? entry[key] : current[key]);
      merged[questionId] = {
        ...current,
        manualSeconds: newer('manualSeconds', 'manualUpdatedAt'),
        manualUpdatedAt: newer('manualUpdatedAt', 'manualUpdatedAt') ?? current.manualUpdatedAt ?? null,
        aiSeconds: newer('aiSeconds', 'aiUpdatedAt'),
        aiSource: newer('aiSource', 'aiUpdatedAt'),
        aiNote: newer('aiNote', 'aiUpdatedAt'),
        aiUpdatedAt: newer('aiUpdatedAt', 'aiUpdatedAt') ?? current.aiUpdatedAt ?? null,
      };
    }
    await idb.put(STORES.meta, { key: api.ESTIMATES_KEY, value: merged });
    applied.estimates = Object.keys(snapshot.estimates).length;
  }

  // 繰り越しの記録も、無いものだけ足す（消さない・上書きしない）。
  const existingMoves = new Set((await idb.all(STORES.moves)).map((m) => m.id));
  const newMoves = (snapshot.moves ?? []).filter((m) => m && m.id && !existingMoves.has(m.id));
  if (newMoves.length) {
    await idb.putAll(STORES.moves, newMoves);
    applied.moves = newMoves.length;
  }

  // 問題マスタは版で決める。送る側と同じ決まりにしておかないと、
  // 「端末→サーバーは置き換え、サーバー→端末は足すだけ」のように意味が食い違い、
  // 端末ごとに問題の集合がずれたままになる。
  //
  //   ・サーバーのほうが新しい版 … 丸ごと入れ替える（消された問題も消える）
  //   ・この端末にまだ1問も無い   … そのまま入れる
  //   ・それ以外（同じか古い）    … 何もしない。次の同期でこちらの版を送る
  const questions = snapshot.questions?.questions;
  if (Array.isArray(questions) && questions.length) {
    const incomingVersion = Math.max(0, Math.floor(Number(snapshot.questions?.masterVersion) || 0));
    const localVersion = await api.getQuestionMasterVersion();
    const localCount = (await idb.all(STORES.questions)).length;
    if (!localCount || incomingVersion > localVersion) {
      await api.importQuestions(questions, { replace: localCount > 0, masterVersion: incomingVersion });
      applied.questions = questions.length;
    }
  }

  for (const goal of snapshot.goals ?? []) {
    const current = await idb.get(STORES.goals, goal.id);
    const currentAt = Date.parse(current?.updatedAt ?? '') || 0;
    const incomingAt = Date.parse(goal.updatedAt ?? '') || 0;
    if (!current || incomingAt >= currentAt) {
      await idb.put(STORES.goals, goal);
      applied.goals += 1;
    }
  }

  // 予定はサーバーで突き合わせ済みの内容が返ってくるので、そのまま置き換える。
  for (const plan of snapshot.taskPlans ?? []) {
    if (!plan?.date) continue;
    await api.updateTodayTasks(plan.tasks ?? [], plan.date, { markDirty: false });
    await api.setPlanMeta(plan.date, {
      revision: plan.revision ?? 0,
      updatedAt: plan.updatedAt ?? null,
      updatedBy: plan.updatedBy ?? null,
      dirty: false,
    });
    applied.plans += 1;
  }
  return applied;
}

let running = null;
let syncAgain = false;

/** Planning failure stays separate from study-data synchronization. */
async function deliverStudyEnds(config, events) {
  const pending = await idb.all(STORES.outbox);
  if (pending.some((entry) => entry.type !== 'session_end' && entry.type !== 'replan')) return;
  const liveKeys = new Set(pending.map((entry) => entry.key));
  for (const entry of events.filter((entry) => liveKeys.has(entry.key))) {
    try {
      const response = await request(config, '/api/sync/study-end', {
        method: 'POST', body: entry.event, token: config.deviceKey,
      });
      if (response.ok && response.studyEnd === 'success') {
        await idb.del(STORES.outbox, entry.key);
        await idb.put(STORES.meta, { key: 'lastSessionEnd', value: { sessionId: entry.event.sessionId, state: 'acknowledged' } });
      }
    } catch {
      // Keep exactly the same event for the next online/startup/schedule refresh.
      await idb.put(STORES.meta, { key: 'lastSessionEnd', value: {
        sessionId: entry.event.sessionId,
        state: 'failed', error: 'backend_unavailable', retryable: true,
      } });
    }
  }
}

async function refreshReplanStatus(config) {
  const replan = await request(config, `/api/sync/replan?date=${api.todayKey()}`, {
    token: config.deviceKey, timeoutMs: 8000,
  });
  await idb.put(STORES.meta, { key: 'lastReplan', value: replan });
}

export async function getReplanStatus(date = api.todayKey()) {
  const config = await getCloudConfig();
  if (!isActive(config)) return null;
  return request(config, `/api/sync/replan?date=${encodeURIComponent(date)}`, { token: config.deviceKey });
}

/**
 * 一度だけ同期する。
 * 同時に呼ばれても1つだけ動く（起動直後にいくつもの引き金が重なるため）。
 */
export async function syncNow({ force = false } = {}) {
  if (running) return running;
  running = (async () => {
    const config = await getCloudConfig();
    if (!isActive(config) && !force) return { ok: false, reason: 'disabled' };
    if (!config.deviceKey) return { ok: false, reason: 'not_linked', message: 'この端末はまだ同期に参加していません。' };
    try {
      const built = await buildPayload(config);
      const response = await request(config, '/api/sync/push', {
        method: 'POST',
        body: built.payload,
        token: config.deviceKey,
        // 初回はまとめて送るので、ふだんの上限では足りないことがある。
        timeoutMs: 60000,
      });
      const applied = await applySnapshot(response.snapshot ?? {});
      if (built.outboxEntries.length) await idb.acknowledgeOutbox(built.outboxEntries);
      await saveCloudConfig({
        lastSyncedAt: new Date().toISOString(),
        // ほかの端末の「すべて削除」を受けて手元を消したときは、続きからではなく
        // 最初から取り直す（消したあとの状態を丸ごと受け取るため）。
        lastPulledAtMs: applied.purged ? null : (response.snapshot?.serverTimeMs ?? Date.now()),
        // 受け取ったマスタで入れ替わったなら、覚えておくのはサーバー側のハッシュ。
        // 送ったときのハッシュのままだと、次の同期でいらない送り直しが起きる。
        questionsHash: applied.purged ? null
          : (applied.questions
            ? (response.snapshot?.questions?.hash ?? null)
            : (built.localHash ?? null)),
        deviceName: response.device?.deviceName ?? config.deviceName,
        lastError: null,
      });
      if (!applied.purged && !built.remainingRecords) {
        await deliverStudyEnds(config, built.sessionEnds).catch(() => {});
        await refreshReplanStatus(config).catch(() => {});
      }
      if (built.remainingRecords) syncAgain = true;
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('study-todo-synced'));
      return {
        ok: true,
        pushed: response.accepted,
        applied,
        // 1回で送りきれなかった分は、次の同期で続きを送る。
        remaining: built.remainingRecords,
      };
    } catch (error) {
      const message = error instanceof CloudError ? error.message : `同期できませんでした（${error.message}）。`;
      // 失敗しても控えは消さない。次にオンラインになったときに送り直す。
      await saveCloudConfig({ lastError: message });
      return { ok: false, reason: error?.offline ? 'offline' : 'error', message };
    }
  })().finally(() => {
    running = null;
    if (syncAgain) { syncAgain = false; syncInBackground(); }
  });
  return running;
}

/** 学習記録・チャレンジ結果を保存したあとなど、静かに同期を試みる。 */
export function syncInBackground() {
  if (running) { syncAgain = true; return; }
  getCloudConfig().then((config) => {
    if (!isActive(config)) return;
    syncNow().catch(() => {});
  }).catch(() => {});
}

/** アプリ起動時に呼ぶ。起動時とオンライン復帰時に同期する（短い周期の監視はしない）。 */
export function startCloudSync() {
  syncInBackground();
  if (typeof window !== 'undefined') {
    window.addEventListener('study-todo-local-change', () => syncInBackground());
    window.addEventListener('online', () => syncInBackground());
    window.addEventListener('focus', () => syncInBackground());
    window.addEventListener('pageshow', () => syncInBackground());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) syncInBackground();
    });
    window.setInterval(() => {
      if (!document.hidden) syncInBackground();
    }, DEVICE_SYNC_INTERVAL_MS);
  }
}

/** 画面に出す接続状態。 */
export function connectionState(config, { serverEnabled = null } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { key: 'offline', label: 'オフライン' };
  if (!isConfigured(config)) return { key: 'unset', label: '未設定' };
  if (!isLinked(config)) return { key: 'unlinked', label: '未接続' };
  if (config.lastError) return { key: 'error', label: 'エラー' };
  if (!config.enabled) return { key: 'paused', label: '停止中' };
  if (serverEnabled === false) return { key: 'server-off', label: 'AI連携オフ' };
  return { key: 'linked', label: '接続済み' };
}
