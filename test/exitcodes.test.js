import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT,
  WebaiError,
  AuthError,
  QuotaError,
  ContentRejectedError,
  PendingError,
  exitCodeFor,
} from '../src/errors.js';

test('each typed error carries its deterministic exit code', () => {
  assert.equal(new WebaiError('x').exitCode, EXIT.OTHER); // 1
  assert.equal(new AuthError('x').exitCode, EXIT.AUTH); // 2
  assert.equal(new PendingError('x').exitCode, EXIT.PENDING); // 3
  assert.equal(new ContentRejectedError('x').exitCode, EXIT.REJECTED); // 4
  assert.equal(new QuotaError('x').exitCode, EXIT.QUOTA); // 5
});

test('exit codes match the spec §4.4 numbering', () => {
  assert.deepEqual(
    [EXIT.OK, EXIT.OTHER, EXIT.AUTH, EXIT.PENDING, EXIT.REJECTED, EXIT.QUOTA],
    [0, 1, 2, 3, 4, 5]
  );
});

test('exitCodeFor maps typed errors and defaults unknown errors to 1', () => {
  assert.equal(exitCodeFor(new AuthError('x')), 2);
  assert.equal(exitCodeFor(new QuotaError('x')), 5);
  assert.equal(exitCodeFor(new Error('plain')), EXIT.OTHER);
  assert.equal(exitCodeFor(undefined), EXIT.OTHER);
});
