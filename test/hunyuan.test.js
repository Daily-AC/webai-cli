import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { deriveSignKey, makeNonce, canonicalize, signQuery } from '../src/providers/hunyuan/sign.js';
import { buildGenerationBody, baseHeaders, MOTIONS, SCENE, DEFAULT_COUNT } from '../src/providers/hunyuan/reqbuild.js';
import { normalizeCreation, normalizeResult, pickFile, isTerminal } from '../src/providers/hunyuan/parse.js';
import { buildCosAuthorization } from '../src/providers/hunyuan/cos.js';

// ---- signature ----

test('deriveSignKey reproduces the obfuscated HMAC key from the web bundle', () => {
  assert.equal(deriveSignKey(), 'Hf6d6KFB3D');
});

test('canonicalize sorts by key, stringifies, and drops empty values', () => {
  assert.equal(
    canonicalize({ b: 2, a: 1, empty: '', missing: null, undef: undefined }),
    'a=1&b=2'
  );
});

test('signQuery adds timestamp/nonce and an HMAC-SHA256 hex sign over the canonical string', () => {
  const signed = signQuery({ creationsId: 'abc' }, { timestamp: 1700000000, nonce: 'NONCE0123456789' });
  assert.equal(signed.timestamp, 1700000000);
  assert.equal(signed.nonce, 'NONCE0123456789');
  const expected = crypto
    .createHmac('sha256', 'Hf6d6KFB3D')
    .update('creationsId=abc&nonce=NONCE0123456789&timestamp=1700000000')
    .digest('hex');
  assert.equal(signed.sign, expected);
  assert.match(signed.sign, /^[0-9a-f]{64}$/);
});

test('makeNonce respects the length and the alphanumeric alphabet', () => {
  const nonce = makeNonce(16, () => 0);
  assert.equal(nonce, 'A'.repeat(16));
  assert.match(makeNonce(16), /^[A-Za-z0-9]{16}$/);
});

// ---- generation bodies ----

test('text mode pairs sceneType playGround3D-2.0 with the V3.1 pipeline and count 4', () => {
  const body = buildGenerationBody('text', { prompt: 'a sword' });
  assert.equal(body.sceneType, SCENE.modelV2);
  assert.equal(body.modelType, 'text2ModelV3.1');
  assert.equal(body.count, DEFAULT_COUNT.text);
  assert.equal(body.count, 4);
  assert.equal(body.prompt, 'a sword');
  assert.equal(body.title, 'a sword');
});

test('an explicit version selects the newer pipeline', () => {
  assert.equal(buildGenerationBody('text', { prompt: 'x', version: '3.5' }).modelType, 'text2ModelV3.5');
});

test('image mode switches to the multi-view pipeline once several images are given', () => {
  const single = buildGenerationBody('image', { images: ['https://x/1.png'] });
  assert.equal(single.modelType, 'image2ModelV3.1');
  assert.deepEqual(single.imageList, ['https://x/1.png']);
  assert.equal(single.count, 1);
  const multi = buildGenerationBody('image', { images: ['https://x/1.png', 'https://x/2.png'] });
  assert.equal(multi.modelType, 'multiView2ModelV3.1');
});

test('animate mode carries the rigged fbx, the mesh triple, and a numeric motionType', () => {
  const body = buildGenerationBody('animate', {
    modelUrl3D: { type: 'fbx', url: 'https://x/rig.fbx' },
    mesh: { fbx: 'https://x/rig.fbx', glb: 'https://x/m.glb', image_url: '' },
    motionType: '13',
  });
  assert.equal(body.sceneType, SCENE.animation);
  assert.equal(body.modelType, 'actionDriven');
  assert.equal(body.motionType, 13);
  assert.equal(body.mesh.glb, 'https://x/m.glb');
  assert.equal(MOTIONS[13], 'OneHandSwordCombo');
});

test('reconstruct mode sends videoList when a video is given, imageList otherwise', () => {
  assert.deepEqual(buildGenerationBody('reconstruct', { video: 'https://x/a.mp4' }).videoList, ['https://x/a.mp4']);
  assert.deepEqual(buildGenerationBody('reconstruct', { images: ['https://x/1.png'] }).imageList, ['https://x/1.png']);
});

test('optional flags are omitted rather than sent as null', () => {
  const body = buildGenerationBody('text', { prompt: 'x' });
  assert.equal('enable_pbr' in body, false);
  assert.equal('style' in body, false);
  assert.equal('faceCount' in body, false);
  const rich = buildGenerationBody('text', { prompt: 'x', pbr: true, lowpoly: false, faceCount: 40000 });
  assert.equal(rich.enable_pbr, true);
  assert.equal(rich.enableLowPoly, false);
  assert.equal(rich.faceCount, 40000);
});

test('an unknown mode fails loudly', () => {
  assert.throws(() => buildGenerationBody('nope', {}), /unknown hunyuan mode/);
});

test('baseHeaders sends the web app product headers and the inner-user id', () => {
  const headers = baseHeaders({ cookieHeader: 'hunyuan_token=t', innerUserId: 'u1' });
  assert.equal(headers['x-source'], 'web');
  assert.equal(headers['x-product'], 'hunyuan3d');
  assert.equal(headers.cookie, 'hunyuan_token=t');
  assert.equal(headers.x_hunyuan_inner_user_id, 'u1');
  assert.equal('x_hunyuan_inner_user_id' in baseHeaders({}), false);
});

// ---- response parsing ----

const CREATION = {
  id: 'job-1',
  status: 'success',
  sceneType: 'playGround3D-2.0',
  modelType: 'text2ModelV3.1',
  prompt: 'a sword',
  n: 2,
  result: [
    {
      assetId: 'asset-1',
      status: 'success',
      urlResult: { glb: 'https://cdn/1.glb', obj: 'https://cdn/1.obj', png: 'https://cdn/1.png' },
    },
    {
      assetId: 'asset-2',
      status: 'success',
      intermediate_outputs: { geometry: { gif_url: 'https://cdn/2.gif', image_url: 'https://cdn/2.png' } },
    },
  ],
};

test('normalizeCreation flattens results and collects file kinds', () => {
  const creation = normalizeCreation(CREATION);
  assert.equal(creation.id, 'job-1');
  assert.equal(creation.count, 2);
  assert.equal(creation.results.length, 2);
  assert.equal(creation.results[0].files.glb, 'https://cdn/1.glb');
  assert.equal(creation.results[1].files.gif, 'https://cdn/2.gif');
});

test('normalizeResult lifts a boneBindingData fbx/glb pair into files', () => {
  const result = normalizeResult({ boneBindingData: { fbx: 'https://cdn/r.fbx', glb: 'https://cdn/r.glb' } });
  assert.equal(result.files.fbx, 'https://cdn/r.fbx');
  assert.equal(result.files.glb, 'https://cdn/r.glb');
  assert.equal(result.boneBindingData.fbx, 'https://cdn/r.fbx');
});

test('pickFile prefers glb, honours an explicit kind, and reports the index it read', () => {
  const creation = normalizeCreation(CREATION);
  assert.deepEqual(pickFile(creation), { kind: 'glb', url: 'https://cdn/1.glb', assetId: 'asset-1' });
  assert.equal(pickFile(creation, { kind: 'obj' }).url, 'https://cdn/1.obj');
  assert.equal(pickFile(creation, { kind: 'glb' })?.kind, 'glb');
  assert.equal(pickFile(creation, { index: 1 }).kind, 'gif');
  assert.equal(pickFile(creation, { index: 9 }), null);
  assert.equal(pickFile(creation, { kind: 'fbx' }), null);
});

test('isTerminal only accepts success/fail', () => {
  assert.equal(isTerminal('success'), true);
  assert.equal(isTerminal('fail'), true);
  assert.equal(isTerminal('processing'), false);
  assert.equal(isTerminal('wait'), false);
});

// ---- COS upload signature ----

test('buildCosAuthorization produces a q-sign-algorithm=sha1 header over the signed host', () => {
  const auth = buildCosAuthorization({
    method: 'PUT',
    pathname: '/dir/file.png',
    secretId: 'AKID-TEST',
    secretKey: 'SECRET-TEST',
    startTime: 1700000000,
    expiredTime: 1700003600,
    headers: { host: 'bucket-1.cos.ap-guangzhou.myqcloud.com' },
  });
  const parts = Object.fromEntries(auth.split('&').map((kv) => kv.split('=')));
  assert.equal(parts['q-sign-algorithm'], 'sha1');
  assert.equal(parts['q-ak'], 'AKID-TEST');
  assert.equal(parts['q-sign-time'], '1700000000;1700003600');
  assert.equal(parts['q-header-list'], 'host');
  assert.equal(parts['q-url-param-list'], '');

  // Recompute independently: signKey = HMAC-SHA1(secret, keyTime);
  // signature  = HMAC-SHA1(signKey, "sha1\n<keyTime>\n<sha1(formatString)>\n").
  const keyTime = '1700000000;1700003600';
  const signKey = crypto.createHmac('sha1', 'SECRET-TEST').update(keyTime).digest('hex');
  const formatString = `put\n/dir/file.png\n\nhost=bucket-1.cos.ap-guangzhou.myqcloud.com\n`;
  const sha1ed = crypto.createHash('sha1').update(formatString).digest('hex');
  const expected = crypto.createHmac('sha1', signKey).update(`sha1\n${keyTime}\n${sha1ed}\n`).digest('hex');
  assert.equal(parts['q-signature'], expected);
});
