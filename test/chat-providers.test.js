import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allChatProviders,
  chatProviders,
  experimentalChatProviders,
  getChatProvider,
} from '../src/providers/chat.js';

test('chat provider registry exposes direct web models and site aliases', () => {
  assert.deepEqual(chatProviders.map((provider) => provider.id), ['gemini-web', 'doubao-web']);
  assert.deepEqual(
    experimentalChatProviders.map((provider) => provider.id),
    ['deepseek-web', 'claude-web', 'chatgpt-web']
  );
  assert.deepEqual(
    allChatProviders.map((provider) => provider.id),
    ['gemini-web', 'doubao-web', 'deepseek-web', 'claude-web', 'chatgpt-web']
  );
  assert.equal(getChatProvider('gemini'), getChatProvider('gemini-web'));
  assert.equal(getChatProvider('doubao'), getChatProvider('doubao-web'));
  assert.equal(getChatProvider('deepseek'), getChatProvider('deepseek-web'));
  assert.equal(getChatProvider('claude'), getChatProvider('claude-web'));
  assert.equal(getChatProvider('chatgpt'), getChatProvider('chatgpt-web'));
});
