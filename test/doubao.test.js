import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sm3Digest, customBase64, longABogus, buildUrlParams, fakeMsToken } from '../src/providers/doubao/sign.js';

const hex = (arr) => arr.map((b) => b.toString(16).padStart(2, '0')).join('');

test('SM3 known-answer vector: sm3("abc")', () => {
  assert.equal(hex(sm3Digest('abc')), '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0');
});

test('SM3 empty string vector', () => {
  assert.equal(hex(sm3Digest('')), '1ab21d8355cfa17f8e61194831e81a8f22bec8c728fefb747ed035eb5082aa2b');
});

test('customBase64 uses the custom alphabet', () => {
  // deterministic mapping of [1,2,3] under the default alphabet
  assert.equal(customBase64([1, 2, 3]), 'DfKp');
});

test('longABogus returns a plausible a_bogus token', () => {
  const ab = longABogus('a=1&b=2', '{"x":1}');
  assert.equal(typeof ab, 'string');
  assert.ok(ab.length >= 160 && ab.length <= 200, `unexpected length ${ab.length}`);
});

test('fakeMsToken has the expected shape', () => {
  const t = fakeMsToken();
  assert.equal(t.length, 172);
  assert.ok(t.endsWith('='));
});

test('buildUrlParams pins samantha web params and carries device ids', () => {
  const p = buildUrlParams({ deviceId: 'D', webId: 'W', teaUuid: 'T' });
  assert.equal(p.aid, '497858');
  assert.equal(p.real_aid, '497858');
  assert.equal(p.version_code, '20800');
  assert.equal(p.device_id, 'D');
  assert.equal(p.web_id, 'W');
  assert.equal(p.tea_uuid, 'T');
  assert.ok(p.web_tab_id && p.msToken);
});
