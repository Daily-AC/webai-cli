// Hunyuan 3D (3d.hunyuan.tencent.com) request construction.
//
// Everything is same-origin JSON under /api/3d/. The web app sends a fixed
// header trio (x-source / x-product / cookie) and, for generations only, a
// signed query string (see sign.js).
export const ORIGIN = 'https://3d.hunyuan.tencent.com';

export const ENDPOINTS = {
  userInfo: `${ORIGIN}/api/3d/getuserinfo`,
  config: `${ORIGIN}/api/3d/config`,
  quota: `${ORIGIN}/api/3d/quotainfo`,
  planCredit: `${ORIGIN}/api/3d/planCreditInfo`,
  generations: `${ORIGIN}/api/3d/creations/generations`,
  list: `${ORIGIN}/api/3d/creations/list`,
  detail: `${ORIGIN}/api/3d/creations/detail`,
  cancel: `${ORIGIN}/api/3d/creations/cancel`,
  remove: `${ORIGIN}/api/3d/creations/delete`,
  count: `${ORIGIN}/api/3d/creations/count`,
  boneBindingFromMesh: `${ORIGIN}/api/3d/creations/boneBindingFromMesh`,
  retopologize: `${ORIGIN}/api/3d/creations/retopologize`,
  genUploadInfo: `${ORIGIN}/api/3d/resource/genUploadInfo`,
  reviewResource: `${ORIGIN}/api/3d/resource/review`,
  reviewScene: `${ORIGIN}/api/3d/worldScene/review`,
};

// sceneType — which product surface the creation belongs to.
export const SCENE = {
  model: 'playGround3D',
  modelV2: 'playGround3D-2.0',
  texture: 'textureGenerate',
  video23D: 'video23D',
  sketch: 'sketchGenerate',
  role: 'characterUGC',
  animation: '3dAnimation',
  game: 'ugcGame',
  lowPoly: 'lowPoly',
  interaction: 'interaction',
};

// modelType — which pipeline runs. Only the ones this CLI drives are named.
//
// `default` is what an ordinary (non-whitelisted) account is actually allowed to
// run: V3.5 pipelines answer "该功能暂未开放，敬请期待" on this account, and the
// pre-2.0 sceneType/modelType pairs answer "configInfo not found". Pass
// --version 3.5 explicitly to try the newer pipeline anyway.
export const MODEL = {
  text3d: { default: 'text2ModelV3.1', '3.5': 'text2ModelV3.5', '3.1': 'text2ModelV3.1', '3.0': 'modelCreationV3.0' },
  image3d: { default: 'image2ModelV3.1', '3.5': 'image2ModelV3.5', '3.1': 'image2ModelV3.1', '3.0': 'modelCreationV3.0' },
  multiview3d: {
    default: 'multiView2ModelV3.1',
    '3.5': 'multiView2ModelV3.5',
    '3.1': 'multiView2ModelV3.1',
    '3.0': 'modelMultiViewCreationV3.0',
  },
  geometryText: { default: 'text2GeometryV3.1', '3.5': 'text2GeometryV3.5', '3.1': 'text2GeometryV3.1' },
  geometryImage: { default: 'image2GeometryV3.1', '3.5': 'image2GeometryV3.5', '3.1': 'image2GeometryV3.1' },
  texture: { default: 'textureV3.1', '3.5': 'textureV3.5', '3.1': 'textureV3.1' },
  lowpolyText: { '3.1': 'text2ModelLowPolyV3.1' },
  lowpolyImage: { '3.1': 'image2ModelLowPolyV3.1' },
  sketch: { '3.1': 'modelSketchV3.1' },
  panoramaText: { '2.1': 'text2panorama-wf-v2.1', '2.0': 'text2panorama-wf-v2.0' },
  panoramaImage: { '2.1': 'image2panorama-wf-v2.1', '2.0': 'image2panorama-wf-v2.0' },
  sceneText: { '2.1': 'text2scene-wf-v2.1', '2.0': 'text2scene-wf-v2.0' },
  sceneImage: { '2.1': 'image2scene-wf-v2.1', '2.0': 'image2scene-wf-v2.0' },
  scenePanorama: { '2.1': 'panorama2scene-wf-v2.1' },
  reconstruct: { default: 'sceneReconstruction-wf' },
  animate: { default: 'actionDriven' },
};

// motionType values for modelType=actionDriven. 9-16 are confirmed from the
// site's own animation good-cases (each names its action in the preview gif).
export const MOTIONS = {
  9: 'Capoeira',
  10: 'FallingBackDeath',
  11: 'Jumping',
  12: 'Kicking',
  13: 'OneHandSwordCombo',
  15: 'TreadmillRunning',
  16: 'TwistDance',
};

export const STATUS = { WAIT: 'wait', PROCESSING: 'processing', SUCCESS: 'success', FAIL: 'fail' };

// The server validates `count` per pipeline and rejects anything else with
// "count param error" — text-to-3D always returns a 4-candidate batch, every
// other pipeline takes a single result.
export const DEFAULT_COUNT = { text: 4 };

function pickModel(table, version) {
  if (version && table[version]) return table[version];
  if (table.default) return table.default;
  const versions = Object.keys(table).sort().reverse();
  return table[versions[0]];
}

export function baseHeaders({ cookieHeader, innerUserId } = {}) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'content-type': 'application/json',
    origin: ORIGIN,
    referer: `${ORIGIN}/`,
    'x-source': 'web',
    'x-product': 'hunyuan3d',
  };
  if (cookieHeader) headers.cookie = cookieHeader;
  if (innerUserId) headers.x_hunyuan_inner_user_id = innerUserId;
  return headers;
}

// Build the JSON body for POST /api/3d/creations/generations.
//
// `mode` is the CLI-level verb; the sceneType/modelType pair and the required
// inputs follow from it. Unset optional fields are dropped rather than sent as
// null, matching the web app (its axios payloads simply omit them).
export function buildGenerationBody(mode, opts = {}) {
  const {
    prompt = '',
    title,
    images = [],
    imageTags,
    video,
    count,
    version,
    style,
    negativePrompt,
    pbr,
    lowpoly,
    faceCount,
    polygonType,
    scaleStandardization,
    modelUrl3D,
    mesh,
    motionType,
    keepUv,
    geometryCreationsId,
    geometryAssetId,
  } = opts;

  const body = { count: count ?? DEFAULT_COUNT[mode] ?? 1 };
  const setIf = (key, value) => {
    if (value !== undefined && value !== null && value !== '') body[key] = value;
  };

  switch (mode) {
    case 'text':
      body.sceneType = SCENE.modelV2;
      body.modelType = pickModel(MODEL.text3d, version);
      body.prompt = prompt;
      break;
    case 'image':
      body.sceneType = SCENE.modelV2;
      body.modelType = pickModel(images.length > 1 ? MODEL.multiview3d : MODEL.image3d, version);
      body.imageList = images;
      setIf('imageTagList', imageTags);
      setIf('prompt', prompt);
      break;
    case 'lowpoly':
      body.sceneType = SCENE.lowPoly;
      body.modelType = pickModel(images.length ? MODEL.lowpolyImage : MODEL.lowpolyText, version || '3.1');
      if (images.length) body.imageList = images;
      else body.prompt = prompt;
      break;
    case 'sketch':
      body.sceneType = SCENE.sketch;
      body.modelType = pickModel(MODEL.sketch, version || '3.1');
      body.imageList = images;
      setIf('prompt', prompt);
      break;
    case 'texture':
      body.sceneType = SCENE.texture;
      body.modelType = pickModel(MODEL.texture, version);
      setIf('prompt', prompt);
      if (images.length) body.imageList = images;
      setIf('modelUrl3D', modelUrl3D);
      setIf('keep_uv', keepUv);
      setIf('geometryCreationsId', geometryCreationsId);
      setIf('geometryAssetId', geometryAssetId);
      break;
    case 'panorama':
      body.sceneType = SCENE.interaction;
      body.modelType = pickModel(images.length ? MODEL.panoramaImage : MODEL.panoramaText, version || '2.1');
      if (images.length) body.imageList = images;
      body.prompt = prompt;
      break;
    case 'scene':
      body.sceneType = SCENE.interaction;
      body.modelType = pickModel(images.length ? MODEL.sceneImage : MODEL.sceneText, version || '2.1');
      if (images.length) body.imageList = images;
      body.prompt = prompt;
      break;
    case 'reconstruct':
      body.sceneType = SCENE.interaction;
      body.modelType = MODEL.reconstruct.default;
      if (video) body.videoList = [video];
      else body.imageList = images;
      break;
    case 'animate':
      body.sceneType = SCENE.animation;
      body.modelType = MODEL.animate.default;
      body.motionType = Number(motionType ?? 1);
      setIf('modelUrl3D', modelUrl3D);
      setIf('mesh', mesh);
      if (images.length) body.imageList = images;
      break;
    default:
      throw new Error(
        `unknown hunyuan mode "${mode}" (expected: text, image, lowpoly, sketch, texture, panorama, scene, reconstruct, animate)`
      );
  }

  setIf('title', title || (prompt ? prompt.slice(0, 60) : undefined));
  setIf('style', style);
  setIf('negativePrompt', negativePrompt);
  if (pbr !== undefined) body.enable_pbr = Boolean(pbr);
  if (lowpoly !== undefined) body.enableLowPoly = Boolean(lowpoly);
  if (scaleStandardization !== undefined) body.enableScaleStandardization = Boolean(scaleStandardization);
  setIf('faceCount', faceCount);
  setIf('polygon_type', polygonType);
  return body;
}
