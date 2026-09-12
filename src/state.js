// 画面をまたいで共有するアプリ状態。
// 循環importを避けるため、再描画は登録したコールバック経由で呼ぶ。

import * as api from './api.js';
import { EMPTY_SESSION, DEFAULT_SETTINGS, todayKey } from './api.js';

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
    toc: { chapter: null, section: null, questionId: null },
    filters: { chapter: '', evaluation: '' },
  },

  schedule: {
    unit: 'month',    // 'month' | 'week' | 'year'
    anchor: todayKey(),
    selectedDate: null,
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
