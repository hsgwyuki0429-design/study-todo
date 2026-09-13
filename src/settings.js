// 設定タブ。

import * as api from './api.js';
import { state, render } from './state.js';
import { el, row } from './ui.js';
import { renderCloudCard } from './settings-cloud.js';
import { renderAvailabilityCard, renderGoalCard } from './settings-plan.js';
import { countDemoStudyData, removeDemoStudyData, loadQuestionMaster } from './seed.js';

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

  // カレンダーは週ぎめの正方形のマスに統一したため、
  // 月表示の「リング型／塗り型」の切り替えは無くなった。
  // 保存済みの設定値は消さずに残してある（古いバックアップもそのまま読める）。
  await renderGoalCard(list, render);
  await renderAvailabilityCard(list, render);

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
      title: '問題マスタ',
      sub: `${info.questionCount}問 ・ ${info.books.join('、') || '冊の情報なし'}`,
    })
  );
  if (info.courses?.length) {
    list.append(
      row({
        title: 'SELECT STUDY',
        sub: info.courses.join(' ・ '),
        classes: ['row-indent'],
      })
    );
  }
  if (info.questionTypes.length) {
    list.append(
      row({
        title: '種類ごとの問題数',
        sub: info.questionTypes.map((t) => `${t.type} ${t.count}問`).join(' ・ '),
        classes: ['row-indent'],
      })
    );
  }
  for (const subject of info.subjects) {
    list.append(el('div', 'section-head', subject.subject));
    for (const ch of subject.chapters) {
      const total = ch.sectionDetails.reduce((sum, sd) => sum + sd.questionCount, 0);
      list.append(row({ title: ch.chapter, sub: `${total}問` }));
      for (const sd of ch.sectionDetails) {
        list.append(
          row({
            title: sd.section,
            sub: `${sd.questionCount}問${sd.page ? ` ・ p.${sd.page}〜` : ''}`,
            classes: ['row-indent'],
          })
        );
      }
    }
  }

  const importBtn = el('button', 'btn', '問題をインポート');
  importBtn.onclick = () => document.querySelector('#dialog-import').showModal();
  const reloadBtn = el('button', 'btn', '同梱の問題マスタを読み直す');
  reloadBtn.onclick = async () => {
    if (!confirm('data/questions.json の内容で問題マスタを置き換えます。学習記録・予定・目標は消えません。')) return;
    try {
      const master = await loadQuestionMaster();
      const n = await api.importQuestions(master.questions, { replace: true });
      alert(`${n}問を読み込みました`);
      render();
    } catch (err) {
      alert(`読み込めませんでした: ${err.message}`);
    }
  };
  const importWrap = el('div', 'setting-actions');
  importWrap.append(importBtn, reloadBtn);
  list.append(importWrap);

  // 以前の版が入れていた確認用のサンプル。本物の成績ではないので、明示的に消せるようにする。
  const demo = await countDemoStudyData();
  const demoTotal = demo.records + demo.tasks + demo.goals + demo.questions;
  if (demoTotal > 0) {
    list.append(el('div', 'section-head', 'サンプル（デモ）データ'));
    list.append(
      row({
        title: '動作確認用のデータが残っています',
        sub: `学習記録${demo.records}件 ・ 予定${demo.tasks}件 ・ 目標${demo.goals}件 ・ 問題${demo.questions}問。これは実際の学習の記録ではありません。`,
      })
    );
    const purgeBtn = el('button', 'btn btn-danger', 'サンプルデータを削除');
    purgeBtn.onclick = async () => {
      if (!confirm('サンプルの学習記録・予定・目標・問題だけを削除します。本物の記録は残ります。よろしいですか？')) return;
      const removed = await removeDemoStudyData();
      alert(`削除しました（記録${removed.records} / 予定${removed.tasks} / 目標${removed.goals} / 問題${removed.questions}）`);
      render();
    };
    const purgeWrap = el('div', 'setting-actions');
    purgeWrap.append(purgeBtn);
    list.append(purgeWrap);
  }

  list.append(el('div', 'section-head', 'データのバックアップ'));
  const exportBtn = el('button', 'btn', 'JSONで書き出す');
  exportBtn.onclick = async () => {
    const data = await api.exportAll();
    download(`aochart-${api.todayKey()}.json`, JSON.stringify(data, null, 2));
  };
  const exportWrap = el('div', 'setting-actions');
  exportWrap.append(exportBtn);
  list.append(exportWrap);

  await renderCloudCard(list, render);

  list.append(
    row({
      title: 'データ形式のバージョン',
      sub: 'MCPサーバーが参照するスキーマの版',
      right: el('span', 'row-time', info.dataVersion),
    })
  );

  screen.append(list);
}
