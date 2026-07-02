// Pure request builders for the Gemini BardFrontendService.
//
// Faithfully ported from HanaokaYuzu/Gemini-API (`client.py::_generate`,
// `constants.py`). The StreamGenerate request is a form POST whose `f.req`
// carries a 69-slot inner array. Plain image/video generation does NOT include
// the deep-research `!<blob>` anti-abuse token (P0-verified) — that slot is only
// filled for deep research.
import { randomUUID } from 'node:crypto';

export const ENDPOINTS = {
  INIT: 'https://gemini.google.com/app',
  GENERATE:
    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
  BATCH_EXEC: 'https://gemini.google.com/_/BardChatUi/data/batchexecute',
  ROTATE_COOKIES: 'https://accounts.google.com/RotateCookies',
};

export const GRPC = {
  READ_CHAT: 'hNvQHb',
  LIST_CHATS: 'MaZiqc',
};

// constants.py: STREAMING_FLAG_INDEX = 7
const STREAMING_FLAG_INDEX = 7;
// constants.py: DEFAULT_METADATA
export const DEFAULT_METADATA = ['', '', '', null, null, null, null, null, null, ''];

export const MODEL_HEADER_KEY = 'x-goog-ext-525001261-jspb';

// constants.py::build_model_header — only needed when pinning a specific model.
// Plain generation routes by prompt (UNSPECIFIED), so callers usually omit this.
export function buildModelHeader(modelId, capacityTail) {
  return {
    [MODEL_HEADER_KEY]: `[1,null,null,null,"${modelId}",null,null,0,[4],null,null,${capacityTail}]`,
    'x-goog-ext-73010989-jspb': '[0]',
    'x-goog-ext-73010990-jspb': '[0]',
  };
}

// Build the 69-slot inner request array (client.py::_generate).
export function buildInner({
  prompt,
  language = 'en',
  metadata = DEFAULT_METADATA,
  reqFileData = null,
  uuid = randomUUID().toUpperCase(),
} = {}) {
  if (!prompt) throw new Error('reqbuild: prompt is required');

  const messageContent = [prompt, 0, null, reqFileData, null, null, 0];

  const inner = new Array(69).fill(null);
  inner[0] = messageContent;
  inner[1] = [language];
  inner[2] = metadata;
  inner[6] = [1];
  inner[STREAMING_FLAG_INDEX] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[0]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [1];
  inner[53] = 0;
  inner[59] = uuid;
  inner[61] = [];
  inner[68] = 2;

  return inner;
}

// f.req = [null, JSON(inner)]  (client.py request_data)
export function buildFreq(inner) {
  return JSON.stringify([null, JSON.stringify(inner)]);
}

// application/x-www-form-urlencoded body: f.req + at (SNlM0e access token).
export function buildGenerateBody({ prompt, at, language, metadata, uuid, reqFileData } = {}) {
  if (!at) throw new Error('reqbuild: access token (at / SNlM0e) is required');
  const usedUuid = uuid || randomUUID().toUpperCase();
  const inner = buildInner({ prompt, language, metadata, reqFileData, uuid: usedUuid });
  const params = new URLSearchParams();
  params.set('f.req', buildFreq(inner));
  params.set('at', at);
  return { body: params.toString(), uuid: usedUuid };
}

// Query string for the StreamGenerate POST.
export function buildGenerateQuery({ bl, reqid, language = 'en', sessionId } = {}) {
  const q = new URLSearchParams();
  q.set('rt', 'c');
  q.set('_reqid', String(reqid));
  if (bl) q.set('bl', bl);
  q.set('hl', language);
  if (sessionId) q.set('f.sid', sessionId);
  return q.toString();
}

// Headers for the generate request. `x-goog-ext-525005358-jspb` echoes the same
// uuid placed in inner[59]; model headers are spread in for pinned models.
export function buildGenerateHeaders({ uuid, modelHeader = {} } = {}) {
  return {
    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    Origin: 'https://gemini.google.com',
    Referer: 'https://gemini.google.com/',
    'X-Same-Domain': '1',
    'x-goog-ext-525005358-jspb': `["${uuid}",1]`,
    ...modelHeader,
  };
}

// batchexecute (used for read_chat polling). f.req = [[[rpcid, payload, null, "generic"]]]
export function buildBatchExecuteBody({ rpcid, payload, at }) {
  const freq = JSON.stringify([[[rpcid, payload, null, 'generic']]]);
  const params = new URLSearchParams();
  params.set('f.req', freq);
  if (at) params.set('at', at);
  return params.toString();
}

export function buildBatchExecuteQuery({ rpcid, bl, reqid, language = 'en', sessionId } = {}) {
  const q = new URLSearchParams();
  q.set('rpcids', rpcid);
  q.set('rt', 'c');
  q.set('_reqid', String(reqid));
  if (bl) q.set('bl', bl);
  q.set('hl', language);
  if (sessionId) q.set('f.sid', sessionId);
  q.set('source-path', '/app');
  return q.toString();
}

// read_chat payload (chat_mixin.py::read_chat): [cid, limit, null, 1, [1], [4], null, 1]
export function buildReadChatPayload(cid, limit = 10) {
  return JSON.stringify([cid, limit, null, 1, [1], [4], null, 1]);
}
