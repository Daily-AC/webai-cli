// Jimeng (即梦) provider — pure-HTTP text-to-image via jimeng.jianying.com.
// Contract: generateImage(prompt, opts) -> { images:[{url}], meta }; download(url, dest).
// Auth = sessionid cookies imported from Chrome (webai auth import chrome jimeng).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { request, errorForStatus } from '../../http/client.js';
import { getProvider, buildCookieHeader } from '../../auth/store.js';
import { AuthError, WebaiError, QuotaError } from '../../errors.js';
import { buildHeaders } from './sign.js';
import {
  BASE_URL,
  STATUS,
  uuid,
  resolveModel,
  resolveResolution,
  buildCoreParam,
  buildMetricsExtra,
  buildDraftContent,
  buildGenerateRequest,
  defaultQuery,
  pollImageInfo,
  resolveVideoModel,
  videoDurationMs,
  buildVideoMetricsExtra,
  buildVideoDraftContent,
  buildVideoRequest,
} from './reqbuild.js';
import { checkResult, extractImageUrls, extractVideoUrl } from './parse.js';

const GENERATE_PATH = '/mweb/v1/aigc_draft/generate';
const HISTORY_PATH = '/mweb/v1/get_history_by_ids';
const CREDIT_PATH = '/commerce/v1/benefits/user_credit';
const RECEIVE_PATH = '/commerce/v1/benefits/credit_receive';
const IMAGE_REFERER = `${BASE_URL}/ai-tool/generate?type=image`;

// Random web id per process, mirroring the reference client.
const WEB_ID = String(Math.floor(Math.random() * 8e17) + 7e18);

function cookieHeader() {
  const rec = getProvider('jimeng');
  if (!rec || !rec.cookies || !rec.cookies.sessionid) {
    throw new AuthError('No Jimeng credentials found. Run: webai auth import chrome jimeng');
  }
  return buildCookieHeader(rec.cookies);
}

// POST a JSON body to a jimeng API path with default query params + signed headers.
async function apiPost(path, dataObj, { noDefaultParams = false, referer, timeoutMs = 60_000 } = {}) {
  const cookie = cookieHeader();
  const params = noDefaultParams ? {} : defaultQuery(WEB_ID);
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const url = `${BASE_URL}${path}${qs ? `?${qs}` : ''}`;
  const res = await request(url, {
    method: 'POST',
    headers: buildHeaders({ uriPath: path, cookieHeader: cookie, referer }),
    body: JSON.stringify(dataObj),
    timeoutMs,
    retries: 1,
  });
  const httpErr = errorForStatus(res.status, `jimeng ${path}`);
  if (httpErr) throw httpErr;
  let json;
  try {
    json = await res.json();
  } catch {
    throw new WebaiError(`jimeng ${path}: non-JSON response`);
  }
  return checkResult(json, `jimeng ${path}`);
}

// Best-effort: top up the daily free credit when the balance is empty.
async function ensureCredit() {
  try {
    const data = await apiPost(CREDIT_PATH, {}, { noDefaultParams: true, referer: `${BASE_URL}/ai-tool/image/generate` });
    const c = data?.credit || {};
    const total = (c.gift_credit || 0) + (c.purchase_credit || 0) + (c.vip_credit || 0);
    if (total <= 0) {
      await apiPost(RECEIVE_PATH, { time_zone: 'Asia/Shanghai' }, { referer: `${BASE_URL}/ai-tool/home` });
    }
  } catch {
    // Non-fatal: proceed and let generate surface a real quota error.
  }
}

export async function generateImage(prompt, opts = {}) {
  const { model: userModelIn, ratio = '1:1', resolution = '2k', sampleStrength = 0.5, negativePrompt = '' } = opts;
  const { userModel, model } = resolveModel(userModelIn);
  const res = resolveResolution(resolution, ratio);

  await ensureCredit();

  const submitId = uuid();
  const componentId = uuid();
  const coreParam = buildCoreParam({
    userModel,
    model,
    prompt,
    negativePrompt,
    seed: Math.floor(Math.random() * 1e8) + 2_500_000_000,
    sampleStrength,
    resolution: res,
  });
  const draftContent = buildDraftContent({ componentId, coreParam });
  const metricsExtra = buildMetricsExtra({ model, submitId, resolutionType: res.resolutionType });
  const requestData = buildGenerateRequest({ model, submitId, draftContent, metricsExtra });

  const data = await apiPost(GENERATE_PATH, requestData, { referer: IMAGE_REFERER });
  const historyId = data?.aigc_data?.history_record_id;
  if (!historyId) throw new WebaiError('jimeng: no history_record_id in generate response (protocol drift?).');

  const urls = await pollImages(historyId);
  if (!urls.length) throw new WebaiError('jimeng: generation finished but no image URL was produced.');
  return { images: urls.map((url) => ({ url })), meta: { historyId, model: userModel } };
}

async function pollImages(historyId, { timeoutMs = 300_000, intervalMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const data = await apiPost(HISTORY_PATH, { history_ids: [historyId], image_info: pollImageInfo() });
    const info = data?.[historyId];
    if (!info) throw new WebaiError('jimeng: history record not found while polling.');
    const status = info.status;
    const urls = extractImageUrls(info.item_list || []);
    if (status === STATUS.FAILED) {
      throw new WebaiError(`jimeng generation failed (status 30, failCode=${info.fail_code || '?'}).`);
    }
    if ((status === STATUS.SUCCESS || status === STATUS.COMPLETED) && urls.length) return urls;
    if (Date.now() > deadline) {
      if (urls.length) return urls;
      throw new WebaiError('jimeng: timed out waiting for image generation.');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const VIDEO_REFERER = `${BASE_URL}/ai-tool/generate?type=video`;

export async function submitVideo(prompt, opts = {}) {
  const { model: userModelIn, ratio = '16:9', duration = 5 } = opts;
  const { userModel, model } = resolveVideoModel(userModelIn);
  const { ms, s } = videoDurationMs(model, duration);

  await ensureCredit();

  const submitId = uuid();
  const componentId = uuid();
  const metricsExtra = buildVideoMetricsExtra({ model, originSubmitId: uuid(), videoDuration: s });
  const draftContent = buildVideoDraftContent({ componentId, prompt, model, ratio, durationMs: ms, metricsExtra });
  const requestData = buildVideoRequest({ model, submitId, draftContent, metricsExtra });

  const data = await apiPost(GENERATE_PATH, requestData, { referer: VIDEO_REFERER });
  const historyId = data?.aigc_data?.history_record_id;
  if (!historyId) throw new WebaiError('jimeng: no history_record_id in video submit response (protocol drift?).');
  return { jobId: historyId, meta: { model: userModel, duration: s }, video: null };
}

export async function pollVideo(jobId) {
  const data = await apiPost(HISTORY_PATH, { history_ids: [jobId] });
  const info = data?.[jobId];
  if (!info) throw new WebaiError('jimeng: video history record not found while polling.');
  const status = info.status;
  if (status === STATUS.FAILED) {
    return { status: 'failed', reason: `status 30, failCode=${info.fail_code || '?'}` };
  }
  const item = (info.item_list || [])[0];
  const url = item ? extractVideoUrl(item) : null;
  if ((status === STATUS.SUCCESS || status === STATUS.COMPLETED) && url) {
    return { status: 'ready', video: { url } };
  }
  return { status: 'pending' };
}

// Jimeng CDN images are plain-HTTP downloadable (no browser-binding like Google).
export async function download(url, destPath) {
  mkdirSync(dirname(destPath), { recursive: true });
  const res = await request(url, { timeoutMs: 120_000, retries: 2 });
  if (res.status !== 200) {
    const err = errorForStatus(res.status, `jimeng download ${res.status}`);
    throw err || new WebaiError(`jimeng download unexpected HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
  return destPath;
}

export const jimeng = { id: 'jimeng', generateImage, submitVideo, pollVideo, download };
export default jimeng;
