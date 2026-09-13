// 画面をまたいで共有するアプリ状態。
// 循環importを避けるため、再描画は登録したコールバック経由で呼ぶ。

import * as api from './api.js';
import { EMPTY_SESSION, DEFAULT_SETTINGS, todayKey } from './api.js';
import { startOfWeekKey } from './datetime.js';

export const state = {
  tab: 'home',
  idleTab: 'todo',
  session: { ...EMPTY_SESSION },
  settings: { ...DEFAULT_SETTINGS },
  tasks: [],          // 今日のタスク
  questions: new Map(),
  today: { seconds: 0, count: 0, records: [] },

  records: {
    view: 'toc',      // 'toc' | 'history'
    toc: { chapter: null, section: null, questionId: null, attemptId: null },
    filters: { chapter: '', evaluation: '' },
  },

  // スケジュールは週ぎめ。日付を押すと詳細へ移り、戻ると同じ週・同じ位置へ帰る。
  schedule: {
    weekStart: startOfWeekKey(todayKey()),
    selectedDate: null,
    scrollY: 0,
    restoreScroll: null,
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
