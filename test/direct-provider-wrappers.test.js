import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatGptDirectProvider } from '../src/providers/chatgpt/direct.js';
import { createClaudeDirectProvider } from '../src/providers/claude/direct.js';

test('Claude direct wrapper selects the credential TLS profile without starting a browser', async () => {
  const profiles = [];
  const provider = createClaudeDirectProvider({
    createTransport({ profile }) {
      profiles.push(profile);
      return async () => new Response('', { status: 401 });
    },
  });

  await assert.rejects(
    async () => {
      for await (const _event of provider.streamChat(
        { messages: [{ role: 'user', content: 'hello' }] },
        { credential: { cookies: { sessionKey: 'secret' }, tlsProfile: 'chrome142' } }
      )) {
        // The negative live-shape path emits no events.
      }
    },
    /rejected the Claude credential/
  );
  assert.deepEqual(profiles, ['chrome142']);
});

test('ChatGPT direct wrapper selects a pinned profile before session exchange', async () => {
  const profiles = [];
  const provider = createChatGptDirectProvider({
    createTransport({ profile }) {
      profiles.push(profile);
      return async () => new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  await assert.rejects(
    async () => {
      for await (const _event of provider.streamChat(
        { messages: [{ role: 'user', content: 'hello' }] },
        { credential: { cookies: { '__Secure-next-auth.session-token': 'secret' } } }
      )) {
        // The negative session exchange emits no events.
      }
    },
    /returned no accessToken/
  );
  assert.deepEqual(profiles, ['firefox144']);
});

