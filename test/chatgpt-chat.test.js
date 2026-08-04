import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnsupportedChatFeatureError } from '../src/chat/errors.js';
import { AuthError } from '../src/errors.js';
import {
  CHATGPT_ENDPOINTS,
  chatgptChat,
  resolveChatGptModel,
  scrapeBuildId,
  streamChat,
} from '../src/providers/chatgpt/chat.js';
import {
  accountIdFromAccessToken,
  cookieHeaderFromCredential,
  mergeSessionCookieRotation,
  normalizeChatGptCredential,
} from '../src/providers/chatgpt/credentials.js';
import {
  ChatGptChallengeError,
  ChatGptCloudflareError,
  ChatGptProtocolError,
  ChatGptTransportRequiredError,
} from '../src/providers/chatgpt/errors.js';
import { buildPowConfig, fnv1aFmix32, solvePowToken } from '../src/providers/chatgpt/pow.js';
import { ChatGptDeltaState, ChatGptSseDecoder } from '../src/providers/chatgpt/sse.js';

const encoder = new TextEncoder();
const fixedUuid = () => '00000000-0000-4000-8000-000000000001';

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function streamBytes(text, chunkSizes = [1, 2, 3, 5, 8, 13], { close = true, onCancel } = {}) {
  const bytes = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      let offset = 0;
      for (const size of chunkSizes) {
        if (offset >= bytes.length) break;
        controller.enqueue(bytes.slice(offset, Math.min(bytes.length, offset + size)));
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

function sseResponse(text, chunkSizes) {
  return new Response(streamBytes(text, chunkSizes), {
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function accessToken(accountId = 'account-1') {
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })
  ).toString('base64url');
  return `header.${payload}.signature`;
}

function credential(overrides = {}) {
  return {
    cookie:
      '__Secure-next-auth.session-token.0=old-a; __Secure-next-auth.session-token.1=old-b; cf_clearance=clear-1; oai-did=device-cookie',
    clientVersion: 'prod-test-build',
    clientBuildNumber: '1234567',
    ...overrides,
  };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function applyFrames(state, frames) {
  return frames.map((frame) => state.apply(frame));
}

test('provider exposes an unregistered shared-chat implementation', () => {
  assert.equal(chatgptChat.id, 'chatgpt-web');
  assert.equal(chatgptChat.streamChat, streamChat);
});

test('sidecar model aliases resolve to the ChatGPT automatic model', () => {
  assert.equal(resolveChatGptModel('chatgpt-web'), 'auto');
  assert.equal(resolveChatGptModel('chatgpt'), 'auto');
  assert.equal(resolveChatGptModel('gpt-5-2'), 'gpt-5-2');
});

test('credentials accept full, bare, and structured cookie injection', () => {
  assert.equal(
    cookieHeaderFromCredential('bare-session-value'),
    '__Secure-next-auth.session-token=bare-session-value'
  );
  assert.equal(
    normalizeChatGptCredential('bare-session-value').cookieHeader,
    '__Secure-next-auth.session-token=bare-session-value'
  );
  assert.equal(
    normalizeChatGptCredential('bare-session-value==').cookieHeader,
    '__Secure-next-auth.session-token=bare-session-value=='
  );
  const fromJar = normalizeChatGptCredential({
    cookieJar: [
      {
        name: '__Secure-next-auth.session-token',
        value: 'session-1',
        domain: '.chatgpt.com',
        path: '/',
        secure: true,
      },
      { name: 'foreign', value: 'secret', domain: '.example.com', path: '/', secure: true },
    ],
  });
  assert.equal(fromJar.cookieHeader, '__Secure-next-auth.session-token=session-1');
  assert.equal(fromJar.tlsProfile, 'firefox144');
  assert.match(fromJar.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(normalizeChatGptCredential(credential()).deviceId, 'device-cookie');

  assert.throws(
    () => normalizeChatGptCredential({ cookie: '__Secure-next-auth.session-token.1=missing-zero' }),
    AuthError
  );
  assert.throws(
    () =>
      normalizeChatGptCredential({
        cookie: '__Secure-next-auth.session-token=old; __Secure-next-auth.session-token.0=new',
      }),
    AuthError
  );
});

test('session rotation replaces the entire token family and preserves Cloudflare cookies', () => {
  const rotated = mergeSessionCookieRotation(
    '__Secure-next-auth.session-token=old; cf_clearance=clear-1; _cfuvid=v1',
    [
      '__Secure-next-auth.session-token.0=new-a; Path=/; Secure; HttpOnly',
      '__Secure-next-auth.session-token.1=new-b; Path=/; Secure; HttpOnly',
    ]
  );
  assert.equal(
    rotated,
    'cf_clearance=clear-1; _cfuvid=v1; __Secure-next-auth.session-token.0=new-a; __Secure-next-auth.session-token.1=new-b'
  );
  assert.equal(mergeSessionCookieRotation(rotated, null), null);
  assert.equal(
    mergeSessionCookieRotation(
      '__Secure-next-auth.session-token.0=new-a; __Secure-next-auth.session-token.1=new-b; cf_clearance=clear-1',
      [
        '__Secure-next-auth.session-token.0=new-a; Path=/',
        '__Secure-next-auth.session-token.1=new-b; Path=/',
      ]
    ),
    null
  );
});

test('account id is taken from the ChatGPT JWT claim, not the session user id', () => {
  assert.equal(accountIdFromAccessToken(accessToken('account-from-jwt')), 'account-from-jwt');
  assert.equal(accountIdFromAccessToken('not-a-jwt'), '');
});

test('current Sentinel hash and token shape are deterministic', async () => {
  assert.equal(fnv1aFmix32('', ''), 'ab3e7c0b');
  assert.equal(fnv1aFmix32('seed', 'QQ=='), 'd6f87bf8');
  const config = buildPowConfig({
    buildId: 'prod-test',
    userAgent: 'test-agent',
    now: 0,
    uuid: fixedUuid,
  });
  assert.equal(config.length, 25);
  const token = await solvePowToken({ prefix: 'gAAAAAC', seed: 'seed', difficulty: 'f', config });
  assert.match(token, /^gAAAAAC[A-Za-z0-9+/]+=*~S$/);
});

test('SSE decoder accepts CRLF, multiline data, and every text split', () => {
  const raw = 'event: delta_encoding\r\ndata: "v1"\r\n\r\nevent: error\ndata: {"message":\ndata: "broken"}\n\n';
  for (let split = 1; split < raw.length; split++) {
    const decoder = new ChatGptSseDecoder();
    const frames = [...decoder.push(raw.slice(0, split)), ...decoder.push(raw.slice(split)), ...decoder.finish()];
    assert.equal(frames.length, 2, `split=${split}`);
    assert.equal(frames[0].event, 'delta_encoding');
    assert.equal(frames[0].data, 'v1');
    assert.deepEqual(frames[1].data, { message: 'broken' });
  }
});

test('delta-v1 state handles add, shorthand append, top-level append, and patch arrays', () => {
  const decoder = new ChatGptSseDecoder();
  const raw = [
    'event: delta_encoding\ndata: "v1"\n\n',
    'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"m1","author":{"role":"assistant"},"status":"in_progress","channel":"analysis","content":{"content_type":"text","parts":[]}}}}\n\n',
    'event: delta\ndata: {"v":"think"}\n\n',
    'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/channel","o":"replace","v":"final"},{"p":"/message/content/parts/0","o":"append","v":"Hel"}]}\n\n',
    'event: delta\ndata: {"p":"/message/content/parts/0","o":"append","v":"lo"}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const state = new ChatGptDeltaState();
  const deltas = applyFrames(state, [...decoder.push(raw), ...decoder.finish()]);
  assert.equal(deltas.map(({ textDelta }) => textDelta).join(''), 'Hello');
  assert.equal(deltas.map(({ reasoningDelta }) => reasoningDelta).join(''), 'think');
  assert.equal(state.text, 'Hello');
  assert.equal(state.reasoning, 'think');
  assert.equal(state.completed, true);
  assert.equal(state.messageId, 'm1');
});

test('full-message state suppresses prior-turn echoes and falls back for instant replies', () => {
  const state = new ChatGptDeltaState();
  const frames = [
    {
      event: '',
      data: {
        message: {
          id: 'old',
          author: { role: 'assistant' },
          status: 'finished_successfully',
          content: { parts: ['old answer'] },
        },
      },
      rawData: '{}',
    },
    {
      event: '',
      data: {
        message: {
          id: 'new',
          author: { role: 'assistant' },
          status: 'in_progress',
          content: { parts: ['New'] },
        },
      },
      rawData: '{}',
    },
    {
      event: '',
      data: {
        message: {
          id: 'new',
          author: { role: 'assistant' },
          status: 'finished_successfully',
          content: { parts: ['New answer'] },
        },
      },
      rawData: '{}',
    },
    { event: '', data: null, rawData: '[DONE]' },
  ];
  const deltas = applyFrames(state, frames);
  assert.equal(deltas.map(({ textDelta }) => textDelta).join(''), 'New answer');

  const instant = new ChatGptDeltaState();
  assert.equal(
    instant.apply({
      event: '',
      data: {
        message: {
          id: 'instant',
          author: { role: 'assistant' },
          status: 'finished_successfully',
          channel: 'final',
          content: { parts: ['cached'] },
        },
      },
      rawData: '{}',
    }).textDelta,
    ''
  );
  assert.equal(instant.apply({ event: '', data: null, rawData: '[DONE]' }).textDelta, 'cached');
});

test('stream metadata retains resume and handoff events', () => {
  const state = new ChatGptDeltaState();
  state.apply({
    event: '',
    data: { type: 'resume_conversation_token', token: 'resume-1', conversation_id: 'conversation-1' },
    rawData: '{}',
  });
  state.apply({
    event: '',
    data: { type: 'stream_handoff', conversation_id: 'conversation-1', options: [] },
    rawData: '{}',
  });
  assert.equal(state.resumeToken, 'resume-1');
  assert.equal(state.conversationId, 'conversation-1');
  assert.equal(state.handoff.type, 'stream_handoff');
});

test('streamChat uses a Fetch-compatible injected transport for the current state machine', async () => {
  const calls = [];
  const rotated = [];
  let responseCancelled = false;
  const token = accessToken('account-from-jwt');
  const sse = [
    'event: delta_encoding\ndata: "v1"\n\n',
    'event: delta\ndata: {"p":"","o":"add","v":{"message":{"id":"assistant-1","author":{"role":"assistant"},"status":"in_progress","channel":"analysis","content":{"parts":[]}}},"conversation_id":"conversation-1"}\n\n',
    'event: delta\ndata: {"v":"plan"}\n\n',
    'event: delta\ndata: {"p":"","o":"patch","v":[{"p":"/message/channel","o":"replace","v":"final"},{"p":"/message/content/parts/0","o":"append","v":"Hello"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const transport = {
    marker: 'bound',
    async fetch(url, init) {
      assert.equal(this.marker, 'bound');
      calls.push({ url: String(url), init });
      switch (calls.length) {
        case 1:
          return jsonResponse(
            { accessToken: token, expires: '2099-01-01T00:00:00.000Z', user: { id: 'not-account-id' } },
            {
              headers: {
                'set-cookie':
                  '__Secure-next-auth.session-token.0=new-a; Path=/, __Secure-next-auth.session-token.1=new-b; Path=/',
              },
            }
          );
        case 2:
          return jsonResponse({ status: 'ok', conduit_token: 'conduit-none' });
        case 3:
          return jsonResponse({
            persona: 'chatgpt-free',
            prepare_token: 'prepare-1',
            turnstile: { required: true, dx: 'advisory-dx' },
          });
        case 4:
          return jsonResponse({ token: 'sentinel-1', expire_after: 540, expire_at: 4_000_000_000 });
        case 5:
          return jsonResponse({ status: 'ok', conduit_token: 'conduit-sent' });
        case 6:
          return jsonResponse({ status: 'ok', conduit_token: 'conduit-success' });
        case 7:
          return new Response(
            streamBytes(sse, new Array(encoder.encode(sse).length).fill(1), {
              close: false,
              onCancel() {
                responseCancelled = true;
              },
            }),
            { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }
          );
        default:
          throw new Error('unexpected call');
      }
    },
  };

  const events = await collect(
    streamChat(
      {
        model: 'auto',
        timezone: 'UTC',
        timezone_offset_min: 0,
        messages: [
          { role: 'system', content: 'Be exact.' },
          { role: 'user', content: 'hello' },
        ],
      },
      {
        credential: credential(),
        transport,
        onCredentialUpdate: async (cookie) => rotated.push(cookie),
        uuidImpl: fixedUuid,
        now: () => 1_700_000_000_000,
        timeoutMs: 50,
      }
    )
  );

  assert.deepEqual(events, [
    { type: 'text_delta', text: 'Hello' },
    {
      type: 'finish',
      finishReason: 'stop',
      metadata: {
        provider: 'chatgpt',
        model: 'auto',
        conversationId: 'conversation-1',
        messageId: 'assistant-1',
        reasoning: 'plan',
        completed: true,
      },
    },
  ]);
  assert.equal(calls.length, 7);
  assert.equal(responseCancelled, true);
  assert.deepEqual(
    calls.map(({ url }) => new URL(url).pathname),
    [
      CHATGPT_ENDPOINTS.session,
      CHATGPT_ENDPOINTS.conduit,
      CHATGPT_ENDPOINTS.sentinelPrepare,
      CHATGPT_ENDPOINTS.sentinelFinalize,
      CHATGPT_ENDPOINTS.conduit,
      CHATGPT_ENDPOINTS.conduit,
      CHATGPT_ENDPOINTS.conversation,
    ]
  );
  assert.equal(rotated.length, 1);
  assert.match(rotated[0], /cf_clearance=clear-1/);
  assert.match(rotated[0], /session-token\.0=new-a/);
  assert.equal(calls[1].init.headers.Cookie, rotated[0]);
  assert.equal(calls[1].init.headers['chatgpt-account-id'], 'account-from-jwt');
  assert.equal(calls[1].init.headers['oai-device-id'], 'device-cookie');
  assert.equal(calls[1].init.headers['x-oai-turn-trace-id'], fixedUuid());
  assert.match(JSON.parse(calls[2].init.body).p, /^gAAAAAC.+~S$/);
  assert.deepEqual(JSON.parse(calls[3].init.body), { prepare_token: 'prepare-1' });
  assert.equal(JSON.parse(calls[1].init.body).client_prepare_state, 'none');
  assert.equal(JSON.parse(calls[4].init.body).client_prepare_state, 'sent');
  assert.equal(JSON.parse(calls[5].init.body).client_prepare_state, 'success');
  assert.equal(calls[4].init.headers['openai-sentinel-chat-requirements-token'], 'sentinel-1');
  assert.equal(calls[4].init.headers['x-conduit-token'], 'conduit-none');
  assert.equal(calls[5].init.headers['x-conduit-token'], 'conduit-sent');
  assert.equal(calls[6].init.headers['x-conduit-token'], 'conduit-success');
  assert.equal(calls[6].init.headers['openai-sentinel-proof-token'], undefined);
  const body = JSON.parse(calls[6].init.body);
  assert.equal(body.client_prepare_state, 'success');
  assert.equal(body.messages[0].content.content_type, 'text');
  assert.match(body.messages[0].content.parts[0], /"role":"system"/);
});

test('tools and missing transport fail before credentials or network access', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      collect(
        streamChat(
          {
            messages: [{ role: 'user', content: 'hello' }],
            tools: [{ type: 'function', function: { name: 'shell', parameters: {} } }],
          },
          { transport: async () => calls++ }
        )
      ),
    UnsupportedChatFeatureError
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () => collect(streamChat({ messages: [{ role: 'user', content: 'hello' }] }, { credential: credential() })),
    ChatGptTransportRequiredError
  );
});

test('Cloudflare and unresolved Sentinel challenges remain typed', async (t) => {
  await t.test('Cloudflare challenge', async () => {
    const transport = async () =>
      new Response('<html><title>Just a moment...</title></html>', {
        status: 403,
        headers: {
          'content-type': 'text/html',
          'cf-mitigated': 'challenge',
          server: 'cloudflare',
        },
      });
    await assert.rejects(
      () =>
        collect(
          streamChat(
            { messages: [{ role: 'user', content: 'hello' }] },
            { credential: credential(), transport }
          )
        ),
      (error) => error instanceof ChatGptCloudflareError && error.code === 'cloudflare_blocked'
    );
  });

  await t.test('Turnstile challenge', async () => {
    let call = 0;
    const transport = async () => {
      call++;
      if (call === 1) return jsonResponse({ accessToken: accessToken() });
      if (call === 2) return jsonResponse({ conduit_token: 'conduit' });
      if (call === 3) {
        return jsonResponse({ prepare_token: 'prepare', turnstile: { required: true, dx: 'dx-value' } });
      }
      return jsonResponse({ detail: 'turnstile challenge required' }, { status: 403 });
    };
    await assert.rejects(
      () =>
        collect(
          streamChat(
            { messages: [{ role: 'user', content: 'hello' }] },
            { credential: credential(), transport, uuidImpl: fixedUuid }
          )
        ),
      (error) =>
        error instanceof ChatGptChallengeError &&
        error.code === 'challenge_required' &&
        error.challenge?.dx === 'dx-value'
    );
  });
});

test('authenticated endpoint redirects are rejected as auth failures', async () => {
  const transport = async () => new Response(null, {
    status: 302,
    headers: { location: 'https://example.com/login' },
  });

  await assert.rejects(
    () => collect(streamChat(
      { messages: [{ role: 'user', content: 'hello' }] },
      { credential: credential(), transport }
    )),
    (error) => error instanceof AuthError && /redirected away/.test(error.message)
  );
});

test('build scraping and unsupported handoff failures are explicit', () => {
  assert.equal(scrapeBuildId('<html data-build="prod-live">'), 'prod-live');
  assert.equal(scrapeBuildId('<html>missing</html>'), '');
  const error = new ChatGptProtocolError('handoff', 'stream_handoff_unsupported');
  assert.equal(error.code, 'stream_handoff_unsupported');
});
