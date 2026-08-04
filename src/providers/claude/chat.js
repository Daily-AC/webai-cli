import { createHash, randomUUID } from 'node:crypto';
import { buildCookieHeader, getProvider } from '../../auth/store.js';
import { createDeadlineSignal, raceWithSignal, signalReason } from '../../chat/abort.js';
import { UnsupportedChatFeatureError } from '../../chat/errors.js';
import { assertSupportedChatRequest, serializeMessages } from '../../chat/messages.js';
import {
  AuthError,
  CloudflareChallengeError,
  QuotaError,
  WebaiError,
} from '../../errors.js';
import { ClaudeSseDecoder, ClaudeStreamState } from './sse.js';

export const CLAUDE_BASE_URL = 'https://claude.ai';
export const CLAUDE_ORGANIZATIONS_URL = `${CLAUDE_BASE_URL}/api/organizations`;
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

const DEFAULT_TIMEOUT_MS = 120_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const DEFAULT_STYLE = {
  isDefault: true,
  key: 'Default',
  name: 'Normal',
  nameKey: 'normal_style_name',
  prompt: 'Normal\n',
  summary: 'Default responses from Claude',
  summaryKey: 'normal_style_summary',
  type: 'default',
};
const DEFAULT_TOOLS = [
  { name: 'web_search', type: 'web_search_v0' },
  { name: 'artifacts', type: 'artifacts_v0' },
  { name: 'repl', type: 'repl_v0' },
  { name: 'ask_user_input_v0', type: 'widget' },
  { name: 'weather_fetch', type: 'widget' },
  { name: 'recipe_display_v0', type: 'widget' },
  { name: 'places_map_display_v0', type: 'widget' },
  { name: 'message_compose_v1', type: 'widget' },
  { name: 'places_search', type: 'widget' },
  { name: 'fetch_sports_data', type: 'widget' },
];

function safeHeaderValue(value, field) {
  const normalized = String(value || '').trim();
  if (/[\r\n\x00]/.test(normalized)) {
    throw new AuthError(`Claude credential field ${field} contains invalid characters.`);
  }
  return normalized;
}

function safeCookieValue(value, field) {
  const normalized = safeHeaderValue(value, field);
  if (normalized.includes(';')) {
    throw new AuthError(`Claude credential field ${field} is not a single cookie value.`);
  }
  return normalized;
}

function explicitCookieHeader(value) {
  const normalized = safeHeaderValue(value, 'cookie').replace(/^Cookie\s*:\s*/i, '');
  if (!normalized) return '';
  if (/^sk-ant-/i.test(normalized) && !normalized.includes(';')) return `sessionKey=${normalized}`;
  if (!normalized.includes(';') && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=/.test(normalized)) {
    return `sessionKey=${normalized}`;
  }
  return normalized;
}

function cookieValue(header, name) {
  for (const segment of String(header || '').split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
    return segment.slice(separator + 1).trim();
  }
  return '';
}

export function cookieHeaderFromCredential(credential, targetUrl = CLAUDE_ORGANIZATIONS_URL) {
  if (typeof credential === 'string') return explicitCookieHeader(credential);
  if (!credential || typeof credential !== 'object') return '';

  let header = '';
  if (typeof credential.cookieHeader === 'string') header = explicitCookieHeader(credential.cookieHeader);
  else if (typeof credential.cookie === 'string') header = explicitCookieHeader(credential.cookie);
  else {
    const source = credential.cookieJar ?? credential.cookies;
    if (typeof source === 'string') header = explicitCookieHeader(source);
    else if (source && typeof source === 'object') header = buildCookieHeader(source, { url: targetUrl });
  }

  const sessionKey = safeCookieValue(
    credential.sessionKey ?? credential.session_key ?? credential.token ?? '',
    'sessionKey'
  );
  if (!cookieValue(header, 'sessionKey') && sessionKey) {
    header = header ? `${header}; sessionKey=${sessionKey}` : `sessionKey=${sessionKey}`;
  }
  return safeHeaderValue(header, 'cookie');
}

function stableUuid(secret, label) {
  const bytes = createHash('sha256').update(label).update('\0').update(secret).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeClaudeCredential(credential) {
  const record = typeof credential === 'string' ? {} : credential;
  const cookieHeader = cookieHeaderFromCredential(credential);
  const sessionKey = cookieValue(cookieHeader, 'sessionKey');
  if (!sessionKey) {
    throw new AuthError(
      'No usable Claude sessionKey found. Inject a bare sessionKey or a full claude.ai Cookie header.'
    );
  }

  const deviceId = safeHeaderValue(
    record?.deviceId ??
      record?.device_id ??
      record?.anthropicDeviceId ??
      cookieValue(cookieHeader, 'anthropic-device-id') ??
      '',
    'deviceId'
  ) || stableUuid(sessionKey, 'claude-device');
  const activitySessionId = safeHeaderValue(
    record?.activitySessionId ??
      record?.activity_session_id ??
      cookieValue(cookieHeader, 'activitySessionId') ??
      '',
    'activitySessionId'
  ) || stableUuid(sessionKey, 'claude-activity');
  const organizationId = safeHeaderValue(
    record?.organizationId ??
      record?.organization_id ??
      record?.orgId ??
      cookieValue(cookieHeader, 'lastActiveOrg') ??
      '',
    'organizationId'
  );

  return {
    cookieHeader,
    sessionKey,
    deviceId,
    activitySessionId,
    organizationId,
    userAgent: safeHeaderValue(record?.userAgent ?? record?.user_agent ?? USER_AGENT, 'userAgent'),
    tlsProfile: safeHeaderValue(record?.tlsProfile ?? record?.tls_profile ?? 'chrome142', 'tlsProfile'),
    locale: safeHeaderValue(record?.locale ?? 'en-US', 'locale'),
    timezone: safeHeaderValue(record?.timezone ?? 'UTC', 'timezone'),
    model: safeHeaderValue(record?.model ?? '', 'model'),
  };
}

export function normalizeClaudeState(state) {
  if (state == null) return { conversationId: '', parentMessageUuid: '' };
  if (typeof state !== 'object' || Array.isArray(state)) {
    throw new TypeError('claude chat: state must be an object');
  }
  return {
    conversationId: String(state.conversationId ?? state.conversation_id ?? '').trim(),
    parentMessageUuid: String(
      state.parentMessageUuid ?? state.parent_message_uuid ?? state.parentUuid ?? ''
    ).trim(),
  };
}

export function resolveClaudeModel(requestModel, credentialModel = '') {
  const requested = String(requestModel || '').trim();
  if (requested && !['claude', 'claude-web'].includes(requested.toLowerCase())) return requested;
  return credentialModel || DEFAULT_CLAUDE_MODEL;
}

export function promptFromMessages(messages, { resuming = false } = {}) {
  if (resuming) {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === 'user') return messages[index].content;
    }
  }
  if (messages.length === 1 && messages[0].role === 'user') return messages[0].content;
  return serializeMessages(messages);
}

export function buildCompletionBody(
  { prompt, model, state, locale = 'en-US', timezone = 'UTC' },
  { randomUUIDImpl = randomUUID } = {}
) {
  const turnMessageUuids = {
    human_message_uuid: randomUUIDImpl(),
    assistant_message_uuid: randomUUIDImpl(),
  };
  const body = {
    attachments: [],
    files: [],
    locale,
    model,
    personalized_styles: [{ ...DEFAULT_STYLE }],
    prompt,
    rendering_mode: 'messages',
    sync_sources: [],
    timezone,
    tools: DEFAULT_TOOLS.map((tool) => ({ ...tool })),
    turn_message_uuids: turnMessageUuids,
  };
  if (state.parentMessageUuid) {
    body.parent_message_uuid = state.parentMessageUuid;
  } else {
    body.create_conversation_params = {
      name: '',
      model,
      include_conversation_preferences: true,
      is_temporary: false,
      enabled_imagine: true,
    };
  }
  return body;
}

function browserHeaders(auth, accept) {
  return {
    Accept: accept,
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': `${auth.locale},en;q=0.9`,
    'anthropic-client-platform': 'web_claude_ai',
    'anthropic-client-version': '1.0.0',
    'anthropic-device-id': auth.deviceId,
    'x-activity-session-id': auth.activitySessionId,
    Cookie: auth.cookieHeader,
    Origin: CLAUDE_BASE_URL,
    Referer: `${CLAUDE_BASE_URL}/new`,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': auth.userAgent,
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
    throw new WebaiError('claude chat: response has no readable body');
  }
  const reader = body.getReader();
  let done = false;
  try {
    while (true) {
      const result = await raceWithSignal(reader.read(), signal);
      if (result.done) {
        done = true;
        return;
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
        // The transport may already have closed while cancellation propagated.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore an already released or errored reader.
    }
  }
}

async function readResponseText(response, signal, limit = 2000) {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of responseChunks(response.body, signal)) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length >= limit) break;
  }
  text += decoder.decode();
  return text.slice(0, limit);
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '') : '';
}

function cloudflareResponse(response, snippet = '') {
  if (headerValue(response?.headers, 'cf-mitigated').toLowerCase() === 'challenge') return true;
  const server = headerValue(response?.headers, 'server');
  const contentType = headerValue(response?.headers, 'content-type');
  return (
    /cloudflare/i.test(server) &&
    (/text\/html/i.test(contentType) || /cf-chl-|cloudflare|just a moment/i.test(snippet))
  );
}

function classifiedError(response, context, stage, snippet = '') {
  const status = Number(response?.status || 0);
  if (cloudflareResponse(response, snippet)) {
    return new CloudflareChallengeError(
      `${context} was blocked by a Cloudflare challenge (HTTP ${status || 'unknown'}).`,
      { provider: 'claude', stage, status }
    );
  }
  if (status === 401 || status === 403) {
    return new AuthError(`${context} rejected the Claude credential (HTTP ${status}).`);
  }
  if (status === 429 || /quota|rate.?limit|message.?limit|too many|usage limit/i.test(snippet)) {
    return new QuotaError(`${context} was rate limited (HTTP ${status}).`);
  }
  if ([301, 302, 303, 307, 308].includes(status)) {
    return new AuthError(`${context} redirected away from the authenticated Claude API (HTTP ${status}).`);
  }
  return new WebaiError(
    `${context} failed with HTTP ${status}${snippet ? `: ${snippet.slice(0, 500)}` : ''}`
  );
}

async function assertOk(response, context, stage, signal) {
  if (response?.status >= 200 && response.status < 300 && !cloudflareResponse(response)) return;
  let snippet = '';
  try {
    snippet = await readResponseText(response, signal, 1000);
  } catch {
    // Preserve the HTTP status when an error body is unavailable.
  }
  throw classifiedError(response, context, stage, snippet);
}

async function discoverOrganization(fetchImpl, auth, signal) {
  const response = await fetchOnce(
    fetchImpl,
    CLAUDE_ORGANIZATIONS_URL,
    { method: 'GET', headers: browserHeaders(auth, 'application/json') },
    signal,
    'claude organization discovery'
  );
  await assertOk(response, 'claude organization discovery', 'organizations', signal);
  const raw = await readResponseText(response, signal, 1_000_000);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new WebaiError('claude organization discovery returned invalid JSON');
  }
  const organizations = Array.isArray(payload) ? payload : payload?.organizations;
  const organizationId = organizations?.find((organization) => organization?.uuid || organization?.id);
  const value = organizationId?.uuid || organizationId?.id;
  if (!value) throw new AuthError('Claude credential has no accessible organization.');
  return String(value);
}

export async function* streamChat(
  request,
  {
    credential,
    fetchImpl = globalThis.fetch,
    signal,
    state,
    timeoutMs = request?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    randomUUIDImpl = randomUUID,
  } = {}
) {
  const messages = assertSupportedChatRequest(request);
  if (typeof fetchImpl !== 'function') throw new TypeError('claude chat: fetchImpl must be a function');
  if (typeof randomUUIDImpl !== 'function') {
    throw new TypeError('claude chat: randomUUIDImpl must be a function');
  }
  const auth = normalizeClaudeCredential(credential ?? getProvider('claude'));
  const priorState = normalizeClaudeState(state);
  if (priorState.parentMessageUuid && !priorState.conversationId) {
    throw new TypeError('claude chat: parentMessageUuid requires conversationId');
  }
  const deadlineMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const operation = createDeadlineSignal(signal, deadlineMs);
  let completed = false;

  try {
    const organizationId = auth.organizationId || await discoverOrganization(fetchImpl, auth, operation.signal);
    const conversationId = priorState.conversationId || randomUUIDImpl();
    const model = resolveClaudeModel(request.model, auth.model);
    const payload = buildCompletionBody(
      {
        prompt: promptFromMessages(messages, { resuming: !!priorState.parentMessageUuid }),
        model,
        state: priorState,
        locale: auth.locale,
        timezone: auth.timezone,
      },
      { randomUUIDImpl }
    );
    const completionUrl =
      `${CLAUDE_BASE_URL}/api/organizations/${encodeURIComponent(organizationId)}` +
      `/chat_conversations/${encodeURIComponent(conversationId)}/completion`;

    // Never retry this POST: a transport failure does not prove Claude failed
    // before creating the conversation or starting the assistant turn.
    const response = await fetchOnce(
      fetchImpl,
      completionUrl,
      {
        method: 'POST',
        headers: {
          ...browserHeaders(auth, 'text/event-stream'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      operation.signal,
      'claude completion'
    );
    await assertOk(response, 'claude completion', 'completion', operation.signal);

    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType && !contentType.includes('text/event-stream')) {
      const raw = await readResponseText(response, operation.signal, 2000);
      if (/quota|rate.?limit|message.?limit|too many|usage limit/i.test(raw)) {
        throw new QuotaError(`claude completion was rate limited: ${raw.slice(0, 500)}`);
      }
      if (/auth|session|cookie|login|sign.?in|credential|expired/i.test(raw)) {
        throw new AuthError(`claude completion rejected the credential: ${raw.slice(0, 500)}`);
      }
      throw new WebaiError(`claude completion returned ${contentType}: ${raw.slice(0, 500)}`);
    }

    const decoder = new TextDecoder();
    const sse = new ClaudeSseDecoder();
    const streamState = new ClaudeStreamState({ parentMessageUuid: priorState.parentMessageUuid });
    const consume = function* (records) {
      for (const record of records) yield* streamState.apply(record);
    };

    for await (const chunk of responseChunks(response.body, operation.signal)) {
      yield* consume(sse.push(decoder.decode(chunk, { stream: true })));
      if (streamState.completed) break;
    }
    if (!streamState.completed) {
      yield* consume(sse.push(decoder.decode()));
      yield* consume(sse.finish());
    }
    if (!streamState.completed) {
      throw new WebaiError('claude chat: stream ended before message_stop');
    }

    const metadata = streamState.metadata();
    if (streamState.stopReason === 'tool_calls') {
      throw new UnsupportedChatFeatureError(
        'upstream_tool_calls',
        'Claude Web stopped for a built-in tool call that cannot be represented by the text-only sidecar'
      );
    }
    completed = true;
    yield {
      type: 'finish',
      finishReason: streamState.stopReason,
      metadata: {
        provider: 'claude',
        model: request.model || 'claude-web',
        upstreamModel: model,
        organizationId,
        conversationId,
        ...metadata,
        parentMessageUuid: metadata.parentMessageUuid || payload.turn_message_uuids.assistant_message_uuid,
      },
    };
  } catch (error) {
    if (operation.timedOut) throw new WebaiError(`claude chat timed out after ${deadlineMs}ms`);
    if (signal?.aborted) throw signalReason(signal, 'claude chat aborted');
    throw error;
  } finally {
    if (!completed) operation.abort();
    operation.dispose();
  }
}

export const claudeChat = { id: 'claude-web', streamChat };

export default claudeChat;
