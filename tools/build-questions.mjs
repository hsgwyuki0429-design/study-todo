// tools/source/*.json から data/questions.json を作る。
//
//   node tools/build-questions.mjs          … 生成して整合性チェック
//   node tools/build-questions.mjs --check  … 生成せず、既存ファイルとの一致だけ確認
//
// 生成物はリポジトリにコミットする（PWA はビルドせずこの JSON を読む）。
//
// 出典:
//   examples.json  数研出版が配布している「改訂版 チャート式基礎からの数学Ⅰ／Ａ
//                  例題一覧」Excel。例題の章・節・番号・種類・タイトル・難易度・
//                  掲載ページ・SELECT STUDY の3コースは、すべてこれが正。
//   exercises.json 誌面の EXERCISES ページから読み取った番号と難易度。
//                  例題一覧の Excel に EXERCISES は載っていないため、こちらだけ
//                  誌面が出典になる。難易度は抜き取り検証で読み違いが見つかって
//                  いるので needsReview を付け、掲載ページは版が違うため持たない。

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'questions.json');

const examplesSource = JSON.parse(await readFile(join(ROOT, 'tools/source/examples.json'), 'utf8'));
const exercisesSource = JSON.parse(await readFile(join(ROOT, 'tools/source/exercises.json'), 'utf8'));

export const BOOK = '改訂版 チャート式基礎からの数学I+A';
const SOURCE_NOTE = [
  '例題は数研出版が配布している「改訂版 チャート式基礎からの数学Ⅰ／Ａ 例題一覧」Excel が出典。',
  'EXERCISES は誌面から読み取った番号と難易度のみ（難易度は未確認、掲載ページは持たない）。',
  '問題文と解答は含まない。',
].join('');

/** 教科ごとのID接頭辞。数学Iと数学Aで番号が重なっても衝突しない。 */
const SUBJECT_SLUG = { 数学I: 'm1', 数学A: 'ma' };

export const COURSES = Object.freeze(['基本定着', '精選速習', '実力錬成']);

const pad = (n) => String(n).padStart(3, '0');

export function buildQuestions() {
  const questions = [];
  for (const subject of examplesSource.subjects) {
    const slug = SUBJECT_SLUG[subject.subject];
    if (!slug) throw new Error(`教科の接頭辞が未定義: ${subject.subject}`);
    for (const chapter of subject.chapters) {
      for (const section of chapter.sections) {
        const common = {
          subject: subject.subject,
          subjectOrder: subject.order,
          book: BOOK,
          chapter: chapter.chapter,
          chapterOrder: chapter.order,
          section: section.section,
          sectionOrder: section.order,
          // 節の開始ページは例題一覧に無いので、その節の最初の例題のページで代用する。
          sectionPage: section.examples[0][4],
        };
        for (const [number, kind, title, difficulty, page, courses] of section.examples) {
          const type = `${kind}例題`;
          questions.push({
            id: `aochart1a-${slug}-ex-${pad(number)}`,
            ...common,
            type,
            number,
            label: `${type}${number}`,
            title,
            page,
            difficulty,
            courses,
          });
        }
        for (const [number, difficulty] of exercisesSource[subject.subject]?.[section.order] ?? []) {
          questions.push({
            id: `aochart1a-${slug}-exr-${pad(number)}`,
            ...common,
            type: 'EXERCISES',
            number,
            label: `EXERCISES ${number}`,
            title: null,
            // EXERCISES の掲載ページは別の刷りのものなので持たない。
            page: null,
            difficulty,
            courses: [],
            needsReview: true,
          });
        }
      }
    }
  }
  return questions;
}

/* ------------------------------------------------------------------ */
/* 整合性チェック                                                      */
/* ------------------------------------------------------------------ */

export function checkQuestions(questions) {
  const problems = [];
  const add = (message) => problems.push(message);

  const ids = new Set();
  for (const q of questions) {
    if (ids.has(q.id)) add(`ID重複: ${q.id}`);
    ids.add(q.id);
    if (!q.subject || !q.chapter || !q.section) add(`章・単元が空: ${q.id}`);
    if (!q.type || !q.label) add(`種類または表示名が空: ${q.id}`);
    if (!Number.isInteger(q.number) || q.number < 1) add(`番号が不正: ${q.id}`);
    if (!(Number.isInteger(q.difficulty) && q.difficulty >= 1 && q.difficulty <= 5)) {
      add(`難易度が1〜5でない: ${q.id} (${q.difficulty})`);
    }
    if (!Number.isInteger(q.sectionPage)) add(`節のページが無い: ${q.id}`);
    for (const course of q.courses) if (!COURSES.includes(course)) add(`知らないコース: ${q.id} (${course})`);
    if (q.type === 'EXERCISES') {
      if (q.needsReview !== true) add(`EXERCISESに確認待ちの印が無い: ${q.id}`);
      if (q.page !== null) add(`EXERCISESにページが入っている: ${q.id}`);
    } else {
      if (!Number.isInteger(q.page)) add(`例題にページが無い: ${q.id}`);
      if (!q.title) add(`例題にタイトルが無い: ${q.id}`);
    }
  }

  // 教科×種類ごとに、番号が1から連番になっているか
  const groups = new Map();
  for (const q of questions) {
    const key = `${q.subject}/${q.type === 'EXERCISES' ? 'EXERCISES' : '例題'}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(q);
  }
  for (const [key, list] of groups) {
    const numbers = list.map((q) => q.number).sort((a, b) => a - b);
    const seen = new Set();
    for (const n of numbers) {
      if (seen.has(n)) add(`番号重複: ${key} の ${n}`);
      seen.add(n);
    }
    for (let n = 1; n <= numbers[numbers.length - 1]; n++) {
      if (!seen.has(n)) add(`番号の欠落: ${key} の ${n}`);
    }
  }

  // 節の並び（sectionOrder）と節の開始ページが同じ向きに増えているか
  const bySubject = new Map();
  for (const q of questions) {
    const map = bySubject.get(q.subject) ?? bySubject.set(q.subject, new Map()).get(q.subject);
    map.set(q.sectionOrder, { section: q.section, page: q.sectionPage, chapterOrder: q.chapterOrder });
  }
  for (const [subject, map] of bySubject) {
    const orders = [...map.keys()].sort((a, b) => a - b);
    orders.forEach((order, i) => {
      if (order !== i + 1) add(`節の並びが飛んでいる: ${subject} sectionOrder=${order}`);
      if (i > 0) {
        const prev = map.get(orders[i - 1]);
        const cur = map.get(order);
        if (cur.chapterOrder < prev.chapterOrder) add(`章の並びが逆: ${subject} ${cur.section}`);
        if (cur.page < prev.page) add(`節のページが戻っている: ${subject} ${cur.section}`);
      }
    });
  }

  // 例題の掲載ページが、番号の順に増えているか
  for (const [subject] of bySubject) {
    const list = questions
      .filter((q) => q.subject === subject && q.type !== 'EXERCISES')
      .sort((a, b) => a.number - b.number);
    list.forEach((q, i) => {
      if (i > 0 && q.page < list[i - 1].page) {
        add(`例題のページが戻っている: ${q.id} (p.${q.page} < p.${list[i - 1].page})`);
      }
    });
  }

  return problems;
}

export function summarize(questions) {
  const bySubject = {};
  const byType = {};
  const byCourse = {};
  for (const q of questions) {
    bySubject[q.subject] = (bySubject[q.subject] ?? 0) + 1;
    byType[q.type] = (byType[q.type] ?? 0) + 1;
    for (const course of q.courses) byCourse[course] = (byCourse[course] ?? 0) + 1;
  }
  const chapterKeys = new Map();
  for (const q of questions) {
    const key = `${q.subject} 第${q.chapterOrder}章 ${q.chapter}`;
    chapterKeys.set(key, (chapterKeys.get(key) ?? 0) + 1);
  }
  const byChapter = [...chapterKeys].map(([chapter, count]) => ({ chapter, count }));
  return { total: questions.length, bySubject, byType, byCourse, byChapter };
}

/* ------------------------------------------------------------------ */

/**
 * 問題マスタの版。中身を変えたら必ず1つ上げること。
 *
 * これは「どちらが新しいか」を決めるためだけの数で、ハッシュとは役割が違う。
 * ハッシュは「違う」ことしか分からないので、古い問題マスタを持ったままの端末が
 * 久しぶりに同期したときに、新しいマスタを古いほうへ巻き戻してしまう。
 * 版が小さいものはサーバーが受け取らない、という決まりにしてそれを防いでいる。
 *
 *   1 … 593問（数学I+A。EXERCISES を含む）
 */
const MASTER_VERSION = 1;

function buildDocument(questions) {
  return {
    schemaVersion: 3,
    masterVersion: MASTER_VERSION,
    book: BOOK,
    source: SOURCE_NOTE,
    generatedBy: 'tools/build-questions.mjs',
    courses: COURSES,
    questionCount: questions.length,
    questions,
  };
}

async function main() {
  const questions = buildQuestions();
  const problems = checkQuestions(questions);
  const summary = summarize(questions);

  console.log(`総問題数: ${summary.total}`);
  console.log('教科別:', summary.bySubject);
  console.log('種類別:', summary.byType);
  console.log('コース別:', summary.byCourse);
  summary.byChapter.forEach((c) => console.log(`  ${c.chapter}: ${c.count}問`));

  if (problems.length) {
    console.error(`\n整合性チェックで ${problems.length} 件の問題:`);
    problems.forEach((p) => console.error(`  - ${p}`));
    process.exitCode = 1;
    return;
  }
  console.log('\n整合性チェック: 問題なし');

  const text = `${JSON.stringify(buildDocument(questions), null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const current = await readFile(OUT, 'utf8').catch(() => null);
    if (current !== text) {
      console.error('data/questions.json が最新ではありません。node tools/build-questions.mjs を実行してください。');
      process.exitCode = 1;
    } else {
      console.log('data/questions.json は最新です。');
    }
    return;
  }
  await writeFile(OUT, text);
  console.log(`書き出し: ${OUT}`);
}

if (process.argv[1] && process.argv[1].endsWith('build-questions.mjs')) await main();
