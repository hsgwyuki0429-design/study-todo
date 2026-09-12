// 設定タブ。

import * as api from './api.js';
import { state, render } from './state.js';
import { el, row, emptyState } from './ui.js';

async function update(patch) {
  state.settings = await api.saveSettings({ ...state.settings, ...patch });
  applyTheme();
  render();
}

export function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

function choiceRow(title, sub, options, current, onSelect, disabled = false) {
  const item = el('div', `setting${disabled ? ' disabled' : ''}`);
  const head = el('div', 'setting-head');
  head.append(el('div', 'row-title', title));
  if (sub) head.append(el('div', 'row-sub', sub));
  item.append(head);
  const choices = el('div', 'choices');
  for (const [value, label] of options) {
    const b = el('button', 'choice', label);
    b.setAttribute('aria-selected', String(value === current));
    b.disabled = disabled;
    b.onclick = () => onSelect(value);
    choices.append(b);
  }
  item.append(choices);
  return item;
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = el('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export async function renderSettings(screen) {
  screen.innerHTML = '';
  const head = el('div', 'view-head');
  head.append(el('div', 'view-title', '設定'));
  screen.append(head);

  const list = el('div', 'list');

  list.append(el('div', 'section-head', 'カレンダー'));
  list.append(
    choiceRow('表示方式', '日ごとの達成率の見せ方',
      [['ring', 'リング型'], ['fill', '塗り型']],
      state.settings.calendarStyle,
      (v) => update({ calendarStyle: v }))
  );
  list.append(
    choiceRow('塗り型のカラーバリエーション', '塗り型を選んでいるときのみ有効',
      [['random', 'ランダム'], ['month', '月ごと'], ['week', '週ごと']],
      state.settings.fillVariation,
      (v) => update({ fillVariation: v }),
      state.settings.calendarStyle !== 'fill')
  );

  list.append(el('div', 'section-head', '表示'));
  list.append(
    choiceRow('ダークモード', null,
      [['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']],
      state.settings.theme,
      (v) => update({ theme: v }))
  );

  list.append(el('div', 'section-head', '問題データの管理'));
  const info = await api.getAppInfo();
  list.append(
    row({
      title: '目次（問題マスタ）',
      sub: `${info.questionCount}問 ・ ${info.subjects.map((s) => s.subject).join('、') || '未登録'}`,
    })
  );
  for (const subject of info.subjects) {
    for (const ch of subject.chapters) {
      list.append(row({ title: ch.chapter, sub: ch.sections.join(' ・ '), classes: ['row-indent'] }));
    }
  }
  const importBtn = el('button', 'btn', '問題をインポート');
  importBtn.onclick = () => document.querySelector('#dialog-import').showModal();
  const importWrap = el('div', 'setting-actions');
  importWrap.append(importBtn);
  list.append(importWrap);

  list.append(el('div', 'section-head', 'データのバックアップ'));
  const exportBtn = el('button', 'btn', 'JSONで書き出す');
  exportBtn.onclick = async () => {
    const data = await api.exportAll();
    download(`aochart-${api.todayKey()}.json`, JSON.stringify(data, null, 2));
  };
  const exportWrap = el('div', 'setting-actions');
  exportWrap.append(exportBtn);
  list.append(exportWrap);

  list.append(el('div', 'section-head', 'MCP連携'));
  list.append(
    row({
      title: '接続状況',
      sub: 'アプリ内で完結（未接続）',
      right: el('span', 'state-pill', '未接続'),
    })
  );
  list.append(
    row({
      title: 'データ形式のバージョン',
      sub: 'MCPサーバーが参照するスキーマの版',
      right: el('span', 'row-time', info.dataVersion),
    })
  );

  screen.append(list);
}
