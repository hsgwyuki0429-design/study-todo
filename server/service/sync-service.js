// 端末どうしでデータを合わせる層。
//
// study-todo は「本人が iPhone / iPad / PC で使う」個人利用なので、
// 学習者は1人だけ。分かれているのは端末である。
//
// 鍵は3種類あり、できることが違う。
//
//   オーナーキー … 本人。設定画面と管理API（同期コードの発行、AI連携の設定）
//   同期コード   … 人が手で入力する短い文字列。端末の登録のときだけ使う
//   端末キー     … 登録のときに配る長い文字列。以後の同期はこれで行う
//
// 同期コードを短くしても安全なのは、それ自体では読み書きできず、
// 登録のときにしか使えないため。登録が済めば端末キーに置き換わる。

import { fail, readString } from "../core/validate.js";
import { generateToken, hashToken, timingSafeEqual } from "../auth/tokens.js";
import { updateDocument } from "../storage/driver.js";
import { dateKeyOf, isDateKey, monthKeyOf, todayKeyOf } from "../../src/datetime.js";
import {
  hashQuestions,
  mergeEvents,
  mergeGoals,
  mergeTaskPlan,
  normalizeChallengeResult,
  normalizeGoal,
  normalizeQuestion,
  normalizeRecord,
  normalizeTaskPlan,
} from "./merge.js";

export const SYNC_KEYS = Object.freeze({
  devices: "studytodo:devices",
  records: (month) => `studytodo:records:${month}`,
  recordsPrefix: "studytodo:records:",
  challenges: "studytodo:challenges",
  taskPlan: (date) => `studytodo:tasks:${date}`,
  taskPlanPrefix: "studytodo:tasks:",
  goals: "studytodo:goals",
  questions: "studytodo:questions",
  log: "studytodo:log",
});

export const SYNC_LIMITS = Object.freeze({
  devices: 10,
  recordsPerPush: 500,
  challengesPerPush: 100,
  taskPlansPerPush: 120,
  goalsPerPush: 100,
  questions: 5000,
  logEntries: 100,
  // 予定を読み取る範囲。過ぎた予定も残すが、毎回すべてを読み直さない。
  planLookbackDays: 400,
  planLookaheadDays: 400,
});

// 見間違えやすい文字（0とO、1とIとl）を除いた並び。紙に書いて渡せるようにする。
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** STUDY-XXXX-XXXX の形の同期コードを作る。 */
export function generateSyncCode() {
  const pick = (length) => {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  };
  return `STUDY-${pick(4)}-${pick(4)}`;
}

/** 入力された同期コードの揺れ（小文字・全角・空白・区切りの有無）を吸収する。 */
export function normalizeSyncCode(value) {
  const text = String(value ?? "").normalize("NFKC").toUpperCase().replace(/[^0-9A-Z]/g, "");
  const body = text.startsWith("STUDY") ? text.slice(5) : text;
  if (body.length !== 8) return null;
  return `STUDY-${body.slice(0, 4)}-${body.slice(4)}`;
}

const DEFAULT_DEVICES = { devices: {}, syncCodeHash: null, syncCodePreview: null, updatedAt: null };
const DEFAULT_RECORDS = { records: {} };
const DEFAULT_CHALLENGES = { results: {} };
const DEFAULT_GOALS = { goals: [] };
const DEFAULT_QUESTIONS = { version: 0, hash: null, updatedAt: null, questions: [] };
const DEFAULT_LOG = { entries: [] };

export function createSyncService({ storage, now = () => Date.now() }) {
  async function readDoc(key, defaults) {
    const stored = await storage.get(key);
    return { ...structuredClone(defaults), ...(stored ?? {}) };
  }

  async function readDeviceIndex() {
    return readDoc(SYNC_KEYS.devices, DEFAULT_DEVICES);
  }

  /** 保存してある学習記録を全部（月ごとに分けて持っている）。 */
  async function readAllRecords() {
    const keys = await storage.list(SYNC_KEYS.recordsPrefix);
    const shards = await Promise.all(keys.map((key) => readDoc(key, DEFAULT_RECORDS)));
    const records = [];
    for (const shard of shards) records.push(...Object.values(shard.records ?? {}));
    return records.sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
  }

  async function readChallenges() {
    const document = await readDoc(SYNC_KEYS.challenges, DEFAULT_CHALLENGES);
    return Object.values(document.results ?? {})
      .sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
  }

  async function readGoals({ includeDeleted = false } = {}) {
    const document = await readDoc(SYNC_KEYS.goals, DEFAULT_GOALS);
    const goals = document.goals ?? [];
    return includeDeleted ? goals : goals.filter((goal) => !goal.deletedAt);
  }

  async function readQuestions() {
    return readDoc(SYNC_KEYS.questions, DEFAULT_QUESTIONS);
  }

  async function readTaskPlan(date) {
    if (!isDateKey(date)) fail(`date は 2026-09-12 のような日付で渡してください（受け取った値: ${date}）。`, "date");
    const stored = await storage.get(SYNC_KEYS.taskPlan(date));
    return stored ?? null;
  }

  /** 保存してある予定の日付を、範囲を決めて並べる。 */
  async function listPlanDates({ from = null, to = null } = {}) {
    const keys = await storage.list(SYNC_KEYS.taskPlanPrefix);
    return keys
      .map((key) => key.slice(SYNC_KEYS.taskPlanPrefix.length))
      .filter((date) => isDateKey(date))
      .filter((date) => (!from || date >= from) && (!to || date <= to))
      .sort();
  }

  async function readTaskPlansInRange(from, to) {
    const dates = await listPlanDates({ from, to });
    const plans = await Promise.all(dates.map((date) => storage.get(SYNC_KEYS.taskPlan(date))));
    return plans.filter(Boolean);
  }

  /**
   * その日の予定を書き込む。競合したときは新しいほうを残す。
   * 誰が変えたか（updatedBy）を必ず残し、AIの操作をあとから追えるようにする。
   */
  async function writeTaskPlan(date, tasks, { updatedBy = "app", baseRevision = null } = {}) {
    const at = new Date(now()).toISOString();
    const incoming = normalizeTaskPlan({ date, tasks, updatedAt: at, updatedBy, revision: baseRevision ?? 0 }, { date, now: now() });
    if (!incoming) fail("予定の形が正しくありません。", "tasks");
    let outcome = "applied";
    const { document } = await updateDocument(storage, SYNC_KEYS.taskPlan(date), (draft) => {
      const stored = draft.date ? draft : null;
      // baseRevision を渡さない書き込み（設定画面やAIからの直接指定）は、
      // いまの版を見てから書くので、常に最新の上へ重ねる。
      const base = baseRevision === null && stored
        ? { ...incoming, revision: Number(stored.revision ?? 0) }
        : incoming;
      const merged = mergeTaskPlan(stored, base);
      outcome = merged.outcome;
      Object.assign(draft, merged.plan);
    }, { defaults: {} });
    return { plan: { ...document, revision: document.revision }, outcome };
  }

  /** 目標を id ごとに重ねて書く。消した印（deletedAt）も引き継ぐ。 */
  async function writeGoals(incoming = []) {
    const normalized = incoming.map((goal) => normalizeGoal(goal, { now: now() })).filter(Boolean);
    const { document } = await updateDocument(storage, SYNC_KEYS.goals, (draft) => {
      draft.goals = mergeGoals(draft.goals ?? [], normalized);
    }, { defaults: structuredClone(DEFAULT_GOALS) });
    return document.goals;
  }

  async function appendLog(entry) {
    await updateDocument(storage, SYNC_KEYS.log, (document) => {
      document.entries = [
        {
          timestamp: new Date(now()).toISOString(),
          clientName: entry.clientName ?? null,
          tool: entry.tool,
          summary: entry.summary,
        },
        ...(document.entries ?? []),
      ].slice(0, SYNC_LIMITS.logEntries);
    }, { defaults: structuredClone(DEFAULT_LOG) });
  }

  async function readLog({ limit = 20 } = {}) {
    const document = await readDoc(SYNC_KEYS.log, DEFAULT_LOG);
    return { entries: (document.entries ?? []).slice(0, Math.max(1, Math.min(limit, SYNC_LIMITS.logEntries))) };
  }

  return {
    limits: SYNC_LIMITS,
    keys: SYNC_KEYS,
    readAllRecords,
    readChallenges,
    readGoals,
    writeGoals,
    readQuestions,
    readTaskPlan,
    readTaskPlansInRange,
    writeTaskPlan,
    appendLog,
    readLog,

    // ----------------------------------------------------------------
    // 同期コードと端末
    // ----------------------------------------------------------------

    /** いまの同期コードの状態（本体はサーバーに残っていない）。 */
    async status() {
      const index = await readDeviceIndex();
      const questions = await readQuestions();
      const records = await readAllRecords();
      return {
        syncCodeIssued: Boolean(index.syncCodeHash),
        syncCodePreview: index.syncCodePreview,
        devices: Object.entries(index.devices ?? {})
          .filter(([, device]) => device.keyHash)
          .map(([id, device]) => ({
            id,
            name: device.name,
            joinedAt: device.joinedAt ?? null,
            lastSeenAt: device.lastSeenAt ?? null,
          })),
        records: records.length,
        questions: (questions.questions ?? []).length,
        questionsVersion: questions.version,
        lastSyncedAt: index.updatedAt,
      };
    },

    /** 同期コードを発行しなおす。登録済みの端末はそのまま使える。 */
    async issueSyncCode() {
      const code = generateSyncCode();
      const hash = await hashToken(code);
      await updateDocument(storage, SYNC_KEYS.devices, (document) => {
        document.syncCodeHash = hash;
        document.syncCodePreview = code.slice(0, 11);
      }, { defaults: structuredClone(DEFAULT_DEVICES) });
      return { syncCode: code };
    },

    /** 同期コードを見せた端末を登録する。端末キーを返すのはこのときだけ。 */
    async joinDevice({ code, deviceName }) {
      const normalized = normalizeSyncCode(code);
      if (!normalized) {
        fail("同期コードの形が違います。STUDY-XXXX-XXXX の形で入力してください。", "code");
      }
      const index = await readDeviceIndex();
      if (!index.syncCodeHash) {
        fail("同期コードがまだ発行されていません。設定画面の「同期コードを発行」を先に押してください。", "code");
      }
      const hash = await hashToken(normalized);
      if (!timingSafeEqual(index.syncCodeHash, hash)) {
        fail("この同期コードは使えません。設定画面で発行しなおしてください。", "code");
      }
      const active = Object.values(index.devices ?? {}).filter((device) => device.keyHash);
      if (active.length >= SYNC_LIMITS.devices) {
        fail(`登録できる端末は${SYNC_LIMITS.devices}台までです。使わない端末の接続を解除してください。`, "code");
      }

      const deviceId = `device-${generateToken(6)}`;
      const deviceKey = generateToken(32);
      const keyHash = await hashToken(deviceKey);
      const at = new Date(now()).toISOString();
      await updateDocument(storage, SYNC_KEYS.devices, (document) => {
        document.devices[deviceId] = {
          name: readString(deviceName, "deviceName", { max: 40 }) || "端末",
          keyHash,
          joinedAt: at,
          lastSeenAt: at,
        };
        document.updatedAt = at;
      }, { defaults: structuredClone(DEFAULT_DEVICES) });
      return { deviceId, deviceKey, deviceName: deviceName || "端末" };
    },

    /** 端末キーから、どの端末かを割り出す。 */
    async resolveDeviceKey(deviceKey) {
      const key = readString(deviceKey, "deviceKey", { max: 200 });
      if (!key) return null;
      const hash = await hashToken(key);
      const index = await readDeviceIndex();
      for (const [deviceId, device] of Object.entries(index.devices ?? {})) {
        if (device.keyHash && timingSafeEqual(device.keyHash, hash)) {
          return { deviceId, deviceName: device.name };
        }
      }
      return null;
    },

    /** 端末の登録を解く。預かっている学習記録は消さない。 */
    async leaveDevice(deviceId) {
      await updateDocument(storage, SYNC_KEYS.devices, (document) => {
        const device = document.devices?.[deviceId];
        if (!device) return;
        device.keyHash = null;
        device.releasedAt = new Date(now()).toISOString();
      }, { defaults: structuredClone(DEFAULT_DEVICES) });
      return { deviceId, released: true };
    },

    // ----------------------------------------------------------------
    // 同期
    // ----------------------------------------------------------------

    /**
     * 端末から届いた分を預かる。
     * 学習記録とチャレンジ結果は id で重複を除くだけなので、
     * 同じものが何度届いても結果は変わらない。既にある分を消すことはない。
     */
    async push(deviceId, payload = {}) {
      const at = now();
      const atIso = new Date(at).toISOString();

      const records = Array.isArray(payload.records) ? payload.records : [];
      if (records.length > SYNC_LIMITS.recordsPerPush) {
        fail(`1回に送れる学習記録は${SYNC_LIMITS.recordsPerPush}件までです。分けて送ってください。`, "records");
      }
      const challenges = Array.isArray(payload.challenges) ? payload.challenges : [];
      if (challenges.length > SYNC_LIMITS.challengesPerPush) {
        fail(`1回に送れるチャレンジ結果は${SYNC_LIMITS.challengesPerPush}件までです。`, "challenges");
      }
      const taskPlans = Array.isArray(payload.taskPlans) ? payload.taskPlans : [];
      if (taskPlans.length > SYNC_LIMITS.taskPlansPerPush) {
        fail(`1回に送れる予定は${SYNC_LIMITS.taskPlansPerPush}日ぶんまでです。`, "taskPlans");
      }
      const goals = Array.isArray(payload.goals) ? payload.goals : [];
      if (goals.length > SYNC_LIMITS.goalsPerPush) fail(`目標は${SYNC_LIMITS.goalsPerPush}件までです。`, "goals");

      // 学習記録は月ごとに分けて預かる。増えても1回の書き込みが重くならない。
      const byMonth = new Map();
      let skippedRecords = 0;
      for (const raw of records) {
        const record = normalizeRecord(raw, { receivedAt: at });
        if (!record) { skippedRecords += 1; continue; }
        const month = monthKeyOf(record.timestamp);
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month).push(record);
      }
      let addedRecords = 0;
      for (const [month, list] of byMonth) {
        await updateDocument(storage, SYNC_KEYS.records(month), (document) => {
          const { merged, added } = mergeEvents(document.records ?? {}, list);
          document.records = merged;
          addedRecords += added;
        }, { defaults: structuredClone(DEFAULT_RECORDS) });
      }

      let addedChallenges = 0;
      const normalizedChallenges = challenges
        .map((raw) => normalizeChallengeResult(raw, { receivedAt: at }))
        .filter(Boolean);
      if (normalizedChallenges.length) {
        await updateDocument(storage, SYNC_KEYS.challenges, (document) => {
          const { merged, added } = mergeEvents(document.results ?? {}, normalizedChallenges);
          document.results = merged;
          addedChallenges += added;
        }, { defaults: structuredClone(DEFAULT_CHALLENGES) });
      }

      // 予定は日ごとに版を見て重ねる。古い内容で新しい内容を消さない。
      const planOutcomes = [];
      for (const raw of taskPlans) {
        const plan = normalizeTaskPlan(raw, { updatedBy: raw?.updatedBy ?? "app", now: at });
        if (!plan) continue;
        let outcome = "ignored";
        await updateDocument(storage, SYNC_KEYS.taskPlan(plan.date), (draft) => {
          const stored = draft.date ? draft : null;
          const merged = mergeTaskPlan(stored, plan);
          outcome = merged.outcome;
          Object.assign(draft, merged.plan);
        }, { defaults: {} });
        planOutcomes.push({ date: plan.date, outcome });
      }

      if (goals.length) {
        const incoming = goals.map((goal) => normalizeGoal(goal, { now: at })).filter(Boolean);
        await updateDocument(storage, SYNC_KEYS.goals, (document) => {
          document.goals = mergeGoals(document.goals ?? [], incoming);
        }, { defaults: structuredClone(DEFAULT_GOALS) });
      }

      // 問題マスタは、中身が変わったときだけ入れ替える。同じものは送り直させない。
      let questionsStored = false;
      if (payload.questions && Array.isArray(payload.questions.questions)) {
        const list = payload.questions.questions.map(normalizeQuestion).filter(Boolean);
        if (list.length > SYNC_LIMITS.questions) {
          fail(`問題マスタは${SYNC_LIMITS.questions}問までです。`, "questions");
        }
        const hash = await hashQuestions(list);
        const current = await readQuestions();
        if (list.length && hash !== current.hash) {
          await updateDocument(storage, SYNC_KEYS.questions, (document) => {
            document.questions = list;
            document.hash = hash;
            document.version = Number(document.version ?? 0) + 1;
            document.updatedAt = atIso;
          }, { defaults: structuredClone(DEFAULT_QUESTIONS) });
          questionsStored = true;
        }
      }

      await updateDocument(storage, SYNC_KEYS.devices, (document) => {
        const device = document.devices?.[deviceId];
        if (device) device.lastSeenAt = atIso;
        document.updatedAt = atIso;
      }, { defaults: structuredClone(DEFAULT_DEVICES) });

      return {
        savedAt: atIso,
        accepted: {
          records: addedRecords,
          duplicatedRecords: records.length - addedRecords - skippedRecords,
          invalidRecords: skippedRecords,
          challenges: addedChallenges,
          taskPlans: planOutcomes,
          goals: goals.length,
        },
        questionsStored,
      };
    },

    /**
     * サーバーにあるいまの内容を返す。
     * since（ミリ秒）を渡すと、それ以降に預かった学習記録だけを返す。
     */
    async pull({ since = null, questionsHash = null, timezoneOffsetMinutes } = {}) {
      const today = todayKeyOf(timezoneOffsetMinutes, now());
      const [allRecords, challenges, goals, questions, index] = await Promise.all([
        readAllRecords(),
        readChallenges(),
        readGoals({ includeDeleted: true }),
        readQuestions(),
        readDeviceIndex(),
      ]);
      const sinceMs = Number.isFinite(Number(since)) ? Number(since) : null;
      const records = sinceMs === null
        ? allRecords
        : allRecords.filter((record) => Number(record.syncedAt ?? 0) > sinceMs);
      const plans = await readTaskPlansInRange(
        shift(today, -SYNC_LIMITS.planLookbackDays),
        shift(today, SYNC_LIMITS.planLookaheadDays),
      );
      const sameQuestions = questionsHash && questions.hash && questionsHash === questions.hash;
      return {
        serverTime: new Date(now()).toISOString(),
        serverTimeMs: now(),
        totalRecords: allRecords.length,
        records,
        challenges: sinceMs === null
          ? challenges
          : challenges.filter((result) => Number(result.syncedAt ?? 0) > sinceMs),
        taskPlans: plans,
        goals,
        questions: {
          version: questions.version,
          hash: questions.hash,
          count: (questions.questions ?? []).length,
          updatedAt: questions.updatedAt,
          // 端末が同じ問題マスタを持っているなら、中身は送らない。
          questions: sameQuestions ? null : (questions.questions ?? []),
        },
        devices: Object.entries(index.devices ?? {})
          .filter(([, device]) => device.keyHash)
          .map(([id, device]) => ({ id, name: device.name, lastSeenAt: device.lastSeenAt ?? null })),
      };
    },
  };
}

function shift(dateKey, days) {
  const ms = Date.parse(`${dateKey}T00:00:00Z`) + days * 86400000;
  return dateKeyOf(ms, 0);
}
