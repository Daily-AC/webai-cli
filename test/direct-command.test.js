import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askDirect } from '../src/commands/ask.js';
import { streamDirect } from '../src/commands/stream.js';

function sink() {
  return {
    value: '',
    write(chunk) {
      this.value += chunk;
      return true;
    },
  };
}

function reasoningProvider(received) {
  return {
    id: 'deepseek-web',
    async *streamChat(request) {
      received.push(request);
      yield { type: 'text_delta', text: 'answer' };
      yield {
        type: 'finish',
        finishReason: 'stop',
        metadata: {
          provider: 'deepseek',
          reasoning: 'reasoning',
          responseId: 'response-id',
          chatSessionId: 'session-id',
        },
      };
    },
  };
}

test('askDirect enables thinking and includes provider reasoning in text and JSON output', async () => {
  for (const json of [false, true]) {
    const received = [];
    const stdout = sink();
    await askDirect(
      reasoningProvider(received),
      'question',
      { thinking: true, json, verbose: false },
      { stdout, stderr: sink() }
    );

    assert.equal(received[0].thinking, true);
    if (json) {
      const result = JSON.parse(stdout.value);
      assert.equal(result.final, 'answer');
      assert.equal(result.thinking, 'reasoning');
      assert.equal(result.conversationId, 'session-id');
    } else {
      assert.equal(stdout.value, '[thinking] reasoning\n\nanswer\n');
    }
  }
});

test('streamDirect enables thinking and reports reasoning without corrupting streamed stdout', async () => {
  const received = [];
  const combined = sink();
  await streamDirect(
    reasoningProvider(received),
    'question',
    { thinking: true, json: false, raw: false },
    { stdout: combined, stderr: combined }
  );

  assert.equal(received[0].thinking, true);
  assert.equal(combined.value, 'answer\nreasoning\n');
});
