import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnsupportedChatFeatureError } from '../src/chat/errors.js';
import {
  AuthError,
  CloudflareChallengeError,
  QuotaError,
  WebaiError,
} from '../src/errors.js';
import {
  CLAUDE_ORGANIZATIONS_URL,
  claudeChat,
  cookieHeaderFromCredential,
  normalizeClaudeCredential,
  streamChat,
} from '../src/providers/claude/chat.js';
import { ClaudeSseDecoder } from '../src/providers/claude/sse.js';

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

function sseResponse(text, chunkSizes = [1, 2, 3, 5, 8, 13]) {
  const bytes = encoder.encode(text);
  return new Response(streamBytes(bytes, chunkSizes), {
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function credential(overrides = {}) {
  return {
    cookie: 'sessionKey=sk-ant-sid02-test; cf_clearance=clearance-test; __cf_bm=bm-test',
    deviceId: 'device-test',
    activitySessionId: 'activity-test',
    ...overrides,
  };
}

function uuidSource(values) {
  let index = 0;
  return () => {
    if (index >= values.length) throw new Error('test UUID source exhausted');
    return values[index++];
  };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test('provider exposes the shared chat contract', () => {
  assert.equal(claudeChat.id, 'claude-web');
  assert.equal(claudeChat.streamChat, streamChat);
});

test('credentials accept bare sessionKey, full Cookie, and a structured cookie jar', () => {
  assert.equal(cookieHeaderFromCredential('sk-ant-sid02-bare'), 'sessionKey=sk-ant-sid02-bare');
  assert.equal(
    cookieHeaderFromCredential('sessionKey=sk-ant-sid02-full; cf_clearance=clear'),
    'sessionKey=sk-ant-sid02-full; cf_clearance=clear'
  );
  assert.equal(
    cookieHeaderFromCredential({
      cookieJar: [
        {
          name: 'sessionKey',
          value: 'sk-ant-sid02-jar',
          domain: '.claude.ai',
          path: '/',
          secure: true,
          expires: Math.floor(Date.now() / 1000) + 60,
        },
        { name: 'wrong-domain', value: 'private', domain: '.example.com', path: '/' },
        { name: 'expired', value: 'private', domain: '.claude.ai', path: '/', expires: 1 },
      ],
    }),
    'sessionKey=sk-ant-sid02-jar'
  );

  const first = normalizeClaudeCredential('sk-ant-sid02-stable');
  const second = normalizeClaudeCredential('sk-ant-sid02-stable');
  assert.equal(first.deviceId, second.deviceId);
  assert.equal(first.activitySessionId, second.activitySessionId);
  assert.throws(() => normalizeClaudeCredential({ cookie: 'cf_clearance=only' }), AuthError);
  assert.throws(
    () => normalizeClaudeCredential({ sessionKey: 'sk-ant-sid02-ok\r\nx-bad: injected' }),
    AuthError
  );
});

test('SSE decoder preserves records across every CRLF split and joins data lines', () => {
  const raw = ': keepalive\r\nevent: custom\r\ndata: {"value":\r\ndata: 1}\r\n\r\n';
  for (let split = 1; split < raw.length; split++) {
    const decoder = new ClaudeSseDecoder();
    const records = [
      ...decoder.push(raw.slice(0, split)),
      ...decoder.push(raw.slice(split)),
      ...decoder.finish(),
    ];
    assert.deepEqual(records, [{ event: 'custom', data: '{"value":\n1}' }], `split=${split}`);
  }
});

test('streamChat discovers the organization, creates a conversation, and parses split SSE state', async () => {
  const calls = [];
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"uuid":"assistant-message-1","usage":{"input_tokens":12}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"plan "}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"carefully"}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"web_search","input":{}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"weather\\"}"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":1}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":"Hel"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"lo"}}',
    '',
    'event: message_limit',
    'data: {"type":"message_limit","message_limit":{"type":"within_limit","windows":{"five_hour":{"utilization":0.2,"status":"within_limit"}}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\r\n');
  const randomUUIDImpl = uuidSource([
    'conversation-1',
    'human-message-1',
    'assistant-message-request-1',
  ]);
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return jsonResponse([{ uuid: 'organization-1' }]);
    return sseResponse(sse, new Array(encoder.encode(sse).length).fill(1));
  };

  const events = await collect(
    streamChat(
      {
        model: 'claude-web',
        messages: [
          { role: 'system', content: 'Be exact.' },
          { role: 'user', content: 'hello' },
        ],
      },
      { credential: credential(), fetchImpl, randomUUIDImpl }
    )
  );

  assert.deepEqual(events.slice(0, -1), [
    { type: 'text_delta', text: 'Hel' },
    { type: 'text_delta', text: 'lo' },
  ]);
  assert.deepEqual(events.at(-1), {
    type: 'finish',
    finishReason: 'stop',
    metadata: {
      provider: 'claude',
      model: 'claude-web',
      upstreamModel: 'claude-sonnet-4-6',
      organizationId: 'organization-1',
      conversationId: 'conversation-1',
      parentMessageUuid: 'assistant-message-1',
      reasoning: 'plan carefully',
      toolBlocks: [
        {
          index: 1,
          type: 'tool_use',
          id: 'tool-1',
          name: 'web_search',
          input: { query: 'weather' },
          inputJson: '{"query":"weather"}',
        },
      ],
      quota: {
        type: 'within_limit',
        windows: { five_hour: { utilization: 0.2, status: 'within_limit' } },
      },
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      completed: true,
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, CLAUDE_ORGANIZATIONS_URL);
  assert.equal(calls[0].init.method, 'GET');
  assert.match(calls[0].init.headers.Cookie, /sessionKey=sk-ant-sid02-test/);
  assert.equal(calls[1].url, 'https://claude.ai/api/organizations/organization-1/chat_conversations/conversation-1/completion');
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers['anthropic-device-id'], 'device-test');
  assert.equal(calls[1].init.headers['x-activity-session-id'], 'activity-test');
  assert.equal(calls[1].init.headers['anthropic-client-platform'], 'web_claude_ai');

  const body = JSON.parse(calls[1].init.body);
  assert.equal(body.model, 'claude-sonnet-4-6');
  assert.match(body.prompt, /"role":"system","content":"Be exact\."/);
  assert.deepEqual(body.turn_message_uuids, {
    human_message_uuid: 'human-message-1',
    assistant_message_uuid: 'assistant-message-request-1',
  });
  assert.deepEqual(body.create_conversation_params, {
    name: '',
    model: 'claude-sonnet-4-6',
    include_conversation_preferences: true,
    is_temporary: false,
    enabled_imagine: true,
  });
  assert.equal(body.parent_message_uuid, undefined);
  assert.ok(body.tools.some((tool) => tool.name === 'web_search' && tool.type === 'web_search_v0'));
});

test('continuation state reuses the conversation and submits only the latest user turn', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return sseResponse([
      'event: message_start',
      'data: {"type":"message_start","message":{"uuid":"parent-new"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n'));
  };

  const events = await collect(
    streamChat(
      {
        model: 'claude-opus-4-6',
        messages: [
          { role: 'system', content: 'Be exact.' },
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'second' },
        ],
      },
      {
        credential: credential({ organizationId: 'organization-1' }),
        state: { conversationId: 'conversation-existing', parentMessageUuid: 'parent-old' },
        fetchImpl,
        randomUUIDImpl: uuidSource(['human-message-2', 'assistant-message-request-2']),
      }
    )
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://claude.ai/api/organizations/organization-1/chat_conversations/conversation-existing/completion');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.prompt, 'second');
  assert.equal(body.parent_message_uuid, 'parent-old');
  assert.equal(body.create_conversation_params, undefined);
  assert.equal(events[0].text, 'done');
  assert.equal(events.at(-1).metadata.parentMessageUuid, 'parent-new');
  assert.equal(events.at(-1).metadata.conversationId, 'conversation-existing');
});

test('arbitrary caller tools fail before credentials or transport are touched', async () => {
  let calls = 0;
  const iterable = streamChat(
    {
      model: 'claude-web',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'shell', parameters: {} } }],
    },
    {
      fetchImpl: async () => {
        calls++;
      },
    }
  );
  await assert.rejects(() => collect(iterable), UnsupportedChatFeatureError);
  assert.equal(calls, 0);
});

test('an upstream tool_use stop is rejected instead of emitting an empty tool_calls finish', async () => {
  const fetchImpl = async () => sseResponse([
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-1","name":"web_search","input":{"query":"weather"}}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n'));

  await assert.rejects(
    () => collect(streamChat(
      { model: 'claude-web', messages: [{ role: 'user', content: 'weather' }] },
      { credential: credential({ organizationId: 'organization-1' }), fetchImpl }
    )),
    (error) => error instanceof UnsupportedChatFeatureError && error.feature === 'upstream_tool_calls'
  );
});

test('HTTP auth and quota responses retain typed errors', async (t) => {
  for (const [status, ErrorType] of [[401, AuthError], [403, AuthError], [429, QuotaError]]) {
    await t.test(String(status), async () => {
      let calls = 0;
      const fetchImpl = async () => {
        calls++;
        return jsonResponse({ error: 'rejected' }, { status });
      };
      await assert.rejects(
        () => collect(streamChat(
          { model: 'claude-web', messages: [{ role: 'user', content: 'hello' }] },
          { credential: credential({ organizationId: 'organization-1' }), fetchImpl }
        )),
        ErrorType
      );
      assert.equal(calls, 1);
    });
  }
});

test('Cloudflare challenge responses are not misclassified as invalid credentials', async () => {
  const fetchImpl = async () => new Response('<html><title>Just a moment...</title></html>', {
    status: 403,
    headers: {
      'content-type': 'text/html; charset=UTF-8',
      'cf-mitigated': 'challenge',
      server: 'cloudflare',
    },
  });

  await assert.rejects(
    () => collect(streamChat(
      { model: 'claude-web', messages: [{ role: 'user', content: 'hello' }] },
      { credential: credential({ organizationId: 'organization-1' }), fetchImpl }
    )),
    (error) =>
      error instanceof CloudflareChallengeError &&
      error.code === 'cloudflare_blocked' &&
      error.provider === 'claude' &&
      error.stage === 'completion' &&
      error.status === 403
  );
});

test('a message_limit event raises QuotaError', async () => {
  const fetchImpl = async () => sseResponse([
    'event: message_limit',
    'data: {"type":"message_limit","message_limit":{"type":"hit_limit","windows":{"five_hour":{"status":"over_limit"}}}}',
    '',
    '',
  ].join('\n'));
  await assert.rejects(
    () => collect(streamChat(
      { model: 'claude-web', messages: [{ role: 'user', content: 'hello' }] },
      { credential: credential({ organizationId: 'organization-1' }), fetchImpl }
    )),
    QuotaError
  );
});

test('submitted completion transport failures are not retried', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw new Error('socket reset');
  };
  await assert.rejects(
    () => collect(streamChat(
      { model: 'claude-web', messages: [{ role: 'user', content: 'hello' }] },
      { credential: credential({ organizationId: 'organization-1' }), fetchImpl }
    )),
    (error) => error instanceof WebaiError && /transport failed: socket reset/.test(error.message)
  );
  assert.equal(calls, 1);
});

test('abort propagates the caller reason while the completion POST is pending', async () => {
  const controller = new AbortController();
  const reason = new Error('caller cancelled');
  let calls = 0;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const fetchImpl = async (_url, init) => {
    calls++;
    markStarted();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };

  const collecting = collect(streamChat(
    { model: 'claude-web', messages: [{ role: 'user', content: 'hello' }] },
    {
      credential: credential({ organizationId: 'organization-1' }),
      fetchImpl,
      signal: controller.signal,
    }
  ));
  await started;
  controller.abort(reason);
  await assert.rejects(collecting, (error) => error === reason);
  assert.equal(calls, 1);
});

test('a stream without message_stop is rejected', async () => {
  const fetchImpl = async () => sseResponse(
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n'
  );
  await assert.rejects(
    () => collect(streamChat(
      { model: 'claude-web', messages: [{ role: 'user', content: 'hello' }] },
      { credential: credential({ organizationId: 'organization-1' }), fetchImpl }
    )),
    (error) => error instanceof WebaiError && /before message_stop/.test(error.message)
  );
});
