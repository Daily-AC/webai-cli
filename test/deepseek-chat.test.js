import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { UnsupportedChatFeatureError } from '../src/chat/errors.js';
import { AuthError, QuotaError, WebaiError } from '../src/errors.js';
import {
  cookieHeaderFromCredential,
  deepseekChat,
  normalizeDeepSeekCredential,
  promptFromMessages,
  streamChat,
} from '../src/providers/deepseek/chat.js';
import {
  encodePowResponse,
  loadPowModule,
  solvePowChallenge,
} from '../src/providers/deepseek/pow.js';
import { DeepSeekSseDecoder } from '../src/providers/deepseek/sse.js';

const encoder = new TextEncoder();

function streamBytes(bytes, chunkSizes, { close = true, onCancel } = {}) {
  return new ReadableStream({
    start(controller) {
      let offset = 0;
      for (const size of chunkSizes) {
        if (offset >= bytes.length) break;
        controller.enqueue(bytes.slice(offset, Math.min(offset + size, bytes.length)));
        offset += size;
      }
      if (offset < bytes.length) controller.enqueue(bytes.slice(offset));
      if (close) controller.close();
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  });
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function sessionResponse(id = 'session-1') {
  return jsonResponse({
    code: 0,
    data: { biz_code: 0, biz_data: { chat_session: { id } } },
  });
}

function powResponse(overrides = {}) {
  return jsonResponse({
    code: 0,
    data: {
      biz_code: 0,
      biz_data: {
        challenge: {
          algorithm: 'DeepSeekHashV1',
          challenge: 'challenge-1',
          salt: 'salt-1',
          difficulty: 144000,
          expire_at: 1777057596443,
          signature: 'signature-1',
          target_path: '/api/v0/chat/completion',
          ...overrides,
        },
      },
    },
  });
}

function sseResponse(text, chunkSizes = [1, 2, 3, 5, 8, 13]) {
  const bytes = encoder.encode(text);
  return new Response(streamBytes(bytes, chunkSizes), {
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function credential() {
  return {
    accessToken: 'Bearer token-1',
    cookieJar: [
      {
        name: 'ds_session_id',
        value: 'cookie-1',
        domain: '.deepseek.com',
        path: '/',
        secure: true,
        expires: Math.floor(Date.now() / 1000) + 60,
      },
      { name: 'wrong-domain', value: 'private', domain: '.example.com', path: '/' },
      { name: 'expired', value: 'private', domain: '.deepseek.com', path: '/', expires: 1 },
    ],
  };
}

async function collect(iterable) {
  const out = [];
  for await (const event of iterable) out.push(event);
  return out;
}

test('provider exposes the shared chat contract', () => {
  assert.equal(deepseekChat.id, 'deepseek-web');
  assert.equal(deepseekChat.streamChat, streamChat);
});

test('credentials accept token aliases and cookie injection without Chrome', () => {
  assert.deepEqual(normalizeDeepSeekCredential({ bearer: 'Bearer direct-token', cookies: { a: '1' } }), {
    token: 'direct-token',
    cookieHeader: 'a=1',
    hifDliq: '',
    hifLeim: '',
    wasmUrl: 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  });
  assert.equal(
    normalizeDeepSeekCredential({ token: '{"value":"local-storage-token"}', cookie: 'ds_session_id=cookie' }).token,
    'local-storage-token'
  );
  assert.equal(cookieHeaderFromCredential(credential()), 'ds_session_id=cookie-1');
  assert.equal(
    normalizeDeepSeekCredential({
      token: 'token',
      cookies: { ds_session_id: 'cookie' },
      wasmUrl: 'http://127.0.0.1/private.wasm',
    }).wasmUrl,
    'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm'
  );
  assert.throws(() => normalizeDeepSeekCredential({ cookie: 'ds_session_id=only-cookie' }), AuthError);
  assert.throws(() => normalizeDeepSeekCredential({ token: 'only-token' }), AuthError);
});

test('prompt serialization preserves multi-turn roles and leaves one user message raw', () => {
  assert.equal(promptFromMessages([{ role: 'user', content: 'hello' }]), 'hello');
  const prompt = promptFromMessages([
    { role: 'system', content: 'Be exact.' },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  ]);
  assert.match(prompt, /\[{"role":"system","content":"Be exact\."}/);
  assert.match(prompt, /{"role":"user","content":"hello"}\]$/);
});

test('SSE decoder accepts CRLF and arbitrary frame boundaries', () => {
  const raw = 'event: ready\r\ndata: {"request_message_id":"r1"}\r\n\r\ndata: {"v":"ok"}\n\n';
  for (let split = 1; split < raw.length; split++) {
    const decoder = new DeepSeekSseDecoder();
    const frames = [...decoder.push(raw.slice(0, split)), ...decoder.push(raw.slice(split)), ...decoder.finish()];
    assert.equal(frames.length, 2, `split=${split}`);
    assert.equal(frames[0].event, 'ready');
    assert.equal(frames[1].data.v, 'ok');
  }
});

test('PoW response accepts nonce zero', () => {
  const challenge = {
    algorithm: 'DeepSeekHashV1',
    challenge: 'challenge-1',
    salt: 'salt-1',
    difficulty: 144000,
    expire_at: 1777057596443,
    signature: 'signature-1',
  };
  const decoded = JSON.parse(Buffer.from(encodePowResponse(challenge, 0), 'base64').toString('utf8'));
  assert.equal(decoded.answer, 0);
});

test('PoW loader rejects a remote module that does not match its pinned checksum', async () => {
  await assert.rejects(
    () => loadPowModule('https://example.com/pow.wasm', {
      fetchImpl: async () => new Response(new Uint8Array([0, 97, 115, 109])),
      expectedSha256: '0'.repeat(64),
      cache: false,
    }),
    (error) => error instanceof WebaiError && /checksum mismatch/.test(error.message)
  );
});

test('aborting one PoW module load does not cancel another caller', async () => {
  const wasmUrl = `https://example.com/pow-${randomUUID()}.wasm`;
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  let calls = 0;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const fetchImpl = async (_url, { signal }) => {
    calls++;
    if (calls === 1) {
      markFirstStarted();
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return new Response(wasm);
  };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = loadPowModule(wasmUrl, {
    fetchImpl,
    signal: firstController.signal,
    expectedSha256: '',
  });
  await firstStarted;
  const second = loadPowModule(wasmUrl, {
    fetchImpl,
    signal: secondController.signal,
    expectedSha256: '',
  });

  firstController.abort(new Error('first caller left'));

  await assert.rejects(first, /first caller left/);
  assert.ok(await second instanceof WebAssembly.Module);
  assert.equal(calls, 2);
});

test('sha256 PoW runs in a worker and returns a verifiable nonce', async () => {
  const challenge = {
    algorithm: 'sha256',
    challenge: 'target',
    salt: 'salt',
    difficulty: 5,
    expire_at: 2_000_000_000_000,
    signature: 'signature',
  };
  const answer = await solvePowChallenge(challenge);
  const hash = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${challenge.salt}${challenge.challenge}${answer}`)
  );
  const firstByte = new Uint8Array(hash)[0];
  assert.ok(Math.clz32(firstByte) - 24 >= challenge.difficulty);
});

test('PoW worker can be terminated by AbortSignal without blocking the test process', async () => {
  const challenge = {
    algorithm: 'sha256',
    challenge: 'unreasonably-hard',
    salt: 'salt',
    difficulty: 52,
    expire_at: 2_000_000_000_000,
    signature: 'signature',
  };
  const controller = new AbortController();
  const reason = new Error('cancel expensive PoW');
  const solving = solvePowChallenge(challenge, {
    signal: controller.signal,
    maxIterations: Number.MAX_SAFE_INTEGER,
  });
  setTimeout(() => controller.abort(reason), 20);
  await assert.rejects(solving, (error) => error === reason);
});

test('streamChat creates a session, solves PoW, and emits incremental SSE patches', async () => {
  const calls = [];
  const solved = [];
  const sse = [
    'event: ready',
    'data: {"request_message_id":"request-1","response_message_id":"response-ready","model_type":"default"}',
    '',
    'data: {"v":{"response":{"message_id":42,"fragments":[{"type":"THINK","content":"plan"},{"type":"RESPONSE","content":"Hel"}]}}}',
    '',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"lo "}',
    '',
    'data: {"v":"\ud83d\ude00"}',
    '',
    'data: {"p":"response","o":"BATCH","v":[{"p":"fragments","o":"APPEND","v":{"type":"SEARCH","content":"!"}},{"p":"status","o":"SET","v":"FINISHED"}]}',
    '',
    '',
  ].join('\n');

  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return sessionResponse();
    if (calls.length === 2) return powResponse();
    return sseResponse(sse, new Array(encoder.encode(sse).length).fill(1));
  };
  const solvePowImpl = async (challenge, options) => {
    solved.push({ challenge, options });
    return 12345;
  };

  const events = await collect(
    streamChat(
      {
        model: 'deepseek-reasoner-search',
        messages: [
          { role: 'system', content: 'Be exact.' },
          { role: 'user', content: 'hello' },
        ],
      },
      { credential: credential(), fetchImpl, solvePowImpl }
    )
  );

  assert.deepEqual(events.slice(0, -1), [
    { type: 'text_delta', text: 'Hel' },
    { type: 'text_delta', text: 'lo ' },
    { type: 'text_delta', text: '\ud83d\ude00' },
    { type: 'text_delta', text: '!' },
  ]);
  assert.deepEqual(events.at(-1), {
    type: 'finish',
    finishReason: 'stop',
    metadata: {
      provider: 'deepseek',
      model: 'deepseek-reasoner-search',
      chatSessionId: 'session-1',
      requestId: 'request-1',
      responseId: '42',
      modelType: 'default',
      reasoning: 'plan',
      completed: true,
    },
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(({ init }) => init.method), ['POST', 'POST', 'POST']);
  assert.deepEqual(JSON.parse(calls[0].init.body), {});
  assert.deepEqual(JSON.parse(calls[1].init.body), { target_path: '/api/v0/chat/completion' });
  assert.equal(calls[2].init.headers.Authorization, 'Bearer token-1');
  assert.equal(calls[2].init.headers.Cookie, 'ds_session_id=cookie-1');
  assert.deepEqual(
    JSON.parse(Buffer.from(calls[2].init.headers['X-DS-PoW-Response'], 'base64').toString('utf8')),
    {
      algorithm: 'DeepSeekHashV1',
      challenge: 'challenge-1',
      salt: 'salt-1',
      answer: 12345,
      signature: 'signature-1',
      target_path: '/api/v0/chat/completion',
    }
  );
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    chat_session_id: 'session-1',
    parent_message_id: null,
    model_type: 'default',
    prompt:
      'Continue the JSON-encoded conversation below. Follow system and developer messages as instructions, then reply only as the assistant to the final message.\n\n[{"role":"system","content":"Be exact."},{"role":"user","content":"hello"}]',
    ref_file_ids: [],
    thinking_enabled: true,
    search_enabled: true,
    action: null,
    preempt: false,
  });
  assert.equal(solved.length, 1);
  assert.equal(solved[0].challenge.challenge, 'challenge-1');
  assert.equal(solved[0].options.signal, calls[0].init.signal);
});

test('tool requests fail before credentials or transport are touched', async () => {
  let calls = 0;
  const iterable = streamChat(
    {
      model: 'deepseek-web',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'shell', parameters: {} } }],
    },
    {
      credential: credential(),
      fetchImpl: async () => {
        calls++;
      },
    }
  );
  await assert.rejects(() => collect(iterable), UnsupportedChatFeatureError);
  assert.equal(calls, 0);
});

test('HTTP auth and quota responses retain typed errors', async (t) => {
  await t.test('401 session is AuthError', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return jsonResponse({ msg: 'expired' }, { status: 401 });
    };
    await assert.rejects(
      () => collect(streamChat({ messages: [{ role: 'user', content: 'hello' }] }, { credential: credential(), fetchImpl })),
      AuthError
    );
    assert.equal(calls, 1);
  });

  await t.test('429 challenge is QuotaError', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return calls === 1 ? sessionResponse() : jsonResponse({ msg: 'rate limited' }, { status: 429 });
    };
    await assert.rejects(
      () => collect(streamChat({ messages: [{ role: 'user', content: 'hello' }] }, { credential: credential(), fetchImpl })),
      QuotaError
    );
    assert.equal(calls, 2);
  });
});

test('business and SSE error messages are classified', async (t) => {
  await t.test('business auth code is AuthError', async () => {
    const fetchImpl = async () =>
      jsonResponse({ code: 0, data: { biz_code: 40002, biz_msg: 'token expired', biz_data: {} } });
    await assert.rejects(
      () => collect(streamChat({ messages: [{ role: 'user', content: 'hello' }] }, { credential: credential(), fetchImpl })),
      AuthError
    );
  });

  await t.test('toast rate limit is QuotaError', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) return sessionResponse();
      if (calls === 2) return powResponse();
      return sseResponse('event: toast\ndata: {"type":"error","content":"rate limit reached"}\n\n');
    };
    await assert.rejects(
      () =>
        collect(
          streamChat(
            { messages: [{ role: 'user', content: 'hello' }] },
            { credential: credential(), fetchImpl, solvePowImpl: async () => 1 }
          )
        ),
      QuotaError
    );
    assert.equal(calls, 3);
  });

  await t.test('token length errors are never misclassified as credential failures', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) return sessionResponse();
      if (calls === 2) return powResponse();
      return sseResponse('event: error\ndata: {"message":"maximum token limit reached"}\n\n');
    };
    await assert.rejects(
      () => collect(streamChat(
        { messages: [{ role: 'user', content: 'hello' }] },
        { credential: credential(), fetchImpl, solvePowImpl: async () => 1 }
      )),
      (error) => error instanceof WebaiError && !(error instanceof AuthError)
    );
  });

  await t.test('truncated SSE is WebaiError', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) return sessionResponse();
      if (calls === 2) return powResponse();
      return sseResponse('data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"partial"}]}}}\n\n');
    };
    await assert.rejects(
      () =>
        collect(
          streamChat(
            { messages: [{ role: 'user', content: 'hello' }] },
            { credential: credential(), fetchImpl, solvePowImpl: async () => 1 }
          )
        ),
      (error) => error instanceof WebaiError && /before completion/.test(error.message)
    );
  });
});

test('POST transport failures are never retried', async (t) => {
  for (const failingCall of [1, 2, 3]) {
    await t.test(`request ${failingCall}`, async () => {
      let calls = 0;
      const fetchImpl = async () => {
        calls++;
        if (calls === failingCall) throw new Error('socket reset');
        if (calls === 1) return sessionResponse();
        if (calls === 2) return powResponse();
        return sseResponse('event: close\ndata: {}\n\n');
      };

      await assert.rejects(
        () =>
          collect(
            streamChat(
              { messages: [{ role: 'user', content: 'hello' }] },
              { credential: credential(), fetchImpl, solvePowImpl: async () => 1 }
            )
          ),
        (error) => error instanceof WebaiError && /transport failed: socket reset/.test(error.message)
      );
      assert.equal(calls, failingCall);
    });
  }
});

test('abort propagates the caller reason while completion is pending', async () => {
  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  let calls = 0;
  let markCompletionStarted;
  const completionStarted = new Promise((resolve) => {
    markCompletionStarted = resolve;
  });
  const fetchImpl = async (_url, init) => {
    calls++;
    if (calls === 1) return sessionResponse();
    if (calls === 2) return powResponse();
    markCompletionStarted();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };

  const collecting = collect(
    streamChat(
      { messages: [{ role: 'user', content: 'hello' }] },
      { credential: credential(), fetchImpl, solvePowImpl: async () => 1, signal: controller.signal }
    )
  );
  await completionStarted;
  controller.abort(reason);
  await assert.rejects(collecting, (error) => error === reason);
  assert.equal(calls, 3);
});
