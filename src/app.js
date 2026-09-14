// 起動・タブ切り替え・再描画のとりまとめ。
// 画面ごとの中身は home / records / schedule / settings が受け持つ。

import * as api from './api.js';
import { seedIfEmpty } from './seed.js';
import { state, setRenderer, render, refreshToday, loadTasks } from './state.js';
import { $ } from './ui.js';
import { heartbeatActivity, renderHome, tickHome } from './home.js';
import { renderRecords } from './records.js';
import { renderSchedule } from './schedule.js';
import { renderSettings, applyTheme } from './settings.js';
import { startCloudSync, syncInBackground } from './cloud-sync.js';

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
    m.setAttribute('aria-hidden', 'true');
    // Inline vectors stay available offline and inherit the selected tab color.
    const paths = {
      home: '<path d="M2 13 14 2l12 11-2 2-2-2v13h-6v-8h-4v8H6V13l-2 2z"/>',
      records: '<g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M10 5h15M10 14h15M10 23h15"/></g><circle cx="3" cy="5" r="1.6"/><circle cx="3" cy="14" r="1.6"/><circle cx="3" cy="23" r="1.6"/>',
      schedule: '<path d="M6 1h2v3h12V1h2v3h2a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H4a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h2zm-2 9v14h20V10z"/><path d="M7 13h3v3H7zm6 0h3v3h-3zm6 0h3v3h-3zM7 19h3v3H7zm6 0h3v3h-3zm6 0h3v3h-3z"/>',
      settings: '<path fill-rule="evenodd" d="m11 1 6 0 1 4 3 1 3-1 3 5-3 3v3l3 3-3 5-4-1-2 2-1 3h-6l-1-4-3-1-3 1-3-5 3-3v-3L1 10l3-5 4 1 2-2zm3 8a5 5 0 1 0 0 10 5 5 0 0 0 0-10"/>',
    };
    m.innerHTML = `<svg viewBox="0 0 28 28" fill="currentColor" focusable="false">${paths[name]}</svg>`;
    b.append(m, document.createTextNode(label));
    b.onclick = () => {
      // スケジュールは、タブを押すたびに今日を真ん中へ持ってくる。
      if (name === 'schedule') {
        state.schedule.selectedDate = null;
        state.schedule.centerToday = true;
      }
      state.tab = name;
      render();
      if (name === 'schedule') syncInBackground();
    };
    bar.append(b);
  }
}

function bindImportDialog() {
  const dlg = $('#dialog-import');
  $('#import-run').onclick = async () => {
    try {
      const parsed = JSON.parse($('#import-text').value);
      // Question[] でも { questions: [...] }（data/questions.json の形）でも受け取る。
      const list = Array.isArray(parsed) ? parsed : parsed?.questions;
      if (!Array.isArray(list)) throw new Error('Question の配列か { questions: [...] } を貼り付けてください');
      const replace = $('#import-replace')?.checked === true;
      // 手で入れたマスタは、本人がそうと決めたものなので、いまの版より1つ上にする。
      // こうしないと、同期のときサーバーの同じ版に負けて戻されてしまう。
      const n = await api.importQuestions(list, {
        replace,
        masterVersion: (await api.getQuestionMasterVersion()) + 1,
      });
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
  // 問題マスタの用意に失敗しても（初回オフラインなど）、
  // 既に入っている学習データは使えるよう、起動そのものは止めない。
  try {
    await seedIfEmpty();
  } catch (err) {
    console.warn('問題マスタを用意できませんでした:', err.message);
  }
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
  // 学習中であることを、ときどきクラウドへ送り直す（AIに動かされないため）。
  // 送れなくても学習は止まらない。
  setInterval(heartbeatActivity, 60 * 1000);
  heartbeatActivity();
  window.addEventListener('online', heartbeatActivity);
  window.addEventListener('pageshow', heartbeatActivity);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { tickHome(); heartbeatActivity(); }
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // クラウド同期は「追加の機能」。設定していなければ何も起きず、
  // 失敗しても学習機能には影響しない。
  window.addEventListener('study-todo-synced', async () => {
    await loadTasks();
    await refreshToday();
    render();
  });
  startCloudSync();
}

boot();
