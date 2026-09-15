// 正方形のマス。スケジュールの週表示・日別の詳細・例題ごとの履歴で、
// すべて同じ見た目・同じ意味になるよう、ここだけで作る。
//
// マスは **色だけ** で表す。記号や数字は入れない。
// 1週間ぶんを1画面に収めたいので、小さく・すき間なく並べられることを優先している。
// 代わりに、押したときの説明・読み上げ用のラベル（aria-label）・設定タブのヘルプで
// 意味が分かるようにしてある。
//
//   実績のマス … 1回の取り組み。その回の評価の色で塗る。
//                評価が入っていない実績は、正解扱いにせず灰色にする。
//   予定のマス … まだやっていない1回ぶんの予定。枠だけにして実績と区別する。
//
// すき間なく並べても数えられるように、マスの右と下に背景色の細い区切りを入れている。

import { EVAL_MAP, EVALUATIONS, RECORD_SOURCE_LABELS, hasDuration, hasExactTime, recordDateOf } from './api.js';
import { q, qLabel } from './state.js';
import { el, fmtMS, fmtDate, fmtTime } from './ui.js';

/** 評価が入っていない実績の見せ方。正解にも不正解にも寄せない。 */
export const UNEVALUATED = { symbol: '?', label: '評価なし', tone: 'idle' };

const evalOf = (evaluation) => EVAL_MAP[evaluation] ?? null;

function baseSquare(classes) {
  const node = el('span', ['sq', ...classes].join(' '));
  node.setAttribute('role', 'img');
  return node;
}

function makeTappable(node, onClick) {
  if (!onClick) return node;
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
  return node;
}

/**
 * 実績のマス（1回の取り組み）。
 * 過去のマスは、その回の記録に入っている評価で塗る。あとで解き直しても変わらない。
 */
export function attemptSquare(record, { label = '', onClick = null } = {}) {
  const mark = evalOf(record.evaluation) ?? UNEVALUATED;
  const node = baseSquare(['sq-done', `tone-${mark.tone}`]);
  const text = `${label || qLabel(record.questionId)} ${mark.label}`
    + (hasDuration(record) ? ` ${fmtMS(record.durationSeconds)}` : ' 時間未登録')
    + (record.challengeId ? '（チャレンジ）' : '')
    + (record.source && record.source !== 'timer' ? '（あとから登録）' : '');
  node.setAttribute('aria-label', text);
  node.title = text;
  return makeTappable(node, onClick);
}

/**
 * 予定のマス（まだやっていない1回ぶん）。
 * 繰り越しかどうかは枠などの見た目では区別せず、説明文だけで示す。
 */
export function plannedSquare({ label = '', onClick = null, carriedOver = false } = {}) {
  const node = baseSquare(['sq-plan']);
  const text = `${label} 未実施の予定${carriedOver ? '（繰り越し）' : ''}`;
  node.setAttribute('aria-label', text);
  node.title = text;
  return makeTappable(node, onClick);
}

/** マスの並び。すき間なく並べ、多いときは折り返す（件数は省かない）。 */
export function squareRow(nodes, { label = null } = {}) {
  const wrap = el('div', `sq-row${nodes.length ? '' : ' is-empty'}`);
  if (label) wrap.append(el('span', 'sq-row-label', label));
  const strip = el('div', 'sq-strip');
  nodes.forEach((node) => strip.append(node));
  wrap.append(strip);
  return wrap;
}

/**
 * マスの見方（ヘルプ）。
 * 設定タブのいちばん下と、スケジュール右上の ℹ️ から、同じものを見せる。
 */
export function helpPanel() {
  const wrap = el('div', 'sq-help');
  wrap.append(el('div', 'sq-help-lead', 'マスは1つが「1回の取り組み」です。色は、その回の評価を表します。'));

  const list = el('div', 'sq-help-list');
  const item = (node, text) => {
    const line = el('div', 'sq-help-item');
    line.append(node, el('span', null, text));
    return line;
  };
  for (const ev of EVALUATIONS) {
    list.append(item(baseSquare(['sq-done', `tone-${ev.tone}`]), `${ev.symbol} ${ev.label}`));
  }
  list.append(item(baseSquare(['sq-done', 'tone-idle']), '評価なし（正解とは数えません）'));
  list.append(item(baseSquare(['sq-plan']), 'まだやっていない予定（ほかの日からの繰り越しも同じ見た目）'));
  wrap.append(list);

  wrap.append(el('div', 'sq-help-lead', '段は「例題」と「エクササイズ」に分かれています。'
    + 'チャレンジで解いた問題も、1問ずつエクササイズの段に並びます。'));
  wrap.append(el('div', 'sq-help-lead', '過ぎた日はその日に実際に取り組んだ記録、今日は実績と残りの予定、'
    + 'これからの日は予定が並びます。日付を押すと、その日の詳しい中身が見られます。'));
  return wrap;
}

/**
 * マスを押したときに出す、その1回の取り組みの中身。
 * スケジュールの詳細でも、例題ごとの履歴でも同じものを使う。
 */
export function attemptDetailCard(record, { planTitle = null, onDelete = null, onUndo = null } = {}) {
  const question = q(record.questionId);
  const ev = evalOf(record.evaluation) ?? UNEVALUATED;
  const card = el('div', 'attempt-detail');
  card.append(el('div', null, `${qLabel(record.questionId)}${question ? `（${question.type}）` : ''}`));
  if (question) {
    card.append(el('div', null, `${question.subject ?? ''} ${question.chapter ?? ''} ・ ${question.section ?? ''}`.trim()));
  }
  // 時刻が分からない記録に、それらしい時刻を出さない。
  card.append(el('div', null, `${fmtDate(recordDateOf(record))}${hasExactTime(record) ? ` ${fmtTime(record.timestamp)}` : '（時刻は未登録）'}`));
  card.append(el('div', null, `評価: ${record.evaluation ? `${ev.symbol} ${ev.label}` : '未登録'}`));
  card.append(el('div', null, `所要時間: ${hasDuration(record) ? fmtMS(record.durationSeconds)
    : (record.durationGroup ? `未登録（まとまりで ${fmtMS(record.durationGroup.totalSeconds)}）` : '未登録')}`));
  card.append(el('div', null, record.challengeId ? 'チャレンジの中で解いた' : '通常の学習'));
  if (Number.isFinite(record.solveSeconds) && Number.isFinite(record.reviewSeconds)) {
    card.append(el('div', null, `解答: ${fmtMS(record.solveSeconds)} ／ 採点・暗記: ${fmtMS(record.reviewSeconds)}`));
  }
  if (onUndo) {
    const undo = el('button', 'btn', '未着手に戻す');
    undo.onclick = () => onUndo(record);
    card.append(undo);
  }
  // どうやって入った記録か。あとから足した分・訂正した分が分かるようにする。
  card.append(el('div', null, `記録: ${RECORD_SOURCE_LABELS[record.source ?? 'timer']}`
    + (record.enteredBy ? `（${record.enteredBy}）` : '')));
  if (record.claimSummary) card.append(el('div', null, `申告: ${record.claimSummary}`));
  for (const correction of (record.corrections ?? []).slice(-3)) {
    const changed = Object.keys(correction.after ?? {}).join('・') || '内容';
    card.append(el('div', null, `訂正: ${correction.at ? new Date(correction.at).toLocaleString('ja-JP') : ''}`
      + ` ${changed}${correction.reason ? `（${correction.reason}）` : ''}`));
  }
  if (planTitle) card.append(el('div', null, `対応する予定: ${planTitle}`));
  else if (!record.planItemId) card.append(el('div', null, '対応する予定: 分かりません（以前の形式の記録）'));
  // 間違って入れた記録を、本人がここから取り消せるようにする。

  // 間違って入った記録を、本人がここから消せるようにする。
  // 印をつけるのではなく本当に消し、他の端末からも消える。
  if (onDelete) {
    const actions = el('div', 'setting-actions');
    const button = el('button', 'link-btn danger-link', record.challengeId
      ? 'この1問の記録を削除'
      : 'この記録を削除');
    button.onclick = () => onDelete(record);
    actions.append(button);
    card.append(actions);
  }
  return card;
}
