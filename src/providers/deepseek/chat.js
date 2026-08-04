import { AuthError, QuotaError, WebaiError } from '../../errors.js';
import { createDeadlineSignal, raceWithSignal, signalReason } from '../../chat/abort.js';
import { UnsupportedChatFeatureError } from '../../chat/errors.js';
import { normalizeMessages } from '../../chat/messages.js';
import { buildCookieHeader, getProvider } from '../../auth/store.js';
import { DEFAULT_POW_WASM_URL, encodePowResponse, solvePowChallenge } from './pow.js';
import { DeepSeekSseDecoder, DeepSeekStreamState } from './sse.js';

export const DEEPSEEK_BASE_URL = 'https://chat.deepseek.com';
export const DEEPSEEK_COMPLETION_PATH = '/api/v0/chat/completion';

const ENDPOINTS = {
  createSession: `${DEEPSEEK_BASE_URL}/api/v0/chat_session/create`,
  createPow: `${DEEPSEEK_BASE_URL}/api/v0/chat/create_pow_challenge`,
  completion: `${DEEPSEEK_BASE_URL}${DEEPSEEK_COMPLETION_PATH}`,
};
const DEFAULT_TIMEOUT_MS = 120_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

function tokenValue(value) {
  if (value === undefined || value === null) return '';
  let token = String(value).trim().replace(/^Bearer\s+/i, '');
  if (token.startsWith('{') && token.endsWith('}')) {
    try {
      const parsed = JSON.parse(token);
      token = String(parsed?.value || parsed?.token || parsed?.access_token || parsed?.accessToken || '').trim();
    } catch {
      // Keep the original token so the upstream produces an actionable auth error.
    }
  }
  return token;
}

export function cookieHeaderFromCredential(credential, targetUrl = DEEPSEEK_BASE_URL) {
  if (!credential || typeof credential !== 'object') return '';
  if (typeof credential.cookieHeader === 'string') return credential.cookieHeader.trim();
  if (typeof credential.cookie === 'string') return credential.cookie.trim();
  const source = credential.cookieJar ?? credential.cookies;
  if (typeof source === 'string') return source.trim();
  if (!source || typeof source !== 'object') return '';
  return buildCookieHeader(source, { url: targetUrl });
}

export function normalizeDeepSeekCredential(credential) {
  const record = typeof credential === 'string' ? { token: credential } : credential;
  if (!record || typeof record !== 'object') {
    throw new AuthError('No DeepSeek credentials found. Inject a bearer token and optional DeepSeek cookies.');
  }
  const token = tokenValue(
    record.token ?? record.accessToken ?? record.access_token ?? record.bearer ?? record.authToken
  );
  if (!token) {
    throw new AuthError('DeepSeek credential is missing the bearer token from localStorage.userToken.');
  }
  const cookieHeader = cookieHeaderFromCredential(record);
  if (!cookieHeader) {
    throw new AuthError('DeepSeek credential is missing the full chat.deepseek.com Cookie header.');
  }
  return {
    token,
    cookieHeader,
    hifDliq: String(record.hifDliq ?? record.hif_dliq ?? record['x-hif-dliq'] ?? ''),
    hifLeim: String(record.hifLeim ?? record.hif_leim ?? record['x-hif-leim'] ?? ''),
    // Production credentials cannot redirect the PoW loader. The default
    // module is fetched from a fixed origin and verified by a pinned checksum;
    // tests can still inject a custom solvePowImpl.
    wasmUrl: DEFAULT_POW_WASM_URL,
    userAgent: String(record.userAgent ?? record.user_agent ?? USER_AGENT),
  };
}

function baseHeaders(credential) {
  const headers = {
    Accept: '*/*',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.token}`,
    Origin: DEEPSEEK_BASE_URL,
    Referer: `${DEEPSEEK_BASE_URL}/`,
    'User-Agent': credential.userAgent,
    'x-app-version': '2.0.0',
    'x-client-version': '2.0.0',
    'x-client-platform': 'web',
    'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': '28800',
    'x-client-bundle-id': 'com.deepseek.chat',
  };
  if (credential.cookieHeader) headers.Cookie = credential.cookieHeader;
  if (credential.hifDliq) headers['x-hif-dliq'] = credential.hifDliq;
  if (credential.hifLeim) headers['x-hif-leim'] = credential.hifLeim;
  return headers;
}

function assertSupportedRequest(request) {
  if (!request || typeof request !== 'object') throw new TypeError('webai chat: request must be an object');
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > 0)) {
    throw new UnsupportedChatFeatureError('tools', 'DeepSeek web tool calling is not implemented');
  }
  if (![undefined, null, 'none'].includes(request.tool_choice)) {
    throw new UnsupportedChatFeatureError('tool_choice', 'DeepSeek web tool calling is not implemented');
  }
  if (request.functions !== undefined || request.function_call !== undefined) {
    throw new UnsupportedChatFeatureError('functions', 'legacy function calling is not implemented');
  }
  return normalizeMessages(request.messages);
}

export function promptFromMessages(messages) {
  const normalized = normalizeMessages(messages);
  if (normalized.length === 1 && normalized[0].role === 'user') return normalized[0].content;
  return [
    'Continue the JSON-encoded conversation below. Follow system and developer messages as instructions, then reply only as the assistant to the final message.',
    JSON.stringify(normalized),
  ].join('\n\n');
}

export function resolveDeepSeekMode(request) {
  const model = String(request?.model || 'deepseek-web').toLowerCase();
  return {
    modelType: model.includes('expert') ? 'expert' : 'default',
    thinkingEnabled:
      request?.thinking === true || request?.deep_think === true || /reasoner|thinking|(?:^|-)r1(?:-|$)/.test(model),
    searchEnabled: request?.search === true || request?.web_search === true || model.includes('search'),
  };
}

async function settleWithinTurn(promise) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ settled: true, value }),
        (error) => ({ settled: true, error })
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), 0);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchOnce(fetchImpl, url, init, signal, context) {
  let lateCancellation = null;
  const pending = Promise.resolve()
    .then(() => fetchImpl(url, { ...init, signal }))
    .then((response) => {
      if (signal.aborted && response?.body && typeof response.body.cancel === 'function') {
        lateCancellation = Promise.resolve(response.body.cancel(signal.reason)).catch(() => {});
      }
      return response;
    });
  try {
    return await raceWithSignal(pending, signal);
  } catch (error) {
    if (signal.aborted) {
      const late = await settleWithinTurn(pending);
      if (late.settled && lateCancellation) await settleWithinTurn(lateCancellation);
      throw signalReason(signal, `${context} aborted`);
    }
    throw new WebaiError(`${context} transport failed: ${error?.message || error}`);
  }
}

async function* responseChunks(body, signal) {
  if (!body || typeof body.getReader !== 'function') {
    throw new WebaiError('deepseek chat: response has no readable body');
  }
  const reader = body.getReader();
  let done = false;
  try {
    while (true) {
      const result = await raceWithSignal(reader.read(), signal);
      if (result.done) {
        done = true;
        break;
      }
      yield result.value;
    }
  } finally {
    if (!done) {
      try {
        await Promise.race([
          Promise.resolve(reader.cancel(signal?.reason)).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 0)),
        ]);
      } catch {
        // The fetch body may already be errored by abort.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore an already released or errored reader.
    }
  }
}

async function readResponseText(response, signal, limit = 1000) {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of responseChunks(response.body, signal)) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length >= limit) break;
  }
  text += decoder.decode();
  return text.slice(0, limit);
}

function looksLikeQuota(value) {
  return /quota|rate.?limit|too many|resource.?limit|额度|限流|频繁|次数|资源紧张/i.test(String(value || ''));
}

function looksLikeAuth(value) {
  return /auth(?:entication|orization)?|access.?token|bearer.?token|session.?token|token\s+(?:expired|invalid)|login|sign.?in|credential|登录|认证|凭据|令牌.{0,8}(?:过期|无效)/i.test(
    String(value || '')
  );
}

function errorFromMessage(message, context, code) {
  const detail = String(message || 'unknown upstream error');
  if (code === 40002 || code === 40003) {
    return new AuthError(`${context} rejected the DeepSeek credential: ${detail}`);
  }
  if (code === 429 || looksLikeQuota(detail)) return new QuotaError(`${context} was rate limited: ${detail}`);
  if (looksLikeAuth(detail)) {
    return new AuthError(`${context} rejected the DeepSeek credential: ${detail}`);
  }
  return new WebaiError(`${context} failed: ${detail}`);
}

async function statusError(response, context, signal) {
  if (response.status < 400) return null;
  const snippet = await readResponseText(response, signal, 1000);
  if (response.status === 401 || response.status === 403) {
    return new AuthError(`${context} rejected the DeepSeek credential (HTTP ${response.status}).`);
  }
  if (response.status === 429) return new QuotaError(`${context} was rate limited (HTTP 429).`);
  return new WebaiError(`${context} failed with HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`);
}

async function postJson(fetchImpl, url, headers, body, signal, context) {
  const response = await fetchOnce(
    fetchImpl,
    url,
    { method: 'POST', headers, body: JSON.stringify(body) },
    signal,
    context
  );
  const error = await statusError(response, context, signal);
  if (error) throw error;
  return response;
}

async function readBusinessPayload(response, signal, context) {
  const raw = await readResponseText(response, signal, 100_000);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new WebaiError(`${context} returned invalid JSON`);
  }
  const rootCode = Number(payload?.code ?? 0);
  const bizCode = Number(payload?.data?.biz_code ?? 0);
  if (rootCode !== 0 || bizCode !== 0) {
    throw errorFromMessage(payload?.data?.biz_msg || payload?.msg || raw, context, bizCode || rootCode);
  }
  const business = payload?.data?.biz_data;
  if (!business || typeof business !== 'object') {
    throw new WebaiError(`${context} returned no data.biz_data`);
  }
  return business;
}

async function createSession(fetchImpl, headers, signal) {
  const response = await postJson(fetchImpl, ENDPOINTS.createSession, headers, {}, signal, 'deepseek session create');
  const business = await readBusinessPayload(response, signal, 'deepseek session create');
  const id = business?.chat_session?.id || business?.id;
  if (!id) throw new WebaiError('deepseek session create returned no session id');
  return String(id);
}

async function createPowChallenge(fetchImpl, headers, signal) {
  const response = await postJson(
    fetchImpl,
    ENDPOINTS.createPow,
    headers,
    { target_path: DEEPSEEK_COMPLETION_PATH },
    signal,
    'deepseek PoW challenge'
  );
  const business = await readBusinessPayload(response, signal, 'deepseek PoW challenge');
  if (!business.challenge || typeof business.challenge !== 'object') {
    throw new WebaiError('deepseek PoW challenge returned no challenge');
  }
  return business.challenge;
}

function completionBody(sessionId, prompt, mode) {
  return {
    chat_session_id: sessionId,
    parent_message_id: null,
    model_type: mode.modelType,
    prompt,
    ref_file_ids: [],
    thinking_enabled: mode.thinkingEnabled,
    search_enabled: mode.searchEnabled,
    action: null,
    preempt: false,
  };
}

export async function* streamChat(
  request,
  {
    credential,
    fetchImpl = globalThis.fetch,
    solvePowImpl = solvePowChallenge,
    signal,
    timeoutMs = request?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  } = {}
) {
  const messages = assertSupportedRequest(request);
  if (typeof fetchImpl !== 'function') throw new TypeError('deepseek chat: fetchImpl must be a function');
  if (typeof solvePowImpl !== 'function') throw new TypeError('deepseek chat: solvePowImpl must be a function');
  const loadedCredential = normalizeDeepSeekCredential(credential ?? getProvider('deepseek'));
  const deadlineMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const operation = createDeadlineSignal(signal, deadlineMs);
  let responseFinished = false;

  try {
    const headers = baseHeaders(loadedCredential);
    const sessionId = await createSession(fetchImpl, headers, operation.signal);
    const challenge = await createPowChallenge(fetchImpl, headers, operation.signal);
    let answer = await raceWithSignal(
      solvePowImpl(challenge, {
        wasmUrl: loadedCredential.wasmUrl,
        fetchImpl,
        signal: operation.signal,
      }),
      operation.signal
    );
    if (answer && typeof answer === 'object') answer = answer.answer;
    const powHeader = encodePowResponse(challenge, Number(answer), DEEPSEEK_COMPLETION_PATH);
    const mode = resolveDeepSeekMode(request);
    const response = await postJson(
      fetchImpl,
      ENDPOINTS.completion,
      { ...headers, Accept: 'text/event-stream', 'X-DS-PoW-Response': powHeader },
      completionBody(sessionId, promptFromMessages(messages), mode),
      operation.signal,
      'deepseek completion'
    );

    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType && !contentType.includes('text/event-stream')) {
      const raw = await readResponseText(response, operation.signal, 2000);
      try {
        const payload = JSON.parse(raw);
        const code = Number(payload?.data?.biz_code ?? payload?.code ?? 0);
        throw errorFromMessage(payload?.data?.biz_msg || payload?.msg || raw, 'deepseek completion', code);
      } catch (error) {
        if (error instanceof AuthError || error instanceof QuotaError || error instanceof WebaiError) throw error;
        throw new WebaiError(`deepseek completion returned ${contentType || 'a non-SSE response'}: ${raw}`);
      }
    }

    const decoder = new TextDecoder();
    const sse = new DeepSeekSseDecoder();
    const state = new DeepSeekStreamState();
    const consume = (frame) => {
      const delta = state.apply(frame);
      if (state.upstreamError) {
        throw errorFromMessage(
          state.upstreamError.message,
          'deepseek completion',
          looksLikeQuota(state.upstreamError.finishReason) ? 429 : 0
        );
      }
      return delta;
    };

    for await (const chunk of responseChunks(response.body, operation.signal)) {
      for (const frame of sse.push(decoder.decode(chunk, { stream: true }))) {
        const delta = consume(frame);
        if (delta) yield { type: 'text_delta', text: delta };
      }
      if (state.completed) break;
    }
    if (!state.completed) {
      const tail = decoder.decode();
      for (const frame of [...sse.push(tail), ...sse.finish()]) {
        const delta = consume(frame);
        if (delta) yield { type: 'text_delta', text: delta };
      }
    }
    if (!state.completed) throw new WebaiError('deepseek chat: stream ended before completion');

    responseFinished = true;
    yield {
      type: 'finish',
      finishReason: state.finishReason || 'stop',
      metadata: {
        provider: 'deepseek',
        model: request.model || 'deepseek-web',
        chatSessionId: sessionId,
        requestId: state.requestId,
        responseId: state.responseId,
        modelType: state.modelType || mode.modelType,
        reasoning: state.reasoning,
        completed: true,
      },
    };
  } catch (error) {
    if (operation.timedOut) throw new WebaiError(`deepseek chat timed out after ${deadlineMs}ms`);
    if (signal?.aborted) throw signalReason(signal, 'deepseek chat aborted');
    throw error;
  } finally {
    if (!responseFinished) operation.abort();
    operation.dispose();
  }
}

export const deepseekChat = { id: 'deepseek-web', streamChat };

export default deepseekChat;
