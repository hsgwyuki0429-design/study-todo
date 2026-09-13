// 記録タブ。目次ビュー（章→単元→例題→履歴）と履歴ビュー（時系列）を切り替える。

import * as api from './api.js';
import { EVALUATIONS, EVAL_MAP, dayOf } from './api.js';
import { state, q, qLabel, render } from './state.js';
import { el, fmtMS, fmtTime, fmtDate, row, segmented, emptyState } from './ui.js';
import { attemptDetailCard, attemptSquare, legend, squareRow } from './squares.js';

const CHEVRON = '›';

function evalMark(evaluation) {
  const ev = EVAL_MAP[evaluation];
  // 評価が入っていない記録は、正解扱いにせず中立の印にする。
  if (!ev) return el('span', 'eval-mark', '?');
  return el('span', `eval-mark tone-${ev.tone}`, ev.symbol);
}

/* ------------------------------------------------------------------ */
/* 目次ビュー                                                          */
/* ------------------------------------------------------------------ */

function backRow(label, onClick) {
  return row({ title: `← ${label}`, onClick, classes: ['row-back'] });
}

async function tocView(screen) {
  const toc = state.records.toc;
  const all = [...state.questions.values()];
  const list = el('div', 'list');

  const go = (patch) => {
    Object.assign(toc, patch);
    render();
  };

  if (toc.questionId) {
    // 例題ごとの取り組み履歴。
    // 1回の取り組み＝1マス。同じ日に2回解いた分もまとめずに2マス出す。
    const attempts = await api.getQuestionAttempts(toc.questionId);
    const question = q(toc.questionId);
    list.append(backRow(toc.section, () => go({ questionId: null, attemptId: null })));
    screen.append(el('div', 'panel-head', question?.label ?? toc.questionId));

    if (!attempts.length) {
      list.append(emptyState('まだ解いていません'));
    } else {
      const last = attempts[attempts.length - 1];
      list.append(row({
        title: `取り組み ${attempts.length}回`,
        sub: [
          `直近 ${fmtDate(dayOf(last.timestamp))} ${EVAL_MAP[last.evaluation]?.label ?? '評価なし'}`,
          question ? question.type : null,
        ].filter(Boolean).join(' ・ '),
      }));
      // 古い順に並べる。マスはスケジュール画面と同じもの。
      const squares = attempts.map((record) => attemptSquare(record, {
        label: `${fmtDate(dayOf(record.timestamp))} ${qLabel(record.questionId)}`,
        onClick: () => {
          toc.attemptId = toc.attemptId === record.id ? null : record.id;
          render();
        },
      }));
      const wrap = el('div', 'attempt-history');
      wrap.append(squareRow(squares));
      list.append(wrap);
      const opened = attempts.find((record) => record.id === toc.attemptId);
      if (opened) list.append(attemptDetailCard(opened));
      for (const record of attempts) {
        const node = row({
          title: fmtDate(dayOf(record.timestamp)),
          sub: `${fmtTime(record.timestamp)}${record.challengeId ? ' ・ チャレンジ' : ''}`,
          right: el('span', 'row-time', fmtMS(record.durationSeconds)),
          onClick: () => {
            toc.attemptId = toc.attemptId === record.id ? null : record.id;
            render();
          },
        });
        node.prepend(evalMark(record.evaluation));
        list.append(node);
      }
    }
    screen.append(list);
    screen.append(legend());
    return;
  }

  if (toc.section) {
    const qs = all
      .filter((x) => x.chapter === toc.chapter && x.section === toc.section)
      .sort((a, b) => a.number - b.number);
    const latest = await api.getLatestEvaluations();
    list.append(backRow(toc.chapter, () => go({ section: null })));
    for (const item of qs) {
      const node = row({
        title: item.label,
        right: el('span', 'row-chevron', CHEVRON),
        onClick: () => go({ questionId: item.id }),
      });
      node.prepend(latest[item.id] ? evalMark(latest[item.id]) : el('span', 'eval-mark', '・'));
      list.append(node);
    }
    screen.append(list);
    return;
  }

  if (toc.chapter) {
    const sections = [...new Set(all.filter((x) => x.chapter === toc.chapter).map((x) => x.section))];
    list.append(backRow('章の一覧', () => go({ chapter: null })));
    for (const section of sections) {
      const count = all.filter((x) => x.chapter === toc.chapter && x.section === section).length;
      list.append(
        row({
          title: section,
          sub: `${count}問`,
          right: el('span', 'row-chevron', CHEVRON),
          onClick: () => go({ section }),
        })
      );
    }
    screen.append(list);
    return;
  }

  const chapters = [...new Set(all.map((x) => x.chapter))];
  if (!chapters.length) list.append(emptyState('問題データがありません（設定からインポート）'));
  for (const chapter of chapters) {
    const count = all.filter((x) => x.chapter === chapter).length;
    list.append(
      row({
        title: chapter,
        sub: `${count}問`,
        right: el('span', 'row-chevron', CHEVRON),
        onClick: () => go({ chapter }),
      })
    );
  }
  screen.append(list);
}

/* ------------------------------------------------------------------ */
/* 履歴ビュー                                                          */
/* ------------------------------------------------------------------ */

async function historyView(screen) {
  const f = state.records.filters;
  const filters = el('div', 'filters');

  const chapters = [...new Set([...state.questions.values()].map((x) => x.chapter))];
  const chapterSel = el('select');
  chapterSel.append(new Option('すべての章', ''));
  chapters.forEach((c) => chapterSel.append(new Option(c, c)));
  chapterSel.value = f.chapter;
  chapterSel.onchange = () => {
    f.chapter = chapterSel.value;
    f.section = '';
    render();
  };

  const sectionSel = el('select');
  sectionSel.append(new Option('すべての単元', ''));
  if (f.chapter) {
    [...new Set([...state.questions.values()].filter((x) => x.chapter === f.chapter).map((x) => x.section))]
      .forEach((s) => sectionSel.append(new Option(s, s)));
  }
  sectionSel.value = f.section ?? '';
  sectionSel.disabled = !f.chapter;
  sectionSel.onchange = () => {
    f.section = sectionSel.value;
    render();
  };

  const evalSel = el('select');
  evalSel.append(new Option('すべての評価', ''));
  EVALUATIONS.forEach((e) => evalSel.append(new Option(`${e.symbol} ${e.label}`, e.value)));
  evalSel.value = f.evaluation;
  evalSel.onchange = () => {
    f.evaluation = evalSel.value;
    render();
  };

  filters.append(chapterSel, sectionSel, evalSel);
  screen.append(filters);

  let records = await api.getStudyHistory({
    limit: 400,
    evaluation: f.evaluation || undefined,
    chapter: f.chapter || undefined,
  });
  if (f.section) records = records.filter((r) => q(r.questionId)?.section === f.section);

  const list = el('div', 'list');
  if (!records.length) list.append(emptyState('記録がありません'));

  let day = null;
  for (const r of records) {
    const d = dayOf(r.timestamp);
    if (d !== day) {
      day = d;
      list.append(el('div', 'section-head', fmtDate(d)));
    }
    const qq = q(r.questionId);
    const node = row({
      title: qLabel(r.questionId),
      sub: `${fmtTime(r.timestamp)}${qq ? ` ・ ${qq.chapter}` : ''}`,
      right: el('span', 'row-time', fmtMS(r.durationSeconds)),
      onClick: () => {
        Object.assign(state.records, { view: 'toc' });
        Object.assign(state.records.toc, {
          chapter: qq?.chapter ?? null,
          section: qq?.section ?? null,
          questionId: r.questionId,
        });
        render();
      },
    });
    node.prepend(evalMark(r.evaluation));
    list.append(node);
  }
  screen.append(list);
}

/* ------------------------------------------------------------------ */

export async function renderRecords(screen) {
  screen.innerHTML = '';
  const head = el('div', 'view-head');
  head.append(el('div', 'view-title', '記録'));
  screen.append(head);
  screen.append(
    segmented([['toc', '目次'], ['history', '履歴']], state.records.view, (v) => {
      state.records.view = v;
      render();
    })
  );
  if (state.records.view === 'toc') await tocView(screen);
  else await historyView(screen);
}
