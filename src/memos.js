// AIメモの画面。設定の「AIメモ」と、問題の詳細（記録タブ）に出す小さな一覧の両方を作る。
//
// メモを足せるのはAIだけで、ここで利用者ができるのは「解決済みにする」「戻す」「削除」。
// 変えたあとは同期の控えに積まれ、クラウドとほかの端末へ届く。

import * as api from './api.js';
import { MEMO_CATEGORIES, MEMO_CATEGORY_LABELS, MEMO_STATUS_LABELS } from './ai-memos.js';
import { qLabel, render } from './state.js';
import { el, fmtDate } from './ui.js';
import { syncInBackground } from './cloud-sync.js';

// 画面を作り直しても選び直さずに済むよう、いま見ている種類と状態を覚えておく。
const view = { category: 'all', status: 'active' };

const AI_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" focusable="false">'
  + '<path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z"/><path d="M13 11l.7 1.8 1.8.7-1.8.7L13 16l-.7-1.8-1.8-.7 1.8-.7z"/></svg>';

const dateOf = (iso) => fmtDate((iso ?? '').slice(0, 10) || '----/--/--');

/** 「AI」を示す小さなアイコン（author.kind が ai のメモに付ける）。 */
function aiBadge(author) {
  const badge = el('span', 'memo-ai');
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', 'AIが書いたメモ');
  badge.title = author?.name ? `AI（${author.name}）` : 'AI';
  badge.innerHTML = AI_ICON;
  return badge;
}

function memoHead(memo) {
  const head = el('div', 'memo-head');
  if (memo.pinned) head.append(el('span', 'memo-pin', '固定'));
  head.append(el('span', 'memo-category', MEMO_CATEGORY_LABELS[memo.category] ?? memo.category));
  if (memo.author?.kind === 'ai') head.append(aiBadge(memo.author));
  head.append(el('span', 'memo-date', `${dateOf(memo.updatedAt)}${memo.author?.name ? ` ・ ${memo.author.name}` : ''}`));
  return head;
}

async function changed() {
  syncInBackground();
  render();
}

function memoCard(memo) {
  const card = el('article', `memo${memo.status !== 'active' ? ' memo-done' : ''}`);
  card.append(memoHead(memo));
  card.append(el('div', 'memo-body', memo.body));
  if (memo.questionIds?.length) {
    const shown = memo.questionIds.slice(0, 6).map(qLabel);
    const rest = memo.questionIds.length - shown.length;
    card.append(el('div', 'memo-meta', `問題: ${shown.join('、')}${rest > 0 ? ` ほか${rest}件` : ''}`));
  }
  const actions = el('div', 'memo-actions');
  const toggle = el('button', 'btn', memo.status === 'active' ? '解決済みにする' : '有効に戻す');
  toggle.onclick = async () => {
    await api.setMemoStatus(memo.id, memo.status === 'active' ? 'resolved' : 'active');
    await changed();
  };
  const remove = el('button', 'btn btn-danger', '削除');
  remove.onclick = async () => {
    if (!confirm('このメモを削除します。ほかの端末からも消え、元に戻せません。よろしいですか？')) return;
    await api.deleteMemo(memo.id);
    await changed();
  };
  actions.append(toggle, remove);
  card.append(actions);
  return card;
}

function choiceBar(options, current, onSelect) {
  const bar = el('div', 'choices memo-choices');
  for (const [value, label] of options) {
    const button = el('button', 'choice', label);
    button.setAttribute('aria-selected', String(value === current));
    button.onclick = () => onSelect(value);
    bar.append(button);
  }
  return bar;
}

/** 設定の「AIメモ」の中身。種類のタブ・pinned が先頭・解決済みにする／削除。 */
export async function renderMemoPanel(list) {
  const all = await api.listMemos();
  const counts = { all: 0 };
  for (const memo of all) {
    if (memo.status !== view.status) continue;
    counts.all += 1;
    counts[memo.category] = (counts[memo.category] ?? 0) + 1;
  }

  list.append(el('div', 'dialog-note memo-intro',
    'AIが予定を組み直したときに残した気づきです。次にAIが呼ばれたとき、これを読んで判断を引き継ぎます。'
    + '古くなったものは「解決済みにする」、不要なものは削除してください。'));

  list.append(choiceBar(
    [['active', MEMO_STATUS_LABELS.active], ['resolved', MEMO_STATUS_LABELS.resolved]],
    view.status,
    (status) => { view.status = status; render(); },
  ));
  list.append(choiceBar(
    [['all', `すべて ${counts.all}`], ...MEMO_CATEGORIES.map((key) => [key, `${MEMO_CATEGORY_LABELS[key]} ${counts[key] ?? 0}`])],
    view.category,
    (category) => { view.category = category; render(); },
  ));

  const shown = all.filter((memo) => memo.status === view.status
    && (view.category === 'all' || memo.category === view.category));
  if (!shown.length) {
    list.append(el('div', 'empty', view.status === 'active' ? 'メモはまだありません' : '解決済みのメモはありません'));
    return;
  }
  const wrap = el('div', 'memo-list');
  for (const memo of shown) wrap.append(memoCard(memo));
  list.append(wrap);
}

/**
 * 問題の詳細に出す、その問題IDを含む有効なメモ（小さく、最大3件）。
 * 解決済み・保管のメモは出さない。1件も無ければ何も足さない。
 */
export async function renderQuestionMemos(list, questionId, { max = 3 } = {}) {
  const memos = await api.listMemos({ status: 'active', questionId });
  if (!memos.length) return;
  const box = el('div', 'memo-mini');
  box.append(el('div', 'memo-mini-title', `AIメモ ${memos.length}件`));
  for (const memo of memos.slice(0, max)) {
    const item = el('div', 'memo-mini-item');
    item.append(memoHead(memo), el('div', 'memo-mini-body', memo.body));
    box.append(item);
  }
  if (memos.length > max) box.append(el('div', 'memo-meta', `ほか${memos.length - max}件は 設定 → AIメモ で読めます`));
  list.append(box);
}
