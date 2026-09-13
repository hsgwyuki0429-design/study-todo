// 画面をまたいで共有するアプリ状態。
// 循環importを避けるため、再描画は登録したコールバック経由で呼ぶ。

import * as api from './api.js';
import { EMPTY_SESSION, DEFAULT_SETTINGS, todayKey } from './api.js';

export const state = {
  tab: 'home',
  // 設定タブで開いている区分（1つずつ開く）。null は全部たたんだ状態。
  settingsOpen: null,
  idleTab: 'todo',
  session: { ...EMPTY_SESSION },
  settings: { ...DEFAULT_SETTINGS },
  tasks: [],          // 今日のタスク
  questions: new Map(),
  today: { seconds: 0, count: 0, records: [] },

  records: {
    toc: { chapter: null, section: null, questionId: null, attemptId: null },
  },

  // スケジュールは日付がずっと続く1本の並び。
  // タブを押したときは今日が真ん中に来て、日付を押すと詳細へ移り、戻ると同じ位置へ帰る。
  schedule: {
    from: null,            // いま出している範囲（null なら今日を中心に取り直す）
    to: null,
    selectedDate: null,
    scrollTop: 0,
    restoreScroll: null,
    centerToday: true,
    // 右上の ⓘ で開く「マスの見方」。
    helpOpen: false,
  },
};

export const q = (id) => state.questions.get(id);
export const qLabel = (id) => q(id)?.label ?? id;

let renderFn = () => {};
export const setRenderer = (fn) => { renderFn = fn; };
export const render = () => renderFn();

export async function refreshToday() {
  state.today = await api.getTodayStats();
}

export async function loadTasks() {
  state.tasks = await api.getTodayTasks();
}
