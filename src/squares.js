// 正方形のマス。スケジュールの週間カレンダー・日別の詳細・例題ごとの履歴で、
// すべて同じ見た目・同じ意味になるよう、ここだけで作る。
//
// マスの意味は3つしかない。
//
//   実績のマス   … 1回の取り組み。その回の評価の色と記号で塗る。
//                  評価が入っていない実績は、正解扱いにせず中立の表示にする。
//   予定のマス   … まだやっていない1回ぶんの予定。枠だけで、実績と見分けられる。
//   チャレンジ   … 1回のチャレンジで1マス。中を評価の割合で塗り分ける。
//                  単一の評価を勝手に当てはめない。
//
// 色だけに頼らないよう、記号（◯解記△✕）と読み上げ用のラベルを必ず付ける。

import { EVAL_MAP, EVALUATIONS, dayOf } from './api.js';
import { q, qLabel } from './state.js';
import { el, fmtMS, fmtDate, fmtTime } from './ui.js';

/** 評価が入っていない実績の見せ方。正解にも不正解にも寄せない。 */
export const UNEVALUATED = { symbol: '?', label: '評価なし', tone: 'idle' };

const evalOf = (evaluation) => EVAL_MAP[evaluation] ?? null;

function baseSquare(classes, text) {
  const node = el('span', ['sq', ...classes].join(' '), text);
  node.setAttribute('role', 'img');
  return node;
}

/**
 * 実績のマス（通常の問題を1回解いた分）。
 * 過去のマスは、その回の記録に入っている評価で塗る。あとで解き直しても変わらない。
 */
export function attemptSquare(record, { label = '', onClick = null } = {}) {
  const ev = evalOf(record.evaluation);
  const mark = ev ?? UNEVALUATED;
  const node = baseSquare(['sq-done', `tone-${mark.tone}`], mark.symbol);
  const text = `${label || record.questionId} ${mark.symbol} ${mark.label}${
    record.durationSeconds ? ` ${fmtMS(record.durationSeconds)}` : ''}`;
  node.setAttribute('aria-label', text);
  node.title = text;
  if (onClick) {
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.onclick = onClick;
    node.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onClick(event);
      }
    };
    node.classList.add('sq-tappable');
  }
  return node;
}

/** 予定のマス（まだやっていない1回ぶん）。枠だけにして実績と区別する。 */
export function plannedSquare({ label = '', onClick = null, carriedOver = false } = {}) {
  const node = baseSquare(['sq-plan', ...(carriedOver ? ['sq-carried'] : [])], '');
  const text = `${label} 未実施の予定${carriedOver ? '（繰り越し）' : ''}`;
  node.setAttribute('aria-label', text);
  node.title = text;
  if (onClick) {
    node.onclick = onClick;
    node.classList.add('sq-tappable');
  }
  return node;
}

/**
 * チャレンジのマス。1回のチャレンジで1マス。
 * 中を「その回に含まれる問題の評価の割合」で塗り分ける。
 * 評価が入っていない問題ぶんは中立の色にして、正解として数えない。
 */
export function challengeSquare(result, { title = 'チャレンジ', onClick = null } = {}) {
  const laps = Array.isArray(result?.laps) ? result.laps : [];
  const counts = new Map();
  for (const lap of laps) {
    const key = lap.evaluation && EVAL_MAP[lap.evaluation] ? lap.evaluation : 'unevaluated';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = laps.length;
  const node = baseSquare(['sq-challenge'], '');

  if (!total) {
    node.classList.add('tone-idle');
  } else {
    // 上から順に、割合ぶんの帯を重ねる（円グラフより小さくても読み取りやすい）。
    const order = [...EVALUATIONS.map((e) => e.value), 'unevaluated'];
    const stops = [];
    let at = 0;
    for (const key of order) {
      const count = counts.get(key) ?? 0;
      if (!count) continue;
      const next = at + (count / total) * 100;
      const tone = key === 'unevaluated' ? 'idle' : EVAL_MAP[key].tone;
      stops.push(`var(--tone-${tone}) ${at.toFixed(2)}% ${next.toFixed(2)}%`);
      at = next;
    }
    node.style.background = `linear-gradient(to bottom, ${stops.join(', ')})`;
  }

  const summary = [...counts.entries()]
    .map(([key, count]) => `${key === 'unevaluated' ? UNEVALUATED.label : EVAL_MAP[key].label} ${count}問`)
    .join('、');
  const text = `${title} ${total}問${summary ? ` ・ ${summary}` : ''}`;
  node.setAttribute('aria-label', text);
  node.title = text;
  node.append(el('span', 'sq-badge', String(total || '')));
  if (onClick) {
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.onclick = onClick;
    node.classList.add('sq-tappable');
  }
  return node;
}

/** チャレンジの予定（まだやっていない回）。 */
export function plannedChallengeSquare(task, { onClick = null } = {}) {
  const count = (task.questionIds ?? []).length;
  const node = baseSquare(['sq-plan', 'sq-challenge'], '');
  const text = `${task.title ?? 'チャレンジ'} ${count}問 未実施の予定`;
  node.setAttribute('aria-label', text);
  node.title = text;
  node.append(el('span', 'sq-badge', String(count || '')));
  if (onClick) {
    node.onclick = onClick;
    node.classList.add('sq-tappable');
  }
  return node;
}

/** マスの並び。多い日は折り返して伸びる（件数を黙って省かない）。 */
export function squareRow(nodes) {
  const wrap = el('div', 'sq-row');
  nodes.forEach((node) => wrap.append(node));
  return wrap;
}

/** 色だけに頼らないための凡例。 */
export function legend() {
  const wrap = el('div', 'sq-legend');
  for (const ev of EVALUATIONS) {
    const item = el('span', 'sq-legend-item');
    item.append(baseSquare(['sq-done', `tone-${ev.tone}`], ev.symbol), el('span', null, ev.label));
    wrap.append(item);
  }
  const unevaluated = el('span', 'sq-legend-item');
  unevaluated.append(baseSquare(['sq-done', 'tone-idle'], UNEVALUATED.symbol), el('span', null, UNEVALUATED.label));
  const planned = el('span', 'sq-legend-item');
  planned.append(baseSquare(['sq-plan'], ''), el('span', null, '未実施の予定'));
  const challenge = el('span', 'sq-legend-item');
  challenge.append(baseSquare(['sq-challenge', 'tone-idle'], ''), el('span', null, 'チャレンジ（1回で1マス）'));
  wrap.append(unevaluated, planned, challenge);
  return wrap;
}


/**
 * マスを押したときに出す、その1回の取り組みの中身。
 * スケジュールの詳細でも、例題ごとの履歴でも同じものを使う。
 */
export function attemptDetailCard(record, { planTitle = null } = {}) {
  const question = q(record.questionId);
  const ev = evalOf(record.evaluation) ?? UNEVALUATED;
  const card = el('div', 'attempt-detail');
  card.append(el('div', null, `${qLabel(record.questionId)}${question ? `（${question.type}）` : ''}`));
  if (question) {
    card.append(el('div', null, `${question.subject ?? ''} ${question.chapter ?? ''} ・ ${question.section ?? ''}`.trim()));
  }
  card.append(el('div', null, `${fmtDate(dayOf(record.timestamp))} ${fmtTime(record.timestamp)}`));
  card.append(el('div', null, `評価: ${ev.symbol} ${ev.label}`));
  card.append(el('div', null, `所要時間: ${fmtMS(record.durationSeconds)}`));
  card.append(el('div', null, record.challengeId ? 'チャレンジの中で解いた' : '通常の学習'));
  if (planTitle) card.append(el('div', null, `対応する予定: ${planTitle}`));
  else if (!record.planItemId) card.append(el('div', null, '対応する予定: 分かりません（以前の形式の記録）'));
  return card;
}
