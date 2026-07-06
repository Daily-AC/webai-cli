import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sm3Digest, customBase64, longABogus, buildUrlParams, buildImParams, fakeMsToken } from '../src/providers/doubao/sign.js';
import { buildVideoBody, videoFromBlocks } from '../src/providers/doubao/index.js';
import { crc32 } from '../src/providers/doubao/upload.js';
import { signAws4Request } from '../src/providers/doubao/aws4.js';

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

test('buildImParams carries device ids but omits msToken/a_bogus (im/chain/single needs neither)', () => {
  const p = buildImParams({ deviceId: 'D', webId: 'W', teaUuid: 'T' });
  assert.equal(p.aid, '497858');
  assert.equal(p.device_id, 'D');
  assert.equal(p.web_id, 'W');
  assert.equal(p.tea_uuid, 'T');
  assert.ok(p.web_tab_id);
  assert.equal('msToken' in p, false);
  assert.equal('a_bogus' in p, false);
});

test('buildVideoBody uses the video skill (17) and an empty attachments array by default', () => {
  const body = buildVideoBody('animate this');
  assert.equal(body.bot_id, '7338286299411103781');
  assert.equal(body.messages[0].content_type, 2009);
  assert.deepEqual(body.messages[0].attachments, []);
  assert.equal(body.messages[0].skill.skill_id, '17');
  assert.equal(body.messages[0].skill.skill_type, 17);
  assert.deepEqual(JSON.parse(body.messages[0].ext.input_skill), { skill_id: '17', skill_type: 17 });
  assert.deepEqual(JSON.parse(body.messages[0].content), { text: 'animate this' });
});

test('buildVideoBody carries the uploaded attachment and optional ratio', () => {
  const attachment = { key: 'tos-cn-i-a9rns2rl98/abc.png', name: 'ref.png' };
  const body = buildVideoBody('animate this', { attachment, ratio: '9:16' });
  assert.deepEqual(body.messages[0].attachments, [attachment]);
  assert.deepEqual(JSON.parse(body.messages[0].content), { text: 'animate this', ratio: '9:16' });
});

test('videoFromBlocks finds a ready (status 3) video creation and ignores others', () => {
  const readyBlocks = [
    {
      block_type: 2074,
      content: { creation_block: { creations: [{ video: { status: 3, download_url: 'https://example.com/v.mp4' } }] } },
    },
  ];
  assert.deepEqual(videoFromBlocks(readyBlocks), { status: 3, download_url: 'https://example.com/v.mp4' });

  const pendingBlocks = [
    { block_type: 2074, content: { creation_block: { creations: [{ video: { status: 1 } }] } } },
  ];
  assert.equal(videoFromBlocks(pendingBlocks), null);
  assert.equal(videoFromBlocks([]), null);
  assert.equal(videoFromBlocks(undefined), null);
});

test('crc32 matches the standard check value for "123456789"', () => {
  assert.equal(crc32(Buffer.from('123456789')), 'cbf43926');
});

test('signAws4Request produces a well-formed, deterministic Authorization header', () => {
  const now = new Date('2026-07-06T07:55:17Z');
  const headers = signAws4Request({
    method: 'GET',
    host: 'imagex.bytedanceapi.com',
    path: '/',
    query: { Action: 'ApplyImageUpload', Version: '2018-08-01' },
    body: '',
    accessKey: 'AKID',
    secretKey: 'SECRET',
    sessionToken: 'TOKEN',
    region: 'cn-north-1',
    service: 'imagex',
    now,
  });
  assert.equal(headers['x-amz-date'], '20260706T075517Z');
  assert.equal(headers['x-amz-security-token'], 'TOKEN');
  assert.match(headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/20260706\/cn-north-1\/imagex\/aws4_request, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);

  // Same inputs -> same signature (no hidden randomness/wall-clock dependence).
  const headers2 = signAws4Request({
    method: 'GET',
    host: 'imagex.bytedanceapi.com',
    path: '/',
    query: { Action: 'ApplyImageUpload', Version: '2018-08-01' },
    body: '',
    accessKey: 'AKID',
    secretKey: 'SECRET',
    sessionToken: 'TOKEN',
    region: 'cn-north-1',
    service: 'imagex',
    now,
  });
  assert.equal(headers2.Authorization, headers.Authorization);
});
