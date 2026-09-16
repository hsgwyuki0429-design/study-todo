// DOM とフォーマットの小道具。

export const $ = (sel) => document.querySelector(sel);

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export const pad = (n) => String(Math.floor(n)).padStart(2, '0');

export function fmtMS(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

export function fmtShort(seconds) {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60}分`;
}

export function fmtTime(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const fmtDate = (key) => key.replace(/-/g, '/');

/** 一覧の行。押せる行は button、押せない行は div にする。 */
export function row({ title, sub, right, onClick, classes = [] }) {
  const node = el(onClick ? 'button' : 'div', ['row', ...classes].join(' '));
  const main = el('div', 'row-main');
  if (title != null) main.append(el('div', 'row-title', title));
  if (sub != null) main.append(el('div', 'row-sub', sub));
  node.append(main);
  if (right) node.append(...(Array.isArray(right) ? right : [right]));
  if (onClick) node.onclick = onClick;
  return node;
}

// この画面にいまある segmented() が最後にどの値を選んでいたか。
// render() のたびにバー全体を作り直すので、タップで切り替えたときも
// 「前の位置→今の位置」へ滑らせるために、作り直しをまたいで覚えておく。
// 1画面に複数のバー（やること／やったこと、再生スライダーなど）が同時に
// あっても混ざらないよう、呼び出し側が渡す key ごとに分けて覚える。
const lastSegmentedState = new Map();

/**
 * やること／やったことの切り替えバー（や、同じ仕組みの再生スライダーなど）。
 * 選ばれている側の背景（丸い光）は独立した要素（thumb）にして、指でつまんで
 * 動かしているあいだはその指にそのままついてくるようにする。
 * 離した位置で近いほうへ切り替わる。
 *
 * タップやスワイプなど、バーの外からの切り替えでも、前の位置から今の位置へ
 * 光が滑って見えるようにする（render() のたびにバーを作り直すため）。
 */
export function segmented(options, current, onSelect, key = 'default') {
  const prev = lastSegmentedState.get(key);
  const previousValue = prev?.value ?? null;
  const changedByDrag = prev?.viaDrag ?? false;
  lastSegmentedState.set(key, { value: current, viaDrag: false });

  const bar = el('div', 'segmented');
  const thumb = el('div', 'segmented-thumb');
  bar.append(thumb);
  const buttons = options.map(([value, label]) => {
    const b = el('button', null, label);
    b.setAttribute('aria-selected', String(value === current));
    b.onclick = () => onSelect(value);
    bar.append(b);
    return b;
  });

  const indexOf = (value) => options.findIndex(([v]) => v === value);
  const placeThumb = (index, animate) => {
    const btn = buttons[index];
    if (!btn) return;
    thumb.style.transition = animate ? '' : 'none';
    thumb.style.width = `${btn.offsetWidth}px`;
    thumb.style.height = `${btn.offsetHeight}px`;
    thumb.style.transform = `translate(${btn.offsetLeft}px, ${btn.offsetTop}px)`;
  };
  // フォントや画面幅でボタンの実寸が決まるのはレイアウト確定後なので、
  // 初期位置合わせは次のフレームで行う。
  requestAnimationFrame(() => {
    if (previousValue != null && previousValue !== current && !changedByDrag) {
      // まず前回の位置へ置いてから、次のフレームでアニメーションさせて滑らせる。
      placeThumb(indexOf(previousValue), false);
      requestAnimationFrame(() => placeThumb(indexOf(current), true));
    } else {
      placeThumb(indexOf(current), false);
    }
  });

  // このバー上で始まった指の動きは、外側（一覧全体のスワイプ）へ伝えない。
  // 伝わると同じ操作で二重に切り替わってしまう。
  let dragStartX = null, dragBaseLeft = 0, dragging = false;
  bar.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    dragging = true;
    dragStartX = e.touches[0].clientX;
    dragBaseLeft = buttons[indexOf(current)]?.offsetLeft ?? 0;
    thumb.style.transition = 'none';
    e.stopPropagation();
  }, { passive: true });
  bar.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const dx = e.touches[0].clientX - dragStartX;
    const max = bar.clientWidth - thumb.offsetWidth;
    const left = Math.min(max, Math.max(0, dragBaseLeft + dx));
    thumb.style.transform = `translate(${left}px, ${buttons[indexOf(current)]?.offsetTop ?? 0}px)`;
    e.stopPropagation();
  }, { passive: true });
  bar.addEventListener('touchend', (e) => {
    if (!dragging) return;
    dragging = false;
    const dx = e.changedTouches[0].clientX - dragStartX;
    const from = indexOf(current);
    const to = Math.min(buttons.length - 1, Math.max(0, from + (dx > 30 ? 1 : dx < -30 ? -1 : 0)));
    if (to !== from) { lastSegmentedState.set(key, { value: options[to][0], viaDrag: true }); onSelect(options[to][0]); }
    else placeThumb(from, true);
    e.stopPropagation();
  }, { passive: true });
  bar.addEventListener('touchcancel', (e) => {
    if (!dragging) return;
    dragging = false;
    placeThumb(indexOf(current), true);
    e.stopPropagation();
  }, { passive: true });

  return bar;
}

/**
 * 左右のスワイプでも切り替えられるようにする。
 *
 * 縦スクロールを邪魔しないように、横の動きが縦よりはっきり大きいときだけ反応する。
 * ボタンを押す操作はそのまま残るので、押しても滑らせても同じ結果になる。
 */
export function swipeable(node, values, current, onSelect) {
  let x = null, y = null;
  node.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { x = null; return; }
    x = e.touches[0].clientX; y = e.touches[0].clientY;
  }, { passive: true });
  node.addEventListener('touchend', (e) => {
    if (x == null) return;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - x, dy = touch.clientY - y;
    x = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const index = values.indexOf(current) + (dx < 0 ? 1 : -1);
    if (index >= 0 && index < values.length) onSelect(values[index]);
  }, { passive: true });
  return node;
}

export function emptyState(text) {
  return el('div', 'empty', text);
}
