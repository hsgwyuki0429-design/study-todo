// 起動時の問題マスタの用意と、初期のサンプル（デモ）データの後始末。
//
// 問題マスタの実体は data/questions.json（青チャート数学I+A）にある。
// ビルドは不要で、PWA はこの JSON をそのまま読み込む。
//
// 以前の版は、動作確認用に架空の問題104問（id が math1a-rei-◯）と、
// それに紐づくサンプルの学習記録・予定・目標を投入していた。
// それらは本物の成績ではないので、
//   ・問題マスタは、中身がデモだけなら安全に本物へ置き換える
//   ・デモの学習記録・予定・目標は、利用者が設定画面で明示的に消す
// という扱いにしている（勝手に消さない）。

import { importQuestions, getGoals, getQuestionMasterVersion } from './api.js';
import { idb, STORES } from './idb.js';

/** 旧サンプルの問題ID の接頭辞。これで本物のマスタと見分ける。 */
export const DEMO_QUESTION_PREFIX = 'math1a-rei-';

/** 旧サンプルが作っていた目標。 */
const DEMO_GOAL_TITLES = ['数列を1周する', '中間テストまでに例題を80%'];

const isDemoQuestionId = (id) => typeof id === 'string' && id.startsWith(DEMO_QUESTION_PREFIX);

/** data/questions.json を読む。アプリの置き場所（サブパス）に追従する。 */
export async function loadQuestionMaster() {
  const url = new URL('../data/questions.json', import.meta.url);
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`問題マスタを読み込めませんでした (${response.status})`);
  const document = await response.json();
  const questions = Array.isArray(document?.questions) ? document.questions : [];
  if (!questions.length) throw new Error('問題マスタが空です');
  return { ...document, questions };
}

/**
 * 問題マスタを用意する。
 *
 * ・何も入っていないとき、入っているのが旧サンプルだけのときは投入する
 * ・すでに入っていても、同梱のマスタのほうが新しい版なら入れ替える
 *   （古いマスタを持ったままの端末が、アプリだけ新しくなって取り残されないように）
 * ・利用者が自分で入れたマスタ（同梱より新しい版）は上書きしない
 */
export async function seedIfEmpty() {
  const existing = await idb.all(STORES.questions);
  const onlyDemo = existing.length > 0 && existing.every((q) => isDemoQuestionId(q.id));
  const localVersion = await getQuestionMasterVersion();

  if (existing.length > 0 && !onlyDemo) {
    // 版だけ見て、同梱のほうが新しければ入れ替える。
    // 中身を読むのはそのときだけなので、ふだんの起動は今までどおり速い。
    const master = await loadQuestionMaster();
    const bundled = Number(master.masterVersion) || 0;
    if (bundled <= localVersion) return { imported: 0, replacedDemo: false, upgraded: false };
    const imported = await importQuestions(master.questions, { replace: true, masterVersion: bundled });
    return { imported, replacedDemo: false, upgraded: true, masterVersion: bundled };
  }

  const master = await loadQuestionMaster();
  const imported = await importQuestions(master.questions, {
    replace: onlyDemo,
    masterVersion: Number(master.masterVersion) || 0,
  });
  return { imported, replacedDemo: onlyDemo, upgraded: false };
}

/** 旧サンプルの学習記録・予定・目標が残っているかを数える。 */
export async function countDemoStudyData() {
  const [records, tasks, goals] = await Promise.all([
    idb.all(STORES.records),
    idb.all(STORES.tasks),
    getGoals(),
  ]);
  return {
    records: records.filter((r) => isDemoQuestionId(r.questionId)).length,
    // デモの予定は、並んでいる問題がすべてデモのもの。
    tasks: tasks.filter((t) => (t.questionIds ?? []).length > 0
      && (t.questionIds ?? []).every(isDemoQuestionId)).length,
    goals: goals.filter((g) => DEMO_GOAL_TITLES.includes(g.title)).length,
    questions: (await idb.all(STORES.questions)).filter((q) => isDemoQuestionId(q.id)).length,
  };
}

/**
 * 旧サンプルのデータだけを消す。利用者が設定画面で選んだときだけ呼ぶ。
 * 本物の問題（id が aochart… ）に紐づく記録には一切触れない。
 */
export async function removeDemoStudyData() {
  const [records, tasks, questions] = await Promise.all([
    idb.all(STORES.records),
    idb.all(STORES.tasks),
    idb.all(STORES.questions),
  ]);
  const goals = await getGoals();

  const removed = { records: 0, tasks: 0, goals: 0, questions: 0 };
  for (const r of records.filter((r) => isDemoQuestionId(r.questionId))) {
    await idb.del(STORES.records, r.id);
    removed.records += 1;
  }
  for (const t of tasks.filter((t) => (t.questionIds ?? []).length > 0
    && (t.questionIds ?? []).every(isDemoQuestionId))) {
    await idb.del(STORES.tasks, t.id);
    removed.tasks += 1;
  }
  for (const g of goals.filter((g) => DEMO_GOAL_TITLES.includes(g.title))) {
    // 目標は他の端末にも残るので、消した印を付けて同期で伝える。
    await idb.put(STORES.goals, {
      ...g,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    removed.goals += 1;
  }
  for (const q of questions.filter((q) => isDemoQuestionId(q.id))) {
    await idb.del(STORES.questions, q.id);
    removed.questions += 1;
  }
  return removed;
}
