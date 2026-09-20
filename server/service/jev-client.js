// TypeSafe AI「System One」（Jev）へ、小さな判断だけを尋ねるための層。
//
// ここが守ること:
//
//   ・秘密（APIキー）を扱うのはこのファイルだけ。応答やエラーの本文は保存・記録しない。
//   ・送るのは匿名の問題IDと、評価・回数・日数・見積もりといった「数えられること」だけ。
//     氏名・認証情報・教材の本文は入れない。
//   ・返ってきた答えは形から確かめる。質問IDが合っているか、選択肢の中の値か、
//     点数が決めた範囲かを見て、外れていたら unknown として捨てる。
//     壊れた答えを「判断」として通さないほうが、予定は安全に保てる。
//   ・質問どうしは独立に評価される（公式仕様）。片方の答えを前提にした質問は作らない。
//
// API: POST https://api.typesafe.ai/v1/systemone  { state, model, questions } → { answers, usage }

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
export const JEV_TIMEOUT_MS = 20000;

/** 1回の要求に詰める候補の数。state と questions を合わせた予算（約32,000トークン）に収める。 */
export const JEV_BATCH_SIZE = 8;

export function jevConfigurationError(env) {
  if (!env.JEV_API_KEY) return 'missing_secrets';
  if (env.JEV_API_URL) {
    try {
      const url = new URL(env.JEV_API_URL);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return 'invalid_configuration';
    } catch { return 'invalid_configuration'; }
  }
  if (env.JEV_MODEL && !/^[A-Za-z0-9._-]{1,60}$/.test(env.JEV_MODEL)) return 'invalid_configuration';
  return null;
}

/** HTTPの状態から、こちらで決めた失敗の名前へ。設定の誤りと一時的な不調を分ける。 */
const HTTP_ERRORS = Object.freeze({
  400: 'invalid_request', 401: 'authentication', 403: 'permission',
  404: 'model_not_found', 413: 'request_too_large', 422: 'invalid_request',
  429: 'rate_limit', 500: 'provider_failure', 503: 'provider_failure',
});

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 答えを1件ずつ確かめる。
 * どの形で返ってきても、こちらが決めた {value, confidence} にそろえる。
 * 想定と違うものは null（＝判断なし）にして、決定的な規則へ戻せるようにする。
 */
export function readAnswer(raw, question) {
  if (!isObject(raw)) return null;
  const confidence = Number.isFinite(Number(raw.confidence))
    ? Math.max(0, Math.min(1, Number(raw.confidence)))
    : null;
  if (question.type === 'choice') {
    const value = raw.choice ?? raw.value ?? raw.selected ?? raw.answer;
    if (typeof value !== 'string') return null;
    if (!Object.keys(question.criteria).includes(value)) return null;
    return { value, confidence };
  }
  if (question.type === 'score') {
    const value = Number(raw.score ?? raw.value ?? raw.answer);
    // Score は小数で返りうる。配列の添字としては決して使わない。
    if (!Number.isFinite(value)) return null;
    const max = question.criteria.length - 1;
    if (value < 0 || value > max) return null;
    return { value, confidence };
  }
  if (question.type === 'noul') {
    const value = Number(raw.probability ?? raw.value ?? raw.answer);
    if (!Number.isFinite(value) || value < 0 || value > 1) return null;
    // Noul には独立した confidence が無い（公式仕様）。確率そのものを confidence と呼ばない。
    return { value, confidence: null };
  }
  return null;
}

/**
 * 1回ぶんの問い合わせ。
 * questions は { id: {type, instructions, criteria} } の形で渡す。
 * 返すのは { ok, answers, usage, error } で、例外は投げない（予定づくりを止めないため）。
 */
export async function askJev({ state, questions }, { env, fetchImpl = fetch, timeoutMs = JEV_TIMEOUT_MS } = {}) {
  const configurationError = jevConfigurationError(env);
  if (configurationError) return { ok: false, error: configurationError, retryable: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(env.JEV_API_URL || JEV_ENDPOINT, {
      method: 'POST',
      // Cloudflare Workers は redirect:'error' を受け付けない。転送は追わず、3xxはこちらで断る。
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${env.JEV_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.JEV_MODEL || JEV_DEFAULT_MODEL,
        state,
        questions: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, {
          type: question.type,
          instructions: question.instructions,
          criteria: question.criteria,
        }])),
      }),
    });
    if (response.status >= 300 && response.status < 400) {
      // 別の宛先へAPIキーを送らない。
      return { ok: false, error: 'provider_redirect', httpStatus: response.status, retryable: false };
    }
    if (!response.ok) {
      const error = HTTP_ERRORS[response.status] ?? (response.status >= 500 ? 'provider_failure' : 'provider_http_error');
      return {
        ok: false, error, httpStatus: response.status,
        // 認証・権限・要求の誤りは、送り直しても同じ。設定を直してもらう。
        retryable: response.status === 429 || response.status >= 500,
      };
    }
    let body;
    try { body = await response.json(); } catch {
      return { ok: false, error: 'invalid_provider_response', detail: 'json', retryable: false };
    }
    if (!isObject(body) || !isObject(body.answers)) {
      return { ok: false, error: 'invalid_provider_response', detail: 'answers', retryable: false };
    }
    const answers = {};
    for (const [id, question] of Object.entries(questions)) {
      answers[id] = readAnswer(body.answers[id], question);
    }
    return { ok: true, answers, usage: readUsage(body.usage) };
  } catch (error) {
    return {
      ok: false,
      error: controller.signal.aborted ? 'timeout' : 'provider_transport',
      // 例外の種類の名前だけ（TypeError など）。本文・URL・キーは残さない。
      ...(controller.signal.aborted ? {} : { detail: String(error?.name ?? 'Error').slice(0, 40) }),
      // 推論の失敗は予定を書いていないので、安全に送り直せる。
      retryable: true,
    };
  } finally { clearTimeout(timer); }
}

/** 費用を見るための数だけを取り出す。出力トークンは無料だが、記録はしておく。 */
function readUsage(raw) {
  if (!isObject(raw)) return { inputTokens: 0, outputTokens: 0 };
  const read = (...keys) => {
    for (const key of keys) {
      const value = Number(raw[key]);
      if (Number.isFinite(value) && value >= 0) return Math.round(value);
    }
    return 0;
  };
  return {
    inputTokens: read('input_tokens', 'inputTokens', 'prompt_tokens'),
    outputTokens: read('output_tokens', 'outputTokens', 'completion_tokens'),
  };
}
