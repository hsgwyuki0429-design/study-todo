// 設定タブの「目標」と「学習に使える時間」のカード。
//
// ここは最小限の操作だけを置く。細かい配分は Claude に頼み、
// 画面では「何を・いつまでに・どこまで」と「1日に何分使えるか」を決められればよい。

import * as api from './api.js';
import {
  GOAL_COMPLETION_LABELS, GOAL_STATUS_LABELS, WEEKDAY_KEYS, WEEKDAY_LABELS,
} from './api.js';
import { state, render } from './state.js';
import { el, row, fmtDate } from './ui.js';

let newGoal = null;   // 追加中の目標（開いているときだけ）

const minutesInput = (value, onChange, { placeholder = '未設定' } = {}) => {
  const input = el('input', 'cloud-input time-input');
  input.type = 'number';
  input.min = '0';
  input.max = '1440';
  input.inputMode = 'numeric';
  input.placeholder = placeholder;
  input.value = value === null || value === undefined ? '' : String(value);
  input.onchange = () => onChange(input.value === '' ? null : Math.max(0, Math.round(Number(input.value) || 0)));
  return input;
};

const button = (label, onClick, cls = 'btn') => {
  const node = el('button', cls, label);
  node.onclick = onClick;
  return node;
};

/* ------------------------------------------------------------------ */
/* 目標                                                                */
/* ------------------------------------------------------------------ */

function goalSummary(goal, progress) {
  if (goal.needsScopeSetup) {
    return '対象が決まっていません（文章だけの古い目標）。対象を選ぶと進み具合を数えられます。';
  }
  const parts = [
    `${progress.satisfied}/${progress.total}問`,
    `残り${progress.remainingMinutes}分${progress.remainingIsComplete ? '' : '（習得までは不確実）'}`,
  ];
  if (progress.unplanned) parts.push(`未配置${progress.unplanned}問`);
  if (goal.deadline) parts.push(`期限 ${fmtDate(goal.deadline)}`);
  return parts.join(' ・ ');
}

async function goalForm(list, rerender) {
  const questions = [...state.questions.values()];
  const chapters = [...new Set(questions.map((question) => question.chapter))];
  const draft = newGoal;

  const titleInput = el('input', 'cloud-input');
  titleInput.placeholder = '例: 2次関数の基本例題を一通り解く';
  titleInput.value = draft.title;
  titleInput.oninput = () => { draft.title = titleInput.value; };

  const deadlineInput = el('input', 'cloud-input');
  deadlineInput.type = 'date';
  deadlineInput.value = draft.deadline;
  deadlineInput.onchange = () => { draft.deadline = deadlineInput.value; };

  const chapterSelect = el('select');
  chapterSelect.append(new Option('章を選ぶ', ''));
  chapters.forEach((chapter) => chapterSelect.append(new Option(chapter, chapter)));
  chapterSelect.value = draft.chapter;
  chapterSelect.onchange = () => {
    draft.chapter = chapterSelect.value;
    draft.section = '';
    rerender();
  };

  const sectionSelect = el('select');
  sectionSelect.append(new Option('単元をすべて', ''));
  if (draft.chapter) {
    [...new Set(questions.filter((question) => question.chapter === draft.chapter).map((question) => question.section))]
      .forEach((section) => sectionSelect.append(new Option(section, section)));
  }
  sectionSelect.value = draft.section;
  sectionSelect.disabled = !draft.chapter;
  sectionSelect.onchange = () => {
    draft.section = sectionSelect.value;
    rerender();
  };

  const completionSelect = el('select');
  completionSelect.append(new Option(GOAL_COMPLETION_LABELS.attempt, 'attempt'));
  completionSelect.append(new Option(GOAL_COMPLETION_LABELS.mastery, 'mastery'));
  completionSelect.value = draft.completionType;
  completionSelect.onchange = () => { draft.completionType = completionSelect.value; };

  const prioritySelect = el('select');
  [1, 2, 3, 4, 5].forEach((value) => prioritySelect.append(new Option(`優先度 ${value}${value === 1 ? '（高）' : value === 5 ? '（低）' : ''}`, String(value))));
  prioritySelect.value = String(draft.priority);
  prioritySelect.onchange = () => { draft.priority = Number(prioritySelect.value); };

  const targets = api.selectQuestions(questions, {
    chapter: draft.chapter || undefined,
    section: draft.section || undefined,
  });

  const form = el('div', 'plan-form');
  form.append(
    el('div', 'row-sub', '目標の内容'), titleInput,
    el('div', 'row-sub', '期限（空なら期限なし）'), deadlineInput,
    el('div', 'row-sub', '対象の範囲'), chapterSelect, sectionSelect,
    el('div', 'row-sub', `対象 ${targets.length}問（いま選んでいる範囲の問題が、作成時に確定します）`),
    el('div', 'row-sub', '達成条件'), completionSelect,
    el('div', 'row-sub', '「習得する」は、この目標に結び付いた最新の取り組みが ◯完璧にできた であれば達成とします。'),
    el('div', 'row-sub', '優先順位'), prioritySelect,
  );
  const actions = el('div', 'setting-actions');
  actions.append(
    button('この内容で作成', async () => {
      if (!draft.title.trim()) {
        alert('目標の内容を入れてください');
        return;
      }
      if (!targets.length) {
        alert('対象の問題がありません。範囲を選び直してください。');
        return;
      }
      await api.addGoal({
        title: draft.title.trim(),
        deadline: draft.deadline,
        questionIds: targets.map((question) => question.id),
        completion: draft.completionType === 'mastery'
          ? { type: 'mastery', evaluations: ['perfect'], mode: 'latest' }
          : { type: 'attempt' },
        priority: draft.priority,
      });
      newGoal = null;
      rerender();
    }, 'btn btn-primary'),
    button('やめる', () => {
      newGoal = null;
      rerender();
    }, 'link-btn'),
  );
  form.append(actions);
  list.append(form);
}

export async function renderGoalCard(list, rerender) {
  list.append(el('div', 'section-head', '目標'));
  const goals = await api.getGoals();
  if (!goals.length) {
    list.append(row({ title: 'まだ目標がありません', sub: '「目標を追加」から作れます。', classes: ['row-indent'] }));
  }
  for (const goal of goals) {
    const progress = await api.getGoalProgressLocal(goal);
    const node = row({
      title: goal.title || '（名前なし）',
      sub: goalSummary(goal, progress),
      right: el('span', 'state-pill', GOAL_STATUS_LABELS[goal.status] ?? goal.status),
    });
    list.append(node);
    const detail = el('div', 'row-sub goal-detail');
    detail.textContent = [
      GOAL_COMPLETION_LABELS[goal.completion.type],
      `優先度 ${goal.priority}`,
      goal.startDate ? `開始 ${fmtDate(goal.startDate)}` : null,
    ].filter(Boolean).join(' ・ ');
    list.append(detail);

    const actions = el('div', 'setting-actions');
    actions.append(
      button(goal.status === 'paused' ? '再開する' : '一時停止', async () => {
        await api.updateGoal(goal.id, { status: goal.status === 'paused' ? 'active' : 'paused' });
        rerender();
      }, 'link-btn'),
      button('削除', async () => {
        if (!confirm('この目標を削除します。学習記録は消えません。よろしいですか？')) return;
        await api.deleteGoal(goal.id);
        rerender();
      }, 'link-btn'),
    );
    list.append(actions);
  }

  if (newGoal) {
    await goalForm(list, rerender);
  } else {
    const actions = el('div', 'setting-actions');
    actions.append(button('目標を追加', () => {
      newGoal = { title: '', deadline: '', chapter: '', section: '', completionType: 'attempt', priority: 3 };
      rerender();
    }));
    list.append(actions);
  }
}

/* ------------------------------------------------------------------ */
/* 学習に使える時間                                                    */
/* ------------------------------------------------------------------ */

export async function renderAvailabilityCard(list, rerender) {
  const availability = await api.getAvailability();
  const today = api.todayKey();
  const todayInfo = await api.availabilityForDay(today);
  const plannedToday = await api.plannedMinutesFor(today);

  list.append(el('div', 'section-head', '学習に使える時間'));
  list.append(row({
    title: `今日: 予定 ${plannedToday}分 ／ 使える ${todayInfo.available === null ? '未設定' : `${todayInfo.available}分`}`,
    sub: todayInfo.note,
    classes: ['row-indent'],
  }));

  // 曜日別の標準。
  const grid = el('div', 'weekday-grid');
  for (const key of WEEKDAY_KEYS) {
    const cell = el('label', 'weekday-cell');
    cell.append(el('span', 'weekday-name', WEEKDAY_LABELS[key]));
    cell.append(minutesInput(availability.weekly[key], async (value) => {
      await api.saveAvailability({ weekly: { [key]: value } });
      rerender();
    }));
    grid.append(cell);
  }
  list.append(el('div', 'row-sub row-indent', '曜日ごとの標準（分）。空欄は「未設定」で、0分とは違います。'));
  list.append(grid);

  // 今日の残り。
  const remaining = availability.todayRemaining && availability.todayRemaining.date === today
    ? availability.todayRemaining.minutes
    : null;
  const remainingRow = el('div', 'setting-actions');
  remainingRow.append(el('span', 'row-sub', '今日はあと'));
  remainingRow.append(minutesInput(remaining, async (value) => {
    await api.saveAvailability({
      todayRemaining: value === null ? null : { date: today, minutes: value, setAt: new Date().toISOString() },
    });
    rerender();
  }, { placeholder: '分' }));
  remainingRow.append(el('span', 'row-sub', '分'));
  if (remaining !== null) {
    remainingRow.append(button('取り消す', async () => {
      await api.saveAvailability({ todayRemaining: null });
      rerender();
    }, 'link-btn'));
  }
  list.append(remainingRow);
  list.append(el('div', 'row-sub row-indent', 'ここを入れると、その日はこの値が優先されます（実施済みの時間は引かれません）。'));

  // 今日・明日を0分にする（例外日の最小限の操作）。
  const tomorrow = api.todayKey(new Date(Date.now() + 86400000));
  const exceptions = el('div', 'setting-actions');
  for (const [date, label] of [[today, '今日'], [tomorrow, '明日']]) {
    const isZero = availability.overrides[date] === 0;
    exceptions.append(button(isZero ? `${label}の0分をやめる` : `${label}は0分にする`, async () => {
      await api.saveAvailability({ overrides: { [date]: isZero ? null : 0 } });
      rerender();
    }, 'link-btn'));
  }
  list.append(exceptions);

  // 予備時間と答え合わせの扱い。
  const reserveRow = el('div', 'setting-actions');
  reserveRow.append(el('span', 'row-sub', '予備として空ける'));
  reserveRow.append(minutesInput(availability.reserveMinutes, async (value) => {
    await api.saveAvailability({ reserveMinutes: value ?? 0 });
    rerender();
  }, { placeholder: '0' }));
  reserveRow.append(el('span', 'row-sub', '分（1日につき1回だけ引かれます）'));
  list.append(reserveRow);

  list.append(row({
    title: 'タイマーは答え合わせまで含む',
    sub: availability.timerIncludesReview
      ? '含む扱いです（タイマーは問題を始めてから評価を記録するまで動きます）。見積もりに答え合わせ時間を足しません。'
      : `含まない扱いです。1問につき${Math.round(availability.reviewOverheadSeconds / 60)}分を見積もりに足します。`,
    right: button(availability.timerIncludesReview ? '含まないに変える' : '含むに変える', async () => {
      await api.saveAvailability({
        timerIncludesReview: !availability.timerIncludesReview,
        reviewOverheadSeconds: availability.timerIncludesReview ? Math.max(60, availability.reviewOverheadSeconds) : 0,
      });
      rerender();
    }, 'link-btn'),
    classes: ['row-indent'],
  }));
}
