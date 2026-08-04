import { AuthError, QuotaError, WebaiError } from '../../errors.js';
import { createDeadlineSignal, raceWithSignal, signalReason } from '../../chat/abort.js';
import { assertSupportedChatRequest, serializeMessages } from '../../chat/messages.js';
import { buildCookieHeader, getProvider, rotate1PSIDTS } from '../../auth/store.js';
import {
  ENDPOINTS,
  buildGenerateBody,
  buildGenerateHeaders,
  buildGenerateQuery,
} from './reqbuild.js';
import { getNested, parseCandidate, parseResponseByFrame } from './parse.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const SESSION_INIT_RETRIES = 2;
const SESSION_INIT_RETRY_DELAY_MS = 250;
const USAGE_LIMIT_EXCEEDED = 1037;
const GEMINI_AUTH_COOKIES = ['__Secure-1PSID', '__Secure-1PSIDTS'];
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

function reqid() {
  return 100000 + Math.floor(Math.random() * 800000);
}

export function cookieHeaderFromCredential(credential, targetUrl = ENDPOINTS.INIT) {
  if (typeof credential === 'string') return credential.trim();
  if (!credential || typeof credential !== 'object') return '';

  if (typeof credential.cookieHeader === 'string') return credential.cookieHeader.trim();
  if (typeof credential.cookie === 'string') return credential.cookie.trim();

  const source = credential.cookieJar ?? credential.cookies ?? credential;
  if (typeof source === 'string') return source.trim();
  if (!source || typeof source !== 'object') return '';
  return buildCookieHeader(source, { only: GEMINI_AUTH_COOKIES, url: targetUrl });
}

function requireCredential(record) {
  if (!record) throw new AuthError('No Gemini credentials found. Inject a cookie credential or configure the webai store.');
  const cookieHeader = cookieHeaderFromCredential(record, ENDPOINTS.INIT);
  if (!/(?:^|;\s*)__Secure-1PSID=/.test(cookieHeader)) {
    throw new AuthError('Gemini credential is missing the __Secure-1PSID cookie.');
  }
  return { record, cookieHeader };
}

function sessionFromCredential(record) {
  const session = record?.session || record?.geminiSession || record;
  if (!session || typeof session.at !== 'string' || !session.at) return null;
  return {
    at: session.at,
    bl: session.bl || '',
    sessionId: session.sessionId || '',
    language: session.language || 'en',
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

async function fetchWithSignal(fetchImpl, url, init, signal) {
  let lateCancellation = null;
  const pending = Promise.resolve()
    .then(() => fetchImpl(url, { ...init, signal }))
    .then((response) => {
      // An injected fetch implementation may ignore AbortSignal and resolve just
      // after the abort won the race. Do not orphan its response body.
      if (signal.aborted && response?.body && typeof response.body.cancel === 'function') {
        lateCancellation = Promise.resolve(response.body.cancel(signal.reason)).catch(() => {});
      }
      return response;
    });
  try {
    return await raceWithSignal(pending, signal);
  } catch (err) {
    if (signal.aborted) {
      const late = await settleWithinTurn(pending);
      if (late.settled && lateCancellation) await settleWithinTurn(lateCancellation);
    }
    throw err;
  }
}

async function* responseChunks(body, signal) {
  if (!body || typeof body.getReader !== 'function') {
    throw new WebaiError('gemini chat: response has no readable body');
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
    const release = () => {
      try {
        reader.releaseLock();
      } catch {
        // Ignore an already-released reader or an in-flight read during abort.
      }
    };
    if (!done) {
      let cancellation;
      try {
        cancellation = reader.cancel(signal?.reason);
      } catch {
        // The underlying fetch may already have errored after abort.
      }
      if (cancellation) {
        // Give cancellation one event-loop turn, but never let a broken custom
        // stream extend the operation indefinitely beyond its deadline.
        await Promise.race([
          cancellation.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 0)),
        ]);
      }
    }
    release();
  }
}

async function readResponseText(response, signal, limit = Infinity) {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of responseChunks(response.body, signal)) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length >= limit) break;
  }
  text += decoder.decode();
  return text.slice(0, limit);
}

async function retryDelay(attempt, signal) {
  let timer;
  try {
    await raceWithSignal(
      new Promise((resolve) => {
        timer = setTimeout(resolve, SESSION_INIT_RETRY_DELAY_MS * 2 ** attempt);
      }),
      signal
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function statusError(response, context, signal) {
  if (response.status < 400) return null;
  const snippet = await readResponseText(response, signal, 500);
  if (response.status === 401 || response.status === 403) {
    return new AuthError(`${context} rejected the Gemini credential (HTTP ${response.status}).`);
  }
  if (response.status === 429) return new QuotaError(`${context} was rate limited (HTTP 429).`);
  return new WebaiError(`${context} failed with HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`);
}

async function initSession(loadedCredential, fetchImpl, signal, { allowPreloaded = true } = {}) {
  const preloaded = allowPreloaded ? sessionFromCredential(loadedCredential.record) : null;
  if (preloaded) return { ...preloaded, cookieHeader: loadedCredential.cookieHeader };

  let response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetchWithSignal(
        fetchImpl,
        ENDPOINTS.INIT,
        {
          method: 'GET',
          headers: {
            Cookie: loadedCredential.cookieHeader,
            Referer: 'https://gemini.google.com/',
            'User-Agent': USER_AGENT,
            'Accept-Language': 'en-US,en;q=0.9',
          },
        },
        signal
      );
      break;
    } catch (error) {
      if (signal.aborted || attempt >= SESSION_INIT_RETRIES) throw error;
      await retryDelay(attempt, signal);
    }
  }
  const error = await statusError(response, 'gemini session init', signal);
  if (error) throw error;
  const html = await readResponseText(response, signal);
  const at = (html.match(/"SNlM0e":"(.*?)"/) || [])[1];
  const bl = (html.match(/"cfb2h":"(.*?)"/) || [])[1] || '';
  const sessionId = (html.match(/"FdrFJe":"(.*?)"/) || [])[1] || '';
  const language = (html.match(/"TuX5cc":"(.*?)"/) || [])[1] || 'en';
  if (!at) throw new AuthError('Gemini session init returned no SNlM0e token; the injected cookies are expired.');
  return { at, bl, sessionId, language, cookieHeader: loadedCredential.cookieHeader };
}

async function loadSession(explicitCredential, fetchImpl, signal, rotateImpl = rotate1PSIDTS) {
  const injected = explicitCredential != null;
  let loaded = requireCredential(injected ? explicitCredential : getProvider('gemini'));
  try {
    return await initSession(loaded, fetchImpl, signal);
  } catch (err) {
    if (injected || !(err instanceof AuthError)) throw err;
    await rotateStoredCredential(rotateImpl, signal);
    loaded = requireCredential(getProvider('gemini'));
    return initSession(loaded, fetchImpl, signal);
  }
}

async function rotateStoredCredential(rotateImpl, signal) {
  try {
    await raceWithSignal(rotateImpl('gemini'), signal);
  } catch (rotationError) {
    if (signal.aborted) throw signalReason(signal, 'gemini chat aborted');
    if (rotationError instanceof AuthError) throw rotationError;
    throw new AuthError(
      'Gemini cookies are expired and automatic __Secure-1PSIDTS rotation failed. ' +
        'Run webai auth login gemini with fresh cookies.'
    );
  }
}

async function refreshStoredSession(fetchImpl, signal, rotateImpl) {
  await rotateStoredCredential(rotateImpl, signal);
  const loaded = requireCredential(getProvider('gemini'));
  return initSession(loaded, fetchImpl, signal, { allowPreloaded: false });
}

async function submitGeneration(session, prompt, fetchImpl, signal) {
  const { body, uuid } = buildGenerateBody({
    prompt,
    at: session.at,
    language: session.language,
    temporary: true,
  });
  const url = `${ENDPOINTS.GENERATE}?${buildGenerateQuery({
    bl: session.bl,
    reqid: reqid(),
    language: session.language,
    sessionId: session.sessionId,
  })}`;

  return fetchWithSignal(
    fetchImpl,
    url,
    {
      method: 'POST',
      headers: {
        ...buildGenerateHeaders({ uuid }),
        Accept: '*/*',
        Cookie: session.cookieHeader,
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      body,
    },
    signal
  );
}

export class GeminiFrameDecoder {
  constructor() {
    this.buffer = '';
    this.preambleHandled = false;
  }

  push(text) {
    this.buffer += text;
    if (!this.preambleHandled) {
      const marker = ")]}'";
      let offset = 0;
      while (offset < this.buffer.length && /\s/.test(this.buffer[offset])) offset++;
      const available = this.buffer.slice(offset);
      if (available.length < marker.length && marker.startsWith(available)) return [];
      if (available.startsWith(marker)) this.buffer = this.buffer.slice(offset + marker.length);
      this.preambleHandled = true;
    }

    const { frames, rest } = parseResponseByFrame(this.buffer);
    this.buffer = rest;
    return frames;
  }

  finish() {
    const frames = this.push('');
    if (this.buffer.trim()) {
      throw new WebaiError('gemini chat: truncated or invalid StreamGenerate frame at end of response');
    }
    return frames;
  }
}

export function parseChatFrame(part) {
  const errorCode = getNested(part, [5, 2, 0, 1, 0]);
  const innerStr = getNested(part, [2]);
  if (typeof innerStr !== 'string') return { errorCode };

  let inner;
  try {
    inner = JSON.parse(innerStr);
  } catch {
    return { errorCode };
  }

  const ids = getNested(inner, [1], []) || [];
  const candidates = getNested(inner, [4], []) || [];
  let candidateId = '';
  let text = '';
  let completed = false;
  for (const candidate of candidates) {
    if (!candidateId && getNested(candidate, [0])) candidateId = getNested(candidate, [0]);
    const parsed = parseCandidate(candidate);
    if (!text && parsed.text) text = parsed.text;
    if (getNested(candidate, [8, 0]) === 2) completed = true;
  }

  return {
    errorCode,
    conversationId: ids[0] || '',
    responseId: ids[1] || '',
    candidateId,
    text,
    completed,
  };
}

function cumulativeDelta(previous, next) {
  if (!next || next === previous || previous.startsWith(next)) return '';
  if (next.startsWith(previous)) return next.slice(previous.length);
  let common = 0;
  while (common < previous.length && common < next.length && previous[common] === next[common]) common++;
  return next.slice(common);
}

export async function* streamChat(
  request,
  {
    credential,
    fetchImpl = globalThis.fetch,
    rotateImpl = rotate1PSIDTS,
    signal,
    timeoutMs = request?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  } = {}
) {
  const messages = assertSupportedChatRequest(request);
  if (typeof fetchImpl !== 'function') throw new TypeError('webai chat: fetchImpl must be a function');
  const prompt = serializeMessages(messages);
  const deadlineMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const operation = createDeadlineSignal(signal, deadlineMs);
  let responseFinished = false;

  try {
    let session = await loadSession(credential, fetchImpl, operation.signal, rotateImpl);

    // A transport failure is never retried because the server may already have
    // accepted the generation. A definitive auth rejection is safe to retry once
    // after rotating credentials, but only when webai owns the stored credential.
    let response = await submitGeneration(session, prompt, fetchImpl, operation.signal);
    let error = await statusError(response, 'gemini StreamGenerate', operation.signal);
    if (error instanceof AuthError && credential == null) {
      session = await refreshStoredSession(fetchImpl, operation.signal, rotateImpl);
      response = await submitGeneration(session, prompt, fetchImpl, operation.signal);
      error = await statusError(response, 'gemini StreamGenerate', operation.signal);
    }
    if (error) throw error;

    const textDecoder = new TextDecoder();
    const frameDecoder = new GeminiFrameDecoder();
    let emittedText = '';
    let completed = false;
    const metadata = {
      provider: 'gemini',
      model: request.model || 'gemini-web',
      conversationId: '',
      responseId: '',
      candidateId: '',
    };

    const consume = (frame) => {
      const update = parseChatFrame(frame);
      if (update.errorCode === USAGE_LIMIT_EXCEEDED) {
        throw new QuotaError('Gemini web usage limit exceeded.');
      }
      if (update.errorCode != null && update.errorCode !== 0 && update.errorCode !== '0') {
        throw new WebaiError(`gemini chat: StreamGenerate returned error code ${update.errorCode}`);
      }
      if (update.conversationId) metadata.conversationId = update.conversationId;
      if (update.responseId) metadata.responseId = update.responseId;
      if (update.candidateId) metadata.candidateId = update.candidateId;
      completed ||= !!update.completed;
      const delta = cumulativeDelta(emittedText, update.text || '');
      if (update.text && update.text.length >= emittedText.length) emittedText = update.text;
      return delta;
    };

    for await (const chunk of responseChunks(response.body, operation.signal)) {
      const frames = frameDecoder.push(textDecoder.decode(chunk, { stream: true }));
      for (const frame of frames) {
        const delta = consume(frame);
        if (delta) yield { type: 'text_delta', text: delta };
      }
      if (completed) break;
    }
    const tail = textDecoder.decode();
    const finalFrames = [...frameDecoder.push(tail), ...frameDecoder.finish()];
    for (const frame of finalFrames) {
      const delta = consume(frame);
      if (delta) yield { type: 'text_delta', text: delta };
    }

    if (!completed) {
      throw new WebaiError('gemini chat: stream ended before completion');
    }
    responseFinished = true;
    yield {
      type: 'finish',
      finishReason: 'stop',
      metadata: { ...metadata, completed },
    };
  } catch (err) {
    if (operation.timedOut) {
      throw new WebaiError(`gemini chat timed out after ${deadlineMs}ms`);
    }
    if (signal?.aborted) throw signalReason(signal, 'gemini chat aborted');
    throw err;
  } finally {
    if (!responseFinished) operation.abort();
    operation.dispose();
  }
}

export const geminiChat = { id: 'gemini-web', streamChat };

export default geminiChat;
