import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInner,
  buildFreq,
  buildGenerateBody,
  buildGenerateQuery,
  buildGenerateHeaders,
  buildModelHeader,
  buildBatchExecuteBody,
  buildReadChatPayload,
  MODEL_HEADER_KEY,
} from '../src/providers/gemini/reqbuild.js';

test('buildInner places the prompt in slot 0 and streaming flag in slot 7', () => {
  const inner = buildInner({ prompt: 'hello world', uuid: 'UUID-1' });
  assert.equal(inner.length, 69);
  assert.deepEqual(inner[0], ['hello world', 0, null, null, null, null, 0]);
  assert.equal(inner[7], 1, 'streaming flag');
  assert.deepEqual(inner[1], ['en']);
  assert.equal(inner[59], 'UUID-1');
  assert.equal(inner[68], 2);
});

test('buildInner does NOT include a deep-research "!" anti-abuse token', () => {
  const inner = buildInner({ prompt: 'draw a cat' });
  const json = JSON.stringify(inner);
  assert.ok(!json.includes('"!'), 'no !<blob> token for plain generation');
  assert.equal(inner[3], null, 'deep-research slot 3 stays null');
  assert.equal(inner[4], null, 'deep-research slot 4 stays null');
});

test('buildFreq wraps inner as [null, JSON(inner)]', () => {
  const inner = buildInner({ prompt: 'x', uuid: 'U' });
  const freq = buildFreq(inner);
  const outer = JSON.parse(freq);
  assert.equal(outer[0], null);
  assert.deepEqual(JSON.parse(outer[1]), inner);
});

test('buildGenerateBody carries f.req and at, and echoes uuid', () => {
  const { body, uuid } = buildGenerateBody({ prompt: 'p', at: 'SNlM0e-token', uuid: 'ABC' });
  const params = new URLSearchParams(body);
  assert.equal(params.get('at'), 'SNlM0e-token');
  assert.ok(params.get('f.req'), 'has f.req');
  assert.equal(uuid, 'ABC');
  // The prompt round-trips through the nested JSON.
  const inner = JSON.parse(JSON.parse(params.get('f.req'))[1]);
  assert.equal(inner[0][0], 'p');
  assert.equal(inner[59], 'ABC');
});

test('buildGenerateBody throws without an access token', () => {
  assert.throws(() => buildGenerateBody({ prompt: 'p' }), /access token/);
});

test('buildGenerateQuery sets rt=c, _reqid and bl', () => {
  const q = new URLSearchParams(buildGenerateQuery({ bl: 'boq_x', reqid: 12345 }));
  assert.equal(q.get('rt'), 'c');
  assert.equal(q.get('_reqid'), '12345');
  assert.equal(q.get('bl'), 'boq_x');
});

test('buildGenerateHeaders echoes uuid in x-goog-ext-525005358-jspb and merges model header', () => {
  const modelHeader = buildModelHeader('fbb127bbb056c959', 1);
  const h = buildGenerateHeaders({ uuid: 'ZZ', modelHeader });
  assert.equal(h['x-goog-ext-525005358-jspb'], '["ZZ",1]');
  assert.equal(h['X-Same-Domain'], '1');
  assert.ok(h[MODEL_HEADER_KEY].includes('fbb127bbb056c959'));
});

test('buildBatchExecuteBody builds [[[rpcid,payload,null,generic]]]', () => {
  const body = buildBatchExecuteBody({ rpcid: 'hNvQHb', payload: '["c_1",10]', at: 'tok' });
  const params = new URLSearchParams(body);
  const freq = JSON.parse(params.get('f.req'));
  assert.deepEqual(freq, [[['hNvQHb', '["c_1",10]', null, 'generic']]]);
  assert.equal(params.get('at'), 'tok');
});

test('buildReadChatPayload matches chat_mixin read_chat shape', () => {
  assert.equal(buildReadChatPayload('c_abc', 10), '["c_abc",10,null,1,[1],[4],null,1]');
});
