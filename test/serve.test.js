import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveServeOptions } from '../src/commands/serve.js';

test('resolveServeOptions defaults to loopback and port 8787', () => {
  assert.deepEqual(resolveServeOptions({}, { WEBAI_SERVER_TOKEN: '0123456789abcdef' }), {
    host: '127.0.0.1',
    port: 8787,
    token: '0123456789abcdef',
  });
});

test('resolveServeOptions reads a private token file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webai-serve-test-'));
  const path = join(dir, 'token');
  writeFileSync(path, 'fedcba9876543210\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  assert.equal(resolveServeOptions({ tokenFile: path, port: '9000' }, {}).token, 'fedcba9876543210');
  assert.equal(resolveServeOptions({ tokenFile: path, port: '9000' }, {}).port, 9000);
});

test('resolveServeOptions rejects remote binds, weak secrets, and invalid ports', () => {
  const env = { WEBAI_SERVER_TOKEN: '0123456789abcdef' };
  assert.throws(() => resolveServeOptions({ host: '0.0.0.0' }, env), /loopback/);
  assert.throws(() => resolveServeOptions({}, { WEBAI_SERVER_TOKEN: 'short' }), /at least 16/);
  assert.throws(
    () => resolveServeOptions({}, { WEBAI_SERVER_TOKEN: '01234567 89abcdef' }),
    /must not contain whitespace/
  );
  assert.throws(() => resolveServeOptions({ port: 'nope' }, env), /--port/);
});

test('resolveServeOptions rejects a token file readable by other users', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'webai-serve-mode-test-'));
  const path = join(dir, 'token');
  writeFileSync(path, 'fedcba9876543210\n', { mode: 0o644 });
  chmodSync(path, 0o644);
  assert.throws(() => resolveServeOptions({ tokenFile: path }, {}), /chmod 600/);
});
