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
  lastError: null,
});

/** 一度に送る学習記録の数。サーバー側の上限に合わせる。 */
const PUSH_CHUNK = 400;

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

async function request(config, path, { method = 'GET', body = null, token = null, signal } = {}) {
  if (!config?.serverUrl) throw new CloudError('同期サーバーのURLが設定されていません。');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new CloudError('オフラインです。オンラインに戻ったときに同期します。', null, true);
  }
  let response;
  try {
    response = await fetch(`${config.serverUrl}${path}`, {
      method,
      signal,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === null ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new CloudError(`サーバーへつながりませんでした（${error.message}）。URLとネットワークを確認してください。`, null, true);
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
  status: (config, signal) => request(config, '/api/admin/status', { token: config.ownerKey, signal }),
  updateSettings: (config, changes) =>
    request(config, '/api/admin/settings', { method: 'POST', body: changes, token: config.ownerKey }),
  issueToken: (config, scopes) =>
    request(config, '/api/admin/token', { method: 'POST', body: { scopes }, token: config.ownerKey }),
  revokeToken: (config) => request(config, '/api/admin/token', { method: 'DELETE', token: config.ownerKey }),
  issueSyncCode: (config) => request(config, '/api/admin/sync-code', { method: 'POST', body: {}, token: config.ownerKey }),
  log: (config) => request(config, '/api/admin/log', { token: config.ownerKey }),
  releaseDevice: (config, deviceId) =>
    request(config, '/api/admin/devices', { method: 'DELETE', body: { deviceId }, token: config.ownerKey }),
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
/* 同期                                                                */
/* ------------------------------------------------------------------ */

/** 送るものを組み立てる。初回（lastPulledAtMs が無い）はローカルの全部を送る。 */
async function buildPayload(config) {
  const first = !config.lastPulledAtMs;
  const [records, challenges, goals, questions, outbox, planMeta] = await Promise.all([
    idb.all(STORES.records),
    idb.all(STORES.challenges),
    api.getGoals({ includeDeleted: true }),
    idb.all(STORES.questions),
    api.listOutbox(),
    api.getPlanMeta(),
  ]);

  const queuedRecordIds = new Set(outbox.filter((e) => e.type === 'record').map((e) => e.id));
  const queuedChallengeIds = new Set(outbox.filter((e) => e.type === 'challenge').map((e) => e.id));

  // 初回はローカルにあるものを全部送る（クラウドが空でも消えないように）。
  const recordsToSend = first ? records : records.filter((r) => queuedRecordIds.has(r.id));
  const challengesToSend = first ? challenges : challenges.filter((c) => queuedChallengeIds.has(c.id));

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
  return {
    first,
    localHash,
    outboxKeys: outbox
      .filter((e) => (e.type === 'record' && queuedRecordIds.has(e.id)) || (e.type === 'challenge' && queuedChallengeIds.has(e.id)))
      .map((e) => e.key),
    pushedDates: dirtyDates,
    payload: {
      since: config.lastPulledAtMs ?? null,
      records: recordsToSend.slice(0, PUSH_CHUNK),
      challenges: challengesToSend.slice(0, 100),
      taskPlans: taskPlans.slice(0, 120),
      goals,
      questions: questions.length && localHash !== config.questionsHash
        ? { hash: localHash, questions }
        : { hash: localHash },
    },
    remainingRecords: Math.max(0, recordsToSend.length - PUSH_CHUNK),
  };
}

/** 受け取った内容をローカルへ重ねる。ここでも消す操作は一切しない。 */
async function applySnapshot(snapshot) {
  const applied = { records: 0, challenges: 0, plans: 0, goals: 0, questions: 0 };

  const existingRecords = new Set((await idb.all(STORES.records)).map((r) => r.id));
  const newRecords = (snapshot.records ?? [])
    .filter((r) => r && r.id && !existingRecords.has(r.id))
    .map(({ syncedAt, ...record }) => record);
  if (newRecords.length) {
    await idb.putAll(STORES.records, newRecords);
    applied.records = newRecords.length;
  }

  const existingChallenges = new Set((await idb.all(STORES.challenges)).map((c) => c.id));
  const newChallenges = (snapshot.challenges ?? [])
    .filter((c) => c && c.id && !existingChallenges.has(c.id))
    .map(({ syncedAt, ...result }) => result);
  if (newChallenges.length) {
    await idb.putAll(STORES.challenges, newChallenges);
    applied.challenges = newChallenges.length;
  }

  // 問題マスタは足すだけ。ローカルにしかない問題を消さない。
  const questions = snapshot.questions?.questions;
  if (Array.isArray(questions) && questions.length) {
    await idb.putAll(STORES.questions, questions);
    applied.questions = questions.length;
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
      });
      const applied = await applySnapshot(response.snapshot ?? {});
      if (built.outboxKeys.length) await api.clearOutboxEntries(built.outboxKeys);
      await saveCloudConfig({
        lastSyncedAt: new Date().toISOString(),
        lastPulledAtMs: response.snapshot?.serverTimeMs ?? Date.now(),
        questionsHash: built.localHash ?? null,
        deviceName: response.device?.deviceName ?? config.deviceName,
        lastError: null,
      });
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
  })().finally(() => { running = null; });
  return running;
}

/** 学習記録・チャレンジ結果を保存したあとなど、静かに同期を試みる。 */
export function syncInBackground() {
  getCloudConfig().then((config) => {
    if (!isActive(config)) return;
    syncNow().catch(() => {});
  }).catch(() => {});
}

/** アプリ起動時に呼ぶ。起動時とオンライン復帰時に同期する（短い周期の監視はしない）。 */
export function startCloudSync() {
  syncInBackground();
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => syncInBackground());
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
