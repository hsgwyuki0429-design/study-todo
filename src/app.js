// 起動・タブ切り替え・再描画のとりまとめ。
// 画面ごとの中身は home / records / schedule / settings が受け持つ。

import * as api from './api.js';
import { seedIfEmpty } from './seed.js';
import { state, setRenderer, render, refreshToday, loadTasks } from './state.js';
import { $ } from './ui.js';
import { renderHome, tickHome } from './home.js';
import { renderRecords } from './records.js';
import { renderSchedule } from './schedule.js';
import { renderSettings, applyTheme } from './settings.js';
import { startCloudSync } from './cloud-sync.js';

const TABS = [
  ['home', 'ホーム', '■'],
  ['records', '記録', '≡'],
  ['schedule', 'スケジュール', '▤'],
  ['settings', '設定', '⚙'],
];

// 非同期の描画が交錯しても、最後に呼ばれたものだけを反映する
let renderSeq = 0;

function renderAll() {
  const seq = ++renderSeq;
  for (const [name] of TABS) $(`#screen-${name}`).hidden = state.tab !== name;
  document.querySelectorAll('.tabbar button').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.tab === state.tab))
  );

  const screen = $(`#screen-${state.tab}`);
  if (state.tab === 'home') {
    renderHome(screen);
    return;
  }

  const build =
    state.tab === 'records' ? renderRecords
      : state.tab === 'schedule' ? renderSchedule
        : renderSettings;

  // いったん切り離した入れ物に組み立ててから差し替える
  const holder = document.createElement('div');
  build(holder).then(() => {
    if (seq === renderSeq) screen.replaceChildren(...holder.childNodes);
  });
}

function buildTabBar() {
  const bar = $('.tabbar');
  bar.innerHTML = '';
  for (const [name, label, mark] of TABS) {
    const b = document.createElement('button');
    b.setAttribute('role', 'tab');
    b.dataset.tab = name;
    const m = document.createElement('span');
    m.className = 'tab-mark';
    m.textContent = mark;
    b.append(m, document.createTextNode(label));
    b.onclick = () => {
      state.tab = name;
      render();
    };
    bar.append(b);
  }
}

function bindImportDialog() {
  const dlg = $('#dialog-import');
  $('#import-run').onclick = async () => {
    try {
      const n = await api.importQuestions(JSON.parse($('#import-text').value));
      await loadQuestions();
      dlg.close();
      alert(`${n}問を取り込みました`);
      render();
    } catch (err) {
      alert(`読み込めませんでした: ${err.message}`);
    }
  };
}

async function loadQuestions() {
  const qs = await api.listQuestions();
  state.questions = new Map(qs.map((x) => [x.id, x]));
}

async function boot() {
  await seedIfEmpty();
  state.settings = await api.getSettings();
  applyTheme();
  await loadQuestions();
  await loadTasks();
  await refreshToday();
  state.session = await api.getSessionState();

  setRenderer(renderAll);
  buildTabBar();
  bindImportDialog();
  render();

  setInterval(tickHome, 250);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tickHome();
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // クラウド同期は「追加の機能」。設定していなければ何も起きず、
  // 失敗しても学習機能には影響しない。
  startCloudSync();
}

boot();
