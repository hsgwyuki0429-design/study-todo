// どのプランナーを動かすかを選ぶところ。
//
// 実行先はイベントごとに決まり、途中で変わらない。
// こうしないと、同じイベントに対して2つのAIが同時に予定を書きうる。
//
//   claude_routine … これまでどおり Claude Routine を起動する（既定）
//   jev            … サーバーの中で Jev に判断させ、配分して保存する
//   jev_shadow     … jev と同じ判断をするが、保存はしない（品質を測るための段階）
//   off            … 自動再計画をしない

import { fireClaudeRoutine, routineConfigurationError } from './claude-routine.js';
import { jevConfigurationError } from './jev-client.js';

export const PLANNER_PROVIDERS = Object.freeze(['claude_routine', 'jev', 'jev_shadow', 'off']);

export function plannerProviderOf(env = {}) {
  const value = env.PLANNER_PROVIDER;
  return PLANNER_PROVIDERS.includes(value) ? value : 'claude_routine';
}

/** 起動する前に分かる設定の誤り。手動実行では、押した人に直せる場所を伝えたい。 */
export function plannerConfigurationError(env = {}) {
  const provider = plannerProviderOf(env);
  if (provider === 'off') return 'planner_disabled';
  if (provider === 'claude_routine') return routineConfigurationError(env);
  return jevConfigurationError(env);
}

/**
 * 1回ぶんの起動。
 * Claude Routine は「起動を伝えた」までしか分からない（triggered）。
 * Jev は、このサーバーの中で最後まで走るので、保存した結果まで返る（applied / no_change）。
 */
export async function runPlanner(event, { env, fetchImpl = fetch, plannerRunner = null } = {}) {
  const provider = plannerProviderOf(env);
  if (provider === 'off') return { state: 'failed', error: 'planner_disabled', retryable: false, provider };
  if (provider === 'claude_routine') return { ...await fireClaudeRoutine(event, { env, fetchImpl }), provider };
  if (!plannerRunner) return { state: 'failed', error: 'planner_not_available', retryable: false, provider };
  try {
    const result = await plannerRunner.run(event, { apply: provider === 'jev' });
    return { ...result, provider, outcomeUnknown: false };
  } catch (error) {
    // 本文・URL・キーは残さない。例外の種類の名前だけを残す。
    return {
      state: 'failed', error: 'planner_failure', detail: String(error?.name ?? 'Error').slice(0, 40),
      // 予定は全部成功か全部未反映かのどちらかなので、ここで落ちていても二重には入らない。
      retryable: true, outcomeUnknown: true, provider,
    };
  }
}
