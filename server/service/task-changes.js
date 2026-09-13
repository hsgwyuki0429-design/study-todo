// 予定を「タスク単位で」安全に書き換えるための、純粋な処理だけを集めたところ。
//
// ここには保存も通信も出てこない。渡された予定（TaskPlan）の写しに対して、
// 変更をぜんぶ確かめてから、まとめて適用する。保存先の都合はここには持ち込まない。
//
// いちばん大事な約束:
//
//   1. タスクのIDは、作るときにだけ発行する。編集しても日をまたいで移しても変わらない。
//   2. 指定されなかったタスクと項目は、そのまま残す。
//   3. どれか1つでも通らなければ、1つも変更しない（全部成功か、全部未反映か）。
//   4. 完了済み・実行中・固定のタスクは、AIからは変えられない。
//
// 「実行中」はサーバーが知っている範囲でしか分からない。端末が圏外のときは
// 届かないので、この保護は完全ではない（docs/mcp.md に限界を書いてある）。

import { TASK_KINDS } from "./merge.js";
import {
  fail,
  readArray,
  readEnum,
  readInteger,
  readString,
  rejectUnknownKeys,
} from "../core/validate.js";
import { isDateKey } from "../../src/datetime.js";
import { MOVE_KINDS, MOVE_REASONS, itemsOf, newItemId, reconcileItems } from "../../src/plan-items.js";

export const CHANGE_OPS = Object.freeze(["add", "update", "remove", "move", "reorder", "carryOver"]);

export const CHANGE_LIMITS = Object.freeze({
  changesPerRequest: 50,
  datesPerRequest: 31,
  tasksPerDay: 50,
  questionIdsPerTask: 100,
  operationIdLength: 120,
  reasonLength: 400,
});

/** タスクを守る理由。AIにはこの名前のまま返し、次に何をすべきか分かるようにする。 */
export const PROTECTION = Object.freeze({
  completed: "completed",
  running: "running",
  pinned: "pinned",
});

const PROTECTION_MESSAGES = Object.freeze({
  completed: "すでに終わったタスクなので変更できません。",
  running: "いま取り組んでいるタスクなので変更できません。",
  pinned: "利用者が固定したタスクなので変更できません。固定を外せるのは利用者だけです。",
});

/** 何も無い日の予定。保存されていない日は「版0の空の予定」として扱う。 */
export function emptyPlan(date) {
  return { date, tasks: [], revision: 0, updatedAt: null, updatedBy: null };
}

export const planRevisionOf = (plan) => Number(plan?.revision ?? 0);

/** その端末が「いま解いている」と知らせてきた状態が、まだ有効か。 */
export function activeStateOf(plan, now) {
  const active = plan?.active;
  if (!active || !active.taskId) return null;
  const expiresAt = Date.parse(active.expiresAt ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  return active;
}

/** そのタスクが守られているか（AIから変えられないか）。守られていなければ null。 */
export function protectionOf(task, plan, now) {
  if (task?.completed) return PROTECTION.completed;
  if (task?.pinned) return PROTECTION.pinned;
  if (activeStateOf(plan, now)?.taskId === task?.id) return PROTECTION.running;
  return null;
}

export const protectionMessage = (reason) => PROTECTION_MESSAGES[reason] ?? "このタスクは変更できません。";

/* ------------------------------------------------------------------ */
/* 入力の確認                                                          */
/* ------------------------------------------------------------------ */

const TASK_FIELDS = ["questionIds", "kind", "title", "timeLimitSeconds", "position", "goalId"];
const PATCH_FIELDS = ["questionIds", "kind", "title", "timeLimitSeconds", "position", "goalId"];

function readTaskId(value, field) {
  return readString(value, field, { required: true, max: 80 });
}

function readDate(value, field, { required = true } = {}) {
  const text = readString(value, field, { required, max: 10 });
  if (text === null) return null;
  if (!isDateKey(text)) fail(`${field} は 2026-09-12 のような日付で渡してください。`, field);
  return text;
}

function readQuestionIds(value, field) {
  return readArray(value, field, { max: CHANGE_LIMITS.questionIdsPerTask })
    .map((id, index) => readString(id, `${field}[${index}]`, { required: true, max: 120 }));
}

function readTaskBody(raw, field, { partial = false } = {}) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`${field} はオブジェクトで渡してください。`, field);
  }
  rejectUnknownKeys(raw, partial ? PATCH_FIELDS : TASK_FIELDS, field);
  const body = {};
  if (raw.questionIds !== undefined) body.questionIds = readQuestionIds(raw.questionIds, `${field}.questionIds`);
  if (raw.kind !== undefined) body.kind = readEnum(raw.kind, `${field}.kind`, [...TASK_KINDS], { required: true });
  if (raw.title !== undefined) {
    body.title = raw.title === null || raw.title === "" ? "" : readString(raw.title, `${field}.title`, { max: 120 });
  }
  if (raw.timeLimitSeconds !== undefined) {
    body.timeLimitSeconds = raw.timeLimitSeconds === null
      ? null
      : readInteger(raw.timeLimitSeconds, `${field}.timeLimitSeconds`, { min: 60, max: 6 * 3600, required: true });
  }
  if (raw.position !== undefined) {
    body.position = readInteger(raw.position, `${field}.position`, { min: 0, max: CHANGE_LIMITS.tasksPerDay });
  }
  if (raw.goalId !== undefined) {
    body.goalId = raw.goalId === null || raw.goalId === "" ? null : readString(raw.goalId, `${field}.goalId`, { max: 80 });
  }
  if (!partial) {
    const questionIds = body.questionIds ?? [];
    if (!questionIds.length && !body.title) {
      fail(`${field} には questionIds か title のどちらかが必要です。`, field);
    }
  } else if (!Object.keys(body).length) {
    fail(`${field} には変えたい項目を1つ以上入れてください。`, field);
  }
  return body;
}

/** MCP から届いた一括変更の要求を確かめる。ここを通れば形は正しい。 */
export function parseChangeRequest(args = {}) {
  const operationId = readString(args.operationId, "operationId", {
    required: true, max: CHANGE_LIMITS.operationIdLength,
  });
  const reason = readString(args.reason, "reason", { max: CHANGE_LIMITS.reasonLength }) ?? "";

  const expected = readArray(args.expectedRevisions, "expectedRevisions", {
    min: 1, max: CHANGE_LIMITS.datesPerRequest,
  });
  const expectedRevisions = new Map();
  expected.forEach((entry, index) => {
    const field = `expectedRevisions[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail(`${field} は { date, revision } の形で渡してください。`, field);
    }
    rejectUnknownKeys(entry, ["date", "revision"], field);
    const date = readDate(entry.date, `${field}.date`);
    const revision = readInteger(entry.revision, `${field}.revision`, { required: true, min: 0 });
    if (expectedRevisions.has(date)) fail(`${field}.date が重複しています（${date}）。`, field);
    expectedRevisions.set(date, revision);
  });

  const rawChanges = readArray(args.changes, "changes", { min: 1, max: CHANGE_LIMITS.changesPerRequest });
  const changes = rawChanges.map((raw, index) => {
    const field = `changes[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      fail(`${field} はオブジェクトで渡してください。`, field);
    }
    const op = readEnum(raw.op, `${field}.op`, [...CHANGE_OPS], { required: true });
    if (op === "add") {
      rejectUnknownKeys(raw, ["op", "date", "task", "tempId"], field);
      return {
        op,
        date: readDate(raw.date, `${field}.date`),
        tempId: readString(raw.tempId, `${field}.tempId`, { max: 80 }),
        task: readTaskBody(raw.task ?? {}, `${field}.task`),
      };
    }
    if (op === "update") {
      rejectUnknownKeys(raw, ["op", "taskId", "date", "patch"], field);
      return {
        op,
        taskId: readTaskId(raw.taskId, `${field}.taskId`),
        date: readDate(raw.date, `${field}.date`, { required: false }),
        patch: readTaskBody(raw.patch ?? {}, `${field}.patch`, { partial: true }),
      };
    }
    if (op === "remove") {
      rejectUnknownKeys(raw, ["op", "taskId", "date"], field);
      return {
        op,
        taskId: readTaskId(raw.taskId, `${field}.taskId`),
        date: readDate(raw.date, `${field}.date`, { required: false }),
      };
    }
    if (op === "move") {
      rejectUnknownKeys(raw, ["op", "taskId", "fromDate", "toDate", "position", "reason", "reasonNote", "kind"], field);
      return {
        op,
        taskId: readTaskId(raw.taskId, `${field}.taskId`),
        fromDate: readDate(raw.fromDate, `${field}.fromDate`, { required: false }),
        toDate: readDate(raw.toDate, `${field}.toDate`),
        position: raw.position === undefined ? null
          : readInteger(raw.position, `${field}.position`, { min: 0, max: CHANGE_LIMITS.tasksPerDay }),
        reason: readEnum(raw.reason, `${field}.reason`, [...MOVE_REASONS], { fallback: "unspecified" }),
        reasonNote: readString(raw.reasonNote, `${field}.reasonNote`, { max: 200 }),
        kind: readEnum(raw.kind, `${field}.kind`, [...MOVE_KINDS], { fallback: "reschedule" }),
      };
    }
    if (op === "carryOver") {
      rejectUnknownKeys(raw, ["op", "taskId", "fromDate", "toDate", "itemIds", "reason", "reasonNote", "kind"], field);
      return {
        op,
        taskId: readTaskId(raw.taskId, `${field}.taskId`),
        fromDate: readDate(raw.fromDate, `${field}.fromDate`, { required: false }),
        toDate: readDate(raw.toDate, `${field}.toDate`),
        itemIds: raw.itemIds === undefined || raw.itemIds === null
          ? null
          : readArray(raw.itemIds, `${field}.itemIds`, { min: 1, max: CHANGE_LIMITS.questionIdsPerTask })
            .map((id, position) => readString(id, `${field}.itemIds[${position}]`, { required: true, max: 120 })),
        // 理由は任意。渡されなければ「未入力」のまま残す（推測を事実にしない）。
        reason: readEnum(raw.reason, `${field}.reason`, [...MOVE_REASONS], { fallback: "unspecified" }),
        reasonNote: readString(raw.reasonNote, `${field}.reasonNote`, { max: 200 }),
        kind: readEnum(raw.kind, `${field}.kind`, [...MOVE_KINDS], { fallback: "carry_over" }),
      };
    }
    rejectUnknownKeys(raw, ["op", "date", "taskIds"], field);
    return {
      op,
      date: readDate(raw.date, `${field}.date`),
      taskIds: readArray(raw.taskIds, `${field}.taskIds`, { min: 1, max: CHANGE_LIMITS.tasksPerDay })
        .map((id, position) => readTaskId(id, `${field}.taskIds[${position}]`)),
    };
  });

  return { operationId, reason, expectedRevisions, changes };
}

/** 同じ操作IDで内容だけ違う要求を見分けるための指紋。 */
export function fingerprintOf(request) {
  return JSON.stringify({
    expected: [...request.expectedRevisions.entries()].sort(),
    changes: request.changes,
  });
}

/* ------------------------------------------------------------------ */
/* 適用                                                                */
/* ------------------------------------------------------------------ */

const conflict = (error, extra) => ({ ok: false, error, ...extra });

const clone = (plan) => structuredClone(plan);

function renumber(plan) {
  plan.tasks.forEach((task, index) => { task.order = index; });
  return plan;
}

function insertAt(plan, task, position) {
  const index = position === null || position === undefined
    ? plan.tasks.length
    : Math.max(0, Math.min(position, plan.tasks.length));
  plan.tasks.splice(index, 0, task);
  renumber(plan);
}

function applyBody(task, body, at) {
  if (body.goalId !== undefined) {
    task.goalId = body.goalId;
    // 予定項目にも目標を書き入れる。繰り越しで別のタスクへ分かれても結び付きが切れない。
    task.items = (task.items ?? []).map((item) => ({ ...item, goalId: body.goalId }));
  }
  if (body.questionIds !== undefined) {
    // 問題を入れ替えても、残る問題の予定項目のIDは引き継ぐ
    // （実績との対応が切れないように）。
    task.items = reconcileItems(task, [...body.questionIds]);
    task.questionIds = task.items.map((item) => item.questionId);
  }
  if (body.kind !== undefined) task.kind = body.kind;
  if (body.title !== undefined) {
    if (body.title) task.title = body.title;
    else delete task.title;
  }
  if (body.timeLimitSeconds !== undefined) {
    if (body.timeLimitSeconds === null) delete task.timeLimitSeconds;
    else task.timeLimitSeconds = body.timeLimitSeconds;
  }
  task.updatedAt = at;
  return task;
}

/**
 * 変更をまとめて適用する。
 *
 *   plans        … 日付 → 予定（保存されていない日は含めなくてよい）
 *   request      … parseChangeRequest を通したもの
 *   actorKind    … "ai" なら保護されたタスクに触れない。"user" は端末の操作。
 *   knownQuestionIds … 問題マスタにあるID。空の Set を渡すと確認しない。
 *
 * 戻り値は { ok: true, plans, summary } か、{ ok: false, error, ... }。
 * ok が false のときは plans を一切変えていない。
 */
export function applyChanges({
  plans = {},
  request,
  now = Date.now(),
  actorKind = "ai",
  updatedBy = "ai",
  knownQuestionIds = null,
  // すでに実施された予定項目（学習記録がある itemId）。繰り越しの対象から外す。
  doneItemIds = null,
  newId = () => `task_${Math.random().toString(36).slice(2, 10)}`,
}) {
  const at = new Date(now).toISOString();
  const dates = [...request.expectedRevisions.keys()];

  // 1. 版の確認。1日でも食い違えば、何も変えない。
  const revisionConflicts = [];
  for (const [date, expected] of request.expectedRevisions) {
    const current = planRevisionOf(plans[date]);
    if (current !== expected) revisionConflicts.push({ date, expectedRevision: expected, currentRevision: current });
  }
  if (revisionConflicts.length) {
    return conflict("revision_conflict", {
      conflicts: revisionConflicts,
      message: "渡された revision が、保存されている予定と食い違っています。ほかの端末かAIが先に変更しています。",
      nextAction: "getTasksInRange で今の予定と revision を取り直し、必要な変更だけを組み立て直してください。",
    });
  }

  // 2. 写しを作る。ここから先は写しだけを触る。
  const draft = {};
  for (const date of dates) draft[date] = clone(plans[date] ?? emptyPlan(date));

  const locate = (taskId, date) => {
    if (date) {
      const task = (draft[date]?.tasks ?? []).find((entry) => entry.id === taskId);
      return task ? { date, task } : null;
    }
    for (const key of dates) {
      const task = draft[key].tasks.find((entry) => entry.id === taskId);
      if (task) return { date: key, task };
    }
    return null;
  };

  // 3. 変更を1つずつ確かめながら、写しへ適用していく。
  //    途中で断ったときは写しを捨てるだけなので、保存されている予定は変わらない。
  //    （確かめるのと適用するのを2周に分けると、同じ要求の中で移したタスクを
  //      さらに編集するような並びを、正しく確かめられない。）
  const snapshot = {};
  for (const date of dates) snapshot[date] = clone(plans[date] ?? emptyPlan(date));

  const touched = new Set();
  const created = [];
  const removed = [];
  const updated = [];
  const moved = [];
  const moveEvents = [];

  for (let index = 0; index < request.changes.length; index += 1) {
    const change = request.changes[index];
    const where = `changes[${index}]`;

    const needDate = (date) => {
      if (!request.expectedRevisions.has(date)) {
        return conflict("missing_revision", {
          date,
          message: `${date} の expectedRevision が渡されていません。変更するすべての日（移動元と移動先を含む）の revision が必要です。`,
          nextAction: "getTasksInRange でその日の revision を取得し、expectedRevisions に足してください。",
        });
      }
      return null;
    };

    const checkQuestions = (ids) => {
      if (!knownQuestionIds || !knownQuestionIds.size) return null;
      const unknown = ids.filter((id) => !knownQuestionIds.has(id));
      if (!unknown.length) return null;
      return conflict("unknown_question", {
        where,
        unknownQuestionIds: unknown,
        message: "問題マスタに無い問題IDが含まれています。予定は変更していません。",
        nextAction: "listQuestions / searchQuestions で正しい question.id を確かめてください。",
      });
    };

    if (change.op === "add") {
      const missing = needDate(change.date);
      if (missing) return missing;
      const unknown = checkQuestions(change.task.questionIds ?? []);
      if (unknown) return unknown;
      if (draft[change.date].tasks.length >= CHANGE_LIMITS.tasksPerDay) {
        return conflict("invalid_change", {
          where,
          message: `${change.date} の予定は${CHANGE_LIMITS.tasksPerDay}件までです。`,
        });
      }
      const task = applyBody({
        id: newId(),
        questionIds: [],
        items: [],
        kind: "new",
        order: 0,
        completed: false,
        pinned: false,
        createdAt: at,
        source: actorKind,
      }, change.task, at);
      // 当初の予定日は、作った日のまま（あとで繰り越しても変えない）。
      task.items = task.items.map((item) => ({
        ...item,
        originalDate: change.date,
        goalId: change.task.goalId ?? item.goalId ?? null,
      }));
      insertAt(draft[change.date], task, change.task.position ?? null);
      created.push({ date: change.date, taskId: task.id, tempId: change.tempId ?? null });
      touched.add(change.date);
      continue;
    }

    if (change.op === "reorder") {
      const missing = needDate(change.date);
      if (missing) return missing;
      const plan = draft[change.date];
      const current = plan.tasks.map((task) => task.id).sort();
      const given = [...change.taskIds].sort();
      if (current.length !== given.length || current.some((id, position) => id !== given[position])) {
        return conflict("invalid_change", {
          where,
          message: `${change.date} の並べ替えには、その日のタスクIDを過不足なく並べてください。`,
          currentTaskIds: plan.tasks.map((task) => task.id),
        });
      }
      if (actorKind === "ai") {
        // 守られているタスクは、並べ替えでも位置を動かせない。
        for (let position = 0; position < plan.tasks.length; position += 1) {
          const task = plan.tasks[position];
          const reason = protectionOf(task, plan, now);
          if (reason && change.taskIds[position] !== task.id) {
            return conflict("protected_task", {
              where,
              taskId: task.id,
              date: change.date,
              protection: reason,
              message: protectionMessage(reason),
              nextAction: "守られているタスクは今の位置のままにして、並べ替えをやり直してください。",
            });
          }
        }
      }
      const byId = new Map(plan.tasks.map((task) => [task.id, task]));
      plan.tasks = change.taskIds.map((id) => byId.get(id));
      renumber(plan);
      updated.push({ date: change.date, taskId: null, field: "order" });
      touched.add(change.date);
      continue;
    }

    if (change.op === "carryOver") {
      const missingTo = needDate(change.toDate);
      if (missingTo) return missingTo;
      const found = locate(change.taskId, change.fromDate);
      if (!found) {
        return conflict("task_not_found", {
          where,
          taskId: change.taskId,
          message: `タスク ${change.taskId} が見つかりません。日付が違うか、すでに消されています。`,
          nextAction: "getTasksInRange で今のタスクIDを取り直してください。",
        });
      }
      const missingFrom = needDate(found.date);
      if (missingFrom) return missingFrom;
      if (found.date === change.toDate) {
        return conflict("invalid_change", { where, message: "移動元と移動先が同じ日です。" });
      }
      if (actorKind === "ai") {
        const reason = protectionOf(found.task, draft[found.date], now);
        if (reason) {
          return conflict("protected_task", {
            where, taskId: change.taskId, date: found.date, protection: reason,
            message: protectionMessage(reason),
            nextAction: "このタスクはそのままにして、ほかのタスクで調整してください。",
          });
        }
      }

      const done = doneItemIds ?? new Set();
      const all = itemsOf(found.task);
      const pending = all.filter((item) => !done.has(item.itemId));
      const wanted = change.itemIds
        ? change.itemIds.map((itemId) => all.find((item) => item.itemId === itemId) ?? { itemId, missing: true })
        : pending;
      const missingItem = wanted.find((item) => item.missing);
      if (missingItem) {
        return conflict("item_not_found", {
          where,
          itemId: missingItem.itemId,
          taskId: found.task.id,
          date: found.date,
          message: `予定項目 ${missingItem.itemId} が ${found.date} のタスク ${found.task.id} にありません。`,
          nextAction: "getTasksInRange で今の itemId を取り直してください。",
        });
      }
      const alreadyDone = wanted.filter((item) => done.has(item.itemId));
      if (alreadyDone.length) {
        return conflict("already_done", {
          where,
          itemIds: alreadyDone.map((item) => item.itemId),
          date: found.date,
          message: "すでに取り組んだ予定は動かせません（実績はその日に残します）。未実施の分だけを指定してください。",
          nextAction: "getUnfinishedPlanItems か getTasksInRange の pending を見て、未実施の itemId だけを渡してください。",
        });
      }
      if (!wanted.length) {
        return conflict("nothing_to_carry_over", {
          where,
          taskId: found.task.id,
          date: found.date,
          message: "未実施の予定がありません（すべて実施済みです）。",
        });
      }

      const carried = wanted.map((item) => ({ ...item, carriedCount: (item.carriedCount ?? 0) + 1 }));
      const carriedIds = new Set(carried.map((item) => item.itemId));
      const keep = all.filter((item) => !carriedIds.has(item.itemId));
      const source = draft[found.date].tasks.find((entry) => entry.id === found.task.id);

      if (keep.length) {
        // 一部だけ動かす。実施済みの分は元の日に残す。
        source.items = keep;
        source.questionIds = keep.map((item) => item.questionId);
        source.updatedAt = at;
        updated.push({ date: found.date, taskId: source.id, field: "items" });
      } else {
        const position = draft[found.date].tasks.findIndex((entry) => entry.id === source.id);
        draft[found.date].tasks.splice(position, 1);
        renumber(draft[found.date]);
        removed.push({ date: found.date, taskId: source.id });
      }

      if (draft[change.toDate].tasks.length >= CHANGE_LIMITS.tasksPerDay) {
        return conflict("invalid_change", {
          where,
          message: `${change.toDate} の予定は${CHANGE_LIMITS.tasksPerDay}件までです。`,
        });
      }
      const carriedTask = {
        id: newId(),
        items: carried,
        questionIds: carried.map((item) => item.questionId),
        kind: found.task.kind,
        order: 0,
        completed: false,
        pinned: false,
        ...(found.task.timeLimitSeconds ? { timeLimitSeconds: found.task.timeLimitSeconds } : {}),
        ...(found.task.title ? { title: found.task.title } : {}),
        ...(found.task.goalId ? { goalId: found.task.goalId } : {}),
        createdAt: at,
        updatedAt: at,
        source: actorKind,
        // どのタスクから繰り越されたか。
        carriedFrom: { taskId: found.task.id, date: found.date },
      };
      insertAt(draft[change.toDate], carriedTask, null);
      created.push({ date: change.toDate, taskId: carriedTask.id, tempId: null, carriedFrom: found.date });
      moveEvents.push({
        fromDate: found.date,
        toDate: change.toDate,
        taskId: found.task.id,
        toTaskId: carriedTask.id,
        kind: change.kind ?? "carry_over",
        reason: change.reason ?? "unspecified",
        reasonNote: change.reasonNote ?? null,
        items: carried,
      });
      touched.add(found.date);
      touched.add(change.toDate);
      continue;
    }

    // update / remove / move はタスクを探すところから。
    const found = locate(change.taskId, change.op === "move" ? change.fromDate : change.date);
    if (!found) {
      return conflict("task_not_found", {
        where,
        taskId: change.taskId,
        searchedDates: change.date || change.fromDate ? [change.date ?? change.fromDate] : dates,
        message: `タスク ${change.taskId} が見つかりません。日付が違うか、すでに消されています。`,
        nextAction: "getTasksInRange で今のタスクIDを取り直してください。",
      });
    }
    const missing = needDate(found.date);
    if (missing) return missing;

    if (actorKind === "ai") {
      const reason = protectionOf(found.task, draft[found.date], now);
      if (reason) {
        return conflict("protected_task", {
          where,
          taskId: change.taskId,
          date: found.date,
          protection: reason,
          message: protectionMessage(reason),
          nextAction: reason === "pinned"
            ? "利用者に固定を外してもらうか、ほかのタスクで調整してください。"
            : "このタスクはそのままにして、ほかのタスクで調整してください。",
        });
      }
    }

    const plan = draft[found.date];
    const position = plan.tasks.findIndex((task) => task.id === change.taskId);
    const task = plan.tasks[position];

    if (change.op === "update") {
      const unknown = checkQuestions(change.patch.questionIds ?? []);
      if (unknown) return unknown;
      const questionIds = change.patch.questionIds ?? task.questionIds ?? [];
      const title = change.patch.title !== undefined ? change.patch.title : task.title;
      if (!questionIds.length && !title) {
        return conflict("invalid_change", {
          where,
          message: "questionIds を空にするなら title が必要です。",
        });
      }
      applyBody(task, change.patch, at);
      if (change.patch.position !== undefined && change.patch.position !== null) {
        plan.tasks.splice(position, 1);
        insertAt(plan, task, change.patch.position);
      }
      updated.push({ date: found.date, taskId: task.id });
      touched.add(found.date);
      continue;
    }

    if (change.op === "remove") {
      plan.tasks.splice(position, 1);
      renumber(plan);
      removed.push({ date: found.date, taskId: task.id });
      touched.add(found.date);
      continue;
    }

    // move
    const missingTo = needDate(change.toDate);
    if (missingTo) return missingTo;
    if (change.toDate !== found.date && draft[change.toDate].tasks.length >= CHANGE_LIMITS.tasksPerDay) {
      return conflict("invalid_change", {
        where,
        message: `${change.toDate} の予定は${CHANGE_LIMITS.tasksPerDay}件までです。`,
      });
    }
    plan.tasks.splice(position, 1);
    renumber(plan);
    task.updatedAt = at;
    const movedItems = itemsOf(task).map((item) => ({ ...item }));
    if (change.toDate !== found.date) {
      // 実施済みの記録は実施日に残る。動くのは「これからやる予定」だけ。
      task.items = movedItems.map((item) => ({ ...item, carriedCount: (item.carriedCount ?? 0) + 1 }));
      task.questionIds = task.items.map((item) => item.questionId);
    }
    insertAt(draft[change.toDate], task, change.position);
    moved.push({ taskId: task.id, from: found.date, to: change.toDate });
    if (change.toDate !== found.date) {
      moveEvents.push({
        fromDate: found.date,
        toDate: change.toDate,
        taskId: task.id,
        toTaskId: task.id,
        kind: change.kind ?? "reschedule",
        reason: change.reason ?? "unspecified",
        reasonNote: change.reasonNote ?? null,
        items: movedItems,
      });
    }
    touched.add(found.date);
    touched.add(change.toDate);
  }

  const before = {};
  for (const date of touched) before[date] = snapshot[date];

  // 5. 触った日だけ版を進める。触っていない日はそのまま。
  const after = {};
  const revisions = {};
  for (const date of touched) {
    const plan = draft[date];
    plan.revision = planRevisionOf(plans[date]) + 1;
    plan.updatedAt = at;
    plan.updatedBy = updatedBy;
    after[date] = clone(plan);
    revisions[date] = plan.revision;
  }

  return {
    ok: true,
    plans: Object.fromEntries([...touched].map((date) => [date, draft[date]])),
    before,
    after,
    revisions,
    summary: {
      dates: [...touched].sort(),
      created,
      removed,
      updated,
      moved,
      carriedOver: moveEvents.filter((event) => event.kind === "carry_over").length,
    },
    moves: moveEvents,
  };
}

/**
 * 記録しておいた変更を打ち消す変更を作る。
 * 「変更前へ丸ごと戻す」のではなく、その変更が触ったタスクだけを戻す。
 * 触ったあとで学習が進んだり、別の変更が入ったタスクは戻さずに競合として返す。
 */
export function buildUndoChanges(record, currentPlans, { now = Date.now() } = {}) {
  const blocked = [];
  const changes = [];
  const dates = new Set([...Object.keys(record.before ?? {}), ...Object.keys(record.after ?? {})]);

  const taskIn = (plans, date, taskId) => (plans[date]?.tasks ?? []).find((task) => task.id === taskId) ?? null;
  const same = (left, right) => {
    if (!left || !right) return false;
    const pick = (task) => JSON.stringify({
      questionIds: task.questionIds ?? [],
      kind: task.kind,
      title: task.title ?? "",
      timeLimitSeconds: task.timeLimitSeconds ?? null,
    });
    return pick(left) === pick(right);
  };

  const beforeTasks = new Map();
  for (const date of dates) {
    for (const task of record.before?.[date]?.tasks ?? []) beforeTasks.set(task.id, { date, task });
  }
  const afterTasks = new Map();
  for (const date of dates) {
    for (const task of record.after?.[date]?.tasks ?? []) afterTasks.set(task.id, { date, task });
  }

  // 追加されたタスク → 消す（そのあと手が付いていなければ）。
  for (const [taskId, entry] of afterTasks) {
    if (beforeTasks.has(taskId)) continue;
    const current = taskIn(currentPlans, entry.date, taskId);
    if (!current) continue; // すでに無い。戻すものが無いので放っておく。
    const protection = protectionOf(current, currentPlans[entry.date], now);
    if (protection) { blocked.push({ taskId, date: entry.date, reason: protection }); continue; }
    if (!same(current, entry.task)) { blocked.push({ taskId, date: entry.date, reason: "changed_since" }); continue; }
    changes.push({ op: "remove", taskId, date: entry.date });
  }

  for (const [taskId, entry] of beforeTasks) {
    const afterEntry = afterTasks.get(taskId);
    if (!afterEntry) {
      // 消されたタスク → 元の日へ作り直す。IDは新しくなるため、その旨を返す。
      changes.push({
        op: "add",
        date: entry.date,
        tempId: `restored_${taskId}`,
        task: {
          questionIds: entry.task.questionIds ?? [],
          kind: entry.task.kind,
          ...(entry.task.title ? { title: entry.task.title } : {}),
          ...(entry.task.timeLimitSeconds ? { timeLimitSeconds: entry.task.timeLimitSeconds } : {}),
          position: entry.task.order ?? 0,
        },
      });
      continue;
    }
    const current = taskIn(currentPlans, afterEntry.date, taskId);
    if (!current) { blocked.push({ taskId, date: afterEntry.date, reason: "missing_now" }); continue; }
    const protection = protectionOf(current, currentPlans[afterEntry.date], now);
    if (protection) { blocked.push({ taskId, date: afterEntry.date, reason: protection }); continue; }
    if (!same(current, afterEntry.task)) { blocked.push({ taskId, date: afterEntry.date, reason: "changed_since" }); continue; }
    if (afterEntry.date !== entry.date) {
      changes.push({ op: "move", taskId, fromDate: afterEntry.date, toDate: entry.date, position: entry.task.order ?? null });
    }
    if (!same(current, entry.task)) {
      changes.push({
        op: "update",
        taskId,
        date: entry.date,
        patch: {
          questionIds: entry.task.questionIds ?? [],
          kind: entry.task.kind,
          title: entry.task.title ?? "",
          timeLimitSeconds: entry.task.timeLimitSeconds ?? null,
        },
      });
    }
  }

  return { changes, blocked, dates: [...dates].sort() };
}
