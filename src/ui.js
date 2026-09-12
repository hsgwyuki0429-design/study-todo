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

export function segmented(options, current, onSelect) {
  const bar = el('div', 'segmented');
  for (const [value, label] of options) {
    const b = el('button', null, label);
    b.setAttribute('aria-selected', String(value === current));
    b.onclick = () => onSelect(value);
    bar.append(b);
  }
  return bar;
}

export function emptyState(text) {
  return el('div', 'empty', text);
}
