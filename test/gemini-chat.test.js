import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UnsupportedChatFeatureError } from '../src/chat/errors.js';
import { serializeMessages } from '../src/chat/messages.js';
import { AuthError, QuotaError, WebaiError } from '../src/errors.js';
import {
  GeminiFrameDecoder,
  cookieHeaderFromCredential,
  geminiChat,
  streamChat,
} from '../src/providers/gemini/chat.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEXT_REPLY = readFileSync(join(HERE, 'fixtures', 'gemini', 'text-reply.txt'));
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

function frame(text, { completed = false, candidateId = 'rc_1' } = {}) {
  const candidate = new Array(14).fill(null);
  candidate[0] = candidateId;
  candidate[1] = [text];
  if (completed) candidate[8] = [2];
  const inner = [null, ['c_1', 'r_1'], null, null, [candidate]];
  const json = JSON.stringify([['wrb.fr', 'frame', JSON.stringify(inner), null, null, null, 'generic']]);
  const payload = `\n${json}`;
  return `${payload.length}${payload}\n`;
}

function errorFrame(code) {
  const part = new Array(6).fill(null);
  part[5] = [null, null, [[null, [code]]]];
  const json = JSON.stringify([part]);
  const payload = `\n${json}`;
  return `${payload.length}${payload}\n`;
}

function initHtml() {
  return '<html><script>window.WIZ_global_data={"SNlM0e":"at-token","cfb2h":"bl-token","FdrFJe":"sid-token","TuX5cc":"en"}</script></html>';
}

function legacyCredential() {
  return { cookies: { '__Secure-1PSID': 'sid-cookie', '__Secure-1PSIDTS': 'ts-cookie' } };
}

async function collect(iterable) {
  const out = [];
  for await (const value of iterable) out.push(value);
  return out;
}

test('serializeMessages is stable for multi-turn OpenAI messages', () => {
  const messages = [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: [{ type: 'text', text: '2 + 2?' }] },
    { role: 'assistant', content: '4' },
    { role: 'user', content: 'and + 3?' },
  ];
  const first = serializeMessages(messages);
  assert.equal(first, serializeMessages(messages));
  assert.match(first, /\[{"role":"system","content":"Be terse\."}/);
  assert.match(first, /{"role":"user","content":"and \+ 3\?"}\]$/);
});

test('tool requests are rejected without calling fetch', async () => {
  let calls = 0;
  const iterable = streamChat(
    {
      model: 'gemini-web',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'shell', parameters: {} } }],
    },
    { credential: legacyCredential(), fetchImpl: async () => { calls++; } }
  );
  await assert.rejects(() => collect(iterable), UnsupportedChatFeatureError);
  assert.equal(calls, 0);
});

test('empty tools and tool_choice none are treated as tools disabled', async () => {
  const raw = encoder.encode(`)]}'\n\n${frame('ok', { completed: true })}`);
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') return new Response(initHtml());
    return new Response(streamBytes(raw, [raw.length]));
  };
  const events = await collect(
    streamChat(
      {
        model: 'gemini-web',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        tool_choice: 'none',
      },
      { credential: legacyCredential(), fetchImpl }
    )
  );
  assert.equal(events[0].text, 'ok');
});

test('cookieHeaderFromCredential accepts structured jars and legacy maps', () => {
  const future = Math.floor(Date.now() / 1000) + 60;
  const structured = {
    cookieJar: [
      { name: '__Secure-1PSID', value: 'structured', domain: '.google.com', path: '/', secure: true, expires: future },
      { name: 'unrelated-google-cookie', value: 'private', domain: '.google.com', path: '/' },
      { name: 'wrong-domain', value: 'no', domain: '.example.com', path: '/' },
      { name: 'expired', value: 'no', domain: '.google.com', path: '/', expires: 1 },
    ],
  };
  assert.equal(cookieHeaderFromCredential(structured), '__Secure-1PSID=structured');
  assert.equal(
    cookieHeaderFromCredential({ cookies: { ...legacyCredential().cookies, unrelated: 'private' } }),
    '__Secure-1PSID=sid-cookie; __Secure-1PSIDTS=ts-cookie'
  );
});

test('GeminiFrameDecoder handles every boundary in the existing text fixture', () => {
  const raw = TEXT_REPLY.toString('utf8');
  for (let split = 1; split < raw.length; split++) {
    const decoder = new GeminiFrameDecoder();
    const parts = [
      ...decoder.push(raw.slice(0, split)),
      ...decoder.push(raw.slice(split)),
      ...decoder.finish(),
    ];
    assert.equal(parts.length, 1, `split=${split}`);
    assert.equal(parts[0][0], 'wrb.fr');
  }
});

test('streamChat incrementally decodes the fixture and marks chat temporary', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return new Response(initHtml(), { status: 200 });
    return new Response(streamBytes(TEXT_REPLY, [1, 2, 3, 5, 8, 13, 21]), { status: 200 });
  };

  const events = await collect(
    streamChat(
      {
        model: 'gemini-web',
        messages: [
          { role: 'system', content: 'Answer exactly.' },
          { role: 'user', content: 'check pipeline' },
        ],
      },
      { credential: legacyCredential(), fetchImpl }
    )
  );

  assert.deepEqual(events[0], { type: 'text_delta', text: 'pipeline is alive.' });
  assert.equal(events[1].type, 'finish');
  assert.equal(events[1].finishReason, 'stop');
  assert.deepEqual(events[1].metadata, {
    provider: 'gemini',
    model: 'gemini-web',
    conversationId: 'c_conv123',
    responseId: 'r_reply456',
    candidateId: 'rc_cand789',
    completed: true,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers.Cookie, '__Secure-1PSID=sid-cookie; __Secure-1PSIDTS=ts-cookie');
  const params = new URLSearchParams(calls[1].init.body);
  const inner = JSON.parse(JSON.parse(params.get('f.req'))[1]);
  assert.equal(inner[45], 1);
  assert.match(inner[0][0], /"role":"system"/);
});

test('streamChat retries only the idempotent session-init GET after a transient network failure', async () => {
  let getCalls = 0;
  let postCalls = 0;
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') {
      getCalls++;
      if (getCalls === 1) throw new Error('transient connection reset');
      return new Response(initHtml());
    }
    postCalls++;
    return new Response(streamBytes(TEXT_REPLY, [TEXT_REPLY.length]));
  };

  const events = await collect(
    streamChat(
      { model: 'gemini-web', messages: [{ role: 'user', content: 'retry init' }] },
      { credential: legacyCredential(), fetchImpl }
    )
  );
  assert.equal(events.at(-1).type, 'finish');
  assert.equal(getCalls, 2);
  assert.equal(postCalls, 1);
});

test('streamChat reads the default credential from the configured store', async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), 'webai-gemini-chat-'));
  const previousConfigDir = process.env.WEBAI_CONFIG_DIR;
  t.after(() => {
    if (previousConfigDir === undefined) delete process.env.WEBAI_CONFIG_DIR;
    else process.env.WEBAI_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });
  process.env.WEBAI_CONFIG_DIR = configDir;
  writeFileSync(join(configDir, 'creds.json'), JSON.stringify({ gemini: legacyCredential() }), { mode: 0o600 });

  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') return new Response(initHtml());
    return new Response(streamBytes(TEXT_REPLY, [TEXT_REPLY.length]));
  };
  const events = await collect(
    streamChat(
      { model: 'gemini-web', messages: [{ role: 'user', content: 'store fallback' }] },
      { fetchImpl }
    )
  );
  assert.equal(events[0].text, 'pipeline is alive.');
  assert.equal(events.at(-1).type, 'finish');
});

test('an expired stored credential stays an auth failure when automatic rotation fails', async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), 'webai-gemini-chat-'));
  const previousConfigDir = process.env.WEBAI_CONFIG_DIR;
  t.after(() => {
    if (previousConfigDir === undefined) delete process.env.WEBAI_CONFIG_DIR;
    else process.env.WEBAI_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });
  process.env.WEBAI_CONFIG_DIR = configDir;
  writeFileSync(join(configDir, 'creds.json'), JSON.stringify({ gemini: legacyCredential() }), { mode: 0o600 });

  let rotations = 0;
  await assert.rejects(
    () => collect(
      streamChat(
        { model: 'gemini-web', messages: [{ role: 'user', content: 'expired' }] },
        {
          fetchImpl: async () => new Response('<html>signed out</html>'),
          rotateImpl: async () => {
            rotations++;
            throw new WebaiError('rotation transport failed');
          },
        }
      )
    ),
    (error) => error instanceof AuthError && /auth login gemini/.test(error.message)
  );
  assert.equal(rotations, 1);
});

test('streamChat removes duplicate prefixes from cumulative frames across UTF-8 chunk splits', async () => {
  const raw = `)]}'\n\n${frame('Hel')}${frame('Hello')}${frame('Hello \ud83d\ude00', { completed: true })}`;
  const bytes = encoder.encode(raw);
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') return new Response(initHtml());
    return new Response(streamBytes(bytes, Array.from({ length: bytes.length }, () => 1)));
  };
  const events = await collect(
    streamChat(
      { model: 'gemini-web', messages: [{ role: 'user', content: 'hello' }] },
      { credential: legacyCredential(), fetchImpl }
    )
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'text_delta').map((event) => event.text),
    ['Hel', 'lo', ' \ud83d\ude00']
  );
  assert.equal(events.at(-1).metadata.completed, true);
});

test('returning from the async iterator cancels the upstream response body', async () => {
  let cancelled = false;
  const raw = encoder.encode(`)]}'\n\n${frame('first')}`);
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') return new Response(initHtml());
    return new Response(streamBytes(raw, [raw.length], { close: false, onCancel: () => { cancelled = true; } }));
  };
  const iterator = streamChat(
    { model: 'gemini-web', messages: [{ role: 'user', content: 'cancel me' }] },
    { credential: legacyCredential(), fetchImpl }
  );
  assert.deepEqual(await iterator.next(), { value: { type: 'text_delta', text: 'first' }, done: false });
  await iterator.return();
  assert.equal(cancelled, true);
});

test('an injected abort signal cancels the body and preserves the caller reason', async () => {
  let cancelled = false;
  let markBodyStarted;
  const bodyStarted = new Promise((resolve) => {
    markBodyStarted = resolve;
  });
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') return new Response(initHtml());
    return new Response(
      new ReadableStream({
        start() {
          markBodyStarted();
        },
        cancel() {
          cancelled = true;
        },
      })
    );
  };
  const controller = new AbortController();
  const reason = new Error('client disconnected');
  const pending = collect(
    streamChat(
      { model: 'gemini-web', messages: [{ role: 'user', content: 'abort me' }] },
      { credential: legacyCredential(), fetchImpl, signal: controller.signal }
    )
  );
  await bodyStarted;
  controller.abort(reason);
  await assert.rejects(() => pending, (error) => error === reason);
  assert.equal(cancelled, true);
});

test('streamChat never retries a failed StreamGenerate POST', async () => {
  let postCalls = 0;
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') return new Response(initHtml());
    postCalls++;
    throw new Error('connection reset after submit');
  };
  await assert.rejects(
    () => collect(
      streamChat(
        { model: 'gemini-web', messages: [{ role: 'user', content: 'once' }] },
        { credential: legacyCredential(), fetchImpl }
      )
    ),
    /connection reset after submit/
  );
  assert.equal(postCalls, 1);
});

test('stored credentials rotate and retry once after StreamGenerate rejects them', async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), 'webai-gemini-chat-'));
  const previousConfigDir = process.env.WEBAI_CONFIG_DIR;
  t.after(() => {
    if (previousConfigDir === undefined) delete process.env.WEBAI_CONFIG_DIR;
    else process.env.WEBAI_CONFIG_DIR = previousConfigDir;
    rmSync(configDir, { recursive: true, force: true });
  });
  process.env.WEBAI_CONFIG_DIR = configDir;
  writeFileSync(join(configDir, 'creds.json'), JSON.stringify({ gemini: legacyCredential() }), { mode: 0o600 });

  let getCalls = 0;
  let postCalls = 0;
  let rotations = 0;
  const raw = encoder.encode(`)]}'\n\n${frame('rotated', { completed: true })}`);
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') {
      getCalls++;
      return new Response(initHtml());
    }
    postCalls++;
    if (postCalls === 1) return new Response('expired', { status: 401 });
    return new Response(streamBytes(raw, [raw.length]));
  };

  const events = await collect(
    streamChat(
      { model: 'gemini-web', messages: [{ role: 'user', content: 'retry auth' }] },
      {
        fetchImpl,
        rotateImpl: async () => {
          rotations++;
        },
      }
    )
  );

  assert.equal(rotations, 1);
  assert.equal(getCalls, 2);
  assert.equal(postCalls, 2);
  assert.equal(events[0].text, 'rotated');
});

test('explicit credentials do not retry StreamGenerate after an auth rejection', async () => {
  let postCalls = 0;
  let rotations = 0;
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') return new Response(initHtml());
    postCalls++;
    return new Response('expired', { status: 401 });
  };

  await assert.rejects(
    () => collect(
      streamChat(
        { model: 'gemini-web', messages: [{ role: 'user', content: 'do not retry' }] },
        {
          credential: legacyCredential(),
          fetchImpl,
          rotateImpl: async () => {
            rotations++;
          },
        }
      )
    ),
    AuthError
  );
  assert.equal(rotations, 0);
  assert.equal(postCalls, 1);
});

test('streamChat enforces a deadline while the response body is stalled', async () => {
  let cancelled = false;
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') return new Response(initHtml());
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  };
  await assert.rejects(
    () => collect(
      streamChat(
        { model: 'gemini-web', messages: [{ role: 'user', content: 'stall' }] },
        { credential: legacyCredential(), fetchImpl, timeoutMs: 25 }
      )
    ),
    /timed out after 25ms/
  );
  assert.equal(cancelled, true);
});

test('streamChat finishes and cancels a response that stays open after a completed frame', async () => {
  const raw = encoder.encode(`)]}'\n\n${frame('done', { completed: true })}`);
  let cancelled = false;
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') return new Response(initHtml());
    return new Response(streamBytes(raw, [raw.length], {
      close: false,
      onCancel() {
        cancelled = true;
      },
    }));
  };

  const events = await collect(streamChat(
    { model: 'gemini-web', messages: [{ role: 'user', content: 'finish' }] },
    { credential: legacyCredential(), fetchImpl, timeoutMs: 30 }
  ));

  assert.deepEqual(events.map((event) => event.type), ['text_delta', 'finish']);
  assert.equal(events[0].text, 'done');
  assert.equal(cancelled, true);
});

test('streamChat rejects an EOF without a candidate completion marker', async () => {
  const raw = encoder.encode(`)]}'\n\n${frame('partial')}`);
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') return new Response(initHtml());
    return new Response(streamBytes(raw, [raw.length]));
  };
  await assert.rejects(
    () => collect(
      streamChat(
        { model: 'gemini-web', messages: [{ role: 'user', content: 'partial' }] },
        { credential: legacyCredential(), fetchImpl }
      )
    ),
    /stream ended before completion/
  );
});

test('streamChat maps Gemini usage-limit frames to QuotaError', async () => {
  const raw = encoder.encode(`)]}'\n\n${errorFrame(1037)}`);
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') return new Response(initHtml());
    return new Response(streamBytes(raw, [raw.length]));
  };
  await assert.rejects(
    () => collect(
      streamChat(
        { model: 'gemini-web', messages: [{ role: 'user', content: 'quota' }] },
        { credential: legacyCredential(), fetchImpl }
      )
    ),
    QuotaError
  );
});

test('streamChat rejects unknown non-zero Gemini error codes', async () => {
  const raw = encoder.encode(`)]}'\n\n${errorFrame(9999)}`);
  const fetchImpl = async (_url, init) => {
    if (init.method === 'GET') return new Response(initHtml());
    return new Response(streamBytes(raw, [raw.length]));
  };
  await assert.rejects(
    () => collect(
      streamChat(
        { model: 'gemini-web', messages: [{ role: 'user', content: 'error' }] },
        { credential: legacyCredential(), fetchImpl }
      )
    ),
    (error) => error instanceof WebaiError && /error code 9999/.test(error.message)
  );
});

test('geminiChat exposes the sidecar provider contract', () => {
  assert.equal(geminiChat.id, 'gemini-web');
  assert.equal(geminiChat.streamChat, streamChat);
});
