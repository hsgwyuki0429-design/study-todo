// 記録タブ。章 → 単元 → 例題 とたどって、その例題の取り組み履歴を見る。
//
// 「いつ何をやったか」はスケジュールの過ぎた日で分かるので、時系列の一覧はここには置かない。
// ここが受け持つのは「この問題を、これまで何回、どうだったか」だけである。

import * as api from './api.js';
import { EVAL_MAP, RECORD_SOURCE_LABELS, hasDuration, hasExactTime, recordDateOf } from './api.js';
import { state, q, qLabel, render } from './state.js';
import { el, fmtMS, fmtTime, fmtDate, row, emptyState } from './ui.js';
import { attemptDetailCard, attemptSquare, squareRow } from './squares.js';

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
          `直近 ${fmtDate(recordDateOf(last))} ${EVAL_MAP[last.evaluation]?.label ?? '評価は未登録'}`,
          question ? question.type : null,
        ].filter(Boolean).join(' ・ '),
      }));
      // 古い順に並べる。マスはスケジュール画面と同じもの。
      const squares = attempts.map((record) => attemptSquare(record, {
        label: `${fmtDate(recordDateOf(record))} ${qLabel(record.questionId)}`,
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
          title: fmtDate(recordDateOf(record)),
          sub: [
            hasExactTime(record) ? fmtTime(record.timestamp) : '時刻は未登録',
            record.challengeId ? 'チャレンジ' : null,
            record.source && record.source !== 'timer' ? RECORD_SOURCE_LABELS[record.source] : null,
          ].filter(Boolean).join(' ・ '),
          right: el('span', 'row-time', hasDuration(record) ? fmtMS(record.durationSeconds) : '—'),
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

export async function renderRecords(screen) {
  screen.innerHTML = '';
  const head = el('div', 'view-head');
  head.append(el('div', 'view-title', '記録'));
  screen.append(head);
  // 時系列の一覧は置かない。「いつ何をやったか」はスケジュールの過ぎた日で分かるので、
  // ここは「この問題をこれまで何回どうだったか」だけを受け持つ。
  await tocView(screen);
}
