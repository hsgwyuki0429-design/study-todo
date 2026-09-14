import * as api from './api.js';
import { qLabel, refreshToday, loadTasks, render } from './state.js';
import { syncInBackground } from './cloud-sync.js';

export async function undoRecord(record) {
  if (!confirm(`${qLabel(record.questionId)}のこの回の結果と計測時間を取り消し、未着手に戻しますか？`)) return false;
  const result = await api.undoStudyRecord(record.id);
  if (!result.ok) return false;
  await refreshToday(); await loadTasks();
  syncInBackground(); render();
  return true;
}
