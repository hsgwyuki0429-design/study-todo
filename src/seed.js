// 初回起動時に投入するサンプルデータ。
// 問題マスタは本来 AI が整形したデータをインポートする想定（設定 > インポート）。
// ここでは動作確認用に最小限の構成を生成する。

import { importQuestions, getTodayTasks, updateTodayTasks, getGoals, addGoal, uid, todayKey } from './api.js';
import { idb, STORES } from './idb.js';

const CHAPTERS = [
  { chapter: '数と式', sections: ['式の計算', '実数', '1次不等式'], from: 1, to: 18 },
  { chapter: '2次関数', sections: ['2次関数のグラフ', '最大・最小', '2次方程式'], from: 19, to: 40 },
  { chapter: '図形と計量', sections: ['三角比', '正弦定理・余弦定理'], from: 41, to: 58 },
  { chapter: '場合の数と確率', sections: ['順列・組合せ', '確率'], from: 59, to: 80 },
  { chapter: '数列', sections: ['等差数列', '等比数列', '漸化式'], from: 81, to: 104 },
];

function buildQuestions() {
  const questions = [];
  for (const c of CHAPTERS) {
    for (let n = c.from; n <= c.to; n++) {
      const section = c.sections[(n - c.from) % c.sections.length];
      const type = n % 4 === 0 ? '基本例題' : '例題';
      questions.push({
        id: `math1a-rei-${n}`,
        subject: '数学I+A',
        chapter: c.chapter,
        section,
        type,
        number: n,
        label: `${type} ${n}`,
        difficulty: (n % 5) + 1,
      });
    }
  }
  return questions;
}

export async function seedIfEmpty() {
  const existing = await idb.all(STORES.questions);
  if (existing.length === 0) {
    await importQuestions(buildQuestions());
  }

  const tasks = await getTodayTasks();
  if (tasks.length === 0) {
    const date = todayKey();
    await updateTodayTasks(
      [
        { kind: 'priority', questionIds: ['math1a-rei-81', 'math1a-rei-82'], order: 0 },
        { kind: 'new', questionIds: ['math1a-rei-83', 'math1a-rei-84', 'math1a-rei-85'], order: 1 },
        {
          kind: 'challenge',
          title: '数列チャレンジ',
          questionIds: ['math1a-rei-86', 'math1a-rei-87', 'math1a-rei-88'],
          timeLimitSeconds: 12 * 60,
          order: 2,
        },
        { kind: 'review', questionIds: ['math1a-rei-42', 'math1a-rei-43', 'math1a-rei-44'], order: 3 },
      ],
      date
    );
  }

  const goals = await getGoals();
  if (goals.length === 0) {
    await addGoal({ title: '数列を1周する', deadline: '2026-10-01', scope: '数学I+A / 数列' });
    await addGoal({ title: '中間テストまでに例題を80%', deadline: '2026-10-20', scope: '数学I+A 全章' });
  }
}

export { uid };
