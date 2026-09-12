// tools/source/*.mjs（誌面から読み取った表）から data/questions.json を作る。
//
//   node tools/build-questions.mjs          … 生成して整合性チェック
//   node tools/build-questions.mjs --check  … 生成せず、既存ファイルとの一致だけ確認
//
// 生成物はリポジトリにコミットする（PWA はビルドせずこの JSON を読む）。

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import math1 from './source/math1.mjs';
import matha from './source/matha.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'questions.json');

export const BOOK = '青チャート数学I+A';
const SOURCE_NOTE = '数研出版「チャート式 基礎からの数学I+A（青チャート）」の目次・章トビラの例題一覧・EXERCISES ページから作成。問題文と解答は含まない。';

/** 教科ごとのID接頭辞。数学Iと数学Aで番号が重なっても衝突しない。 */
const SUBJECT_SLUG = { 数学I: 'm1', 数学A: 'ma' };

const pad = (n) => String(n).padStart(3, '0');

export function buildQuestions() {
  const questions = [];
  for (const book of [math1, matha]) {
    const slug = SUBJECT_SLUG[book.subject];
    if (!slug) throw new Error(`教科の接頭辞が未定義: ${book.subject}`);
    for (const chapter of book.chapters) {
      for (const section of chapter.sections) {
        const common = {
          subject: book.subject,
          subjectOrder: book.order,
          book: BOOK,
          chapter: chapter.chapter,
          chapterOrder: chapter.order,
          section: section.section,
          sectionOrder: section.order,
          sectionPage: section.page,
        };
        for (const [number, kind, title, difficulty] of section.examples) {
          const type = `${kind}例題`;
          questions.push({
            id: `aochart1a-${slug}-ex-${pad(number)}`,
            ...common,
            type,
            number,
            label: `${type}${number}`,
            title,
            // 例題の掲載ページは例題一覧に無いため持たない（節の開始ページは sectionPage）。
            page: null,
            difficulty,
          });
        }
        for (const [number, difficulty, page] of section.exercises) {
          questions.push({
            id: `aochart1a-${slug}-exr-${pad(number)}`,
            ...common,
            type: 'EXERCISES',
            number,
            label: `EXERCISES ${number}`,
            title: null,
            page,
            difficulty,
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
    if (q.difficulty !== null && !(Number.isInteger(q.difficulty) && q.difficulty >= 1 && q.difficulty <= 5)) {
      add(`難易度が1〜5でない: ${q.id} (${q.difficulty})`);
    }
    if (!Number.isInteger(q.sectionPage)) add(`節のページが無い: ${q.id}`);
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
      }
    });
  }

  // EXERCISES のページが節の開始ページより後ろにあるか
  for (const q of questions) {
    if (q.type === 'EXERCISES' && q.page !== null && q.page < q.sectionPage) {
      add(`EXERCISESのページが節より前: ${q.id} (p.${q.page} < p.${q.sectionPage})`);
    }
  }

  return problems;
}

export function summarize(questions) {
  const bySubject = {};
  const byChapter = [];
  const byType = {};
  for (const q of questions) {
    bySubject[q.subject] = (bySubject[q.subject] ?? 0) + 1;
    byType[q.type] = (byType[q.type] ?? 0) + 1;
  }
  const chapterKeys = new Map();
  for (const q of questions) {
    const key = `${q.subject} 第${q.chapterOrder}章 ${q.chapter}`;
    chapterKeys.set(key, (chapterKeys.get(key) ?? 0) + 1);
  }
  for (const [key, count] of chapterKeys) byChapter.push({ chapter: key, count });
  return { total: questions.length, bySubject, byType, byChapter };
}

/* ------------------------------------------------------------------ */

function document(questions) {
  return {
    schemaVersion: 2,
    book: BOOK,
    source: SOURCE_NOTE,
    generatedBy: 'tools/build-questions.mjs',
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
  summary.byChapter.forEach((c) => console.log(`  ${c.chapter}: ${c.count}問`));

  if (problems.length) {
    console.error(`\n整合性チェックで ${problems.length} 件の問題:`);
    problems.forEach((p) => console.error(`  - ${p}`));
    process.exitCode = 1;
    return;
  }
  console.log('\n整合性チェック: 問題なし');

  const text = `${JSON.stringify(document(questions), null, 2)}\n`;
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
