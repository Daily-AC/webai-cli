import crypto from 'node:crypto';
import { createDeadlineSignal, raceWithSignal, signalReason } from '../../chat/abort.js';
import { assertSupportedChatRequest, serializeMessages } from '../../chat/messages.js';
import { buildCookieHeader, getProvider, setProvider } from '../../auth/store.js';
import { AuthError, QuotaError, WebaiError } from '../../errors.js';
import {
  USER_AGENT,
  buildUrlParams,
  generateXFlowTrace,
  signSamanthaUrl,
} from './sign.js';

const API_BASE = 'https://www.doubao.com';
const COMPLETION_URL = `${API_BASE}/samantha/chat/completion`;
const DEFAULT_TIMEOUT_MS = 120_000;
const RATE_LIMIT_CODE = 710022004;
const INVALID_USER_CODE = 710012000;
const TEXT_CONTENT_TYPES = new Set([10000, 2001, 2008, 2071]);

function randomDeviceId() {
  const digits = Array.from(crypto.randomBytes(18), (byte) => String(byte % 10)).join('');
  return `7${digits}`;
}

function normalizeDevice(device = {}) {
  const deviceId = device.deviceId || randomDeviceId();
  const webId = device.webId || deviceId;
  return {
    deviceId,
    webId,
    teaUuid: device.teaUuid || webId,
    ...(device.webTabId ? { webTabId: device.webTabId } : {}),
    ...(device.fp ? { fp: device.fp } : {}),
  };
}

export function cookieHeaderFromCredential(credential) {
  if (typeof credential === 'string') return credential.trim();
  if (!credential || typeof credential !== 'object') return '';
  if (typeof credential.cookieHeader === 'string') return credential.cookieHeader.trim();
  if (typeof credential.cookie === 'string') return credential.cookie.trim();
  return buildCookieHeader(credential.cookieJar || credential.cookies || credential, {
    url: COMPLETION_URL,
  });
}

function loadCredential(explicitCredential) {
  const stored = explicitCredential == null;
  const record = stored ? getProvider('doubao') : explicitCredential;
  const cookieHeader = cookieHeaderFromCredential(record);
  if (!/(?:^|;\s*)sessionid=/.test(cookieHeader)) {
    throw new AuthError(
      'No usable Doubao sessionid cookie found. Run: webai auth login doubao'
    );
  }

  const device = normalizeDevice(record?.device);
  if (stored && (!record.device?.deviceId || !record.device?.webId || !record.device?.teaUuid)) {
    setProvider('doubao', { device });
  }
  return { cookieHeader, device };
}

function promptFromMessages(messages) {
  if (messages.length === 1 && messages[0].role === 'user') return messages[0].content;
  return serializeMessages(messages);
}

export function buildChatBody(prompt, { randomUUID = crypto.randomUUID, now = Date.now } = {}) {
  return {
    messages: [
      {
        content: JSON.stringify({ text: prompt }),
        content_type: 2001,
        attachments: [],
        references: [],
      },
    ],
    completion_option: {
      is_regen: false,
      with_suggest: false,
      need_create_conversation: true,
      launch_stage: 1,
      is_replace: false,
      is_delete: false,
      message_from: 0,
      action_bar_skill_id: 0,
      use_deep_think: false,
      use_auto_cot: false,
      resend_for_regen: false,
      enable_commerce_credit: false,
      event_id: '0',
    },
    evaluate_option: { web_ab_params: '' },
    section_id: `26${String(now()).replace(/\D/g, '').slice(-16).padStart(16, '0')}`,
    conversation_id: '0',
    local_conversation_id: `local_16${String(now()).replace(/\D/g, '').slice(-14).padStart(14, '0')}`,
    local_message_id: randomUUID(),
    ext: { fp: '' },
  };
}

function providerCodeError(code, message = '') {
  const embeddedCode = String(message).match(/(?:code\s*[=:]\s*|\b)(\d{6,})\b/i)?.[1];
  const numericCode = Number.isFinite(Number(code)) ? Number(code) : Number(embeddedCode);
  if (numericCode === INVALID_USER_CODE || /\buser invalid\b/i.test(message)) {
    return new AuthError(`Doubao rejected the configured credential (${INVALID_USER_CODE}).`);
  }
  if (numericCode === RATE_LIMIT_CODE) {
    return new QuotaError(`Doubao web rate limit exceeded (${RATE_LIMIT_CODE}).`);
  }
  return new WebaiError(`doubao chat: upstream error ${code}${message ? ` (${message})` : ''}`);
}

function decodedContent(content) {
  if (typeof content !== 'string' || !content) return '';
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed?.text === 'string') return parsed.text;
    if (typeof parsed?.delta?.text === 'string') return parsed.delta.text;
    if (typeof parsed?.content === 'string') return parsed.content;
  } catch {
    return content;
  }
  return '';
}

function samanthaEvents(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (payload.code != null && Number(payload.code) !== 0) {
    throw providerCodeError(payload.code, payload.message);
  }
  if (payload.event_type === 2003) return [{ type: 'finish' }];

  let data = payload.event_data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      throw new WebaiError('doubao chat: invalid event_data JSON');
    }
  }
  if (!data || typeof data !== 'object') return [];

  const metadata = {};
  if (data.conversation_id) metadata.conversationId = String(data.conversation_id);
  if (data.message_id) metadata.responseId = String(data.message_id);
  const events = Object.keys(metadata).length ? [{ type: 'metadata', metadata }] : [];
  if (data.is_finish) return [...events, { type: 'finish' }];
  if (![2001, 2002].includes(payload.event_type)) return events;

  const message = data.message;
  if (!message || !TEXT_CONTENT_TYPES.has(Number(message.content_type))) return events;
  const text = decodedContent(message.content);
  if (text) events.push({ type: 'text', text });
  return events;
}

function namedSseEvents(event, payload) {
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    throw new WebaiError(`doubao chat: invalid ${event || 'SSE'} event JSON`);
  }
  const normalizedEvent = event.replaceAll('-', '_').toUpperCase();
  if (normalizedEvent === 'STREAM_ERROR' || normalizedEvent === 'GATEWAY_ERROR') {
    throw providerCodeError(
      data.error_code ?? data.code ?? 'unknown',
      data.error_msg ?? data.message ?? ''
    );
  }
  if (normalizedEvent === 'CHUNK_DELTA') {
    return typeof data.text === 'string' && data.text ? [{ type: 'text', text: data.text }] : [];
  }
  if (normalizedEvent === 'STREAM_CHUNK') {
    return (Array.isArray(data.patch_op) ? data.patch_op : [])
      .map((patch) => patch?.patch_value?.tts_content)
      .filter((text) => typeof text === 'string' && text)
      .map((text) => ({ type: 'text', text }));
  }
  if (normalizedEvent === 'STREAM_MSG_NOTIFY') {
    const blocks = data.content?.content_block;
    return (Array.isArray(blocks) ? blocks : [])
      .map((block) => block?.content?.text_block?.text)
      .filter((text) => typeof text === 'string' && text)
      .map((text) => ({ type: 'text', text }));
  }
  if (['STREAM_END', 'STREAM_FINISH', 'DONE'].includes(normalizedEvent)) return [{ type: 'finish' }];
  return [];
}

function payloadEvents(event, payload) {
  if (event) return namedSseEvents(event, payload);
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new WebaiError('doubao chat: invalid Samantha event JSON');
  }
  return samanthaEvents(parsed);
}

export class DoubaoStreamDecoder {
  constructor() {
    this.buffer = '';
    this.pendingEvent = '';
    this.pendingData = [];
  }

  push(text) {
    this.buffer += text;
    const events = [];
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      events.push(...this.consumeLine(line));
    }
    return events;
  }

  finish() {
    const events = [];
    if (this.buffer) events.push(...this.consumeLine(this.buffer.replace(/\r$/, '')));
    this.buffer = '';
    events.push(...this.flushPending());
    return events;
  }

  consumeLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return this.flushPending();

    const combined = trimmed.match(/^id:\s*\S+\s+event:\s*(\S+)\s+data:\s*(.+)$/);
    if (combined) return payloadEvents(combined[1], combined[2]);
    if (trimmed.startsWith('event:')) {
      this.pendingEvent = trimmed.slice(6).trim();
      return [];
    }
    if (trimmed.startsWith('data:')) {
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return [{ type: 'finish' }];
      this.pendingData.push(data);
      return [];
    }
    return payloadEvents('', trimmed);
  }

  flushPending() {
    if (this.pendingData.length === 0) {
      this.pendingEvent = '';
      return [];
    }
    const event = this.pendingEvent;
    const data = this.pendingData.join('\n');
    this.pendingEvent = '';
    this.pendingData = [];
    return payloadEvents(event, data);
  }
}

async function* responseChunks(body, signal) {
  if (!body || typeof body.getReader !== 'function') {
    throw new WebaiError('doubao chat: response has no readable body');
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
        await Promise.race([reader.cancel(signal?.reason).catch(() => {}), Promise.resolve()]);
      } catch {
        // The transport may already have closed while cancellation was propagating.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore an already released reader.
    }
  }
}

async function statusError(response, signal) {
  if (response.status < 400) return null;
  if (response.status === 401 || response.status === 403) {
    return new AuthError(`Doubao rejected the configured credential (HTTP ${response.status}).`);
  }
  if (response.status === 429) return new QuotaError('Doubao web rate limit exceeded (HTTP 429).');
  let snippet = '';
  try {
    snippet = (await raceWithSignal(response.text(), signal)).slice(0, 300);
  } catch {
    // Preserve the HTTP status when an error response body cannot be read.
  }
  return new WebaiError(`doubao chat: completion failed with HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`);
}

export async function* streamChat(
  request,
  {
    credential,
    fetchImpl = globalThis.fetch,
    signal,
    timeoutMs = request?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  } = {}
) {
  const messages = assertSupportedChatRequest(request);
  if (typeof fetchImpl !== 'function') throw new TypeError('webai chat: fetchImpl must be a function');
  const deadlineMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const operation = createDeadlineSignal(signal, deadlineMs);
  let completed = false;

  try {
    const auth = loadCredential(credential);
    const body = buildChatBody(promptFromMessages(messages));
    const bodyJson = JSON.stringify(body);
    const params = buildUrlParams({
      deviceId: auth.device.deviceId,
      webId: auth.device.webId,
      teaUuid: auth.device.teaUuid,
      webTabId: auth.device.webTabId,
    });
    const url = signSamanthaUrl(COMPLETION_URL, params, bodyJson);

    // Never retry a submitted generation: a transport failure does not prove
    // that Doubao rejected the request before creating a conversation.
    const response = await raceWithSignal(
      fetchImpl(url, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          'agw-js-conv': 'str',
          Cookie: auth.cookieHeader,
          Origin: API_BASE,
          Referer: `${API_BASE}/chat/`,
          'User-Agent': USER_AGENT,
          'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
          'x-flow-trace': generateXFlowTrace(),
        },
        body: bodyJson,
        signal: operation.signal,
      }),
      operation.signal
    );
    const error = await statusError(response, operation.signal);
    if (error) throw error;

    const decoder = new TextDecoder();
    const streamDecoder = new DoubaoStreamDecoder();
    const metadata = { provider: 'doubao', model: request.model || 'doubao-web' };
    const consume = function* (events) {
      for (const event of events) {
        if (event.type === 'metadata') Object.assign(metadata, event.metadata);
        else if (event.type === 'text') yield { type: 'text_delta', text: event.text };
        else if (event.type === 'finish') completed = true;
      }
    };

    for await (const chunk of responseChunks(response.body, operation.signal)) {
      yield* consume(streamDecoder.push(decoder.decode(chunk, { stream: true })));
      if (completed) break;
    }
    yield* consume(streamDecoder.push(decoder.decode()));
    yield* consume(streamDecoder.finish());
    if (!completed) throw new WebaiError('doubao chat: stream ended before a completion event');
    yield { type: 'finish', finishReason: 'stop', metadata };
  } catch (error) {
    if (operation.timedOut) throw new WebaiError(`doubao chat timed out after ${deadlineMs}ms`);
    if (signal?.aborted) throw signalReason(signal, 'doubao chat aborted');
    throw error;
  } finally {
    operation.abort();
    operation.dispose();
  }
}

export const doubaoChat = { id: 'doubao-web', streamChat };

export default doubaoChat;
