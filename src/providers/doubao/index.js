// Doubao (豆包) provider — pure-HTTP text-to-image via the samantha SSE endpoint.
// Generation needs the a_bogus signature (see sign.js) plus device params
// (device_id / web_id / tea_uuid) that live in the browser's localStorage, not
// cookies — so on first use we read them once via opencli and cache them.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import crypto from 'node:crypto';
import { request, errorForStatus } from '../../http/client.js';
import { getProvider, setProvider, buildCookieHeader } from '../../auth/store.js';
import { openUrl, evalInTab } from '../../core/opencli.js';
import { AuthError, WebaiError, ContentRejectedError } from '../../errors.js';
import { USER_AGENT, buildUrlParams, signSamanthaUrl, generateXFlowTrace } from './sign.js';

const API_BASE = 'https://www.doubao.com';
const COMPLETION_URL = `${API_BASE}/samantha/chat/completion`;
const BOT_ID = '7338286299411103781'; // doubao-image bot
const RATIOS = new Set(['1:1', '4:3', '3:4', '16:9', '9:16']);

function account() {
  const rec = getProvider('doubao');
  if (!rec || !rec.cookies || !rec.cookies.sessionid) {
    throw new AuthError('No Doubao credentials found. Run: webai auth import chrome doubao');
  }
  return rec;
}

// device_id / web_id / tea_uuid come from doubao.com localStorage. Read once via
// opencli (real Chrome) and cache under the provider record.
function getDeviceParams(rec) {
  if (rec.device && rec.device.webId) return rec.device;
  const session = process.env.WEBAI_SESSION || 'webai-doubao';
  const tab = openUrl(session, `${API_BASE}/chat/`);
  const js = `(() => {
    const out = {};
    try { const t = JSON.parse(localStorage.getItem('__tea_cache_tokens_497858') || '{}'); out.webId = t.web_id; out.deviceId = t.user_unique_id || t.web_id; } catch {}
    out.teaUuid = localStorage.getItem('__msuuid__') || '';
    try { const s = JSON.parse(localStorage.getItem('samantha_web_web_id') || '{}'); out.samanthaWebId = s.web_id; } catch {}
    return out;
  })()`;
  let dev = null;
  for (let i = 0; i < 12 && !(dev && dev.webId); i++) {
    dev = evalInTab(session, tab, js);
    if (dev && dev.webId) break;
  }
  if (!dev || !dev.webId) {
    throw new AuthError(
      'Could not read Doubao device params from Chrome localStorage. Open doubao.com (logged in) in Chrome and retry.'
    );
  }
  const device = { deviceId: dev.deviceId || dev.webId, webId: dev.webId, teaUuid: dev.teaUuid || '', samanthaWebId: dev.samanthaWebId };
  setProvider('doubao', { ...rec, device });
  return device;
}

function buildImageBody(prompt, ratio) {
  const content = JSON.stringify({ text: prompt, ratio });
  const inputSkill = JSON.stringify({ skill_id: '3', skill_type: 3 });
  return {
    bot_id: BOT_ID,
    completion_option: {
      is_regen: false,
      with_suggest: false,
      need_create_conversation: true,
      launch_stage: 1,
      action_bar_skill_id: 3,
      enable_commerce_credit: true,
    },
    conversation_id: '0',
    local_conversation_id: `local_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    local_message_id: crypto.randomUUID(),
    messages: [
      {
        content,
        content_type: 2009,
        attachments: [],
        references: [],
        skill: { skill_type: 3, skill_type_no_default: 3, skill_id: '3', skill_id_no_default: '3' },
        ext: { fp: '', input_skill: inputSkill },
      },
    ],
    ext: { fp: '' },
  };
}

// Pull image URLs out of one parsed SSE event (event_type 2001). Doubao delivers
// finished images two ways: as content_block[] entries (block_type 2074), or as a
// message with content_type 2074 whose `content` is a JSON string of {creations}.
// Only status 2 (or unset) counts as ready; status 1 is a placeholder.
function pickImageUrl(img) {
  if (!img) return null;
  if (![undefined, null, 2].includes(img.status)) return null;
  return (
    img.image_ori_raw?.url || img.image_raw?.url || img.image_ori?.url || img.image_thumb?.url || img.image_preview?.url || img.image_url || null
  );
}

function imageUrlsFromEvent(evt) {
  if (!evt || evt.event_type !== 2001) return [];
  const msg = evt.data?.message || {};
  const urls = [];
  const blocks = msg.content_block || msg.content_blocks || msg.content_blocks_v2 || [];
  for (const block of blocks) {
    if (block.block_type !== 2074) continue;
    for (const creation of block.content?.creation_block?.creations || []) {
      const u = pickImageUrl(creation.image);
      if (u && !urls.includes(u)) urls.push(u);
    }
  }
  if (msg.content_type === 2074 && typeof msg.content === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      parsed = null;
    }
    for (const creation of parsed?.creations || []) {
      const u = pickImageUrl(creation.image);
      if (u && !urls.includes(u)) urls.push(u);
    }
  }
  return urls;
}

function parseSseLine(line) {
  if (!line.startsWith('data:')) return null;
  const s = line.slice(5).trim();
  if (!s || s === '[DONE]') return null;
  let outer;
  try {
    outer = JSON.parse(s);
  } catch {
    return null;
  }
  let inner = {};
  const raw = outer.event_data;
  if (typeof raw === 'string' && raw) {
    try {
      inner = JSON.parse(raw);
    } catch {
      inner = {};
    }
  } else if (raw && typeof raw === 'object') {
    inner = raw;
  }
  return { event_type: outer.event_type, data: inner, event_id: outer.event_id };
}

export async function generateImage(prompt, opts = {}) {
  const rec = account();
  const ratio = RATIOS.has(opts.ratio) ? opts.ratio : '1:1';
  const dev = getDeviceParams(rec);
  const cookie = buildCookieHeader(rec.cookies);

  const body = buildImageBody(prompt, ratio);
  const bodyJson = JSON.stringify(body);
  const params = buildUrlParams({ deviceId: dev.deviceId, webId: dev.webId, teaUuid: dev.teaUuid });
  const signedUrl = signSamanthaUrl(COMPLETION_URL, params, bodyJson);

  const res = await request(signedUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'agw-js-conv': 'str',
      Cookie: cookie,
      Origin: API_BASE,
      Referer: `${API_BASE}/chat/`,
      'User-Agent': USER_AGENT,
      'x-flow-trace': generateXFlowTrace(),
    },
    body: bodyJson,
    timeoutMs: 120_000,
    retries: 0,
  });
  const httpErr = errorForStatus(res.status, 'doubao image completion');
  if (httpErr) throw httpErr;

  const images = [];
  let buffer = '';
  let done = false;
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const evt = parseSseLine(line);
      if (!evt) continue;
      for (const u of imageUrlsFromEvent(evt)) if (!images.includes(u)) images.push(u);
      if (evt.event_type === 2003) done = true; // stream complete
    }
    if (done) break;
  }

  if (!images.length) {
    throw new ContentRejectedError('Doubao returned no image (possible refusal, risk control, or protocol drift).');
  }
  return { images: images.map((url) => ({ url })), meta: { provider: 'doubao', ratio } };
}

// Doubao images are on byteimg CDN — plain-HTTP downloadable.
export async function download(url, destPath) {
  mkdirSync(dirname(destPath), { recursive: true });
  const res = await request(url, { timeoutMs: 120_000, retries: 2 });
  if (res.status !== 200) {
    const err = errorForStatus(res.status, `doubao download ${res.status}`);
    throw err || new WebaiError(`doubao download unexpected HTTP ${res.status}`);
  }
  writeFileSync(destPath, Buffer.from(await res.arrayBuffer()));
  return destPath;
}

export const doubao = { id: 'doubao', generateImage, download };
export default doubao;
