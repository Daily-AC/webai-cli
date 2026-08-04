import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { computeSign, buildHeaders } from '../src/providers/jimeng/sign.js';
import {
  resolveModel,
  resolveResolution,
  buildCoreParam,
  buildDraftContent,
  buildGenerateRequest,
  buildMetricsExtra,
  defaultQuery,
  IMAGE_MODEL_MAP,
  DEFAULT_IMAGE_MODEL,
  AID,
} from '../src/providers/jimeng/reqbuild.js';
import {
  resolveVideoModel,
  videoBenefitType,
  videoDurationMs,
  buildVideoDraftContent,
  buildVideoRequest,
  DEFAULT_VIDEO_MODEL,
  VIDEO_MODEL_MAP,
} from '../src/providers/jimeng/reqbuild.js';
import { checkResult, extractImageUrls, extractVideoUrl } from '../src/providers/jimeng/parse.js';
import { AuthError, QuotaError } from '../src/errors.js';

test('computeSign matches md5("9e2c|<last7>|7|8.4.0|<sec>||11ac")', () => {
  const sec = 1000000000;
  const expected = crypto.createHash('md5').update('9e2c|enerate|7|8.4.0|1000000000||11ac').digest('hex');
  assert.equal(computeSign('/mweb/v1/aigc_draft/generate', sec), expected);
});

test('computeSign uses only the last 7 chars of the path', () => {
  const sec = 42;
  assert.equal(computeSign('/x/by_ids', sec), computeSign('/totally/different/by_ids', sec));
});

test('buildHeaders carries the sign, device-time, appid and cookie', () => {
  const h = buildHeaders({ uriPath: '/mweb/v1/aigc_draft/generate', cookieHeader: 'sessionid=abc' });
  assert.match(h.Sign, /^[0-9a-f]{32}$/);
  assert.equal(h['Sign-Ver'], '1');
  assert.equal(h.Appid, String(AID));
  assert.equal(h.Cookie, 'sessionid=abc');
  assert.equal(h.Appvr, '8.4.0');
  assert.equal(h.Pf, '7');
  assert.equal(String(Number(h['Device-Time'])), h['Device-Time']); // numeric seconds
});

test('resolveModel maps names and falls back to the default', () => {
  assert.equal(resolveModel('jimeng-4.5').model, IMAGE_MODEL_MAP['jimeng-4.5']);
  assert.equal(resolveModel('bogus').userModel, DEFAULT_IMAGE_MODEL);
});

test('resolveResolution returns width/height/ratio, defaulting to 2k 1:1', () => {
  const r = resolveResolution('2k', '16:9');
  assert.deepEqual([r.width, r.height, r.imageRatio], [2560, 1440, 3]);
  const d = resolveResolution('bogus', 'bogus');
  assert.equal(d.resolutionType, '2k');
  assert.deepEqual([d.width, d.height], [2048, 2048]);
});

test('buildCoreParam keeps image_ratio unless intelligent_ratio wins', () => {
  const res = resolveResolution('2k', '1:1');
  const cp = buildCoreParam({ userModel: 'jimeng-4.5', model: 'm', prompt: 'p', resolution: res });
  assert.equal(cp.image_ratio, 1);
  assert.equal(cp.prompt, 'p');
  const smart = buildCoreParam({ userModel: 'jimeng-4.5', model: 'm', prompt: 'p', resolution: res, intelligentRatio: true });
  assert.ok(!('image_ratio' in smart));
});

test('buildDraftContent produces a generate-type image_base_component draft', () => {
  const res = resolveResolution('2k', '1:1');
  const cp = buildCoreParam({ userModel: 'jimeng-4.5', model: 'm', prompt: 'p', resolution: res });
  const draft = JSON.parse(buildDraftContent({ componentId: 'cid', coreParam: cp }));
  assert.equal(draft.type, 'draft');
  assert.equal(draft.version, '3.3.9');
  assert.equal(draft.main_component_id, 'cid');
  const comp = draft.component_list[0];
  assert.equal(comp.type, 'image_base_component');
  assert.equal(comp.generate_type, 'generate');
  assert.equal(comp.abilities.generate.core_param.prompt, 'p');
});

test('buildGenerateRequest nests draft/metrics with the CN assistant id', () => {
  const req = buildGenerateRequest({ model: 'm', submitId: 's', draftContent: '{}', metricsExtra: '{}' });
  assert.equal(req.extend.root_model, 'm');
  assert.equal(req.submit_id, 's');
  assert.equal(req.http_common_info.aid, AID);
});

test('buildMetricsExtra emits a stringified sceneOptions array', () => {
  const m = JSON.parse(buildMetricsExtra({ model: 'm', submitId: 's', resolutionType: '2k' }));
  const scene = JSON.parse(m.sceneOptions)[0];
  assert.equal(scene.modelReqKey, 'm');
  assert.equal(scene.benefitCount, 4);
});

test('defaultQuery pins the web client params', () => {
  const q = defaultQuery('7123');
  assert.equal(q.aid, AID);
  assert.equal(q.web_version, '7.5.0');
  assert.equal(q.webId, '7123');
});

test('extractImageUrls reads large_images and unescapes \\u0026', () => {
  const urls = extractImageUrls([
    { image: { large_images: [{ image_url: 'https://x/y?a=1\\u0026b=2' }] } },
    { image: {} },
  ]);
  assert.deepEqual(urls, ['https://x/y?a=1&b=2']);
});

test('checkResult returns data on ret 0 and throws typed errors otherwise', () => {
  assert.deepEqual(checkResult({ ret: '0', data: { ok: 1 } }), { ok: 1 });
  assert.throws(() => checkResult({ ret: '1000', errmsg: 'not login' }), AuthError);
  assert.throws(() => checkResult({ ret: '5000', errmsg: '积分不足' }), QuotaError);
});

test('resolveVideoModel maps names and falls back to the default', () => {
  assert.equal(resolveVideoModel('jimeng-video-2.0').model, VIDEO_MODEL_MAP['jimeng-video-2.0']);
  assert.equal(resolveVideoModel('nope').userModel, DEFAULT_VIDEO_MODEL);
});

test('videoBenefitType keys off the mapped model id', () => {
  assert.equal(videoBenefitType('dreamina_ic_generate_video_model_vgfm_3.5_pro'), 'dreamina_video_seedance_15_pro');
  assert.equal(videoBenefitType('dreamina_ic_generate_video_model_vgfm_lite'), 'basic_video_operation_vgfm_v_three');
  assert.equal(videoBenefitType('dreamina_veo3_generate_video'), 'generate_video_veo3');
});

test('videoDurationMs clamps per model family', () => {
  assert.deepEqual(videoDurationMs('x_3.5_pro', 12), { ms: 12000, s: 12 });
  assert.deepEqual(videoDurationMs('x_3.5_pro', 5), { ms: 5000, s: 5 });
  assert.deepEqual(videoDurationMs('vgfm_lite', 10), { ms: 10000, s: 10 });
  assert.deepEqual(videoDurationMs('vgfm_lite', 7), { ms: 5000, s: 5 });
});

test('buildVideoDraftContent produces a gen_video video_base_component', () => {
  const draft = JSON.parse(
    buildVideoDraftContent({ componentId: 'cid', prompt: 'p', model: 'm', ratio: '16:9', durationMs: 5000, metricsExtra: '{}' })
  );
  const comp = draft.component_list[0];
  assert.equal(comp.type, 'video_base_component');
  assert.equal(comp.generate_type, 'gen_video');
  const inputs = comp.abilities.gen_video.text_to_video_params.video_gen_inputs[0];
  assert.equal(inputs.prompt, 'p');
  assert.equal(inputs.duration_ms, 5000);
  assert.equal(comp.abilities.gen_video.text_to_video_params.video_aspect_ratio, '16:9');
});

test('buildVideoRequest embeds commerce benefit info', () => {
  const req = buildVideoRequest({ model: 'dreamina_ic_generate_video_model_vgfm_lite', submitId: 's', draftContent: '{}', metricsExtra: '{}' });
  assert.equal(req.extend.m_video_commerce_info.benefit_type, 'basic_video_operation_vgfm_v_three');
  assert.equal(req.extend.m_video_commerce_info_list[0].resource_id, 'generate_video');
});

test('extractVideoUrl walks the mp4 fallback chain', () => {
  assert.equal(extractVideoUrl({ video: { transcoded_video: { origin: { video_url: 'u1' } } } }), 'u1');
  assert.equal(extractVideoUrl({ video: { play_url: 'u2' } }), 'u2');
  assert.equal(extractVideoUrl({ video: {} }), null);
});
