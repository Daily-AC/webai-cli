import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { afterEach, test } from 'node:test';
import { UnsupportedChatFeatureError } from '../src/chat/errors.js';
import { AuthError, QuotaError } from '../src/errors.js';
import { createOpenAIServer, startOpenAIServer } from '../src/server/index.js';

const TOKEN = 'test-sidecar-token';
const servers = new Set();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections?.();
          server.close(resolve);
        })
    )
  );
  servers.clear();
});

test('health is public and models require bearer authentication', async () => {
  const { baseUrl } = await listen(fakeProvider([]), ['web-model']);

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const unauthorized = await fetch(`${baseUrl}/v1/models`);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer');
  assert.deepEqual(Object.keys((await unauthorized.json()).error), ['message', 'type', 'param', 'code']);

  const wrongToken = await fetch(`${baseUrl}/v1/models`, { headers: authHeaders('wrong-token') });
  assert.equal(wrongToken.status, 401);

  const models = await fetch(`${baseUrl}/v1/models`, { headers: authHeaders() });
  assert.equal(models.status, 200);
  const body = await models.json();
  assert.equal(body.object, 'list');
  assert.deepEqual(body.data.map((model) => model.id), ['web-model']);
});

test('routes each advertised model to its provider and rejects unknown models', async () => {
  const calls = [];
  const providers = ['gemini-web', 'doubao-web'].map((id) => ({
    id,
    async *streamChat(request) {
      calls.push([id, request.model]);
      yield { type: 'text_delta', text: id };
      yield { type: 'finish', finishReason: 'stop' };
    },
  }));
  const server = createOpenAIServer({
    chatProviders: providers,
    token: TOKEN,
    logger: silentLogger,
  });
  servers.add(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const models = await fetch(`${baseUrl}/v1/models`, { headers: authHeaders() });
  assert.deepEqual((await models.json()).data.map((model) => model.id), ['gemini-web', 'doubao-web']);

  for (const provider of providers) {
    const response = await postJson(`${baseUrl}/v1/chat/completions`, {
      model: provider.id,
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, provider.id);
  }

  const unknown = await postJson(`${baseUrl}/v1/chat/completions`, {
    model: 'missing-web',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'model_not_found');
  assert.deepEqual(calls, [
    ['gemini-web', 'gemini-web'],
    ['doubao-web', 'doubao-web'],
  ]);
});

test('aggregates provider events into a non-streaming chat completion', async () => {
  let received;
  const provider = {
    async *streamChat(request, options) {
      received = { request, options };
      yield { type: 'text_delta', text: 'hello ' };
      yield { type: 'text_delta', text: 'world' };
      yield {
        type: 'finish',
        finishReason: 'stop',
        metadata: { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
      };
    },
  };
  const { baseUrl } = await listen(provider);
  const input = { model: 'web-model', messages: [{ role: 'user', content: 'hi' }] };

  const response = await postJson(`${baseUrl}/v1/chat/completions`, input);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.id, /^chatcmpl-/);
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.model, 'web-model');
  assert.deepEqual(body.choices, [
    {
      index: 0,
      message: { role: 'assistant', content: 'hello world' },
      finish_reason: 'stop',
    },
  ]);
  assert.equal(body.usage.total_tokens, 5);
  assert.deepEqual(received.request, input);
  assert.equal(received.options.signal.aborted, false);
});

test('streams OpenAI chat chunks followed by [DONE]', async () => {
  const provider = fakeProvider([
    { type: 'text_delta', text: 'hel' },
    { type: 'text_delta', text: 'lo' },
    { type: 'finish', finishReason: 'length' },
  ]);
  const { baseUrl } = await listen(provider);

  const response = await postJson(`${baseUrl}/v1/chat/completions`, {
    model: 'web-model',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);

  const events = parseSse(await response.text());
  assert.equal(events.at(-1), '[DONE]');
  const chunks = events.slice(0, -1).map(JSON.parse);
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks[0].choices[0], {
    index: 0,
    delta: { role: 'assistant' },
    finish_reason: null,
  });
  assert.equal(chunks[1].choices[0].delta.content, 'hel');
  assert.equal(chunks[2].choices[0].delta.content, 'lo');
  assert.deepEqual(chunks[3].choices[0], { index: 0, delta: {}, finish_reason: 'length' });
  assert.ok(chunks.every((chunk) => chunk.id === chunks[0].id));
});

test('delivers text before the upstream stream finishes', async () => {
  let releaseProvider;
  const providerReleased = new Promise((resolve) => {
    releaseProvider = resolve;
  });
  const provider = {
    async *streamChat() {
      yield { type: 'text_delta', text: 'available-now' };
      await providerReleased;
      yield { type: 'text_delta', text: '-finished' };
      yield { type: 'finish', finishReason: 'stop' };
    },
  };
  const { baseUrl } = await listen(provider);
  const response = await postJson(`${baseUrl}/v1/chat/completions`, {
    model: 'web-model',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let prefix = '';
  try {
    while (!prefix.includes('available-now')) {
      const next = await withTimeout(reader.read(), 1000, 'timed out waiting for an incremental text chunk');
      assert.equal(next.done, false);
      prefix += decoder.decode(next.value, { stream: true });
    }
  } finally {
    releaseProvider();
  }
  const rest = await readRemaining(reader, decoder);
  assert.match(prefix + rest, /-finished/);
  assert.match(prefix + rest, /data: \[DONE\]/);
});

test('emits streaming usage as a final choices-free chunk when requested', async () => {
  const provider = fakeProvider([
    { type: 'text_delta', text: 'hello' },
    {
      type: 'finish',
      finishReason: 'stop',
      metadata: { usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
    },
  ]);
  const { baseUrl } = await listen(provider);

  const response = await postJson(`${baseUrl}/v1/chat/completions`, {
    model: 'web-model',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    stream_options: { include_usage: true },
  });
  const chunks = parseSse(await response.text()).slice(0, -1).map(JSON.parse);
  assert.deepEqual(chunks.at(-1).choices, []);
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
});

test('synthesizes a stop chunk when the provider ends without a finish event', async () => {
  const { baseUrl } = await listen(fakeProvider([{ type: 'text_delta', text: 'complete' }]));
  const response = await postJson(`${baseUrl}/v1/chat/completions`, {
    model: 'web-model',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  });
  const events = parseSse(await response.text());
  const finalChunk = JSON.parse(events.at(-2));
  assert.deepEqual(finalChunk.choices[0], { index: 0, delta: {}, finish_reason: 'stop' });
  assert.equal(events.at(-1), '[DONE]');
});

test('rejects unsupported tools instead of pretending to support them', async () => {
  let calls = 0;
  const provider = {
    async *streamChat() {
      calls++;
      yield { type: 'finish', finishReason: 'stop' };
    },
  };
  const { baseUrl } = await listen(provider);
  const base = { model: 'web-model', messages: [{ role: 'user', content: 'hi' }] };

  for (const extra of [
    { tools: [{ type: 'function', function: { name: 'shell', parameters: {} } }] },
    { tools: [], tool_choice: 'auto' },
  ]) {
    const response = await postJson(`${baseUrl}/v1/chat/completions`, { ...base, ...extra });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.type, 'unsupported_feature');
    assert.equal(body.error.code, 'tool_calls_unsupported');
  }
  assert.equal(calls, 0);
});

test('returns an explicit unsupported error for responses compact', async () => {
  const { baseUrl } = await listen(fakeProvider([]));
  const response = await postJson(`${baseUrl}/v1/responses/compact`, { model: 'web-model', input: [] });
  assert.equal(response.status, 501);
  const body = await response.json();
  assert.equal(body.error.type, 'unsupported_feature');
  assert.equal(body.error.code, 'responses_compact_unsupported');
});

test('requires JSON and enforces the request body limit', async () => {
  const { baseUrl } = await listen(fakeProvider([]), [], { bodyLimit: 64 });

  const text = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(text.status, 415);

  const large = await postJson(`${baseUrl}/v1/chat/completions`, {
    model: 'web-model',
    messages: [{ role: 'user', content: 'x'.repeat(80) }],
  });
  assert.equal(large.status, 413);
  assert.equal((await large.json()).error.code, 'request_too_large');
});

test('rejects an empty messages array before calling the provider', async () => {
  let calls = 0;
  const provider = {
    async *streamChat() {
      calls++;
    },
  };
  const { baseUrl } = await listen(provider);
  const response = await postJson(`${baseUrl}/v1/chat/completions`, { model: 'web-model', messages: [] });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(body.error.param, 'messages');
  assert.equal(calls, 0);
});

test('rejects invalid message roles and content before calling the provider', async () => {
  let calls = 0;
  const provider = {
    async *streamChat() {
      calls++;
      yield { type: 'finish', finishReason: 'stop' };
    },
  };
  const { baseUrl } = await listen(provider);

  for (const [messages, status, type] of [
    [[{ role: 'bogus', content: 'hi' }], 400, 'invalid_request_error'],
    [[{ role: 'user', content: { text: 'hi' } }], 400, 'invalid_request_error'],
    [[{ role: 'tool', content: 'result' }], 422, 'unsupported_feature'],
    [[{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }], 422, 'unsupported_feature'],
  ]) {
    const response = await postJson(`${baseUrl}/v1/chat/completions`, { model: 'web-model', messages });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.type, type);
  }
  assert.equal(calls, 0);
});

test('maps provider failures to public OpenAI error envelopes', async (t) => {
  const cases = [
    [new AuthError('sensitive auth detail'), 401, 'authentication_error', 'upstream_auth_error'],
    [new QuotaError('sensitive quota detail'), 429, 'rate_limit_error', 'rate_limit_error'],
    [new UnsupportedChatFeatureError('images', 'sensitive feature detail'), 422, 'unsupported_feature', 'unsupported_feature'],
    [new Error('sensitive upstream detail'), 502, 'upstream_error', 'upstream_error'],
  ];

  for (const [error, status, type, code] of cases) {
    await t.test(error.name, async () => {
      const logs = [];
      const { baseUrl } = await listen(throwingProvider(error), [], {
        logger: { error: (...args) => logs.push(args) },
      });
      const response = await postJson(`${baseUrl}/v1/chat/completions`, chatRequest());
      assert.equal(response.status, status);
      const text = await response.text();
      assert.doesNotMatch(text, /sensitive/);
      assert.doesNotMatch(JSON.stringify(logs), /sensitive/);
      const body = JSON.parse(text);
      assert.equal(body.error.type, type);
      assert.equal(body.error.code, code);
      if (error instanceof UnsupportedChatFeatureError) assert.equal(body.error.param, 'images');
    });
  }
});

test('terminates a partial stream instead of disguising an upstream failure as [DONE]', async (t) => {
  const cases = [
    new AuthError('sensitive auth detail'),
    new QuotaError('sensitive quota detail'),
    new UnsupportedChatFeatureError('images', 'sensitive feature detail'),
    new Error('sensitive upstream detail'),
  ];

  for (const error of cases) {
    await t.test(error.name, async () => {
      const { baseUrl } = await listen(throwingAfterTextProvider(error));
      const response = await postJson(`${baseUrl}/v1/chat/completions`, { ...chatRequest(), stream: true });
      assert.equal(response.status, 200);
      await assert.rejects(() => response.text());
    });
  }
});

test('preserves an immediate streaming provider failure as an HTTP error', async () => {
  const { baseUrl } = await listen(throwingProvider(new AuthError('sensitive auth detail')));
  const response = await postJson(`${baseUrl}/v1/chat/completions`, { ...chatRequest(), stream: true });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  const text = await response.text();
  assert.doesNotMatch(text, /sensitive/);
  assert.equal(JSON.parse(text).error.code, 'upstream_auth_error');
});

test('aborts the upstream provider when a streaming client disconnects', async () => {
  let providerStarted;
  const started = new Promise((resolve) => {
    providerStarted = resolve;
  });
  let upstreamAborted;
  const aborted = new Promise((resolve) => {
    upstreamAborted = resolve;
  });
  const provider = {
    async *streamChat(_request, { signal }) {
      providerStarted();
      yield { type: 'text_delta', text: 'first' };
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      upstreamAborted(signal.aborted);
    },
  };
  const { port } = await listen(provider);
  const req = httpRequest({
    hostname: '127.0.0.1',
    port,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
    },
  });
  req.end(JSON.stringify({ ...chatRequest(), stream: true }));
  const [response] = await once(req, 'response');
  await once(response, 'data');
  await started;
  response.destroy();
  assert.equal(await withTimeout(aborted, 1000, 'upstream provider was not aborted'), true);
});

test('closes the provider iterator when a client disconnects during stream priming', async () => {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let markFinalized;
  const finalized = new Promise((resolve) => {
    markFinalized = resolve;
  });
  const provider = {
    async *streamChat() {
      try {
        markStarted();
        yield { type: 'text_delta', text: 'first' };
      } finally {
        markFinalized(true);
      }
    },
  };
  const { port } = await listen(provider);
  const req = httpRequest({
    hostname: '127.0.0.1',
    port,
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      ...authHeaders(),
      'Content-Type': 'application/json',
    },
  });
  req.on('error', () => {});
  req.end(JSON.stringify({ ...chatRequest(), stream: true }));
  await started;
  req.destroy();

  assert.equal(await withTimeout(finalized, 1000, 'provider iterator was not finalized'), true);
});

test('closes the provider iterator when the request aborts after the primed event', async () => {
  let server;
  let aborted = false;
  let markFinalized;
  const finalized = new Promise((resolve) => {
    markFinalized = resolve;
  });
  const first = { text: 'first' };
  Object.defineProperty(first, 'type', {
    enumerable: true,
    get() {
      if (!aborted) {
        aborted = true;
        server.abortActiveRequests(new Error('client left during stream priming'));
      }
      return 'text_delta';
    },
  });
  const provider = {
    async *streamChat() {
      try {
        yield first;
      } finally {
        markFinalized(true);
      }
    },
  };
  const listening = await listen(provider);
  server = listening.server;

  await assert.rejects(() => postJson(
    `${listening.baseUrl}/v1/chat/completions`,
    { ...chatRequest(), stream: true }
  ));
  assert.equal(await withTimeout(finalized, 1000, 'provider iterator was not finalized'), true);
});

test('abortActiveRequests cancels upstream work and closes connected clients', async () => {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let markAborted;
  const aborted = new Promise((resolve) => {
    markAborted = resolve;
  });
  const provider = {
    async *streamChat(_request, { signal }) {
      markStarted();
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      markAborted(signal.aborted);
    },
  };
  const { server, baseUrl } = await listen(provider);
  const response = postJson(`${baseUrl}/v1/chat/completions`, chatRequest());
  await started;
  server.abortActiveRequests(new Error('server shutting down'));

  assert.equal(await withTimeout(aborted, 1000, 'upstream provider was not aborted'), true);
  await assert.rejects(() => response);
});

test('abortActiveRequests closes a client stalled while uploading its request body', async () => {
  let providerCalls = 0;
  const { server, port } = await listen({
    async *streamChat() {
      providerCalls++;
      yield { type: 'finish' };
    },
  });
  const accepted = once(server, 'connection');
  const socket = netConnect(port, '127.0.0.1');
  socket.on('error', () => {});
  await Promise.all([once(socket, 'connect'), accepted]);
  socket.write(
    'POST /v1/chat/completions HTTP/1.1\r\n' +
      'Host: localhost\r\n' +
      `Authorization: Bearer ${TOKEN}\r\n` +
      'Content-Type: application/json\r\n' +
      'Content-Length: 9999\r\n\r\n' +
      '{'
  );

  const closed = new Promise((resolve) => socket.once('close', resolve));
  server.abortActiveRequests(new Error('server shutting down'));

  await withTimeout(closed, 1000, 'partial request connection was not closed');
  assert.equal(providerCalls, 0);
});

test('start helper listens on loopback by default', async () => {
  const server = await startOpenAIServer({
    port: 0,
    token: TOKEN,
    models: [],
    chatProvider: fakeProvider([]),
    logger: silentLogger,
  });
  servers.add(server);
  assert.equal(server.address().address, '127.0.0.1');
});

async function listen(chatProvider, models = [], options = {}) {
  const server = createOpenAIServer({
    chatProvider,
    models,
    token: TOKEN,
    logger: silentLogger,
    ...options,
  });
  servers.add(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return { server, port, baseUrl: `http://127.0.0.1:${port}` };
}

function fakeProvider(events) {
  return {
    async *streamChat() {
      for (const event of events) yield event;
    },
  };
}

function throwingProvider(error) {
  return {
    async *streamChat() {
      throw error;
    },
  };
}

function throwingAfterTextProvider(error) {
  return {
    async *streamChat() {
      yield { type: 'text_delta', text: 'partial' };
      throw error;
    },
  };
}

function chatRequest() {
  return { model: 'web-model', messages: [{ role: 'user', content: 'hi' }] };
}

function authHeaders(token = TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function parseSse(body) {
  return body
    .split('\n\n')
    .map((event) => event.trim())
    .filter(Boolean)
    .map((event) => event.replace(/^data: /, ''));
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readRemaining(reader, decoder) {
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

const silentLogger = { error() {} };
