// 問題マスタの「形」と「並び」をここ1か所に置く。
// PWA（src/api.js）とサーバー（server/service/）の両方から読み込むので、
// ブラウザ専用のもの（fetch・IndexedDB）には触れない。

/** 問題マスタが持つ項目。ここに無い項目は保存も同期もされない。 */
export const QUESTION_FIELDS = Object.freeze([
  'id',
  'subject',
  'subjectOrder',
  'book',
  'chapter',
  'chapterOrder',
  'section',
  'sectionOrder',
  'type',
  'number',
  'label',
  'title',
  'page',
  'sectionPage',
  'difficulty',
  'needsReview',
]);

/** 同じ節の中の並び。例題を先に、EXERCISES を後に置く（誌面と同じ順）。 */
const TYPE_ORDER = { 基本例題: 0, 重要例題: 0, 演習例題: 0, 例題: 0, 練習: 1, EXERCISES: 2 };

export const typeOrderOf = (type) => TYPE_ORDER[type] ?? 1;

const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * 掲載順（教科 → 章 → 節 → 種類 → 番号）で比べる。
 * 順序の項目を持たない古いデータが混じっても落ちないよう、無いときは名前順にする。
 */
export function compareQuestions(left, right) {
  const a = left ?? {};
  const b = right ?? {};
  return (
    num(a.subjectOrder, 9999) - num(b.subjectOrder, 9999) ||
    String(a.subject ?? '').localeCompare(String(b.subject ?? '')) ||
    num(a.chapterOrder, 9999) - num(b.chapterOrder, 9999) ||
    String(a.chapter ?? '').localeCompare(String(b.chapter ?? '')) ||
    num(a.sectionOrder, 9999) - num(b.sectionOrder, 9999) ||
    String(a.section ?? '').localeCompare(String(b.section ?? '')) ||
    typeOrderOf(a.type) - typeOrderOf(b.type) ||
    String(a.type ?? '').localeCompare(String(b.type ?? '')) ||
    num(a.number, 0) - num(b.number, 0) ||
    String(a.id ?? '').localeCompare(String(b.id ?? ''))
  );
}

const text = (value, max) => (value === undefined || value === null ? null : String(value).slice(0, max));

/**
 * 1問ぶんを保存できる形に整える。
 * 追加した項目（book / chapterOrder / page など）は、ここを通っても必ず残す。
 * この関数はPWA・サーバー双方で使い、経路の途中で項目が落ちないようにしている。
 */
export function normalizeQuestion(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const number = Number(raw.number) || 0;
  const type = text(raw.type, 40) ?? '';
  const fallbackId = id || (raw.subject && type ? `${raw.subject}-${type}-${number}` : '');
  if (!fallbackId) return null;

  // null / undefined / 空文字は「不明」。0 と取り違えないようにする。
  const integer = (value) =>
    value === null || value === undefined || value === '' || !Number.isInteger(Number(value))
      ? null
      : Number(value);
  const difficulty = raw.difficulty === undefined || raw.difficulty === null ? null : integer(raw.difficulty);

  const question = {
    id: fallbackId.slice(0, 120),
    subject: text(raw.subject, 60) ?? '',
    chapter: text(raw.chapter, 80) ?? '',
    section: text(raw.section, 80) ?? '',
    type,
    number,
    label: text(raw.label, 120) || `${type} ${number}`.trim(),
    difficulty,
  };

  // タイトルと掲載ページは「資料に無い＝null」に意味があるので、常に持たせる。
  question.title = text(raw.title, 120);
  question.page = integer(raw.page);

  // 並び順などは、値があるときだけ持たせる（古いデータをむやみに膨らませない）。
  const optional = {
    subjectOrder: integer(raw.subjectOrder),
    book: text(raw.book, 80),
    chapterOrder: integer(raw.chapterOrder),
    sectionOrder: integer(raw.sectionOrder),
    sectionPage: integer(raw.sectionPage),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== null) question[key] = value;
  }
  if (raw.needsReview === true) question.needsReview = true;
  return question;
}

/** 検索でひっかける文字列。タイトルと本の名前も対象にする。 */
export function questionHaystack(question) {
  return [
    question.label,
    question.title,
    question.chapter,
    question.section,
    question.subject,
    question.book,
    question.type,
    String(question.number),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * 教科 → 章 → 節 の目次を、掲載順のまま組み立てる。
 * getAppInfo（PWA・MCPの両方）で使う。
 */
export function buildOutline(questions) {
  const subjects = new Map();
  for (const q of questions) {
    const subject = subjects.get(q.subject) ?? { subject: q.subject, order: num(q.subjectOrder, 9999), chapters: new Map() };
    subjects.set(q.subject, subject);
    const chapter = subject.chapters.get(q.chapter)
      ?? { chapter: q.chapter, order: num(q.chapterOrder, 9999), sections: new Map() };
    subject.chapters.set(q.chapter, chapter);
    const section = chapter.sections.get(q.section)
      ?? { section: q.section, order: num(q.sectionOrder, 9999), page: q.sectionPage ?? null, count: 0 };
    section.count += 1;
    chapter.sections.set(q.section, section);
  }
  const sortByOrder = (a, b) => a.order - b.order || String(a.chapter ?? a.section ?? a.subject).localeCompare(String(b.chapter ?? b.section ?? b.subject));
  return [...subjects.values()]
    .sort((a, b) => a.order - b.order || a.subject.localeCompare(b.subject))
    .map((subject) => ({
      subject: subject.subject,
      chapters: [...subject.chapters.values()].sort(sortByOrder).map((chapter) => ({
        chapter: chapter.chapter,
        sections: [...chapter.sections.values()].sort(sortByOrder).map((s) => s.section),
        sectionDetails: [...chapter.sections.values()].sort(sortByOrder).map((s) => ({
          section: s.section,
          page: s.page,
          questionCount: s.count,
        })),
      })),
    }));
}
