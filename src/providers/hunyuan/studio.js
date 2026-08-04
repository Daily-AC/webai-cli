// Hunyuan "3D Studio" (混元3D Studio) provider — the game-asset pipeline that
// lives at 3d.hunyuan.tencent.com/studio and talks to /api/game3d/*.
//
// This is a different product from the playground surface in ./index.js: a
// separate Vite SPA (game-3d.qstatic.com) driving a node pipeline — concept →
// geometry → component split → retopology → UV → texture → **rigging** →
// animation. Same cookies, but a plain axios client: no query signature, no
// x-source/x-product headers, and an {errNo, errMsg, data} envelope. Endpoints
// that submit a job answer bare {worksId} with no envelope at all.
//
// Contract:
//   remainingTimes()                    -> number of runs left today
//   uploadModel(path)                   -> URL inside the studio's own bucket
//   convert(url, fmt)                   -> converted-asset URL (glb <-> fbx)
//   validateCharacter(fbxUrl)           -> { status }   (0 = humanoid, ok to rig)
//   rig({ model, keepBone, withBone })  -> { worksId }
//   motions()                           -> [{ uid, name, image, gif, fbx }]
//   retarget({ motionType, fbxUrl })    -> { worksId }
//   textToMotion({ prompt, duration })  -> { worksId }
//   videoToMotion({ videoUrl })         -> { worksId }
//   poll(worksId)                       -> { status, work }
//   outputsOf(work)                     -> { fbx, glb, image, ... }
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request, errorForStatus } from '../../http/client.js';
import { getProvider, buildCookieHeader } from '../../auth/store.js';
import { AuthError, WebaiError, QuotaError, ContentRejectedError } from '../../errors.js';
import { ORIGIN } from './reqbuild.js';
import { putObject } from './cos.js';

export const API = `${ORIGIN}/api`;

// worksPipeline — which node of the pipeline produced a work.
export const NODE = {
  ALL: 0,
  CONCEPT: 1,
  GEOMETRY: 2,
  COMPONENT: 3,
  POLY: 4,
  UV: 5,
  TEXTURE: 6,
  RIGGING: 7,
  ANIMATION: 8,
};

export const NODE_NAMES = {
  0: 'all',
  1: 'concept',
  2: 'geometry',
  3: 'component',
  4: 'poly',
  5: 'uv',
  6: 'texture',
  7: 'rigging',
  8: 'animation',
};

// pipelineStatus on a work record.
export const WORK_STATUS = {
  PENDING: 0,
  PROCESSING: 1,
  SUCCESS: 2,
  FAILED: 3,
  CANCEL: 4,
  DELETED: 5,
};

export const WORK_STATUS_NAMES = {
  0: 'pending',
  1: 'processing',
  2: 'success',
  3: 'failed',
  4: 'cancel',
  5: 'deleted',
};

export const ENDPOINTS = {
  whitelist: '/new-portal/whitelist/query',
  remainingTimes: '/game3d/general_info/get_remaining_times',
  worksList: '/game3d/general_info/get_works_list',
  deleteWorks: '/game3d/general_info/delete_works',
  motionCase: '/game3d/general_info/get_motion_case',
  goodCase: '/game3d/general_info/get_good_case',
  upload: '/game3d/resource/upload',
  convert: '/game3d/resource/format_conversions',
  characterValidate: '/game3d/resource/character_validations',
  rig: '/game3d/bone_skinning/bone_skinning',
  retarget: '/game3d/motion_retarget/motion_retarget',
  text2motion: '/game3d/motion_generation/text2motion',
  video2motion: '/game3d/motion_generation/video2motion',
};

// The rigging node refuses anything heavier than this; the web UI greys the
// button out rather than letting the job fail server-side.
export const MAX_RIG_FACES = 500_000;

const CONTENT_TYPES = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream',
  '.obj': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
};

function credentials() {
  const rec = getProvider('hunyuan');
  const cookie = rec ? buildCookieHeader(rec.cookieJar || rec.cookies, { url: `${ORIGIN}/` }) : '';
  if (!/(?:^|;\s*)hunyuan_token=/.test(cookie)) {
    throw new AuthError('No Hunyuan 3D credentials found. Run: webai auth import chrome hunyuan');
  }
  return { cookie, innerUserId: /(?:^|;\s*)hy_user=([^;]+)/.exec(cookie)?.[1] };
}

function headers(referer = '/studio/creation/role/rs') {
  const { cookie, innerUserId } = credentials();
  const h = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'content-type': 'application/json',
    origin: ORIGIN,
    referer: ORIGIN + referer,
    cookie,
  };
  if (innerUserId) h.x_hunyuan_inner_user_id = innerUserId;
  return h;
}

// Error numbers observed on the live API. 200010 is a moderation verdict on the
// submitted asset URL, not a parameter problem.
const ERR = {
  BAD_PARAMS: new Set([200001, 200002]),
  NOT_HUMANOID: 200004,
  REJECTED: 200010,
};

// Every game3d call is a POST with a JSON body; the client-side axios adds a
// requestId to each one, and the server echoes it back on job submissions.
export async function api(path, body = {}, { timeoutMs = 600_000, referer } = {}) {
  const res = await request(API + path, {
    method: 'POST',
    headers: headers(referer),
    body: JSON.stringify({ ...body, requestId: randomUUID() }),
    timeoutMs,
    retries: 1,
  });
  const text = await res.text();
  const label = `hunyuan studio ${path}`;
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    const httpErr = errorForStatus(res.status, label, text);
    if (httpErr) throw httpErr;
    throw new WebaiError(`${label}: non-JSON response (${text.slice(0, 120)})`);
  }
  const errNo = json?.errNo;
  if (errNo !== undefined && errNo !== 0) {
    const message = `${label} failed (errNo ${errNo}): ${json.errMsg || 'unknown'}`;
    if (errNo === ERR.REJECTED) throw new ContentRejectedError(message);
    if (errNo === ERR.NOT_HUMANOID) {
      throw new WebaiError(`${label}: the model is not a standard humanoid — rigging only accepts A/T-pose characters`);
    }
    if (ERR.BAD_PARAMS.has(errNo)) {
      throw new WebaiError(`${message} (the asset URL must live in the studio's own bucket — upload it first)`);
    }
    if (/quota|次数|额度|不足/.test(message)) throw new QuotaError(message);
    throw new WebaiError(message);
  }
  const httpErr = errorForStatus(res.status, label, text);
  if (httpErr) throw httpErr;
  // Job submissions answer bare {worksId,…}; everything else wraps in {data}.
  return json?.data !== undefined ? json.data : json;
}

export async function whitelist() {
  return api(ENDPOINTS.whitelist, { business: '3dgame', scene: 'all' }, { timeoutMs: 60_000 });
}

export async function remainingTimes() {
  const data = await api(ENDPOINTS.remainingTimes, {}, { timeoutMs: 60_000 });
  return data?.remainingTimes ?? null;
}

// A work's inputInfo arrives as a JSON string; the rest of the record is plain.
export function normalizeWork(raw = {}) {
  let inputInfo = raw.inputInfo;
  if (typeof inputInfo === 'string') {
    try {
      inputInfo = JSON.parse(inputInfo);
    } catch {
      /* leave as-is */
    }
  }
  return {
    worksId: raw.worksId || null,
    status: raw.pipelineStatus ?? raw.status ?? null,
    statusName: WORK_STATUS_NAMES[raw.pipelineStatus ?? raw.status] || 'unknown',
    node: raw.worksPipeline ?? null,
    nodeName: NODE_NAMES[raw.worksPipeline] || String(raw.worksPipeline ?? ''),
    nodeList: raw.nodeList || [],
    workFlow: raw.workFlow || raw.model || '',
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
    estimatedTimeCost: raw.estimatedTimeCost ?? null,
    dependsOn: raw.dependonWorksInfo?.dependOnWorksId || '',
    errorCode: raw.modelInfo?.errorCode ?? 0,
    errorMsg: raw.modelInfo?.errorMsg || '',
    inputInfo,
    files: outputsOf(raw),
    raw,
  };
}

// Collect the downloadable URLs a finished work exposes, whichever node made it.
export function outputsOf(raw = {}) {
  const info = raw.modelInfo || {};
  const files = {};
  const put = (kind, url) => {
    if (typeof url === 'string' && url && !files[kind]) files[kind] = url;
  };
  put('fbx', info.boneSkinningRsp?.rigFbxUrl);
  put('image', info.boneSkinningRsp?.rigImageUrl);
  put('fbx', info.motionRetargetRsp?.fbxUrl);
  put('image', info.motionRetargetRsp?.imageUrl);
  put('fbx', info.motionGenerationRsp?.fbxUrl);
  put('glb', info.lowPolyTopologyRsp?.glbUrl);
  put('glb', info.texturePaintingRsp?.glbUrl);
  put('glb', info.uvUnwrappingRsp?.glbUrl);
  put('glb', info.geometryGenerationRsp?.glbUrl);
  put('image', info.conceptDesignRsp?.imageUrl);
  return files;
}

export async function worksList({ node, ids = [], status, limit, offset } = {}) {
  const body = {};
  if (ids.length) body.worksIds = ids;
  if (node !== undefined && node !== null) body.worksPipeline = node;
  if (status !== undefined && status !== null) body.pipelineStatus = status;
  if (limit !== undefined) body.limit = limit;
  if (offset !== undefined) body.offset = offset;
  const data = await api(ENDPOINTS.worksList, body, { timeoutMs: 120_000 });
  return {
    total: data?.total ?? null,
    works: (data?.list || []).map(normalizeWork),
  };
}

export async function work(worksId) {
  const { works } = await worksList({ ids: [worksId] });
  return works.find((w) => w.worksId === worksId) || works[0] || null;
}

export async function poll(worksId) {
  const found = await work(worksId);
  if (!found) return { status: 'pending', work: null };
  if (found.status === WORK_STATUS.SUCCESS) return { status: 'ready', work: found };
  if (found.status === WORK_STATUS.FAILED || found.status === WORK_STATUS.CANCEL) {
    return {
      status: 'failed',
      work: found,
      reason: found.errorMsg || `errorCode=${found.errorCode}`,
    };
  }
  return { status: 'pending', work: found };
}

export async function deleteWorks(ids) {
  return api(ENDPOINTS.deleteWorks, { worksIds: [].concat(ids) }, { timeoutMs: 60_000 });
}

// The pipeline only accepts assets it hosts itself: an arbitrary URL — even one
// on Hunyuan's own playground CDN — is answered with "输入参数错误". Uploading
// goes through temporary COS credentials, same mechanism as the playground.
export async function uploadModel(path) {
  const info = await api(ENDPOINTS.upload, { fileName: basename(path) }, { timeoutMs: 120_000 });
  if (!info?.location) {
    throw new WebaiError(`hunyuan studio upload: no COS credentials in response (${JSON.stringify(info).slice(0, 200)})`);
  }
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
  const url = await putObject(
    { ...info, bucketName: info.bucket, expiredTime: info.expireTime },
    readFileSync(path),
    { contentType, request }
  );
  return info.resourceUrl || url;
}

// Server-side format conversion. The request field is named after the *source*
// format, so a glb source is sent as glbUrl and an fbx source as fbxUrl.
export async function convert(url, fmt = 'fbx') {
  const source = /\.fbx(\?|$)/i.test(url) ? { fbxUrl: url } : { glbUrl: url };
  const data = await api(ENDPOINTS.convert, { ...source, fmt }, { timeoutMs: 300_000 });
  const out = data?.rspUrl;
  if (!out) throw new WebaiError(`hunyuan studio convert: no rspUrl in response (${JSON.stringify(data).slice(0, 200)})`);
  return out;
}

// status 0 means "humanoid, safe to rig". A non-humanoid answers errNo 200004,
// which api() has already turned into a readable error.
export async function validateCharacter(fbxUrl) {
  return api(ENDPOINTS.characterValidate, { fbxUrl }, { timeoutMs: 300_000 });
}

// Auto-rig: predicts a 28-bone Mixamo-named humanoid skeleton and skins the mesh.
// `withBone` tells the server the input already carries a skeleton; `keepBone`
// then decides whether to preserve it instead of predicting a fresh one.
export async function rig({ fbxUrl, withBone = false, keepBone = false, dependOnWorksId = '' } = {}) {
  if (!fbxUrl) throw new WebaiError('hunyuan studio rig: an fbx URL is required');
  const data = await api(ENDPOINTS.rig, {
    fbxUrl,
    isWithBone: Boolean(withBone),
    isKeepBone: Boolean(keepBone),
    dependOnWorksId,
  });
  const worksId = data?.worksId;
  if (!worksId) throw new WebaiError(`hunyuan studio rig: no worksId in response (${JSON.stringify(data).slice(0, 200)})`);
  return { worksId };
}

// The built-in action library. `uid` is what retarget() wants as motionType.
export async function motions() {
  const data = await api(ENDPOINTS.motionCase, {}, { timeoutMs: 120_000 });
  return (data?.motionRetarget || []).map((m) => ({
    uid: m.m_uid,
    id: m.m_id,
    name: m.m_name,
    image: m.m_image_url,
    gif: m.m_gif_url,
    fbx: m.m_fbx_url,
  }));
}

export async function retarget({ motionType, fbxUrl, dependOnWorksId = '', imageUrl = '' } = {}) {
  if (!motionType) throw new WebaiError('hunyuan studio animate: a motion uid is required');
  const data = await api(ENDPOINTS.retarget, { motionType, fbxUrl, dependOnWorksId, imageUrl });
  const worksId = data?.worksId;
  if (!worksId) throw new WebaiError(`hunyuan studio animate: no worksId in response (${JSON.stringify(data).slice(0, 200)})`);
  return { worksId };
}

// Prompt-driven animation. disableRewrite=false lets the server rewrite a
// Chinese prompt into its English canonical form and infer the duration.
export async function textToMotion({ prompt, duration, disableRewrite = false, retargetFbx, dependOnWorksId = '' } = {}) {
  if (!prompt) throw new WebaiError('hunyuan studio animate: a prompt is required');
  const body = { textPrompt: prompt, disableRewrite: Boolean(disableRewrite), dependOnWorksId };
  if (duration !== undefined) body.duration = Number(duration);
  if (retargetFbx) body.retargetFbx = retargetFbx;
  const data = await api(ENDPOINTS.text2motion, body);
  const worksId = data?.worksId;
  if (!worksId) throw new WebaiError(`hunyuan studio animate: no worksId in response (${JSON.stringify(data).slice(0, 200)})`);
  return { worksId };
}

export async function videoToMotion({ videoUrl, retargetFbx, dependOnWorksId = '' } = {}) {
  if (!videoUrl) throw new WebaiError('hunyuan studio animate: a video URL is required');
  const body = { videoUrl, dependOnWorksId };
  if (retargetFbx) body.retargetFbx = retargetFbx;
  const data = await api(ENDPOINTS.video2motion, body);
  const worksId = data?.worksId;
  if (!worksId) throw new WebaiError(`hunyuan studio animate: no worksId in response (${JSON.stringify(data).slice(0, 200)})`);
  return { worksId };
}

export async function download(url, destPath) {
  mkdirSync(dirname(destPath), { recursive: true });
  const res = await request(url, { timeoutMs: 600_000, retries: 2 });
  if (res.status !== 200) {
    const err = errorForStatus(res.status, `hunyuan studio download ${res.status}`);
    throw err || new WebaiError(`hunyuan studio download unexpected HTTP ${res.status}`);
  }
  writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
  return destPath;
}

// Count triangles in a .glb without a full parser: the JSON chunk lists every
// primitive's index accessor, and each accessor's count is the index count.
// Used as a preflight so an over-budget mesh does not burn a generation credit.
export function glbTriangleCount(path) {
  if (extname(path).toLowerCase() !== '.glb') return null;
  const buf = readFileSync(path);
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) return null;
  const jsonLength = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) return null;
  let doc;
  try {
    doc = JSON.parse(buf.subarray(20, 20 + jsonLength).toString('utf8'));
  } catch {
    return null;
  }
  let triangles = 0;
  for (const mesh of doc.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const mode = prim.mode ?? 4;
      if (mode !== 4) continue; // TRIANGLES only
      const accessor =
        prim.indices !== undefined
          ? doc.accessors?.[prim.indices]
          : doc.accessors?.[prim.attributes?.POSITION];
      if (accessor?.count) triangles += Math.floor(accessor.count / 3);
    }
  }
  return triangles;
}

export const studio = {
  id: 'hunyuan-studio',
  NODE,
  NODE_NAMES,
  WORK_STATUS,
  WORK_STATUS_NAMES,
  MAX_RIG_FACES,
  api,
  whitelist,
  remainingTimes,
  worksList,
  work,
  poll,
  deleteWorks,
  uploadModel,
  convert,
  validateCharacter,
  rig,
  motions,
  retarget,
  textToMotion,
  videoToMotion,
  outputsOf,
  normalizeWork,
  download,
  glbTriangleCount,
};
export default studio;
