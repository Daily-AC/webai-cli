// Jimeng (即梦, jimeng.jianying.com) request builders + constants.
// Protocol ported from iptag/jimeng-api (src/api/consts/common.ts,
// src/api/builders/payload-builder.ts). CN region only for now.
import crypto from 'node:crypto';

export const BASE_URL = 'https://jimeng.jianying.com';
export const AID = 513695; // DEFAULT_ASSISTANT_ID_CN
export const PLATFORM_CODE = '7';
export const VERSION_CODE = '8.4.0'; // Appvr — drift-prone, pin to reference
export const APP_SDK_VERSION = '48.0.0';
export const WEB_VERSION = '7.5.0';
export const DA_VERSION = '3.3.9';
export const DRAFT_VERSION = '3.3.9';
export const DRAFT_MIN_VERSION = '3.0.2';
export const AIGC_FEATURES = 'app_lip_sync';

export const DEFAULT_IMAGE_MODEL = 'jimeng-4.5';
export const IMAGE_MODEL_MAP = {
  'jimeng-5.0': 'high_aes_general_v50',
  'jimeng-4.6': 'high_aes_general_v42',
  'jimeng-4.5': 'high_aes_general_v40l',
  'jimeng-4.1': 'high_aes_general_v41',
  'jimeng-4.0': 'high_aes_general_v40',
  'jimeng-3.1': 'high_aes_general_v30l_art_fangzhou:general_v3.0_18b',
  'jimeng-3.0': 'high_aes_general_v30l:general_v3.0_18b',
};

// STATUS_CODE_MAP: 10=SUCCESS, 20=PROCESSING, 30=FAILED, 42/45=processing, 50=COMPLETED
export const STATUS = { SUCCESS: 10, PROCESSING: 20, FAILED: 30, COMPLETED: 50 };

// resolution → ratio table (subset: 1k/2k). ratio codes match the web client.
export const RESOLUTION_OPTIONS = {
  '1k': {
    '1:1': { width: 1024, height: 1024, ratio: 1 },
    '4:3': { width: 768, height: 1024, ratio: 4 },
    '3:4': { width: 1024, height: 768, ratio: 2 },
    '16:9': { width: 1024, height: 576, ratio: 3 },
    '9:16': { width: 576, height: 1024, ratio: 5 },
    '3:2': { width: 1024, height: 682, ratio: 7 },
    '2:3': { width: 682, height: 1024, ratio: 6 },
    '21:9': { width: 1195, height: 512, ratio: 8 },
  },
  '2k': {
    '1:1': { width: 2048, height: 2048, ratio: 1 },
    '4:3': { width: 2304, height: 1728, ratio: 4 },
    '3:4': { width: 1728, height: 2304, ratio: 2 },
    '16:9': { width: 2560, height: 1440, ratio: 3 },
    '9:16': { width: 1440, height: 2560, ratio: 5 },
    '3:2': { width: 2496, height: 1664, ratio: 7 },
    '2:3': { width: 1664, height: 2496, ratio: 6 },
    '21:9': { width: 3024, height: 1296, ratio: 8 },
  },
};

export function uuid(withDashes = true) {
  const u = crypto.randomUUID();
  return withDashes ? u : u.replace(/-/g, '');
}

export function resolveModel(userModel = DEFAULT_IMAGE_MODEL) {
  const model = IMAGE_MODEL_MAP[userModel] ? userModel : DEFAULT_IMAGE_MODEL;
  return { userModel: model, model: IMAGE_MODEL_MAP[model] };
}

export function resolveResolution(resolution = '2k', ratio = '1:1') {
  const group = RESOLUTION_OPTIONS[resolution] || RESOLUTION_OPTIONS['2k'];
  const cfg = group[ratio] || group['1:1'];
  return { width: cfg.width, height: cfg.height, imageRatio: cfg.ratio, resolutionType: RESOLUTION_OPTIONS[resolution] ? resolution : '2k' };
}

// core_param for text-to-image (mode text2img).
export function buildCoreParam({ userModel, model, prompt, negativePrompt = '', seed, sampleStrength = 0.5, resolution, intelligentRatio = false }) {
  const effectiveIntelligent = ['jimeng-4.0', 'jimeng-4.1', 'jimeng-4.5', 'jimeng-4.6', 'jimeng-5.0'].includes(userModel)
    ? intelligentRatio
    : false;
  const coreParam = {
    type: '',
    id: uuid(),
    model,
    prompt,
    sample_strength: sampleStrength,
    large_image_info: {
      type: '',
      id: uuid(),
      min_version: DRAFT_MIN_VERSION,
      height: resolution.height,
      width: resolution.width,
      resolution_type: resolution.resolutionType,
    },
    intelligent_ratio: effectiveIntelligent,
  };
  if (!effectiveIntelligent) coreParam.image_ratio = resolution.imageRatio;
  coreParam.negative_prompt = negativePrompt;
  if (seed !== undefined) coreParam.seed = seed;
  return coreParam;
}

export function buildMetricsExtra({ model, submitId, resolutionType }) {
  const sceneOption = {
    type: 'image',
    scene: 'ImageBasicGenerate',
    modelReqKey: model,
    resolutionType,
    abilityList: [],
    reportParams: {
      enterSource: 'generate',
      vipSource: 'generate',
      extraVipFunctionKey: `${model}-${resolutionType}`,
      useVipFunctionDetailsReporterHoc: true,
    },
    benefitCount: 4,
  };
  return JSON.stringify({
    promptSource: 'custom',
    generateCount: 1,
    enterFrom: 'click',
    sceneOptions: JSON.stringify([sceneOption]),
    generateId: submitId,
    isRegenerate: false,
  });
}

// draft_content for text-to-image (generate_type "generate").
export function buildDraftContent({ componentId, coreParam }) {
  const abilities = {
    type: '',
    id: uuid(),
    generate: {
      type: '',
      id: uuid(),
      core_param: coreParam,
      gen_option: { type: '', id: uuid(), generate_all: false },
    },
  };
  return JSON.stringify({
    type: 'draft',
    id: uuid(),
    min_version: DRAFT_MIN_VERSION,
    min_features: [],
    is_from_tsn: true,
    version: DRAFT_VERSION,
    main_component_id: componentId,
    component_list: [
      {
        type: 'image_base_component',
        id: componentId,
        min_version: DRAFT_MIN_VERSION,
        aigc_mode: 'workbench',
        metadata: {
          type: '',
          id: uuid(),
          created_platform: 3,
          created_platform_version: '',
          created_time_in_ms: Date.now().toString(),
          created_did: '',
        },
        generate_type: 'generate',
        abilities,
      },
    ],
  });
}

export function buildGenerateRequest({ model, submitId, draftContent, metricsExtra }) {
  return {
    extend: { root_model: model },
    submit_id: submitId,
    metrics_extra: metricsExtra,
    draft_content: draftContent,
    http_common_info: { aid: AID },
  };
}

// Default query params on every non-commerce API call (CN).
export function defaultQuery(webId) {
  return {
    aid: AID,
    device_platform: 'web',
    region: 'cn',
    webId,
    da_version: DA_VERSION,
    os: 'windows',
    web_component_open_flag: 1,
    web_version: WEB_VERSION,
    aigc_features: AIGC_FEATURES,
  };
}

// ---------- video (text-to-video) ----------
export const DEFAULT_VIDEO_MODEL = 'jimeng-video-3.5-pro';
export const VIDEO_MODEL_MAP = {
  'jimeng-video-seedance-2.0': 'dreamina_seedance_40_pro',
  'jimeng-video-seedance-2.0-fast': 'dreamina_seedance_40',
  'jimeng-video-3.5-pro': 'dreamina_ic_generate_video_model_vgfm_3.5_pro',
  'jimeng-video-3.0-pro': 'dreamina_ic_generate_video_model_vgfm_3.0_pro',
  'jimeng-video-3.0': 'dreamina_ic_generate_video_model_vgfm_3.0',
  'jimeng-video-3.0-fast': 'dreamina_ic_generate_video_model_vgfm_3.0_fast',
  'jimeng-video-2.0': 'dreamina_ic_generate_video_model_vgfm_lite',
  'jimeng-video-2.0-pro': 'dreamina_ic_generate_video_model_vgfm1.0',
};

export function resolveVideoModel(userModel = DEFAULT_VIDEO_MODEL) {
  const key = VIDEO_MODEL_MAP[userModel] ? userModel : DEFAULT_VIDEO_MODEL;
  return { userModel: key, model: VIDEO_MODEL_MAP[key] };
}

// benefit_type from the mapped model id (getVideoBenefitType in videos.ts).
export function videoBenefitType(model) {
  if (model.includes('veo3.1')) return 'generate_video_veo3.1';
  if (model.includes('veo3')) return 'generate_video_veo3';
  if (model.includes('sora2')) return 'generate_video_sora2';
  if (model.includes('40_pro')) return 'dreamina_video_seedance_20_pro';
  if (model.includes('40')) return 'dreamina_seedance_20_fast';
  if (model.includes('3.5_pro')) return 'dreamina_video_seedance_15_pro';
  if (model.includes('3.5')) return 'dreamina_video_seedance_15';
  return 'basic_video_operation_vgfm_v_three';
}

// Duration → ms. 3.5-pro supports 5/10/12 (default 5).
export function videoDurationMs(model, duration = 5) {
  if (model.includes('3.5_pro')) {
    if (duration === 12) return { ms: 12000, s: 12 };
    if (duration === 10) return { ms: 10000, s: 10 };
    return { ms: 5000, s: 5 };
  }
  return duration === 10 ? { ms: 10000, s: 10 } : { ms: 5000, s: 5 };
}

function commerceInfo(benefitType) {
  return { benefit_type: benefitType, resource_id: 'generate_video', resource_id_type: 'str', resource_sub_type: 'aigc' };
}

export function buildVideoMetricsExtra({ model, originSubmitId, videoDuration }) {
  const sceneOption = {
    type: 'video',
    scene: 'BasicVideoGenerateButton',
    modelReqKey: model,
    videoDuration,
    materialTypes: [],
    reportParams: {
      enterSource: 'generate',
      vipSource: 'generate',
      extraVipFunctionKey: model,
      useVipFunctionDetailsReporterHoc: true,
    },
  };
  return JSON.stringify({
    promptSource: 'custom',
    isDefaultSeed: 1,
    originSubmitId,
    isRegenerate: false,
    enterFrom: 'use_bgimage_prompt',
    position: 'page_bottom_box',
    functionMode: 'first_last_frames',
    sceneOptions: JSON.stringify([sceneOption]),
  });
}

export function buildVideoDraftContent({ componentId, prompt, model, ratio, durationMs, metricsExtra }) {
  return JSON.stringify({
    type: 'draft',
    id: uuid(),
    min_version: '3.0.5',
    min_features: [],
    is_from_tsn: true,
    version: DRAFT_VERSION,
    main_component_id: componentId,
    component_list: [
      {
        type: 'video_base_component',
        id: componentId,
        min_version: '1.0.0',
        aigc_mode: 'workbench',
        metadata: {
          type: '',
          id: uuid(),
          created_platform: 3,
          created_platform_version: '',
          created_time_in_ms: Date.now().toString(),
          created_did: '',
        },
        generate_type: 'gen_video',
        abilities: {
          type: '',
          id: uuid(),
          gen_video: {
            id: uuid(),
            type: '',
            text_to_video_params: {
              type: '',
              id: uuid(),
              video_gen_inputs: [
                {
                  type: '',
                  id: uuid(),
                  min_version: '3.0.5',
                  prompt,
                  video_mode: 2,
                  fps: 24,
                  duration_ms: durationMs,
                  first_frame_image: undefined,
                  end_frame_image: undefined,
                  idip_meta_list: [],
                },
              ],
              video_aspect_ratio: ratio,
              seed: Math.floor(Math.random() * 4294967296),
              model_req_key: model,
              priority: 0,
            },
            video_task_extra: metricsExtra,
          },
        },
        process_type: 1,
      },
    ],
  });
}

export function buildVideoRequest({ model, submitId, draftContent, metricsExtra }) {
  const bt = videoBenefitType(model);
  return {
    extend: {
      root_model: model,
      m_video_commerce_info: commerceInfo(bt),
      m_video_commerce_info_list: [commerceInfo(bt)],
    },
    submit_id: submitId,
    metrics_extra: metricsExtra,
    draft_content: draftContent,
    http_common_info: { aid: AID },
  };
}

// image_info block for the get_history_by_ids poll.
export function pollImageInfo() {
  return {
    width: 2048,
    height: 2048,
    format: 'webp',
    image_scene_list: [
      { scene: 'smart_crop', width: 360, height: 360, uniq_key: 'smart_crop-w:360-h:360', format: 'webp' },
      { scene: 'smart_crop', width: 480, height: 480, uniq_key: 'smart_crop-w:480-h:480', format: 'webp' },
      { scene: 'smart_crop', width: 720, height: 720, uniq_key: 'smart_crop-w:720-h:720', format: 'webp' },
      { scene: 'normal', width: 2400, height: 2400, uniq_key: '2400', format: 'webp' },
      { scene: 'normal', width: 1080, height: 1080, uniq_key: '1080', format: 'webp' },
      { scene: 'normal', width: 720, height: 720, uniq_key: '720', format: 'webp' },
    ],
  };
}
