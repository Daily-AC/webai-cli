// Normalize Hunyuan 3D creation records.
//
// A creation is a job (one id, one status) that carries `count` results. Each
// result's downloadable files live under `urlResult`, whose keys vary by
// pipeline: mesh jobs expose glb/obj/gif/png, animation jobs expose glb/fbx,
// panorama/scene jobs expose image_url/ply/video, and geometry-only stages hide
// their preview under intermediate_outputs.geometry.
import { STATUS } from './reqbuild.js';

const FILE_KEYS = [
  ['glb', ['glb', 'glb_url', 'model_url']],
  ['fbx', ['fbx', 'fbx_url']],
  ['obj', ['obj', 'obj_url']],
  ['ply', ['ply', 'ply_url']],
  ['usdz', ['usdz', 'usdz_url']],
  ['gif', ['gif', 'gif_url']],
  ['png', ['png', 'png_url']],
  ['image', ['image_url', 'super_resolution_image_url', 'cover_image_url', 'coverImage']],
  ['video', ['video_url', 'mp4', 'video']],
];

function firstString(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

export function normalizeResult(result = {}) {
  const url = result.urlResult || {};
  const geometry = result.intermediate_outputs?.geometry || {};
  const files = {};
  for (const [name, keys] of FILE_KEYS) {
    const value = firstString(url, keys) || firstString(geometry, keys);
    if (value) files[name] = value;
  }
  const bone = result.boneBindingData || url.boneBindingData;
  if (bone && typeof bone === 'object') {
    if (bone.fbx && !files.fbx) files.fbx = bone.fbx;
    if (bone.glb && !files.glb) files.glb = bone.glb;
  }
  return {
    assetId: result.assetId || result.asset_id || null,
    status: result.status || null,
    files,
    positionInfo: url.position_info || null,
    boneBindingData: bone && typeof bone === 'object' ? bone : null,
  };
}

export function normalizeCreation(raw = {}) {
  const results = Array.isArray(raw.result) ? raw.result.map(normalizeResult) : [];
  return {
    id: raw.id || raw.creationsId || null,
    status: raw.status || null,
    sceneType: raw.sceneType || null,
    modelType: raw.modelType || null,
    motionType: raw.motionType ?? null,
    prompt: raw.prompt || '',
    title: raw.title || '',
    count: raw.n ?? results.length,
    createTime: raw.createTime || raw.create_time || null,
    failCode: raw.failCode ?? raw.failedCode ?? null,
    message: raw.message || raw.errorMsg || '',
    results,
  };
}

export function isTerminal(status) {
  return status === STATUS.SUCCESS || status === STATUS.FAIL;
}

// Preferred download for a finished creation: an explicit kind if asked for,
// otherwise the richest 3D payload available, then a preview.
export const DEFAULT_KIND_ORDER = ['glb', 'fbx', 'obj', 'ply', 'video', 'gif', 'image', 'png'];

export function pickFile(creation, { kind, index = 0 } = {}) {
  const result = creation.results?.[index];
  if (!result) return null;
  const order = kind ? [kind] : DEFAULT_KIND_ORDER;
  for (const name of order) {
    if (result.files[name]) return { kind: name, url: result.files[name], assetId: result.assetId };
  }
  return null;
}
