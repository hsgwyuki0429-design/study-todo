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
import { runTransaction, supportsTransactions, updateDocument } from "../storage/driver.js";
import {
  applyChanges,
  buildUndoChanges,
  emptyPlan,
  fingerprintOf,
  planRevisionOf,
  protectionOf,
} from "./task-changes.js";
import { dateKeyOf, isDateKey, monthKeyOf, todayKeyOf } from "../../src/datetime.js";
import {
  hashQuestions,
  mergeEvents,
  mergeGoals,
  mergeTaskPlan,
  normalizeChallengeResult,
  normalizeGoal,
  normalizeMove,
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
  // 予定の一括変更の記録（取り消しのために変更前後を持つ）。
  changes: "studytodo:changes",
  // タスクIDごとの「今どの日にあるか」。古い端末が移動前の日へ戻すのを防ぐ。
  placements: "studytodo:placements",
  // 予定を別の日へ動かした記録（繰り越し・予定変更）。追加専用。
  moves: "studytodo:moves",
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
  // 変更の記録（取り消しに使う）を何件残すか。
  changeEntries: 50,
  // 繰り越しの記録。追加専用で、1回に送れる数と持っておく数の上限。
  movesPerPush: 200,
  moves: 2000,
  movesPerPull: 500,
  // 「いま解いている」の記録を何件覚えておくか／どれだけで期限切れにするか。
  placements: 2000,
  activityTtlSeconds: 15 * 60,
  activityMaxTtlSeconds: 60 * 60,
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
const DEFAULT_CHANGES = { entries: [] };
const DEFAULT_PLACEMENTS = { tasks: {} };
const DEFAULT_MOVES = { moves: {} };

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

  /* ------------------------------------------------------------------ */
  /* 予定のタスク単位の変更                                               */
  /* ------------------------------------------------------------------ */

  const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  /**
   * 予定1日ぶんを、他の書き込みと混ざらないように読んで書く。
   * transaction を持つ保存先ではその中で行い、持たない保存先（KV）では
   * そのまま読み書きする（KV は比較して書き込む仕組みを持たないため、
   * ここでの保証は「同時更新が無ければ正しい」までである）。
   */
  async function mutatePlan(date, mutate) {
    const key = SYNC_KEYS.taskPlan(date);
    if (supportsTransactions(storage)) {
      return runTransaction(storage, async (tx) => {
        const stored = await tx.get(key);
        const outcome = await mutate(stored);
        if (outcome?.plan) await tx.put(key, outcome.plan);
        return outcome;
      });
    }
    const stored = await storage.get(key);
    const outcome = await mutate(stored);
    if (outcome?.plan) await storage.put(key, outcome.plan);
    return outcome;
  }

  /** transaction の中から、操作の記録を1件足す。 */
  async function appendLogTx(tx, entry) {
    const document = (await tx.get(SYNC_KEYS.log)) ?? structuredClone(DEFAULT_LOG);
    document.entries = [
      {
        timestamp: new Date(now()).toISOString(),
        clientName: entry.clientName ?? null,
        tool: entry.tool,
        summary: entry.summary,
        ...(entry.changeId ? { changeId: entry.changeId } : {}),
      },
      ...(document.entries ?? []),
    ].slice(0, SYNC_LIMITS.logEntries);
    await tx.put(SYNC_KEYS.log, document);
  }

  /** 「このタスクは今どの日にあるか」を書き留める。古い端末の巻き戻しを防ぐ。 */
  function recordPlacements(document, plans, at) {
    const tasks = document.tasks ?? {};
    for (const [date, plan] of Object.entries(plans)) {
      for (const task of plan.tasks ?? []) tasks[task.id] = { date, at };
    }
    // 増えすぎたら古いものから捨てる（捨てても最新の予定そのものは残る）。
    const entries = Object.entries(tasks);
    if (entries.length > SYNC_LIMITS.placements) {
      entries.sort((left, right) => String(right[1].at).localeCompare(String(left[1].at)));
      document.tasks = Object.fromEntries(entries.slice(0, SYNC_LIMITS.placements));
    } else {
      document.tasks = tasks;
    }
    return document;
  }

  async function readPlacements() {
    const document = await readDoc(SYNC_KEYS.placements, DEFAULT_PLACEMENTS);
    return document.tasks ?? {};
  }

  /** 予定の一括変更の記録。新しい順。 */
  async function readChanges({ limit = 20 } = {}) {
    const document = await readDoc(SYNC_KEYS.changes, DEFAULT_CHANGES);
    const entries = (document.entries ?? []).slice(0, Math.max(1, Math.min(limit, SYNC_LIMITS.changeEntries)));
    return { total: (document.entries ?? []).length, entries };
  }

  const summarizePlan = (plan) => ({
    date: plan.date,
    revision: planRevisionOf(plan),
    taskCount: (plan.tasks ?? []).length,
    tasks: (plan.tasks ?? []).map((task) => ({
      id: task.id,
      kind: task.kind,
      questionIds: task.questionIds ?? [],
      ...(task.title ? { title: task.title } : {}),
      completed: task.completed === true,
      pinned: task.pinned === true,
    })),
  });

  /**
   * タスク単位の一括変更を、まとめて（全部成功か、全部未反映で）適用する。
   *
   * ・operationId が同じで内容も同じ要求は、前回の結果をそのまま返す（重複しない）
   * ・operationId が同じで内容が違う要求は断る
   * ・期待した revision と食い違えば、1つも変更せずに競合として返す
   */
  async function applyTaskChanges({
    request,
    actorKind = "ai",
    actorName = "AI",
    updatedBy = "ai",
    tool = "applyTaskChanges",
    knownQuestionIds = null,
    doneItemIds = null,
    undoOf = null,
  }) {
    const fingerprint = fingerprintOf(request);
    const at = new Date(now()).toISOString();

    return runTransaction(storage, async (tx) => {
      const changesDoc = (await tx.get(SYNC_KEYS.changes)) ?? structuredClone(DEFAULT_CHANGES);
      const entries = changesDoc.entries ?? [];
      const already = entries.find((entry) => entry.operationId === request.operationId);
      if (already) {
        if (already.fingerprint !== fingerprint) {
          return {
            ok: false,
            error: "operation_conflict",
            changeId: already.id,
            message: "同じ operationId で、内容の違う変更がすでに実行されています。別の operationId を使ってください。",
            nextAction: "やり直すなら新しい operationId を付け直し、getTasksInRange で今の revision を取り直してください。",
          };
        }
        // 同じ要求の再送。前と同じ結果を返すだけで、予定は動かさない。
        return { ...already.result, replayed: true };
      }

      const dates = [...request.expectedRevisions.keys()];
      const plans = {};
      for (const date of dates) plans[date] = (await tx.get(SYNC_KEYS.taskPlan(date))) ?? null;

      const outcome = applyChanges({
        plans,
        request,
        now: now(),
        actorKind,
        updatedBy,
        knownQuestionIds,
        doneItemIds,
        newId: () => uid("task"),
      });
      if (!outcome.ok) {
        return {
          ...outcome,
          plans: dates.map((date) => summarizePlan(plans[date] ?? emptyPlan(date))),
        };
      }

      for (const [date, plan] of Object.entries(outcome.plans)) {
        await tx.put(SYNC_KEYS.taskPlan(date), plan);
      }

      const placements = (await tx.get(SYNC_KEYS.placements)) ?? structuredClone(DEFAULT_PLACEMENTS);
      await tx.put(SYNC_KEYS.placements, recordPlacements(placements, outcome.plans, at));

      const changeId = uid("chg");
      // 予定を別の日へ動かしたことは、追加専用のイベントとしても残す。
      // 同じ operationId の再送では、ここまで来ないので二重にならない。
      const moves = (outcome.moves ?? []).map((event, index) => normalizeMove({
        ...event,
        id: `${changeId}-m${index}`,
        at,
        actorKind,
        actorName,
        changeId,
      }, { now: now() }));
      if (moves.length) {
        const document = (await tx.get(SYNC_KEYS.moves)) ?? structuredClone(DEFAULT_MOVES);
        const { merged } = mergeEvents(document.moves ?? {}, moves);
        document.moves = capMoves(merged);
        await tx.put(SYNC_KEYS.moves, document);
      }
      const result = {
        ok: true,
        changeId,
        appliedAt: at,
        reason: request.reason || null,
        revisions: outcome.revisions,
        summary: outcome.summary,
        moves,
        days: Object.values(outcome.plans).map(summarizePlan),
      };
      const record = {
        id: changeId,
        operationId: request.operationId,
        fingerprint,
        at,
        actorKind,
        actorName,
        tool,
        reason: request.reason || null,
        dates: outcome.summary.dates,
        before: outcome.before,
        after: outcome.after,
        revisions: outcome.revisions,
        summary: outcome.summary,
        undoOf,
        undoneBy: null,
        result,
      };
      changesDoc.entries = [record, ...entries].slice(0, SYNC_LIMITS.changeEntries);
      if (undoOf) {
        const target = changesDoc.entries.find((entry) => entry.id === undoOf);
        if (target) target.undoneBy = changeId;
      }
      await tx.put(SYNC_KEYS.changes, changesDoc);

      await appendLogTx(tx, {
        clientName: actorName,
        tool,
        changeId,
        summary: describeChange(outcome.summary, request.reason),
      });

      return result;
    });
  }

  /** 変更の概要を、人が読める1行にする。 */
  function describeChange(summary, reason) {
    const parts = [];
    if (summary.created.length) parts.push(`追加${summary.created.length}件`);
    if (summary.removed.length) parts.push(`削除${summary.removed.length}件`);
    if (summary.moved.length) parts.push(`移動${summary.moved.length}件`);
    if (summary.updated.length) parts.push(`変更${summary.updated.length}件`);
    const what = parts.length ? parts.join("・") : "変更なし";
    return `${summary.dates.join("・")} の予定を${what}${reason ? `（理由: ${reason}）` : ""}`;
  }

  /**
   * 記録してある変更を取り消す。
   * 履歴は消さず、「打ち消す変更」を新しく1件作って記録する。
   * そのあとで学習が進んだり、別の変更が入っていたら、何も変えずに競合として返す。
   */
  async function undoTaskChange({ changeId, operationId, actorKind = "user", actorName = "study-todo", reason = null }) {
    const { entries } = await readChanges({ limit: SYNC_LIMITS.changeEntries });
    const record = entries.find((entry) => entry.id === changeId) ?? (changeId ? null : entries[0]);
    if (!record) {
      return { ok: false, error: "not_found", message: "その変更は記録に残っていません。", changeId };
    }
    if (record.undoneBy) {
      return { ok: false, error: "already_undone", changeId: record.id, undoneBy: record.undoneBy, message: "この変更はすでに取り消されています。" };
    }

    const dates = [...new Set([...Object.keys(record.before ?? {}), ...Object.keys(record.after ?? {})])];
    const current = {};
    for (const date of dates) current[date] = (await readTaskPlan(date)) ?? emptyPlan(date);

    const undo = buildUndoChanges(record, current, { now: now() });
    if (undo.blocked.length) {
      return {
        ok: false,
        error: "undo_conflict",
        changeId: record.id,
        blocked: undo.blocked,
        message: "この変更のあとに学習が進んだか、別の変更が入っています。安全に取り消せないので何も変えていません。",
        nextAction: "今の予定を確かめて、必要な変更だけをやり直してください。",
      };
    }
    if (!undo.changes.length) {
      return { ok: false, error: "nothing_to_undo", changeId: record.id, message: "戻すものがありません（すでに元の状態です）。" };
    }

    const request = {
      operationId: operationId ?? `undo_${record.id}`,
      reason: reason ?? `変更 ${record.id} の取り消し`,
      expectedRevisions: new Map(dates.map((date) => [date, planRevisionOf(current[date])])),
      changes: undo.changes,
    };
    const result = await applyTaskChanges({
      request,
      // 取り消しはアプリからの操作として扱う。ただし保護は buildUndoChanges で見ている。
      actorKind,
      actorName,
      updatedBy: `${actorKind}:undo`,
      tool: "undoTaskChanges",
      undoOf: record.id,
    });
    return result.ok ? { ...result, undoOf: record.id } : result;
  }

  /** 固定（ピン留め）の付け外し。アプリ（端末）だけが行える。 */
  async function setTaskPinned({ date, taskId, pinned, deviceId = null }) {
    const outcome = await mutatePlan(date, (stored) => {
      if (!stored) return { ok: false, error: "not_found", message: `${date} の予定はありません。` };
      const task = (stored.tasks ?? []).find((entry) => entry.id === taskId);
      if (!task) return { ok: false, error: "not_found", message: `タスク ${taskId} が見つかりません。` };
      const plan = structuredClone(stored);
      const target = plan.tasks.find((entry) => entry.id === taskId);
      target.pinned = pinned === true;
      target.updatedAt = new Date(now()).toISOString();
      plan.revision = planRevisionOf(stored) + 1;
      plan.updatedAt = new Date(now()).toISOString();
      plan.updatedBy = deviceId ? `app:${deviceId}` : "app";
      return { ok: true, plan };
    });
    if (!outcome.ok) return outcome;
    return { ok: true, date, taskId, pinned: pinned === true, revision: outcome.plan.revision };
  }

  /**
   * 端末から「いまこのタスクを解いている」と知らせてもらう。
   * 期限つきで預かり、期限を過ぎたら実行中ではなくなる。
   * 圏外の端末は知らせられないので、この情報は「サーバーが知っている範囲」でしかない。
   */
  async function reportActivity({ date, taskId, questionId = null, deviceId = null, ttlSeconds = null }) {
    const ttl = Math.max(60, Math.min(Number(ttlSeconds) || SYNC_LIMITS.activityTtlSeconds, SYNC_LIMITS.activityMaxTtlSeconds));
    const at = new Date(now()).toISOString();
    const expiresAt = new Date(now() + ttl * 1000).toISOString();
    const outcome = await mutatePlan(date, (stored) => {
      const base = stored ?? { ...emptyPlan(date), updatedAt: at, updatedBy: "app" };
      const plan = structuredClone(base);
      if (taskId === null) {
        delete plan.active;
      } else {
        if (!(plan.tasks ?? []).some((task) => task.id === taskId)) {
          return { ok: false, error: "not_found", message: `タスク ${taskId} が ${date} にありません。` };
        }
        plan.active = { taskId, ...(questionId ? { questionId } : {}), deviceId, startedAt: at, expiresAt };
      }
      // 実行中の知らせは予定の中身を変えないので、revision は進めない
      // （進めると、端末とAIが持っている revision が理由なく古くなってしまう）。
      return { ok: true, plan };
    });
    if (!outcome.ok) return outcome;
    return { ok: true, date, taskId, expiresAt: taskId === null ? null : expiresAt };
  }

  /** 繰り越しの記録は追加専用。増えすぎたら古いものから捨てる。 */
  function capMoves(moves) {
    const entries = Object.entries(moves);
    if (entries.length <= SYNC_LIMITS.moves) return moves;
    entries.sort((left, right) => String(right[1].at).localeCompare(String(left[1].at)));
    return Object.fromEntries(entries.slice(0, SYNC_LIMITS.moves));
  }

  /**
   * 繰り越し・予定変更の記録を新しい順に返す。
   * 件数が多いので、必ず上限つきで返し、続きがあることを知らせる。
   */
  async function readMoves({ limit = 50, offset = 0, from = null, to = null, itemId = null, questionId = null } = {}) {
    const document = await readDoc(SYNC_KEYS.moves, DEFAULT_MOVES);
    // 同じ時刻の記録が並んだときは、あとから入ったものを新しいものとして扱う。
    let list = Object.values(document.moves ?? {}).reverse();
    if (from) list = list.filter((move) => move.toDate >= from || move.fromDate >= from);
    if (to) list = list.filter((move) => move.toDate <= to || move.fromDate <= to);
    if (itemId) list = list.filter((move) => move.items.some((item) => item.itemId === itemId));
    if (questionId) list = list.filter((move) => move.items.some((item) => item.questionId === questionId));
    list.sort((left, right) => String(right.at).localeCompare(String(left.at)));
    const page = list.slice(offset, offset + limit);
    return {
      total: list.length,
      offset,
      count: page.length,
      nextOffset: offset + page.length < list.length ? offset + page.length : null,
      moves: page,
    };
  }

  /** 端末から届いた繰り越しの記録を預かる（id で重複を除くだけ）。 */
  async function saveMoves(incoming = []) {
    const normalized = incoming.map((move) => normalizeMove(move, { now: now() })).filter(Boolean);
    if (!normalized.length) return { added: 0 };
    let added = 0;
    await updateDocument(storage, SYNC_KEYS.moves, (document) => {
      const merged = mergeEvents(document.moves ?? {}, normalized);
      document.moves = capMoves(merged.merged);
      added = merged.added;
    }, { defaults: structuredClone(DEFAULT_MOVES) });
    return { added };
  }

  /** 保存先が何を保証できるか。画面とAIへ正直に返すために使う。 */
  function storageCapabilities() {
    return {
      driver: storage.name ?? "unknown",
      atomicBatchUpdates: supportsTransactions(storage),
      note: supportsTransactions(storage)
        ? "複数の日の予定をまとめて安全に書き換えられます。"
        : "この保存先（Cloudflare KV 単体）では、まとめての安全な書き換えができません。Durable Object を有効にしてください。",
    };
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
    appendLog,
    readLog,
    applyTaskChanges,
    undoTaskChange,
    readChanges,
    readMoves,
    saveMoves,
    readPlacements,
    setTaskPinned,
    reportActivity,
    storageCapabilities,

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
      const moves = Array.isArray(payload.moves) ? payload.moves : [];
      if (moves.length > SYNC_LIMITS.movesPerPush) {
        fail(`1回に送れる繰り越しの記録は${SYNC_LIMITS.movesPerPush}件までです。`, "moves");
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
      //
      // さらに placements（タスクがいまどの日にあるかの記録）でふるいにかける。
      // 移動を知らない端末が、移動前の日の予定をそのまま送ってきても、
      // 移したタスクを元の日へ復活させない。
      const placements = await readPlacements();
      const planOutcomes = [];
      const acceptedPlans = {};
      for (const raw of taskPlans) {
        const plan = normalizeTaskPlan(raw, { updatedBy: raw?.updatedBy ?? "app", now: at });
        if (!plan) continue;
        const merged = await mutatePlan(plan.date, (stored) => {
          const result = mergeTaskPlan(stored ?? null, plan, { placements, now: at });
          return { ok: true, plan: result.plan, outcome: result.outcome, droppedTasks: result.droppedTasks ?? 0 };
        });
        planOutcomes.push({
          date: plan.date,
          outcome: merged.outcome,
          ...(merged.droppedTasks ? { droppedMovedTasks: merged.droppedTasks } : {}),
        });
        if (merged.outcome !== "kept-server" && merged.plan) acceptedPlans[plan.date] = merged.plan;
      }
      if (Object.keys(acceptedPlans).length) {
        // 端末が動かした結果も配置の記録へ反映する（AIの記録と同じ扱い）。
        await updateDocument(storage, SYNC_KEYS.placements, (document) => {
          recordPlacements(document, acceptedPlans, atIso);
        }, { defaults: structuredClone(DEFAULT_PLACEMENTS) });
      }

      const addedMoves = (await saveMoves(moves)).added;

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
          moves: addedMoves,
          duplicatedMoves: moves.length - addedMoves,
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
        // 繰り越しの記録も配る（追加専用なので、重ねても増えない）。
        moves: (await readMoves({ limit: SYNC_LIMITS.movesPerPull })).moves,
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
