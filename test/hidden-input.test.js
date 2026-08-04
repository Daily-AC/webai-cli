import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readHiddenLine } from '../src/cli/hidden-input.js';
import { WebaiError } from '../src/errors.js';

class FakeTty extends PassThrough {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
    this.rawModes = [];
  }

  setRawMode(value) {
    this.isRaw = Boolean(value);
    this.rawModes.push(this.isRaw);
    return this;
  }
}

function outputSink() {
  let value = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    },
  });
  return { stream, get value() { return value; } };
}

test('readHiddenLine accepts editing without echoing credential bytes', async () => {
  const input = new FakeTty();
  const output = outputSink();
  const pending = readHiddenLine({ input, output: output.stream, prompt: 'Cookie: ' });

  input.write('session-secret\u007fX\r');

  assert.equal(await pending, 'session-secreX');
  assert.equal(output.value, 'Cookie: \n');
  assert.equal(output.value.includes('session-secret'), false);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
});

test('readHiddenLine restores raw mode when the user cancels', async () => {
  const input = new FakeTty();
  const output = outputSink();
  const pending = readHiddenLine({ input, output: output.stream, prompt: 'Token: ' });

  input.write('do-not-echo\u0003');

  await assert.rejects(pending, (error) => error instanceof WebaiError && /cancelled/.test(error.message));
  assert.equal(output.value, 'Token: \n');
  assert.equal(output.value.includes('do-not-echo'), false);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.equal(input.isPaused(), true);
});

test('readHiddenLine rejects non-TTY input with an automation hint', () => {
  assert.throws(
    () => readHiddenLine({ input: new PassThrough(), output: outputSink().stream }),
    (error) => error instanceof WebaiError && /--stdin or --file/.test(error.message)
  );
});
