import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { UnsupportedChatFeatureError } from '../chat/errors.js';
import { normalizeMessages } from '../chat/messages.js';
import { AuthError, QuotaError } from '../errors.js';

export const DEFAULT_BODY_LIMIT = 1024 * 1024;

const JSON_CONTENT_TYPE = /^application\/(?:[\w!#$&^_.+-]+\+)?json(?:\s*;|$)/i;

export function createOpenAIServer({
  chatProvider,
  chatProviders,
  models,
  token,
  logger = console,
  bodyLimit = DEFAULT_BODY_LIMIT,
} = {}) {
  const providerRouter = normalizeChatProviders(chatProvider, chatProviders);
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('token must be a non-empty string');
  }
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit <= 0) {
    throw new TypeError('bodyLimit must be a positive integer');
  }

  const modelList = normalizeModels(models ?? providerRouter.modelIds);

  const activeRequests = new Set();
  const connections = new Set();
  const server = createServer((req, res) => {
    void handleRequest(req, res, { providerRouter, modelList, token, logger, bodyLimit, activeRequests });
  });
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  server.abortActiveRequests = (reason = new Error('OpenAI sidecar is shutting down')) => {
    for (const active of activeRequests) {
      active.controller.abort(reason);
      active.response.destroy();
    }
    // Requests that are still uploading their JSON body have not reached the
    // provider yet, so they are not in activeRequests. They must also be closed
    // during shutdown or server.close() can wait forever on a stalled client.
    for (const socket of connections) socket.destroy();
  };
  return server;
}

export async function startOpenAIServer({ host = '127.0.0.1', port = 0, ...options } = {}) {
  const server = createOpenAIServer(options);
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    return server;
  } catch (error) {
    server.close();
    throw error;
  }
}

async function handleRequest(req, res, context) {
  const pathname = requestPath(req);

  if (req.method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (!isAuthorized(req.headers.authorization, context.token)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    sendError(res, 401, 'Invalid or missing bearer token.', 'authentication_error', null, 'invalid_api_key');
    return;
  }

  if (req.method === 'GET' && pathname === '/v1/models') {
    sendJson(res, 200, { object: 'list', data: context.modelList });
    return;
  }

  if (req.method === 'POST' && (pathname === '/v1/responses/compact' || pathname === '/responses/compact')) {
    sendError(
      res,
      501,
      'Response compaction is not supported by this upstream.',
      'unsupported_feature',
      null,
      'responses_compact_unsupported'
    );
    return;
  }

  if (req.method !== 'POST' || pathname !== '/v1/chat/completions') {
    sendError(res, 404, 'Not found.', 'invalid_request_error', null, 'not_found');
    return;
  }

  if (!isJsonContentType(req.headers['content-type'])) {
    sendError(
      res,
      415,
      'Content-Type must be application/json.',
      'invalid_request_error',
      null,
      'unsupported_media_type'
    );
    return;
  }

  let request;
  try {
    request = await readJsonBody(req, context.bodyLimit);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendError(res, 413, error.message, 'invalid_request_error', null, 'request_too_large');
      return;
    }
    if (error instanceof ClientDisconnectedError) return;
    sendError(res, 400, 'Request body must contain valid JSON.', 'invalid_request_error', null, 'invalid_json');
    return;
  }

  const validationError = validateChatRequest(request);
  if (validationError) {
    sendError(res, validationError.status, validationError.message, validationError.type, validationError.param, validationError.code);
    return;
  }

  const chatProvider = context.providerRouter.resolve(request.model);
  if (!chatProvider) {
    sendError(
      res,
      404,
      `The model "${request.model}" is not available.`,
      'invalid_request_error',
      'model',
      'model_not_found'
    );
    return;
  }

  const controller = new AbortController();
  const activeRequest = { controller, response: res };
  context.activeRequests.add(activeRequest);
  const abort = () => controller.abort();
  const abortIfIncomplete = () => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', abortIfIncomplete);
  if (req.aborted || res.destroyed) abort();

  try {
    if (request.stream === true) {
      await streamCompletion(res, request, chatProvider, controller.signal);
    } else {
      await collectCompletion(res, request, chatProvider, controller.signal);
    }
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    const publicError = providerError(error);
    logProviderFailure(context.logger, publicError);
    if (!res.headersSent) {
      sendError(
        res,
        publicError.status,
        publicError.message,
        publicError.type,
        publicError.param,
        publicError.code
      );
    } else {
      // Once a 200 stream has started, an OpenAI-style error object is not
      // portable across protocol translators. Closing an unfinished chunked
      // response makes relays surface a transport failure instead of treating a
      // partial answer followed by [DONE] as successful.
      res.destroy();
    }
  } finally {
    context.activeRequests.delete(activeRequest);
    req.off('aborted', abort);
    res.off('close', abortIfIncomplete);
  }
}

async function collectCompletion(res, request, chatProvider, signal) {
  const completion = newCompletion(request.model);
  let text = '';
  let finishReason = 'stop';
  let metadata;

  for await (const event of providerEvents(chatProvider, request, signal)) {
    if (event.type === 'text_delta') {
      text += event.text;
      continue;
    }
    finishReason = event.finishReason || 'stop';
    metadata = event.metadata;
    break;
  }

  const response = {
    id: completion.id,
    object: 'chat.completion',
    created: completion.created,
    model: completion.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: finishReason,
      },
    ],
  };
  addUsage(response, metadata);
  sendJson(res, 200, response);
}

async function streamCompletion(res, request, chatProvider, signal) {
  const completion = newCompletion(request.model);
  const events = providerEvents(chatProvider, request, signal);
  const iterator = events[Symbol.asyncIterator]();
  let finished = false;

  try {
    // Prime the provider before committing a 200 response. Authentication,
    // quota, and feature failures normally happen before the first text event,
    // so CLIProxyAPI can still act on their real HTTP status.
    let next = await iterator.next();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    await writeSse(res, completionChunk(completion, { role: 'assistant' }, null), signal);
    while (!next.done) {
      const event = next.value;
      if (event.type === 'text_delta') {
        await writeSse(res, completionChunk(completion, { content: event.text }, null), signal);
        next = await iterator.next();
        continue;
      }
      const chunk = completionChunk(completion, {}, event.finishReason || 'stop');
      await writeSse(res, chunk, signal);
      if (request.stream_options?.include_usage === true && event.metadata?.usage) {
        const usageChunk = { ...completion, object: 'chat.completion.chunk', choices: [] };
        addUsage(usageChunk, event.metadata);
        await writeSse(res, usageChunk, signal);
      }
      finished = true;
      break;
    }

    if (!finished) await writeSse(res, completionChunk(completion, {}, 'stop'), signal);
    await writeResponse(res, 'data: [DONE]\n\n', signal);
    res.end();
  } finally {
    await iterator.return?.();
  }
}

async function* providerEvents(chatProvider, request, signal) {
  if (signal.aborted) return;
  const stream = chatProvider.streamChat(request, { signal });
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('chatProvider.streamChat must return an AsyncIterable');
  }
  for await (const event of stream) {
    if (signal.aborted) return;
    if (event?.type === 'text_delta' && typeof event.text === 'string') {
      yield event;
      continue;
    }
    if (event?.type === 'finish' && (event.finishReason === undefined || typeof event.finishReason === 'string')) {
      yield event;
      return;
    }
    throw new TypeError('chatProvider emitted an invalid event');
  }
}

function validateChatRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return invalidRequest('Request body must be a JSON object.');
  }
  if (typeof request.model !== 'string' || request.model.length === 0) {
    return invalidRequest('model must be a non-empty string.', 'model');
  }
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    return invalidRequest('messages must be a non-empty array.', 'messages');
  }
  if (request.stream !== undefined && typeof request.stream !== 'boolean') {
    return invalidRequest('stream must be a boolean.', 'stream');
  }
  if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > 0)) {
    return unsupportedTools('tools');
  }
  if (request.tool_choice !== undefined && request.tool_choice !== null && request.tool_choice !== 'none') {
    return unsupportedTools('tool_choice');
  }
  try {
    normalizeMessages(request.messages);
  } catch (error) {
    if (error instanceof UnsupportedChatFeatureError) {
      return {
        status: 422,
        message: 'The request contains an unsupported message feature.',
        type: 'unsupported_feature',
        param: error.feature || 'messages',
        code: 'unsupported_feature',
      };
    }
    if (error instanceof TypeError) {
      return invalidRequest('messages contains an invalid role or content value.', 'messages');
    }
    throw error;
  }
  return null;
}

function invalidRequest(message, param = null) {
  return { status: 400, message, type: 'invalid_request_error', param, code: 'invalid_request' };
}

function unsupportedTools(param) {
  return {
    status: 422,
    message: 'Tool calling is not supported by this upstream.',
    type: 'unsupported_feature',
    param,
    code: 'tool_calls_unsupported',
  };
}

function providerError(error) {
  if (error instanceof AuthError) {
    return {
      status: 401,
      message: 'The upstream provider rejected the configured credentials.',
      type: 'authentication_error',
      param: null,
      code: 'upstream_auth_error',
    };
  }
  if (error instanceof QuotaError) {
    return {
      status: 429,
      message: 'The upstream provider rate limit or quota was exceeded.',
      type: 'rate_limit_error',
      param: null,
      code: 'rate_limit_error',
    };
  }
  if (error instanceof UnsupportedChatFeatureError) {
    return {
      status: 422,
      message: 'The upstream provider does not support a requested chat feature.',
      type: 'unsupported_feature',
      param: typeof error.feature === 'string' ? error.feature : null,
      code: 'unsupported_feature',
    };
  }
  return {
    status: 502,
    message: 'The upstream provider failed.',
    type: 'upstream_error',
    param: null,
    code: 'upstream_error',
  };
}

function logProviderFailure(logger, publicError) {
  try {
    logger?.error?.('OpenAI sidecar upstream failed', {
      code: publicError.code,
    });
  } catch {
    // A logger must not break the HTTP error response.
  }
}

function normalizeModels(models) {
  if (!Array.isArray(models)) throw new TypeError('models must be an array');
  const created = Math.floor(Date.now() / 1000);
  return models.map((model) => {
    if (typeof model === 'string' && model.length > 0) {
      return { id: model, object: 'model', created, owned_by: 'webai' };
    }
    if (model && typeof model === 'object' && typeof model.id === 'string' && model.id.length > 0) {
      return {
        object: 'model',
        created,
        owned_by: 'webai',
        ...model,
      };
    }
    throw new TypeError('each model must be a non-empty string or an object with an id');
  });
}

function normalizeChatProviders(chatProvider, chatProviders) {
  if (chatProvider && chatProviders !== undefined) {
    throw new TypeError('provide either chatProvider or chatProviders, not both');
  }
  if (chatProvider) {
    assertChatProvider(chatProvider, 'chatProvider');
    return {
      modelIds: typeof chatProvider.id === 'string' && chatProvider.id ? [chatProvider.id] : [],
      resolve() {
        return chatProvider;
      },
    };
  }

  let entries;
  if (chatProviders instanceof Map) entries = [...chatProviders.entries()];
  else if (Array.isArray(chatProviders)) entries = chatProviders.map((provider) => [provider?.id, provider]);
  else if (chatProviders && typeof chatProviders === 'object') entries = Object.entries(chatProviders);
  else throw new TypeError('chatProvider.streamChat or chatProviders must be provided');

  const byModel = new Map();
  for (const [model, provider] of entries) {
    if (typeof model !== 'string' || !model) {
      throw new TypeError('each chatProviders entry must have a non-empty model id');
    }
    assertChatProvider(provider, `chatProviders[${model}]`);
    if (byModel.has(model)) throw new TypeError(`duplicate chat provider model id "${model}"`);
    byModel.set(model, provider);
  }
  if (byModel.size === 0) throw new TypeError('chatProviders must not be empty');
  return {
    modelIds: [...byModel.keys()],
    resolve(model) {
      return byModel.get(model) || null;
    },
  };
}

function assertChatProvider(provider, label) {
  if (!provider || typeof provider.streamChat !== 'function') {
    throw new TypeError(`${label}.streamChat must be a function`);
  }
}

function newCompletion(model) {
  return {
    id: `chatcmpl-${randomUUID().replaceAll('-', '')}`,
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

function completionChunk(completion, delta, finishReason) {
  return {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function addUsage(response, metadata) {
  if (metadata?.usage && typeof metadata.usage === 'object' && !Array.isArray(metadata.usage)) {
    response.usage = metadata.usage;
  }
}

function requestPath(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

function isJsonContentType(value) {
  return typeof value === 'string' && JSON_CONTENT_TYPE.test(value);
}

function isAuthorized(header, expectedToken) {
  if (typeof header !== 'string') return false;
  const match = header.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return false;
  const actual = createHash('sha256').update(match[1]).digest();
  const expected = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(actual, expected);
}

function readJsonBody(req, limit) {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    req.resume();
    return Promise.reject(new BodyTooLargeError(limit));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish(() => reject(new BodyTooLargeError(limit)));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      finish(() => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
    };
    const onError = (error) => finish(() => reject(error));
    const onAborted = () => finish(() => reject(new ClientDisconnectedError()));

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
  });
}

function writeSse(res, value, signal) {
  return writeResponse(res, `data: ${JSON.stringify(value)}\n\n`, signal);
}

function writeResponse(res, chunk, signal) {
  if (res.destroyed || signal?.aborted) return Promise.reject(abortError());
  if (res.write(chunk)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(abortError());
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sendJson(res, status, body) {
  if (res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res, status, message, type, param, code) {
  sendJson(res, status, { error: openAIError(message, type, param, code) });
}

function openAIError(message, type, param, code) {
  return { message, type, param, code };
}

class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`Request body exceeds the ${limit} byte limit.`);
  }
}

class ClientDisconnectedError extends Error {}

function abortError() {
  const error = new Error('The client disconnected.');
  error.name = 'AbortError';
  return error;
}
