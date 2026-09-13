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
      // スケジュールは、タブを押すたびに今日を真ん中へ持ってくる。
      if (name === 'schedule') {
        state.schedule.selectedDate = null;
        state.schedule.centerToday = true;
      }
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
  setInterval(heartbeatActivity, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tickHome();
  });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // クラウド同期は「追加の機能」。設定していなければ何も起きず、
  // 失敗しても学習機能には影響しない。
  startCloudSync();
}

boot();
