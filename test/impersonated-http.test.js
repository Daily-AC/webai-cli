import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  createImpersonatedFetch,
  normalizeTlsProfile,
} from '../src/http/impersonated.js';
import { WebaiError } from '../src/errors.js';

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

test('normalizeTlsProfile accepts bundled browser profiles and rejects unknown native input', () => {
  assert.equal(normalizeTlsProfile(), 'firefox144');
  assert.equal(normalizeTlsProfile(' Chrome142 '), 'chrome142');
  assert.throws(() => normalizeTlsProfile('custom-profile'), WebaiError);
});

test('impersonated fetch exposes Fetch-compatible headers and a readable streaming body', async (t) => {
  const server = await listen((request, response) => {
    assert.equal(request.headers.cookie, 'session=private');
    response.writeHead(200, { 'Content-Type': 'text/plain', 'X-Test': 'yes' });
    response.write('first');
    response.end('-second');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const response = await createImpersonatedFetch({ profile: 'firefox144' })(
    `http://127.0.0.1:${address.port}/stream`,
    { headers: { Cookie: 'session=private' } }
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-test'), 'yes');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    body += decoder.decode(result.value, { stream: true });
  }
  body += decoder.decode();
  assert.equal(body, 'first-second');
});

test('impersonated fetch does not forward credentials across redirects', async (t) => {
  let redirectedHeaders = null;
  const target = await listen((request, response) => {
    redirectedHeaders = request.headers;
    response.end('unexpected redirect follow');
  });
  const targetAddress = target.address();
  const source = await listen((_request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${targetAddress.port}/capture` });
    response.end();
  });
  t.after(() => Promise.all([
    new Promise((resolve) => source.close(resolve)),
    new Promise((resolve) => target.close(resolve)),
  ]));

  const sourceAddress = source.address();
  const response = await createImpersonatedFetch({ profile: 'firefox144' })(
    `http://127.0.0.1:${sourceAddress.port}/redirect`,
    {
      headers: {
        Cookie: 'session=SECRET_COOKIE',
        Authorization: 'Bearer SECRET_TOKEN',
      },
    }
  );

  assert.equal(response.status, 302);
  assert.equal(redirectedHeaders, null);
});
