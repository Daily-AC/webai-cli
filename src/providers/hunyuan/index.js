// Hunyuan 3D (混元3D) provider — pure-HTTP image/text-to-3D via
// 3d.hunyuan.tencent.com. No browser: the whole surface is same-origin JSON,
// the only anti-abuse measure on submit is a reproducible query signature, and
// the produced glb/fbx/ply files sit on a COS CDN that serves plain GETs.
//
// Contract:
//   submit(mode, opts)      -> { jobId, body }
//   poll(jobId)             -> { status, creation }  (status: pending|ready|failed)
//   list(opts)              -> { total, creations }
//   quota()                 -> { remainQuota, ... }
//   bindBones({glb,image})  -> { fbx, glb, image_url }   (blocking, ~1 min)
//   uploadImage(path)       -> public COS URL
//   download(url, dest)     -> dest
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { request, errorForStatus } from '../../http/client.js';
import { getProvider, buildCookieHeader } from '../../auth/store.js';
import { AuthError, WebaiError, QuotaError, ContentRejectedError } from '../../errors.js';
import { signQuery } from './sign.js';
import { ENDPOINTS, ORIGIN, baseHeaders, buildGenerationBody, STATUS } from './reqbuild.js';
import { normalizeCreation, isTerminal, pickFile } from './parse.js';
import { putObject } from './cos.js';

const CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.fbx': 'application/octet-stream',
  '.mp4': 'video/mp4',
};

function credentials() {
  const rec = getProvider('hunyuan');
  const cookie = rec ? buildCookieHeader(rec.cookieJar || rec.cookies, { url: `${ORIGIN}/` }) : '';
  if (!/(?:^|;\s*)hunyuan_token=/.test(cookie)) {
    throw new AuthError('No Hunyuan 3D credentials found. Run: webai auth import chrome hunyuan');
  }
  const innerUserId = /(?:^|;\s*)hy_user=([^;]+)/.exec(cookie)?.[1];
  return { cookie, innerUserId };
}

function headers() {
  const { cookie, innerUserId } = credentials();
  return baseHeaders({ cookieHeader: cookie, innerUserId });
}

// Every /api/3d response is a bare JSON object; failures arrive either as an
// HTTP status or as a body carrying `code`/`message`.
async function api(url, { method = 'POST', body, signed = false, timeoutMs = 60_000 } = {}) {
  let target = url;
  if (signed) {
    const params = signQuery();
    target += (url.includes('?') ? '&' : '?') + new URLSearchParams(params).toString();
  }
  const res = await request(target, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
    retries: 1,
  });
  const text = await res.text();
  const label = `hunyuan ${new URL(url).pathname}`;
  if (res.status === 422) throw new ContentRejectedError(`${label}: content rejected by review (HTTP 422)`);
  const httpErr = errorForStatus(res.status, label, text);
  if (httpErr) throw httpErr;
  if (!text) return {};
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new WebaiError(`${label}: non-JSON response (${text.slice(0, 120)})`);
  }
  if (json && typeof json === 'object' && json.code && json.code !== 0) {
    const message = `${label} failed (code ${json.code}): ${json.message || json.msg || 'unknown'}`;
    if (/quota|次数|额度|不足/.test(message)) throw new QuotaError(message);
    throw new WebaiError(message);
  }
  return json;
}

export async function userInfo() {
  return api(ENDPOINTS.userInfo, { method: 'GET' });
}

export async function quota() {
  return api(ENDPOINTS.quota, { body: {} });
}

export async function planCredit() {
  return api(ENDPOINTS.planCredit, { method: 'GET' });
}

export async function config() {
  return api(ENDPOINTS.config, { method: 'GET', timeoutMs: 120_000 });
}

export async function submit(mode, opts = {}) {
  const body = buildGenerationBody(mode, opts);
  const data = await api(ENDPOINTS.generations, { body, signed: true });
  const jobId = data?.creationsId;
  if (!jobId) {
    throw new WebaiError(`hunyuan submit: no creationsId in response (${JSON.stringify(data).slice(0, 200)})`);
  }
  return { jobId, body };
}

export async function list({ limit = 20, offset = 0, sceneTypes = [], modelTypes = [], ids = [] } = {}) {
  const body = {};
  if (ids.length) body.creationsIdList = ids;
  else {
    body.limit = limit;
    body.offset = offset;
  }
  if (sceneTypes.length) body.sceneTypeList = sceneTypes;
  if (modelTypes.length) body.modelTypeList = modelTypes;
  const data = await api(ENDPOINTS.list, { body });
  return {
    total: data?.totalCount ?? null,
    creations: (data?.creations || []).map(normalizeCreation),
  };
}

export async function detail(jobId) {
  const data = await api(`${ENDPOINTS.detail}?creationsId=${encodeURIComponent(jobId)}`, { method: 'GET' });
  const raw = data?.creations?.[0] || data?.creation || data;
  return normalizeCreation({ id: jobId, ...raw });
}

// Poll one job. The list endpoint accepts creationsIdList and returns the same
// records as the site's own polling loop, so it is the primary path; detail is
// the fallback for ids the list filter drops.
export async function poll(jobId) {
  const { creations } = await list({ ids: [jobId] });
  let creation = creations.find((c) => c.id === jobId) || creations[0];
  if (!creation) creation = await detail(jobId);
  if (creation.status === STATUS.FAIL) {
    return {
      status: 'failed',
      creation,
      reason: creation.message || `failCode=${creation.failCode ?? '?'}`,
    };
  }
  if (creation.status === STATUS.SUCCESS) return { status: 'ready', creation };
  return { status: 'pending', creation };
}

export async function cancel(jobId) {
  return api(ENDPOINTS.cancel, { body: { creationsId: jobId } });
}

export async function remove(jobIds) {
  return api(ENDPOINTS.remove, { body: { creationsIdList: [].concat(jobIds) } });
}

// Rig a mesh: hands a glb (plus a cover image, which the site always sends) to
// the auto-rigger and returns the bound fbx/glb pair that `animate` needs.
export async function bindBones({ glb, image = '' } = {}) {
  if (!glb) throw new WebaiError('hunyuan bind: a glb URL is required');
  const data = await api(ENDPOINTS.boneBindingFromMesh, { body: { glb, image_url: image }, timeoutMs: 300_000 });
  const bound = data?.boneBindingData || data;
  if (!bound?.fbx) {
    throw new WebaiError(`hunyuan bind: no fbx in response (${JSON.stringify(data).slice(0, 200)})`);
  }
  return { fbx: bound.fbx, glb: bound.glb || glb, image_url: bound.image_url || image };
}

// Upload a local file through Hunyuan's own COS credentials and return the URL
// the generation endpoints expect in imageList / videoList.
export async function uploadFile(path) {
  const fileName = basename(path);
  const info = await api(ENDPOINTS.genUploadInfo, { body: { fileName } });
  const cosInfo = info?.data || info;
  const body = readFileSync(path);
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
  const url = await putObject(cosInfo, body, { contentType, request });
  return url;
}

export async function uploadImage(path) {
  return uploadFile(path);
}

export async function download(url, destPath) {
  mkdirSync(dirname(destPath), { recursive: true });
  const res = await request(url, { timeoutMs: 300_000, retries: 2 });
  if (res.status !== 200) {
    const err = errorForStatus(res.status, `hunyuan download ${res.status}`);
    throw err || new WebaiError(`hunyuan download unexpected HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buf);
  return destPath;
}

export const hunyuan = {
  id: 'hunyuan',
  userInfo,
  quota,
  planCredit,
  config,
  submit,
  poll,
  list,
  detail,
  cancel,
  remove,
  bindBones,
  uploadFile,
  uploadImage,
  download,
  pickFile,
  isTerminal,
};
export default hunyuan;
