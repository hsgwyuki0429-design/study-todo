// 初回起動時に投入するサンプルデータ。
// 問題マスタは本来 AI が整形したデータをインポートする想定（設定 > 問題データの管理）。
// カレンダーや進捗バーの見え方を確認できるよう、前後の日付にもタスクを置いている。

import { importQuestions, getGoals, addGoal, uid, todayKey } from './api.js';
import { idb, STORES } from './idb.js';

const CHAPTERS = [
  { chapter: '数と式', sections: ['式の計算', '実数', '1次不等式'], from: 1, to: 18 },
  { chapter: '2次関数', sections: ['2次関数のグラフ', '最大・最小', '2次方程式'], from: 19, to: 40 },
  { chapter: '図形と計量', sections: ['三角比', '正弦定理・余弦定理'], from: 41, to: 58 },
  { chapter: '場合の数と確率', sections: ['順列・組合せ', '確率'], from: 59, to: 80 },
  { chapter: '数列', sections: ['等差数列', '等比数列', '漸化式'], from: 81, to: 104 },
];

const EVAL_VALUES = ['perfect', 'better_solution', 'weak_writing', 'calc_error', 'wrong_approach'];

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

const shiftDate = (days) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
};

// 日付から決まる擬似乱数。再生成しても同じサンプルになるようにする。
function rand(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function buildSchedule() {
  const tasks = [];
  const records = [];
  const today = todayKey();

  // 19番から順に配り、最後まで行ったら先頭へ戻す（どの日も空にならないように）
  let number = 19;
  const used = [];
  const nextQuestion = () => {
    const id = `math1a-rei-${number}`;
    number = number >= 104 ? 1 : number + 1;
    used.push(id);
    return id;
  };

  // 復習日は既に出した問題を再び出す（同じ問題の評価の推移が見えるように）
  let reviewCursor = 0;
  const reviewQuestion = () => {
    if (!used.length) return nextQuestion();
    const id = used[reviewCursor % used.length];
    reviewCursor += 1;
    return id;
  };

  for (let offset = -18; offset <= 6; offset++) {
    const d = shiftDate(offset);
    const date = todayKey(d);
    const isChallengeDay = offset % 5 === 0;

    const isReviewDay = offset % 3 === 0 && offset !== 0;
    const plain = [];
    for (let i = 0; i < 4; i++) plain.push(isReviewDay ? reviewQuestion() : nextQuestion());
    tasks.push({
      id: uid('task'),
      date,
      questionIds: plain,
      kind: isReviewDay ? 'review' : 'new',
      order: 0,
      completed: false,
    });

    let challenge = null;
    if (isChallengeDay) {
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push(nextQuestion());
      challenge = {
        id: uid('task'),
        date,
        title: `${offset === 0 ? '数列' : '総合'}チャレンジ`,
        questionIds: ids,
        kind: 'challenge',
        timeLimitSeconds: 12 * 60,
        order: 1,
        completed: false,
      };
      tasks.push(challenge);
    }

    // 過去の日付には、ばらつきのある実績を入れておく
    if (date < today) {
      const rate = 0.35 + rand(offset + 100) * 0.65;
      const all = [...plain, ...(challenge?.questionIds ?? [])];
      const doneCount = Math.round(all.length * rate);
      all.slice(0, doneCount).forEach((questionId, i) => {
        const ts = new Date(d);
        ts.setHours(17 + Math.floor(i / 3), (i % 3) * 15, 0, 0);
        records.push({
          id: uid('rec'),
          questionId,
          timestamp: ts.toISOString(),
          evaluation: EVAL_VALUES[Math.floor(rand(offset * 7 + i) * EVAL_VALUES.length)],
          durationSeconds: 180 + Math.floor(rand(offset + i) * 600),
        });
      });
      if (doneCount >= all.length) {
        tasks.forEach((t) => {
          if (t.date === date) t.completed = true;
        });
      }
    }
  }
  return { tasks, records };
}

export async function seedIfEmpty() {
  const existing = await idb.all(STORES.questions);
  if (existing.length === 0) await importQuestions(buildQuestions());

  const tasks = await idb.all(STORES.tasks);
  if (tasks.length === 0) {
    const built = buildSchedule();
    await idb.putAll(STORES.tasks, built.tasks);
    await idb.putAll(STORES.records, built.records);
  }

  const goals = await getGoals();
  if (goals.length === 0) {
    const deadline = (days) => todayKey(shiftDate(days));
    await addGoal({ title: '数列を1周する', deadline: deadline(19), scope: '数学I+A / 数列' });
    await addGoal({ title: '中間テストまでに例題を80%', deadline: deadline(38), scope: '数学I+A 全章' });
  }
}
