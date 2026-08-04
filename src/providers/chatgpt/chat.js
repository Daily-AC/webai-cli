import { randomUUID } from 'node:crypto';
import { AuthError, QuotaError, WebaiError } from '../../errors.js';
import { createDeadlineSignal, raceWithSignal, signalReason } from '../../chat/abort.js';
import { assertSupportedChatRequest, serializeMessages } from '../../chat/messages.js';
import { getProvider } from '../../auth/store.js';
import {
  CHATGPT_BASE_URL,
  accountIdFromAccessToken,
  mergeSessionCookieRotation,
  normalizeChatGptCredential,
} from './credentials.js';
import {
  ChatGptChallengeError,
  ChatGptProtocolError,
  ChatGptTransportRequiredError,
  chatGptStatusError,
} from './errors.js';
import { buildPowConfig, buildRequirementsToken, solveProofChallenge } from './pow.js';
import { ChatGptDeltaState, ChatGptSseDecoder } from './sse.js';

export const CHATGPT_ENDPOINTS = {
  session: '/api/auth/session',
  conduit: '/backend-api/f/conversation/prepare',
  sentinelPrepare: '/backend-api/sentinel/chat-requirements/prepare',
  sentinelFinalize: '/backend-api/sentinel/chat-requirements/finalize',
  conversation: '/backend-api/f/conversation',
};

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BUILD_NUMBER = '7904904';
const EMPTY_DELTA = { textDelta: '', reasoningDelta: '' };

function resolveTransport(transport) {
  if (typeof transport === 'function') return transport;
  if (typeof transport?.request === 'function') return transport.request.bind(transport);
  if (typeof transport?.fetch === 'function') return transport.fetch.bind(transport);
  throw new ChatGptTransportRequiredError();
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '') : '';
}

async function requestOnce(requestImpl, url, init, signal, context) {
  try {
    const response = await raceWithSignal(
      Promise.resolve().then(() => requestImpl(url, { ...init, signal })),
      signal
    );
    if (!response || !Number.isFinite(Number(response.status))) {
      throw new TypeError('transport returned no Fetch-compatible response status');
    }
    return response;
  } catch (error) {
    if (signal?.aborted) throw signalReason(signal, `${context} aborted`);
    if (error instanceof WebaiError) throw error;
    throw new WebaiError(`${context} transport failed: ${error?.message || error}`);
  }
}

async function readText(response, signal, limit = Infinity) {
  if (typeof response?.text !== 'function') {
    throw new ChatGptProtocolError('chatgpt transport response must implement text()');
  }
  const text = await raceWithSignal(response.text(), signal);
  return String(text || '').slice(0, limit);
}

async function throwForStatus(response, context, signal) {
  const challenged = headerValue(response?.headers, 'cf-mitigated').toLowerCase() === 'challenge';
  if (Number(response.status) >= 200 && Number(response.status) < 300 && !challenged) return;
  const body = await readText(response, signal, 4000);
  throw chatGptStatusError(response, context, body);
}

async function readJson(response, context, signal) {
  const raw = await readText(response, signal, 200_000);
  try {
    return JSON.parse(raw);
  } catch {
    throw new ChatGptProtocolError(`${context} returned invalid JSON`);
  }
}

function browserHeaders(credential) {
  return {
    Accept: '*/*',
    'Accept-Language': `${credential.language},en;q=0.9`,
    Cookie: credential.cookieHeader,
    Origin: CHATGPT_BASE_URL,
    Referer: `${CHATGPT_BASE_URL}/`,
    'User-Agent': credential.userAgent,
  };
}

function apiHeaders(context, path, additions = {}) {
  const headers = {
    ...browserHeaders(context.credential),
    Authorization: `Bearer ${context.accessToken}`,
    'Content-Type': 'application/json',
    'oai-device-id': context.deviceId,
    'oai-session-id': context.sessionId,
    'oai-language': context.credential.language,
    'x-oai-turn-trace-id': context.turnTraceId,
    'x-openai-target-path': path,
    'x-openai-target-route': path,
    ...additions,
  };
  if (context.accountId) headers['chatgpt-account-id'] = context.accountId;
  if (context.buildId) headers['oai-client-version'] = context.buildId;
  if (context.clientBuildNumber) headers['oai-client-build-number'] = context.clientBuildNumber;
  return headers;
}

function sentinelHeaders(sentinel) {
  const headers = {};
  if (sentinel?.token) headers['openai-sentinel-chat-requirements-token'] = sentinel.token;
  if (sentinel?.prepareToken) {
    headers['openai-sentinel-chat-requirements-prepare-token'] = sentinel.prepareToken;
  }
  if (sentinel?.proofToken) headers['openai-sentinel-proof-token'] = sentinel.proofToken;
  if (sentinel?.turnstileToken) headers['openai-sentinel-turnstile-token'] = sentinel.turnstileToken;
  if (sentinel?.sessionObserverToken) headers['openai-sentinel-so-token'] = sentinel.sessionObserverToken;
  return headers;
}

async function postJson(requestImpl, path, headers, body, signal, context) {
  const response = await requestOnce(
    requestImpl,
    `${CHATGPT_BASE_URL}${path}`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    signal,
    context
  );
  await throwForStatus(response, context, signal);
  return readJson(response, context, signal);
}

export async function exchangeSession(
  credential,
  requestImpl,
  signal,
  { onCredentialUpdate } = {}
) {
  const response = await requestOnce(
    requestImpl,
    `${CHATGPT_BASE_URL}${CHATGPT_ENDPOINTS.session}`,
    { method: 'GET', headers: { ...browserHeaders(credential), Accept: 'application/json' } },
    signal,
    'chatgpt session exchange'
  );
  await throwForStatus(response, 'chatgpt session exchange', signal);
  const rotatedCookie = mergeSessionCookieRotation(credential.cookieHeader, response.headers);
  const payload = await readJson(response, 'chatgpt session exchange', signal);
  if (!payload?.accessToken) {
    throw new AuthError('ChatGPT session exchange returned no accessToken; the injected cookies are expired.');
  }
  if (rotatedCookie) {
    credential.cookieHeader = rotatedCookie;
    if (typeof onCredentialUpdate === 'function') {
      await raceWithSignal(onCredentialUpdate(rotatedCookie), signal);
    }
  }
  return {
    accessToken: String(payload.accessToken),
    expires: payload.expires ? String(payload.expires) : '',
    accountId: credential.accountId || accountIdFromAccessToken(payload.accessToken),
    cookieHeader: credential.cookieHeader,
  };
}

export function scrapeBuildId(html) {
  return String(html || '').match(/\bdata-build=["']([^"']+)["']/)?.[1] || '';
}

async function resolveBuildId(credential, requestImpl, signal) {
  if (credential.clientVersion) return credential.clientVersion;
  const response = await requestOnce(
    requestImpl,
    `${CHATGPT_BASE_URL}/`,
    { method: 'GET', headers: browserHeaders(credential) },
    signal,
    'chatgpt build discovery'
  );
  await throwForStatus(response, 'chatgpt build discovery', signal);
  const buildId = scrapeBuildId(await readText(response, signal, 2_000_000));
  if (!buildId) throw new ChatGptProtocolError('chatgpt build discovery returned no data-build value');
  return buildId;
}

export function promptFromMessages(messages) {
  if (messages.length === 1 && messages[0].role === 'user') return messages[0].content;
  return serializeMessages(messages);
}

export function resolveChatGptModel(model) {
  const requested = String(model || '').trim();
  if (!requested || ['chatgpt', 'chatgpt-web'].includes(requested.toLowerCase())) return 'auto';
  return requested;
}

function textMessage(id, prompt, now) {
  return {
    id,
    author: { role: 'user' },
    create_time: now / 1000,
    content: { content_type: 'text', parts: [prompt] },
    metadata: {
      selected_sources: [],
      serialization_metadata: { custom_symbol_offsets: [] },
    },
  };
}

function commonConversationBody(request, model, timezone, timezoneOffset, parentMessageId) {
  return {
    action: 'next',
    parent_message_id: parentMessageId,
    model,
    timezone_offset_min: timezoneOffset,
    timezone,
    conversation_mode: { kind: 'primary_assistant' },
    system_hints: [],
    supports_buffering: true,
    supported_encodings: ['v1'],
    client_contextual_info: {
      is_dark_mode: false,
      time_since_loaded: 1,
      page_height: 1014,
      page_width: 1055,
      pixel_ratio: 1,
      screen_height: 1080,
      screen_width: 1920,
      app_name: 'chatgpt.com',
    },
    thinking_effort: request.thinking_effort || request.thinkingEffort || 'standard',
  };
}

function conduitBody(base, state, message) {
  const body = {
    action: base.action,
    fork_from_shared_post: false,
    parent_message_id: base.parent_message_id,
    model: base.model,
    client_prepare_state: state,
    timezone_offset_min: base.timezone_offset_min,
    timezone: base.timezone,
    conversation_mode: base.conversation_mode,
    system_hints: base.system_hints,
    supports_buffering: base.supports_buffering,
    supported_encodings: base.supported_encodings,
    client_contextual_info: { app_name: 'chatgpt.com' },
    thinking_effort: base.thinking_effort,
  };
  if (state !== 'none') body.partial_query = message;
  return body;
}

async function prepareConduit(
  requestImpl,
  context,
  base,
  message,
  signal,
  sentinel = null,
  states = ['none'],
  initialConduitToken = ''
) {
  let conduitToken = initialConduitToken;
  for (const state of states) {
    const additions = { ...sentinelHeaders(sentinel) };
    if (conduitToken) additions['x-conduit-token'] = conduitToken;
    const result = await postJson(
      requestImpl,
      CHATGPT_ENDPOINTS.conduit,
      apiHeaders(context, CHATGPT_ENDPOINTS.conduit, additions),
      conduitBody(base, state, message),
      signal,
      `chatgpt conduit prepare (${state})`
    );
    if (!result?.conduit_token) {
      throw new ChatGptProtocolError(`chatgpt conduit prepare (${state}) returned no conduit_token`);
    }
    conduitToken = String(result.conduit_token);
  }
  return conduitToken;
}

async function prepareSentinel(
  requestImpl,
  context,
  conduitToken,
  signal,
  { solveProofImpl, turnstileSolver, sessionObserverSolver, powOptions }
) {
  const requirementsToken = await raceWithSignal(
    buildRequirementsToken({ ...powOptions, signal }),
    signal
  );
  const conduit = conduitToken ? { 'x-conduit-token': conduitToken } : {};
  const prepared = await postJson(
    requestImpl,
    CHATGPT_ENDPOINTS.sentinelPrepare,
    apiHeaders(context, CHATGPT_ENDPOINTS.sentinelPrepare, conduit),
    { p: requirementsToken },
    signal,
    'chatgpt Sentinel prepare'
  );
  if (prepared?.force_login) throw new AuthError('ChatGPT Sentinel requires a fresh authenticated session.');
  if (!prepared?.prepare_token) {
    throw new ChatGptProtocolError('chatgpt Sentinel prepare returned no prepare_token');
  }
  if (prepared?.arkose?.required) {
    throw new ChatGptChallengeError('ChatGPT Sentinel requires an unsupported Arkose challenge.', prepared.arkose);
  }

  let proofToken = '';
  if (prepared?.proofofwork?.required) {
    proofToken = await raceWithSignal(
      solveProofImpl(prepared.proofofwork, { ...powOptions, signal }),
      signal
    );
  }
  let turnstileToken = '';
  if (prepared?.turnstile?.required && typeof turnstileSolver === 'function') {
    turnstileToken = String(
      (await raceWithSignal(
        turnstileSolver(prepared.turnstile, { requirementsToken, prepareToken: prepared.prepare_token, signal }),
        signal
      )) || ''
    );
  }
  let sessionObserverToken = '';
  if (prepared?.so?.required) {
    if (typeof sessionObserverSolver !== 'function') {
      throw new ChatGptChallengeError(
        'ChatGPT Sentinel requires an unsupported session-observer challenge.',
        prepared.so
      );
    }
    sessionObserverToken = String(
      (await raceWithSignal(sessionObserverSolver(prepared.so, { requirementsToken, signal }), signal)) || ''
    );
  }

  const finalizeBody = { prepare_token: String(prepared.prepare_token) };
  if (proofToken) finalizeBody.proofofwork = proofToken;
  if (turnstileToken) finalizeBody.turnstile = turnstileToken;
  let finalized;
  try {
    finalized = await postJson(
      requestImpl,
      CHATGPT_ENDPOINTS.sentinelFinalize,
      apiHeaders(context, CHATGPT_ENDPOINTS.sentinelFinalize, conduit),
      finalizeBody,
      signal,
      'chatgpt Sentinel finalize'
    );
  } catch (error) {
    if (error instanceof ChatGptChallengeError && prepared?.turnstile?.required && !turnstileToken) {
      throw new ChatGptChallengeError(
        'ChatGPT Sentinel finalize requires Turnstile; inject a compatible solver.',
        prepared.turnstile
      );
    }
    throw error;
  }
  if (!finalized?.token) {
    if (prepared?.turnstile?.required && !turnstileToken) {
      throw new ChatGptChallengeError(
        'ChatGPT Sentinel returned no token because Turnstile was not satisfied.',
        prepared.turnstile
      );
    }
    throw new ChatGptProtocolError('chatgpt Sentinel finalize returned no token');
  }
  return {
    token: String(finalized.token),
    prepareToken: String(prepared.prepare_token),
    proofToken: String(proofToken || ''),
    turnstileToken,
    sessionObserverToken,
    expireAfter: Number(finalized.expire_after || 0),
    expireAt: Number(finalized.expire_at || 0),
  };
}

function conversationBody(base, message, request) {
  const body = { ...base };
  body.messages = [message];
  body.client_prepare_state = 'success';
  body.enable_message_followups = true;
  body.history_and_training_disabled = request.temporary !== false;
  body.paragen_cot_summary_display_override = 'allow';
  body.force_parallel_switch = 'auto';
  return body;
}

async function* responseChunks(body, signal) {
  if (!body || typeof body.getReader !== 'function') {
    throw new ChatGptProtocolError('chatgpt transport response body must be a web ReadableStream');
  }
  const reader = body.getReader();
  let finished = false;
  try {
    while (true) {
      const result = await raceWithSignal(reader.read(), signal);
      if (result.done) {
        finished = true;
        break;
      }
      yield result.value;
    }
  } finally {
    if (!finished) {
      try {
        await Promise.race([
          Promise.resolve(reader.cancel(signal?.reason)).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 0)),
        ]);
      } catch {
        // The transport may have already closed the response after abort.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore an already released or errored reader.
    }
  }
}

function streamError(value) {
  const message = String(value?.message || 'ChatGPT returned an unknown stream error');
  if (/quota|rate.?limit|too many|capacity/i.test(message)) return new QuotaError(`chatgpt chat: ${message}`);
  if (/auth(?:entication|orization)?|access.?token|session.?token|token\s+(?:expired|invalid)|login|sign.?in|credential/i.test(message)) {
    return new AuthError(`chatgpt chat: ${message}`);
  }
  return new WebaiError(`chatgpt chat: ${message}`);
}

export async function* streamChat(
  request,
  {
    credential,
    transport,
    signal,
    timeoutMs = request?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    solveProofImpl = solveProofChallenge,
    turnstileSolver,
    sessionObserverSolver,
    onCredentialUpdate,
    uuidImpl = randomUUID,
    now = Date.now,
  } = {}
) {
  const messages = assertSupportedChatRequest(request);
  const requestImpl = resolveTransport(transport);
  if (typeof solveProofImpl !== 'function') throw new TypeError('chatgpt chat: solveProofImpl must be a function');
  const loadedCredential = normalizeChatGptCredential(credential ?? getProvider('chatgpt'));
  const deadlineMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const operation = createDeadlineSignal(signal, deadlineMs);
  let responseFinished = false;

  try {
    const session = await exchangeSession(loadedCredential, requestImpl, operation.signal, { onCredentialUpdate });
    const buildId = await resolveBuildId(loadedCredential, requestImpl, operation.signal);
    const model = resolveChatGptModel(request.model);
    const prompt = promptFromMessages(messages);
    const currentTime = Number(now());
    const message = textMessage(uuidImpl(), prompt, currentTime);
    const timezone = String(request.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    const timezoneOffset = Number.isFinite(Number(request.timezone_offset_min))
      ? Number(request.timezone_offset_min)
      : new Date(currentTime).getTimezoneOffset();
    const base = commonConversationBody(request, model, timezone, timezoneOffset, uuidImpl());
    const context = {
      credential: loadedCredential,
      accessToken: session.accessToken,
      accountId: session.accountId,
      deviceId: loadedCredential.deviceId,
      sessionId: uuidImpl(),
      turnTraceId: uuidImpl(),
      buildId,
      clientBuildNumber: loadedCredential.clientBuildNumber || DEFAULT_BUILD_NUMBER,
    };
    const powOptions = {
      buildId,
      deviceId: loadedCredential.deviceId,
      userAgent: loadedCredential.userAgent,
      now: currentTime,
      uuid: uuidImpl,
    };

    let conduitToken = await prepareConduit(
      requestImpl,
      context,
      base,
      message,
      operation.signal,
      null,
      ['none']
    );
    const sentinel = await prepareSentinel(requestImpl, context, conduitToken, operation.signal, {
      solveProofImpl,
      turnstileSolver,
      sessionObserverSolver,
      powOptions,
    });
    conduitToken = await prepareConduit(
      requestImpl,
      context,
      base,
      message,
      operation.signal,
      sentinel,
      ['sent', 'success'],
      conduitToken
    );

    const response = await requestOnce(
      requestImpl,
      `${CHATGPT_BASE_URL}${CHATGPT_ENDPOINTS.conversation}`,
      {
        method: 'POST',
        headers: apiHeaders(context, CHATGPT_ENDPOINTS.conversation, {
          ...sentinelHeaders(sentinel),
          Accept: 'text/event-stream',
          'x-conduit-token': conduitToken,
          'oai-echo-logs': '0,943,1,65876,0,68124,1,68930',
          'oai-telemetry': '[1,null]',
        }),
        body: JSON.stringify(conversationBody(base, message, request)),
      },
      operation.signal,
      'chatgpt conversation'
    );
    await throwForStatus(response, 'chatgpt conversation', operation.signal);
    const contentType = headerValue(response.headers, 'content-type');
    if (contentType && !/text\/event-stream/i.test(contentType)) {
      const raw = await readText(response, operation.signal, 4000);
      throw new ChatGptProtocolError(`chatgpt conversation returned ${contentType}: ${raw}`);
    }

    const decoder = new TextDecoder();
    const sse = new ChatGptSseDecoder();
    const state = new ChatGptDeltaState();
    const consume = (frame) => {
      const delta = state.apply(frame);
      if (state.upstreamError) throw streamError(state.upstreamError);
      return delta || EMPTY_DELTA;
    };

    for await (const chunk of responseChunks(response.body, operation.signal)) {
      for (const frame of sse.push(decoder.decode(chunk, { stream: true }))) {
        const delta = consume(frame);
        if (delta.textDelta) yield { type: 'text_delta', text: delta.textDelta };
      }
      if (state.completed) break;
    }
    const tail = decoder.decode();
    for (const frame of [...sse.push(tail), ...sse.finish()]) {
      const delta = consume(frame);
      if (delta.textDelta) yield { type: 'text_delta', text: delta.textDelta };
    }
    if (state.handoff) {
      throw new ChatGptProtocolError(
        'chatgpt chat: stream handoff requires a continuation transport that is not implemented',
        'stream_handoff_unsupported'
      );
    }
    if (!state.completed) throw new ChatGptProtocolError('chatgpt chat: stream ended before [DONE]');

    responseFinished = true;
    yield {
      type: 'finish',
      finishReason: 'stop',
      metadata: {
        provider: 'chatgpt',
        model,
        conversationId: state.conversationId,
        messageId: state.messageId,
        reasoning: state.reasoning,
        completed: true,
      },
    };
  } catch (error) {
    if (operation.timedOut) throw new WebaiError(`chatgpt chat timed out after ${deadlineMs}ms`);
    if (signal?.aborted) throw signalReason(signal, 'chatgpt chat aborted');
    throw error;
  } finally {
    if (!responseFinished) operation.abort();
    operation.dispose();
  }
}

export const chatgptChat = { id: 'chatgpt-web', streamChat };

export default chatgptChat;
