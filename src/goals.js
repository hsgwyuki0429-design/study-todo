// 目標を「計算できるデータ」として扱うための、PWAとサーバーで共有する純粋な処理。
//
// 目標は「何を・いつまでに・どの状態まで」を持つ。
//
//   何を   … 対象の問題ID一覧（questionIds）。作るときに確定させる。
//            条件（教科・章・単元・種類・コース）で選んでも、保存するのはID一覧である。
//            こうしないと、問題マスタを入れ替えたときに対象が黙って変わってしまう。
//   いつまで … deadline（空なら期限なし）。startDate から数える。
//   どの状態まで … completion（達成条件）。
//
// 達成条件は2種類。
//
//   attempt（取り組む）… 対象の問題に、この目標のために1回ずつ取り組めば達成。
//                        評価が不正解でも「取り組んだ」として数える。
//   mastery（習得する）… 対象の問題が、決めた評価（既定は perfect）になっていれば達成。
//                        判定は「この目標に関連する **最新** の記録」で行う（latest 方式）。
//                        「一度でも満たしたことがあるか」ではない。画面と docs にも明記する。
//
// 大事な決めごと:
//   実績は、目標へ **明示的に結び付いた取り組み** だけを数える。
//   具体的には、その目標に紐づく予定項目（item.goalId）から実施された記録だけである。
//   こうしないと、2周目の目標を作ったときに1周目の記録で達成扱いになってしまう。

export const GOAL_COMPLETION_TYPES = Object.freeze(['attempt', 'mastery']);
export const GOAL_STATUSES = Object.freeze(['active', 'achieved', 'paused', 'cancelled']);

/** 習得の既定条件。青チャートの評価のうち「◯完璧にできた」だけを合格とする。 */
export const DEFAULT_MASTERY_EVALUATIONS = Object.freeze(['perfect']);

export const GOAL_STATUS_LABELS = Object.freeze({
  active: '進行中',
  achieved: '達成',
  paused: '一時停止',
  cancelled: '取り消し',
});

export const GOAL_COMPLETION_LABELS = Object.freeze({
  attempt: '取り組む（1回ずつ解けば達成）',
  mastery: '習得する（最新の結果が条件を満たせば達成）',
});

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 目標を保存してよい形へ整える。
 *
 * 古い目標（文章の scope だけを持つもの）は、対象を勝手に問題IDへ変換しない。
 * 「対象の設定が要る目標」として印（needsScopeSetup）を付けて、そのまま残す。
 */
export function normalizeGoal(raw, { now = Date.now() } = {}) {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const at = new Date(now).toISOString();
  const questionIds = Array.isArray(raw.questionIds)
    ? [...new Set(raw.questionIds.filter((value) => typeof value === 'string' && value))].slice(0, 2000)
    : [];
  const scope = typeof raw.scope === 'string' ? raw.scope.slice(0, 400) : '';
  return {
    id: id.slice(0, 80),
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
    startDate: typeof raw.startDate === 'string' ? raw.startDate.slice(0, 10) : null,
    deadline: typeof raw.deadline === 'string' ? raw.deadline.slice(0, 40) : '',
    // 対象は必ずID一覧で持つ。条件は「どう選んだか」の記録としてだけ残す。
    questionIds,
    scopeFilter: isObject(raw.scopeFilter) ? normalizeScopeFilter(raw.scopeFilter) : null,
    scope,
    completion: normalizeCompletion(raw.completion),
    priority: Number.isFinite(Number(raw.priority))
      ? Math.max(1, Math.min(5, Math.round(Number(raw.priority))))
      : 3,
    status: GOAL_STATUSES.includes(raw.status) ? raw.status : 'active',
    // 対象がID一覧になっていない古い目標。計算には使えないことを、はっきり示す。
    needsScopeSetup: questionIds.length === 0,
    updatedAt: typeof raw.updatedAt === 'string' && Number.isFinite(Date.parse(raw.updatedAt))
      ? raw.updatedAt
      : at,
    // 目標そのものの版。計画を作ってから反映するまでに変わっていないかを見る。
    revision: Number.isFinite(Number(raw.revision)) ? Math.max(0, Math.floor(Number(raw.revision))) : 0,
    ...(typeof raw.deletedAt === 'string' ? { deletedAt: raw.deletedAt } : {}),
  };
}

function normalizeCompletion(raw) {
  const source = isObject(raw) ? raw : {};
  const type = GOAL_COMPLETION_TYPES.includes(source.type) ? source.type : 'attempt';
  if (type === 'attempt') return { type };
  const evaluations = Array.isArray(source.evaluations) && source.evaluations.length
    ? [...new Set(source.evaluations.filter((value) => typeof value === 'string' && value))].slice(0, 5)
    : [...DEFAULT_MASTERY_EVALUATIONS];
  return {
    type,
    evaluations,
    // latest = この目標に関連する最新の記録で判定する（初期仕様）。
    mode: source.mode === 'ever' ? 'ever' : 'latest',
  };
}

function normalizeScopeFilter(raw) {
  const pick = (key, max = 80) => (typeof raw[key] === 'string' ? raw[key].slice(0, max) : null);
  return {
    subject: pick('subject'),
    chapter: pick('chapter'),
    section: pick('section'),
    course: pick('course', 20),
    types: Array.isArray(raw.types) ? raw.types.filter((t) => typeof t === 'string').slice(0, 20) : null,
    numberFrom: Number.isFinite(Number(raw.numberFrom)) ? Number(raw.numberFrom) : null,
    numberTo: Number.isFinite(Number(raw.numberTo)) ? Number(raw.numberTo) : null,
    difficultyFrom: Number.isFinite(Number(raw.difficultyFrom)) ? Number(raw.difficultyFrom) : null,
    difficultyTo: Number.isFinite(Number(raw.difficultyTo)) ? Number(raw.difficultyTo) : null,
  };
}

/** 条件から対象の問題を選ぶ。選んだ結果は目標作成時にID一覧として確定させる。 */
export function selectQuestions(questions, filter = {}) {
  let list = [...questions];
  if (filter.subject) list = list.filter((q) => q.subject === filter.subject);
  if (filter.chapter) list = list.filter((q) => q.chapter === filter.chapter);
  if (filter.section) list = list.filter((q) => q.section === filter.section);
  if (filter.course) list = list.filter((q) => (q.courses ?? []).includes(filter.course));
  if (Array.isArray(filter.types) && filter.types.length) list = list.filter((q) => filter.types.includes(q.type));
  if (Number.isFinite(Number(filter.numberFrom))) list = list.filter((q) => q.number >= Number(filter.numberFrom));
  if (Number.isFinite(Number(filter.numberTo))) list = list.filter((q) => q.number <= Number(filter.numberTo));
  if (Number.isFinite(Number(filter.difficultyFrom))) {
    list = list.filter((q) => Number.isInteger(q.difficulty) && q.difficulty >= Number(filter.difficultyFrom));
  }
  if (Number.isFinite(Number(filter.difficultyTo))) {
    list = list.filter((q) => Number.isInteger(q.difficulty) && q.difficulty <= Number(filter.difficultyTo));
  }
  return list;
}

/**
 * その目標に結び付いた取り組みだけを集める。
 *
 * 結び付きは、予定項目（item.goalId）を通した記録だけを見る。
 * 「同じ問題を同じころに解いた」というだけでは、その目標の実績にしない。
 */
export function goalAttempts(goal, { records = [], itemGoalMap = new Map() } = {}) {
  const byQuestion = new Map();
  for (const record of records) {
    if (!record.planItemId) continue;
    if (itemGoalMap.get(record.planItemId) !== goal.id) continue;
    if (!byQuestion.has(record.questionId)) byQuestion.set(record.questionId, []);
    byQuestion.get(record.questionId).push(record);
  }
  for (const list of byQuestion.values()) {
    list.sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
  }
  return byQuestion;
}

/** 1問が、その目標の条件を満たしているか。 */
export function questionSatisfied(goal, attempts = []) {
  if (!attempts.length) return false;
  if (goal.completion.type === 'attempt') return true;
  const evaluations = goal.completion.evaluations ?? DEFAULT_MASTERY_EVALUATIONS;
  if (goal.completion.mode === 'ever') {
    return attempts.some((record) => evaluations.includes(record.evaluation));
  }
  // latest（初期仕様）… この目標に関連する最新の記録で判定する。
  return evaluations.includes(attempts[attempts.length - 1].evaluation);
}
