// Only this adapter handles Routine secrets. Never persist/log provider bodies or errors.
// API contract: https://platform.claude.com/docs/en/api/claude-code/routines-fire
export function routineConfigurationError(env) {
  if (!env.CLAUDE_ROUTINE_FIRE_URL || !env.CLAUDE_ROUTINE_API_TOKEN) return 'missing_secrets';
  if (env.CLAUDE_ROUTINE_TEST_MODE && !['dry_run', 'write_test'].includes(env.CLAUDE_ROUTINE_TEST_MODE)) return 'invalid_configuration';
  try {
    const url = new URL(env.CLAUDE_ROUTINE_FIRE_URL);
    if (url.origin !== 'https://api.anthropic.com' || url.username || url.password
      || url.search || url.hash || !/^\/v1\/claude_code\/routines\/trig_[A-Za-z0-9_-]+\/fire$/.test(url.pathname)) {
      return 'invalid_configuration';
    }
  } catch { return 'invalid_configuration'; }
  return null;
}

export async function fireClaudeRoutine(event, { env, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const configurationError = routineConfigurationError(env);
  if (configurationError) return { state: 'failed', error: configurationError, retryable: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(env.CLAUDE_ROUTINE_FIRE_URL, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: {
        authorization: `Bearer ${env.CLAUDE_ROUTINE_API_TOKEN}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: `${env.CLAUDE_ROUTINE_TEST_MODE ? `mode=${env.CLAUDE_ROUTINE_TEST_MODE} ` : ''}`
        + `trigger=${event.trigger} eventId=${event.eventId} date=${event.date}`
        + (event.sessionId ? ` sessionId=${event.sessionId}` : '') }),
    });
    if (!response.ok) {
      const error = ({ 400: 'invalid_request', 401: 'authentication', 403: 'permission',
        404: 'routine_not_found', 429: 'rate_limit', 500: 'provider_failure', 503: 'provider_failure' })[response.status]
        ?? (response.status >= 500 ? 'provider_failure' : 'provider_http_error');
      // Even temporary errors do not authorize another POST for this event.
      return { state: 'failed', error, httpStatus: response.status, retryable: false,
        temporary: response.status === 429 || response.status >= 500 };
    }
    let body;
    try { body = await response.json(); } catch {
      return { state: 'failed', error: controller.signal.aborted ? 'timeout' : 'invalid_provider_response', retryable: false, outcomeUnknown: true };
    }
    const id = body?.claude_code_session_id;
    if (body?.type !== 'routine_fire' || typeof id !== 'string' || !/^session_[A-Za-z0-9_-]{1,150}$/.test(id)
      || body.claude_code_session_url !== `https://claude.ai/code/${id}`) {
      return { state: 'failed', error: 'invalid_provider_response', retryable: false, outcomeUnknown: true };
    }
    return { state: 'triggered', retryable: false, providerSessionId: id,
      providerSessionUrl: `https://claude.ai/code/${id}` };
  } catch {
    return { state: 'failed', error: controller.signal.aborted ? 'timeout' : 'provider_transport',
      retryable: false, outcomeUnknown: true };
  } finally { clearTimeout(timer); }
}
