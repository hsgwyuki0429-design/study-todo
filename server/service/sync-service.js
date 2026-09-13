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
import { normalizeAvailability } from "../../src/availability.js";
import { normalizeGoal as normalizeStructuredGoal } from "../../src/goals.js";
import {
  describeRecord,
  isCountedRecord,
  normalizeStudyRecord,
  recordDateOf,
} from "../../src/records-model.js";
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
  mergeAvailability,
  mergeRecords,
  mergeEstimateEntries,
  mergeChallenges,
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
  // 学習記録の追加・訂正・削除の記録（誰が・いつ・何を・なぜ）。
  recordOps: "studytodo:recordops",
  // 削除した学習記録・チャレンジのID（墓標）。
  // 中身は残さないが、IDだけは覚えておく。これが無いと、削除を知らない端末が
  // 同じものをもう一度送ってきたときに復活してしまう。
  deletions: "studytodo:deletions",
  // 1日に使える学習時間（曜日別・日付ごと・今日の残り）。
  availability: "studytodo:availability",
  // 問題別の見積もり指定（本人の指定とAIの仮見積もり）。実績から計算する分は保存しない。
  estimates: "studytodo:estimates",
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
  // 学習記録の追加・訂正の記録。1回に扱える件数と、残しておく件数。
  recordsPerOperation: 50,
  // 覚えておく墓標の数。IDと日時だけなので小さいが、際限なくは増やさない。
  deletionEntries: 5000,
  deletionsPerPush: 200,
  recordOpEntries: 100,
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
const DEFAULT_DELETIONS = { records: {}, challenges: {} };
const DEFAULT_GOALS = { goals: [] };
// masterVersion は「どちらが新しいか」を決める数（ハッシュでは分からない）。
// version は書き換えた回数で、こちらは同期の目安にしか使わない。
const DEFAULT_QUESTIONS = { version: 0, masterVersion: 0, hash: null, updatedAt: null, questions: [] };
const DEFAULT_LOG = { entries: [] };
const DEFAULT_CHANGES = { entries: [] };
const DEFAULT_PLACEMENTS = { tasks: {} };
const DEFAULT_MOVES = { moves: {} };
const DEFAULT_RECORD_OPS = { entries: [] };
const DEFAULT_AVAILABILITY_DOC = { weekly: {}, overrides: {}, todayRemaining: null, reserveMinutes: 0, updatedAt: null };
const DEFAULT_ESTIMATES = { byQuestion: {} };

export function createSyncService({ storage, now = () => Date.now() }) {
  async function readDoc(key, defaults) {
    const stored = await storage.get(key);
    return { ...structuredClone(defaults), ...(stored ?? {}) };
  }

  async function readDeviceIndex() {
    return readDoc(SYNC_KEYS.devices, DEFAULT_DEVICES);
  }

  /**
   * 保存してある学習記録（月ごとに分けて持っている）。
   * 消した記録はそもそも残っていない。古い版で「取り消し」にした記録だけ、ここで外す。
   */
  async function readAllRecords() {
    const keys = await storage.list(SYNC_KEYS.recordsPrefix);
    const shards = await Promise.all(keys.map((key) => readDoc(key, DEFAULT_RECORDS)));
    const records = [];
    for (const shard of shards) {
      for (const record of Object.values(shard.records ?? {})) {
        // 古い版で「取り消し」にした記録がまだ残っていることがある。数えない。
        if (!isCountedRecord(record)) continue;
        records.push(record);
      }
    }
    // 新しい順。日付だけの記録も混ざるので、実施日 → 時刻の順で見る。
    return records.sort((left, right) => (
      String(recordDateOf(right)).localeCompare(String(recordDateOf(left)))
      || String(right.timestamp).localeCompare(String(left.timestamp))
    ));
  }

  /** 1件の記録を id から引く（訂正・削除の対象を確かめるため）。 */
  async function findRecord(recordId) {
    const keys = await storage.list(SYNC_KEYS.recordsPrefix);
    for (const key of keys) {
      const shard = await readDoc(key, DEFAULT_RECORDS);
      const record = shard.records?.[recordId];
      if (record) return { record, key };
    }
    return null;
  }

  async function readChallenges() {
    const document = await readDoc(SYNC_KEYS.challenges, DEFAULT_CHALLENGES);
    return Object.values(document.results ?? {})
      // 古い版で「取り消し」にした回がまだ残っていることがある。数えない。
      .filter((result) => result.voided !== true)
      .sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
  }

  /**
   * 削除した学習記録・チャレンジのID（墓標）。
   *
   * 削除は本当に消す。中身は残さないが、IDと消した日時だけは覚えておく。
   * これが無いと、削除を知らない端末が同じものをもう一度送ってきたときに復活してしまう。
   */
  async function readDeletions() {
    return readDoc(SYNC_KEYS.deletions, DEFAULT_DELETIONS);
  }

  /** 墓標に足す。多くなりすぎたら古いものから落とす。 */
  function addTombstones(document, kind, ids, at) {
    const table = document[kind] ?? (document[kind] = {});
    for (const id of ids) table[id] = at;
    const entries = Object.entries(table);
    if (entries.length > SYNC_LIMITS.deletionEntries) {
      entries.sort((left, right) => String(right[1]).localeCompare(String(left[1])));
      document[kind] = Object.fromEntries(entries.slice(0, SYNC_LIMITS.deletionEntries));
    }
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
  async function writeGoals(incoming = [], { bumpRevision = false } = {}) {
    const at = new Date(now()).toISOString();
    let saved = [];
    const { document } = await updateDocument(storage, SYNC_KEYS.goals, (draft) => {
      const stored = draft.goals ?? [];
      const normalized = incoming.map((goal) => {
        const current = stored.find((entry) => entry.id === goal.id);
        return normalizeStructuredGoal({
          ...goal,
          updatedAt: goal.updatedAt ?? at,
          // 目標そのものにも版を持たせる。計画を作ってから反映するまでに
          // 目標が変わっていないかを、この番号で確かめられる。
          revision: bumpRevision ? Number(current?.revision ?? 0) + 1 : (goal.revision ?? current?.revision ?? 0),
        }, { now: now() });
      }).filter(Boolean);
      saved = normalized;
      draft.goals = mergeGoals(stored, normalized);
    }, { defaults: structuredClone(DEFAULT_GOALS) });
    void saved;
    return document.goals;
  }

  /** 目標全体の版。どれか1つでも変われば増える（計画の作り直しの目安になる）。 */
  async function goalsRevision() {
    const goals = await readGoals({ includeDeleted: true });
    return goals.reduce((sum, goal) => sum + Number(goal.revision ?? 0), 0);
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

  /** 同じ操作IDで、すでに実行された変更があるか。送り直しの見分けに使う。 */
  async function findChangeByOperation(operationId) {
    if (!operationId) return null;
    const document = await readDoc(SYNC_KEYS.changes, DEFAULT_CHANGES);
    return (document.entries ?? []).find((entry) => entry.operationId === operationId) ?? null;
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

  /* ------------------------------------------------------------------ */
  /* 学習可能時間と見積もり                                               */
  /* ------------------------------------------------------------------ */

  /** 1日に使える学習時間の設定。未設定の曜日は null のまま返す。 */
  async function readAvailability() {
    const stored = await storage.get(SYNC_KEYS.availability);
    return normalizeAvailability(stored ?? {});
  }

  /** 設定を書き換える。渡された項目だけを変え、ほかはそのまま残す。 */
  async function writeAvailability(patch = {}, { updatedBy = "app" } = {}) {
    const at = new Date(now()).toISOString();
    const { document } = await updateDocument(storage, SYNC_KEYS.availability, (draft) => {
      const current = normalizeAvailability(draft);
      const next = normalizeAvailability({
        ...current,
        ...patch,
        weekly: { ...current.weekly, ...(patch.weekly ?? {}) },
        overrides: { ...current.overrides, ...(patch.overrides ?? {}) },
        // 上書きを消したいときは、その日に null を渡す。
        updatedAt: at,
        revision: Number(current.revision ?? 0) + 1,
      });
      if (patch.overrides) {
        for (const [date, value] of Object.entries(patch.overrides)) {
          if (value === null) delete next.overrides[date];
        }
      }
      if (patch.todayRemaining === null) next.todayRemaining = null;
      Object.assign(draft, next, { updatedBy });
    }, { defaults: structuredClone(DEFAULT_AVAILABILITY_DOC) });
    return normalizeAvailability(document);
  }

  /** 端末から届いた設定を重ねる（新しいほうを採る）。 */
  async function pushAvailability(incoming) {
    if (!incoming) return { outcome: "ignored" };
    let outcome = "ignored";
    await updateDocument(storage, SYNC_KEYS.availability, (draft) => {
      const merged = mergeAvailability(draft.updatedAt ? draft : null, incoming);
      outcome = merged.outcome;
      if (merged.availability) Object.assign(draft, merged.availability);
    }, { defaults: structuredClone(DEFAULT_AVAILABILITY_DOC) });
    return { outcome };
  }

  /**
   * 問題別の見積もり指定。
   * ここに入るのは「本人が決めた時間」と「AIが教材を見て入れた仮の値」だけで、
   * 実績から計算できる分は保存しない（記録が増えれば計算し直せるため）。
   */
  async function readEstimateEntries() {
    const document = await readDoc(SYNC_KEYS.estimates, DEFAULT_ESTIMATES);
    return document.byQuestion ?? {};
  }

  async function writeEstimateEntries(entries = {}) {
    const at = new Date(now()).toISOString();
    const stamped = {};
    for (const [questionId, entry] of Object.entries(entries)) {
      stamped[questionId] = {
        ...entry,
        ...(entry.manualSeconds !== undefined ? { manualUpdatedAt: entry.manualUpdatedAt ?? at } : {}),
        ...(entry.aiSeconds !== undefined ? { aiUpdatedAt: entry.aiUpdatedAt ?? at } : {}),
      };
    }
    const { document } = await updateDocument(storage, SYNC_KEYS.estimates, (draft) => {
      draft.byQuestion = mergeEstimateEntries(draft.byQuestion ?? {}, stamped);
    }, { defaults: structuredClone(DEFAULT_ESTIMATES) });
    return document.byQuestion;
  }

  /* ------------------------------------------------------------------ */
  /* 学習記録の追加・訂正・取り消し                                       */
  /* ------------------------------------------------------------------ */

  /** 同じ操作IDで、すでに実行された記録の操作があるか（送り直しの見分け）。 */
  async function findRecordOperation(operationId) {
    if (!operationId) return null;
    const document = await readDoc(SYNC_KEYS.recordOps, DEFAULT_RECORD_OPS);
    return (document.entries ?? []).find((entry) => entry.operationId === operationId) ?? null;
  }

  /** 学習記録の操作の履歴（新しい順）。 */
  async function readRecordOperations({ limit = 20 } = {}) {
    const document = await readDoc(SYNC_KEYS.recordOps, DEFAULT_RECORD_OPS);
    const entries = document.entries ?? [];
    return {
      total: entries.length,
      entries: entries.slice(0, Math.max(1, Math.min(limit, SYNC_LIMITS.recordOpEntries))),
    };
  }

  const recordsKeyFor = (record) => SYNC_KEYS.records(recordDateOf(record).slice(0, 7));

  /**
   * 学習記録をまとめて追加・訂正・削除する。
   *
   * ・全部の確認を通ったときだけ書き込む（1つでも通らなければ1件も変えない）
   * ・同じ operationId の送り直しでは、前回の結果を返すだけで二重にならない
   * ・訂正は revision を1つ進め、変更前後を履歴に残す
   * ・削除は本当に消す。消したIDだけを墓標に残し、送り直されても復活させない
   *
   * 実際の中身の確かめ（問題IDが正しいか、日付が未来でないかなど）は、
   * 呼び出し側（study-service）が先に済ませている前提。ここでは保存の正しさだけを見る。
   */
  async function applyRecordOperations({
    operationId,
    fingerprint,
    adds = [],
    updates = [],
    deletes = [],
    deleteChallenges = [],
    actorKind = "ai",
    actorName = "AI",
    tool = "addStudyRecords",
    claimSummary = null,
    reason = null,
  }) {
    const at = new Date(now()).toISOString();

    return runTransaction(storage, async (tx) => {
      const opsDoc = (await tx.get(SYNC_KEYS.recordOps)) ?? structuredClone(DEFAULT_RECORD_OPS);
      const already = (opsDoc.entries ?? []).find((entry) => entry.operationId === operationId);
      if (already) {
        if (already.fingerprint !== fingerprint) {
          return {
            ok: false,
            error: "operation_conflict",
            operationId,
            message: "同じ operationId で、内容の違う操作がすでに実行されています。別の operationId を使ってください。",
            nextAction: "やり直すなら新しい operationId を付け直し、getStudyHistory で今の記録を確かめてください。",
          };
        }
        return { ...already.result, replayed: true };
      }

      // 1. 触る記録を集める（どの月の箱に入っているかも覚えておく）。
      const keys = await tx.list(SYNC_KEYS.recordsPrefix);
      const shards = new Map();
      for (const key of keys) shards.set(key, (await tx.get(key)) ?? structuredClone(DEFAULT_RECORDS));
      const locate = (recordId) => {
        for (const [key, shard] of shards) {
          if (shard.records?.[recordId]) return { key, record: shard.records[recordId] };
        }
        return null;
      };

      // 2. 先に全部確かめる。
      const targets = [...updates, ...deletes];
      for (const target of targets) {
        const found = locate(target.recordId);
        if (!found) {
          return {
            ok: false,
            error: "record_not_found",
            recordId: target.recordId,
            message: `学習記録 ${target.recordId} が見つかりません。`,
            nextAction: "getStudyHistory / getQuestionAttempts で recordId を確かめてください。",
          };
        }
        if (target.expectedRevision !== undefined && target.expectedRevision !== null
          && Number(target.expectedRevision) !== Number(found.record.revision ?? 0)) {
          return {
            ok: false,
            error: "revision_conflict",
            recordId: target.recordId,
            expectedRevision: Number(target.expectedRevision),
            currentRevision: Number(found.record.revision ?? 0),
            message: "その記録は、読み取ったあとに別の場所から変更されています。何も変えていません。",
            nextAction: "getQuestionAttempts で今の内容と revision を取り直してください。",
          };
        }
        // チャレンジの中の記録は、結果（ラップ・合計時間）と地続きである。
        //
        //  ・削除は1件ずつできる。チャレンジ結果そのものは残り、
        //    その1問だけが集計から外れる（総時間は測った事実として残す）。
        //  ・訂正は、結果と食い違わない評価だけ通す。
        if (found.record.challengeId && updates.includes(target)) {
          // source は訂正のたびに付く印なので、中身の変更としては数えない。
          const touched = Object.keys(target.patch ?? {}).filter((key) => key !== "source");
          const allowed = touched.length > 0 && touched.every((key) => key === "evaluation");
          if (!allowed) {
            return {
              ok: false,
              error: "challenge_record",
              recordId: target.recordId,
              challengeId: found.record.challengeId,
              fields: touched.filter((key) => key !== "evaluation"),
              message: "チャレンジの中の記録は、評価だけ直せます（日付や所要時間を変えると、チャレンジ結果の合計と食い違うため）。",
              nextAction: "評価だけを直すか、その1問を消す（deleteStudyRecords）か、チャレンジごと消してください（deleteChallengeResults）。",
            };
          }
        }
        target.found = found;
      }

      // チャレンジ1回ぶんの削除。中で解いた記録もいっしょに消す。
      const challengesDoc = (await tx.get(SYNC_KEYS.challenges)) ?? structuredClone(DEFAULT_CHALLENGES);
      const challengeTargets = new Map();
      for (const target of deleteChallenges) {
        const stored = challengesDoc.results?.[target.challengeId];
        if (!stored) {
          return {
            ok: false,
            error: "challenge_not_found",
            challengeId: target.challengeId,
            message: `チャレンジ ${target.challengeId} が見つかりません。`,
            nextAction: "getChallengeResults で id を確かめてください。",
          };
        }
        challengeTargets.set(target.challengeId, { stored, reason: target.reason ?? reason ?? null });
      }
      const expandedDeletes = [...deletes];
      if (challengeTargets.size) {
        const already = new Set(deletes.map((target) => target.recordId));
        for (const [, shard] of shards) {
          for (const record of Object.values(shard.records ?? {})) {
            if (!record.challengeId || !challengeTargets.has(record.challengeId)) continue;
            if (already.has(record.id)) continue;
            already.add(record.id);
            expandedDeletes.push({
              recordId: record.id,
              reason: challengeTargets.get(record.challengeId).reason,
              found: { key: recordsKeyFor(record), record },
            });
          }
        }
      }

      // 3. 書き込む。
      const put = (record) => {
        const key = recordsKeyFor(record);
        if (!shards.has(key)) shards.set(key, structuredClone(DEFAULT_RECORDS));
        shards.get(key).records[record.id] = record;
      };
      const added = [];
      for (const draft of adds) {
        const record = normalizeStudyRecord({
          ...draft,
          enteredAt: at,
          enteredBy: actorName,
          revision: 0,
          ...(claimSummary ? { claimSummary } : {}),
        }, { receivedAt: now() });
        if (!record) {
          return {
            ok: false,
            error: "invalid_record",
            message: "記録の形が正しくありません（問題IDと実施日が必要です）。何も保存していません。",
          };
        }
        put(record);
        added.push(record);
      }

      const changed = [];
      for (const target of updates) {
        const before = target.found.record;
        const next = normalizeStudyRecord({
          ...before,
          ...target.patch,
          revision: Number(before.revision ?? 0) + 1,
          updatedAt: at,
          corrections: [
            ...(before.corrections ?? []),
            {
              at,
              by: actorName,
              reason: target.reason ?? reason ?? null,
              before: target.beforeSummary ?? {},
              after: target.afterSummary ?? {},
            },
          ],
        }, { receivedAt: now() });
        if (!next) {
          return { ok: false, error: "invalid_record", recordId: target.recordId, message: "訂正後の形が正しくありません。何も保存していません。" };
        }
        // 実施日を直すと、入っている月の箱が変わることがある。古いほうから外す。
        if (target.found.key !== recordsKeyFor(next)) delete shards.get(target.found.key).records[next.id];
        put(next);
        changed.push({ before, after: next });
      }

      // 削除は本当に消す。戻せないので、呼ぶ側で本人の意思を確かめてある前提。
      // 消したIDだけは墓標に残す（削除を知らない端末が送り直しても復活しないように）。
      const deletedRecords = [];
      for (const target of expandedDeletes) {
        const before = target.found.record;
        delete shards.get(target.found.key).records[before.id];
        deletedRecords.push(before);
      }

      const deletedChallenges = [];
      for (const [challengeId, { stored }] of challengeTargets) {
        delete challengesDoc.results[challengeId];
        deletedChallenges.push({
          challengeId,
          timestamp: stored.timestamp,
          questionCount: (stored.laps ?? []).length,
        });
      }

      const deletionsDoc = (await tx.get(SYNC_KEYS.deletions)) ?? structuredClone(DEFAULT_DELETIONS);
      if (deletedRecords.length) addTombstones(deletionsDoc, "records", deletedRecords.map((record) => record.id), at);
      if (deletedChallenges.length) addTombstones(deletionsDoc, "challenges", deletedChallenges.map((entry) => entry.challengeId), at);
      if (deletedRecords.length || deletedChallenges.length) await tx.put(SYNC_KEYS.deletions, deletionsDoc);

      for (const [key, shard] of shards) await tx.put(key, shard);
      if (deletedChallenges.length) await tx.put(SYNC_KEYS.challenges, challengesDoc);

      const result = {
        ok: true,
        operationId,
        at,
        added: added.map(describeRecord),
        updated: changed.map((entry) => describeRecord(entry.after)),
        deleted: deletedRecords.map(describeRecord),
        deletedChallenges,
        counts: {
          added: added.length,
          updated: changed.length,
          deleted: deletedRecords.length,
          deletedChallenges: deletedChallenges.length,
        },
      };

      opsDoc.entries = [{
        operationId,
        fingerprint,
        at,
        actorKind,
        actorName,
        tool,
        reason: reason ?? null,
        claimSummary: claimSummary ?? null,
        result,
        // あとから「何がどう変わったか」を追えるようにしておく。
        changes: [
          ...added.map((record) => ({ recordId: record.id, kind: "add", after: describeRecord(record) })),
          ...changed.map((entry) => ({
            recordId: entry.after.id,
            kind: "update",
            before: describeRecord(entry.before),
            after: describeRecord(entry.after),
          })),
          // 消したものは中身が残らないので、何を消したかだけ履歴に残す。
          ...deletedRecords.map((record) => ({ recordId: record.id, kind: "delete", before: describeRecord(record) })),
          ...deletedChallenges.map((entry) => ({ challengeId: entry.challengeId, kind: "delete_challenge", before: entry })),
        ],
      }, ...(opsDoc.entries ?? [])].slice(0, SYNC_LIMITS.recordOpEntries);
      await tx.put(SYNC_KEYS.recordOps, opsDoc);

      await appendLogTx(tx, {
        clientName: actorName,
        tool,
        summary: `学習記録を${added.length ? `${added.length}件追加` : ""}`
          + `${changed.length ? `${added.length ? "・" : ""}${changed.length}件訂正` : ""}`
          + `${deletedRecords.length ? `${added.length || changed.length ? "・" : ""}${deletedRecords.length}件削除` : ""}`
          + `${deletedChallenges.length ? `（チャレンジ${deletedChallenges.length}回ぶん）` : ""}`
          + `${claimSummary ? `（申告: ${claimSummary}）` : ""}`,
      });

      return result;
    });
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

  /**
   * クラウドに預けてある学習データを、すべて消す。
   *
   * 消すのは学習記録・チャレンジ・予定・目標・繰り越し・変更履歴。
   * 問題マスタ・端末の登録・AI連携の設定は残す（消すと使えなくなってしまうため）。
   * 戻せないので、呼ぶ側で本人の意思を確かめてある前提。
   */
  async function purgeStudyData() {
    const [recordKeys, planKeys] = await Promise.all([
      storage.list(SYNC_KEYS.recordsPrefix),
      storage.list(SYNC_KEYS.taskPlanPrefix),
    ]);
    const keys = [
      ...recordKeys,
      ...planKeys,
      SYNC_KEYS.challenges,
      SYNC_KEYS.goals,
      SYNC_KEYS.moves,
      SYNC_KEYS.changes,
      SYNC_KEYS.placements,
      SYNC_KEYS.recordOps,
      SYNC_KEYS.deletions,
      SYNC_KEYS.availability,
      SYNC_KEYS.estimates,
    ];
    for (const key of keys) await storage.delete(key);
    await appendLog({
      clientName: "設定画面",
      tool: "purgeStudyData",
      summary: `クラウドの学習データをすべて削除（記録${recordKeys.length}か月ぶん・予定${planKeys.length}日ぶん）`,
    });
    return { ok: true, removed: { recordMonths: recordKeys.length, planDays: planKeys.length } };
  }

  return {
    limits: SYNC_LIMITS,
    keys: SYNC_KEYS,
    purgeStudyData,
    readDeletions,
    readAllRecords,
    findRecord,
    applyRecordOperations,
    findRecordOperation,
    readRecordOperations,
    readChallenges,
    readGoals,
    writeGoals,
    goalsRevision,
    readQuestions,
    readTaskPlan,
    readTaskPlansInRange,
    appendLog,
    readLog,
    applyTaskChanges,
    undoTaskChange,
    readChanges,
    findChangeByOperation,
    readMoves,
    saveMoves,
    readAvailability,
    writeAvailability,
    readEstimateEntries,
    writeEstimateEntries,
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

      // 端末で消したもの。先に消してから、送られてきた中身を重ねる。
      // この順でないと、同じ送信の中にある「消したはずのもの」が入り直してしまう。
      const deleteIds = {
        records: (payload.deletions?.records ?? []).filter((id) => typeof id === "string").slice(0, SYNC_LIMITS.deletionsPerPush),
        challenges: (payload.deletions?.challenges ?? []).filter((id) => typeof id === "string").slice(0, SYNC_LIMITS.deletionsPerPush),
      };
      const tombstones = await readDeletions();
      if (deleteIds.records.length || deleteIds.challenges.length) {
        if (deleteIds.records.length) {
          const wanted = new Set(deleteIds.records);
          const keys = await storage.list(SYNC_KEYS.recordsPrefix);
          for (const key of keys) {
            const shard = await readDoc(key, DEFAULT_RECORDS);
            const hit = Object.keys(shard.records ?? {}).filter((id) => wanted.has(id));
            if (!hit.length) continue;
            await updateDocument(storage, key, (document) => {
              for (const id of hit) delete document.records[id];
            }, { defaults: structuredClone(DEFAULT_RECORDS) });
          }
        }
        if (deleteIds.challenges.length) {
          const wanted = new Set(deleteIds.challenges);
          await updateDocument(storage, SYNC_KEYS.challenges, (document) => {
            for (const id of wanted) delete document.results?.[id];
          }, { defaults: structuredClone(DEFAULT_CHALLENGES) });
        }
        await updateDocument(storage, SYNC_KEYS.deletions, (document) => {
          addTombstones(document, "records", deleteIds.records, atIso);
          addTombstones(document, "challenges", deleteIds.challenges, atIso);
        }, { defaults: structuredClone(DEFAULT_DELETIONS) });
        for (const id of deleteIds.records) tombstones.records[id] = atIso;
        for (const id of deleteIds.challenges) tombstones.challenges[id] = atIso;
      }

      // 学習記録は月ごとに分けて預かる。増えても1回の書き込みが重くならない。
      // 訂正や取り消しも届くので、id が同じものは revision の大きいほうを残す
      // （訂正を知らない端末が古い内容を送ってきても、戻らない）。
      const byMonth = new Map();
      let skippedRecords = 0;
      for (const raw of records) {
        const record = normalizeRecord(raw, { receivedAt: at });
        if (!record) { skippedRecords += 1; continue; }
        // 消したものは受け取らない。削除を知らない端末が送り直しても復活させない。
        if (tombstones.records[record.id]) { skippedRecords += 1; continue; }
        const month = recordDateOf(record).slice(0, 7);
        if (!byMonth.has(month)) byMonth.set(month, []);
        byMonth.get(month).push(record);
      }
      let addedRecords = 0;
      let updatedRecords = 0;
      for (const [month, list] of byMonth) {
        await updateDocument(storage, SYNC_KEYS.records(month), (document) => {
          const { merged, added, updated } = mergeRecords(document.records ?? {}, list);
          document.records = merged;
          addedRecords += added;
          updatedRecords += updated;
        }, { defaults: structuredClone(DEFAULT_RECORDS) });
      }

      let addedChallenges = 0;
      const normalizedChallenges = challenges
        .map((raw) => normalizeChallengeResult(raw, { receivedAt: at }))
        .filter(Boolean)
        .filter((result) => !tombstones.challenges[result.id]);
      if (normalizedChallenges.length) {
        await updateDocument(storage, SYNC_KEYS.challenges, (document) => {
          const { merged, added } = mergeChallenges(document.results ?? {}, normalizedChallenges);
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

      // 学習可能時間と見積もりの指定も同期する（どちらも消さずに重ねる）。
      let availabilityOutcome = "ignored";
      if (payload.availability) {
        availabilityOutcome = (await pushAvailability(payload.availability)).outcome;
      }
      let estimatesStored = 0;
      if (payload.estimates && typeof payload.estimates === "object") {
        const entries = Object.entries(payload.estimates).slice(0, 2000);
        if (entries.length) {
          await writeEstimateEntries(Object.fromEntries(entries));
          estimatesStored = entries.length;
        }
      }

      if (goals.length) {
        const incoming = goals.map((goal) => normalizeGoal(goal, { now: at })).filter(Boolean);
        await updateDocument(storage, SYNC_KEYS.goals, (document) => {
          document.goals = mergeGoals(document.goals ?? [], incoming);
        }, { defaults: structuredClone(DEFAULT_GOALS) });
      }

      // 問題マスタは、中身が変わったときだけ入れ替える。同じものは送り直させない。
      let questionsStored = false;
      // 問題マスタは、版（masterVersion）が今より大きいときだけ受け取る。
      //
      // ハッシュは「違う」ことしか言えないので、それだけで置き換えると、
      // 古い問題マスタを持ったままの端末が久しぶりに同期したときに、
      // 新しいマスタを古いほうへ巻き戻してしまう。
      // 版を知らない（この仕組みより前の）端末は 0 として扱うので、
      // 何も送り込めないかわりに、pull で新しいマスタを受け取る。
      let questionsIgnored = null;
      if (payload.questions && Array.isArray(payload.questions.questions)) {
        const list = payload.questions.questions.map(normalizeQuestion).filter(Boolean);
        if (list.length > SYNC_LIMITS.questions) {
          fail(`問題マスタは${SYNC_LIMITS.questions}問までです。`, "questions");
        }
        const hash = await hashQuestions(list);
        const current = await readQuestions();
        const incomingVersion = Math.max(0, Math.floor(Number(payload.questions.masterVersion) || 0));
        const currentVersion = Math.max(0, Math.floor(Number(current.masterVersion) || 0));
        // サーバーに1問も無いときは、版に関わらず受け取る（最初の1台ぶん）。
        const first = !(current.questions ?? []).length;
        if (list.length && hash !== current.hash) {
          if (first || incomingVersion > currentVersion) {
            await updateDocument(storage, SYNC_KEYS.questions, (document) => {
              document.questions = list;
              document.hash = hash;
              document.masterVersion = Math.max(incomingVersion, currentVersion);
              document.version = Number(document.version ?? 0) + 1;
              document.updatedAt = atIso;
            }, { defaults: structuredClone(DEFAULT_QUESTIONS) });
            questionsStored = true;
          } else {
            // 送ってきたほうが古い。受け取らず、pull で新しいマスタを返す。
            questionsIgnored = {
              reason: "older_master",
              sentMasterVersion: incomingVersion,
              currentMasterVersion: currentVersion,
              message: "送られた問題マスタのほうが古いので受け取りませんでした。この端末には新しいマスタを配ります。",
            };
          }
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
          updatedRecords,
          duplicatedRecords: records.length - addedRecords - skippedRecords,
          invalidRecords: skippedRecords,
          challenges: addedChallenges,
          taskPlans: planOutcomes,
          moves: addedMoves,
          duplicatedMoves: moves.length - addedMoves,
          availability: availabilityOutcome,
          estimates: estimatesStored,
          goals: goals.length,
        },
        questionsStored,
        // 古いマスタを送ってきたときは、その旨を返す（端末側で気づけるように）。
        ...(questionsIgnored ? { questionsIgnored } : {}),
      };
    },

    /**
     * サーバーにあるいまの内容を返す。
     * since（ミリ秒）を渡すと、それ以降に預かった学習記録だけを返す。
     */
    async pull({ since = null, questionsHash = null, timezoneOffsetMinutes } = {}) {
      const today = todayKeyOf(timezoneOffsetMinutes, now());
      const [allRecords, challenges, goals, questions, index, deletions] = await Promise.all([
        readAllRecords(),
        readChallenges(),
        readGoals({ includeDeleted: true }),
        readQuestions(),
        readDeviceIndex(),
        // 消したもののID。端末側でも消えるようにするため、これも配る。
        readDeletions(),
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
        // 消したもののID。端末はこれを見て、手元からも消す。
        deletions: {
          records: Object.entries(deletions.records ?? {})
            .filter(([, at]) => sinceMs === null || Date.parse(at) > sinceMs)
            .map(([id]) => id),
          challenges: Object.entries(deletions.challenges ?? {})
            .filter(([, at]) => sinceMs === null || Date.parse(at) > sinceMs)
            .map(([id]) => id),
        },
        // 繰り越しの記録も配る（追加専用なので、重ねても増えない）。
        moves: (await readMoves({ limit: SYNC_LIMITS.movesPerPull })).moves,
        availability: await readAvailability(),
        // 見積もりの「指定」だけを配る。実績から計算できる分は配らない。
        estimates: await readEstimateEntries(),
        goals,
        questions: {
          version: questions.version,
          masterVersion: Math.max(0, Math.floor(Number(questions.masterVersion) || 0)),
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
