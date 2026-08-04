import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGIN_PROVIDER_IDS, verifyChatCredential } from '../src/auth/verify.js';
import { WebaiError } from '../src/errors.js';

test('login verifier sends a minimal text request through every direct provider', async () => {
  for (const provider of LOGIN_PROVIDER_IDS) {
    let captured;
    const result = await verifyChatCredential(
      provider,
      { cookies: { secret: 'value' } },
      {
        getProvider: () => ({
          id: `${provider}-web`,
          async *streamChat(request, options) {
            captured = { request, options };
            yield { type: 'text_delta', text: 'webai-ok' };
            yield { type: 'finish', metadata: { provider } };
          },
        }),
      }
    );

    assert.equal(captured.request.model, `${provider}-web`);
    assert.match(captured.request.messages[0].content, /webai-ok/);
    assert.deepEqual(captured.options.credential, { cookies: { secret: 'value' } });
    assert.equal(result.model, `${provider}-web`);
  }
});

test('login verifier returns Claude organization metadata and ChatGPT cookie rotation', async () => {
  const claude = await verifyChatCredential(
    'claude',
    { cookies: { sessionKey: 'old-secret' } },
    {
      getProvider: () => ({
        id: 'claude-web',
        async *streamChat() {
          yield { type: 'text_delta', text: 'ok' };
          yield { type: 'finish', metadata: { organizationId: 'org-id' } };
        },
      }),
    }
  );
  assert.deepEqual(claude.updates, { organizationId: 'org-id' });

  const chatgpt = await verifyChatCredential(
    'chatgpt',
    { cookies: { '__Secure-next-auth.session-token': 'old-secret' } },
    {
      getProvider: () => ({
        id: 'chatgpt-web',
        async *streamChat(_request, options) {
          await options.onCredentialUpdate(
            '__Secure-next-auth.session-token=rotated-secret; oai-did=device-id'
          );
          yield { type: 'text_delta', text: 'ok' };
          yield { type: 'finish' };
        },
      }),
    }
  );
  assert.equal(chatgpt.updates.cookies['__Secure-next-auth.session-token'], 'rotated-secret');
  assert.equal(chatgpt.updates.cookies['oai-did'], 'device-id');
  assert.equal(chatgpt.updates.cookieJar.length, 2);
});

test('login verifier rejects incomplete probes and providers without direct chat', async () => {
  await assert.rejects(
    () => verifyChatCredential('gemini', {}, {
      getProvider: () => ({
        id: 'gemini-web',
        async *streamChat() {
          yield { type: 'finish' };
        },
      }),
    }),
    (error) => error instanceof WebaiError && /did not complete a text response/.test(error.message)
  );

  await assert.rejects(
    () => verifyChatCredential('gemini', {}, { getProvider: () => null }),
    (error) => error instanceof WebaiError && /no direct chat verifier/.test(error.message)
  );
  await assert.rejects(
    () => verifyChatCredential('grok', {}, { getProvider: () => null }),
    (error) => error instanceof WebaiError && /unknown provider/.test(error.message)
  );
});
