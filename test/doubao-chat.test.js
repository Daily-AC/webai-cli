import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AuthError, QuotaError, WebaiError } from '../src/errors.js';
import {
  DoubaoStreamDecoder,
  buildChatBody,
  cookieHeaderFromCredential,
  doubaoChat,
  streamChat,
} from '../src/providers/doubao/chat.js';

const encoder = new TextEncoder();
const HERE = dirname(fileURLToPath(import.meta.url));

function credential() {
  return {
    cookies: { sessionid: 'session-secret', sessionid_ss: 'session-secret' },
    device: {
      deviceId: '7123456789012345678',
      webId: '7234567890123456789',
      teaUuid: '7345678901234567890',
    },
  };
}

function samanthaEvent(eventType, data = {}) {
  return `data: ${JSON.stringify({ event_type: eventType, event_data: JSON.stringify(data) })}\n\n`;
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test('buildChatBody creates a temporary text conversation request', () => {
  const body = buildChatBody('hello', {
    randomUUID: () => 'message-id',
    now: () => 1720000000123,
  });
  assert.deepEqual(JSON.parse(body.messages[0].content), { text: 'hello' });
  assert.equal(body.messages[0].content_type, 2001);
  assert.equal(body.completion_option.need_create_conversation, true);
  assert.equal(body.completion_option.use_deep_think, false);
  assert.equal(body.conversation_id, '0');
  assert.equal(body.local_message_id, 'message-id');
});

test('cookieHeaderFromCredential accepts structured and legacy credentials', () => {
  assert.match(cookieHeaderFromCredential(credential()), /sessionid=session-secret/);
  assert.equal(cookieHeaderFromCredential('sessionid=raw'), 'sessionid=raw');
});

test('DoubaoStreamDecoder handles split Samantha deltas and completion', () => {
  const raw =
    samanthaEvent(2002, { conversation_id: 'conversation-1' }) +
    samanthaEvent(2001, {
      conversation_id: 'conversation-1',
      message_id: 'response-1',
      message: { content_type: 2001, content: JSON.stringify({ text: 'hel' }) },
    }) +
    samanthaEvent(2001, {
      message: { content_type: 2001, content: JSON.stringify({ delta: { text: 'lo' } }) },
    }) +
    samanthaEvent(2003);
  const decoder = new DoubaoStreamDecoder();
  const events = [];
  for (let i = 0; i < raw.length; i += 7) events.push(...decoder.push(raw.slice(i, i + 7)));
  events.push(...decoder.finish());

  assert.deepEqual(events.filter((event) => event.type === 'text').map((event) => event.text), ['hel', 'lo']);
  assert.equal(events.find((event) => event.type === 'metadata').metadata.conversationId, 'conversation-1');
  assert.equal(events.at(-1).type, 'finish');
});

test('DoubaoStreamDecoder parses a sanitized real Samantha response fixture', () => {
  // Captured from a direct Node request on 2026-07-22. Only dynamic ids and
  // unrelated intent telemetry were removed from the upstream response.
  const raw = readFileSync(join(HERE, 'fixtures', 'doubao', 'chat-text-sse.txt'), 'utf8');
  const decoder = new DoubaoStreamDecoder();
  const events = [...decoder.push(raw), ...decoder.finish()];

  assert.deepEqual(events.filter((event) => event.type === 'text').map((event) => event.text), ['dou']);
  assert.equal(events.find((event) => event.type === 'metadata').metadata.conversationId, '<redacted-id>');
  assert.equal(events.at(-1).type, 'finish');
});

test('DoubaoStreamDecoder maps provider rate limits', () => {
  const decoder = new DoubaoStreamDecoder();
  assert.throws(
    () => decoder.push(`data: ${JSON.stringify({ code: 710022004, message: 'limited' })}\n\n`),
    QuotaError
  );
});

test('Doubao maps the real HTTP 200 gateway auth error to AuthError', async () => {
  const raw = readFileSync(join(HERE, 'fixtures', 'doubao', 'gateway-auth-error-sse.txt'), 'utf8');
  await assert.rejects(
    () => collect(streamChat(
      { messages: [{ role: 'user', content: 'ping' }] },
      {
        credential: credential(),
        fetchImpl: async () => new Response(raw, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      }
    )),
    AuthError
  );
});

test('streamChat signs a direct request and emits canonical events', async () => {
  const raw =
    samanthaEvent(2001, {
      conversation_id: 'conversation-1',
      message_id: 'response-1',
      message: { content_type: 2001, content: JSON.stringify({ text: 'pong' }) },
    }) + samanthaEvent(2003);
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(raw, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  const events = await collect(
    streamChat(
      { model: 'doubao-web', messages: [{ role: 'user', content: 'ping' }] },
      { credential: credential(), fetchImpl }
    )
  );

  const url = new URL(captured.url);
  assert.equal(url.pathname, '/samantha/chat/completion');
  assert.equal(url.searchParams.get('device_id'), '7123456789012345678');
  assert.ok(url.searchParams.get('a_bogus'));
  assert.match(captured.init.headers.Cookie, /sessionid=session-secret/);
  assert.deepEqual(events.map((event) => event.type), ['text_delta', 'finish']);
  assert.equal(events[0].text, 'pong');
  assert.equal(events[1].metadata.conversationId, 'conversation-1');
});

test('streamChat finishes and cancels a response that stays open after STREAM_END', async () => {
  const raw =
    samanthaEvent(2001, {
      message: { content_type: 2001, content: JSON.stringify({ text: 'ok' }) },
    }) + samanthaEvent(2003);
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(raw));
    },
    cancel() {
      cancelled = true;
    },
  });

  const events = await collect(streamChat(
    { model: 'doubao-web', messages: [{ role: 'user', content: 'ping' }] },
    {
      credential: credential(),
      timeoutMs: 30,
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    }
  ));

  assert.deepEqual(events.map((event) => event.type), ['text_delta', 'finish']);
  assert.equal(events[0].text, 'ok');
  assert.equal(cancelled, true);
});

test('streamChat reports missing and rejected credentials as AuthError', async () => {
  await assert.rejects(
    () => collect(streamChat({ messages: [{ role: 'user', content: 'hi' }] }, { credential: { cookies: {} } })),
    AuthError
  );
  await assert.rejects(
    () => collect(
      streamChat(
        { messages: [{ role: 'user', content: 'hi' }] },
        { credential: credential(), fetchImpl: async () => new Response('denied', { status: 401 }) }
      )
    ),
    AuthError
  );
});

test('streamChat rejects incomplete streams and never retries transport failures', async () => {
  await assert.rejects(
    () => collect(
      streamChat(
        { messages: [{ role: 'user', content: 'hi' }] },
        { credential: credential(), fetchImpl: async () => new Response(samanthaEvent(2001, {
          message: { content_type: 2001, content: JSON.stringify({ text: 'partial' }) },
        })) }
      )
    ),
    (error) => error instanceof WebaiError && /before a completion event/.test(error.message)
  );

  let calls = 0;
  await assert.rejects(
    () => collect(
      streamChat(
        { messages: [{ role: 'user', content: 'hi' }] },
        {
          credential: credential(),
          fetchImpl: async () => {
            calls++;
            throw new Error('connection reset after submit');
          },
        }
      )
    ),
    /connection reset after submit/
  );
  assert.equal(calls, 1);
});

test('doubaoChat exposes the sidecar provider contract', () => {
  assert.equal(doubaoChat.id, 'doubao-web');
  assert.equal(doubaoChat.streamChat, streamChat);
});
