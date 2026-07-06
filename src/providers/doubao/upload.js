// Doubao attachment upload — prepare_upload (STS creds) -> ApplyImageUpload
// (imagex, AWS4-signed) -> PUT bytes to the returned TOS host -> CommitImageUpload.
// Ported from the network trace of a real i2v submission (see
// docs/superpowers/recon/2026-07-06-doubao-video.md) plus the public reference
// implementation 5201213/doubao-free-api (uploader.py).
import crypto from 'node:crypto';
import { request, errorForStatus } from '../../http/client.js';
import { WebaiError } from '../../errors.js';
import { USER_AGENT, buildUrlParams, signSamanthaUrl } from './sign.js';
import { signAws4Request } from './aws4.js';

const API_BASE = 'https://www.doubao.com';
const PREPARE_UPLOAD_URL = `${API_BASE}/alice/resource/prepare_upload`;
const IMAGEX_HOST = 'imagex.bytedanceapi.com';
const IMAGEX_REGION = 'cn-north-1';
const IMAGEX_SERVICE = 'imagex';

export function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

async function jsonOrThrow(res, context) {
  const httpErr = errorForStatus(res.status, context);
  if (httpErr) throw httpErr;
  try {
    return await res.json();
  } catch {
    throw new WebaiError(`${context}: non-JSON response`);
  }
}

async function prepareUpload({ cookie, dev }) {
  const params = buildUrlParams({ deviceId: dev.deviceId, webId: dev.webId, teaUuid: dev.teaUuid });
  const body = JSON.stringify({ resource_type: 2, scene_id: '5', tenant_id: '5' });
  const signedUrl = signSamanthaUrl(PREPARE_UPLOAD_URL, params, body);
  const res = await request(signedUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: API_BASE,
      Referer: `${API_BASE}/chat/`,
      'User-Agent': USER_AGENT,
    },
    body,
    timeoutMs: 30_000,
    retries: 1,
  });
  const json = await jsonOrThrow(res, 'doubao prepare_upload');
  if (json.code !== 0) throw new WebaiError(`doubao prepare_upload failed: ${json.msg || json.code}`);
  const data = json.data || {};
  const auth = data.upload_auth_token || {};
  if (!data.service_id || !auth.access_key || !auth.secret_key) {
    throw new WebaiError('doubao prepare_upload: missing service_id/access_key/secret_key in response');
  }
  return { serviceId: data.service_id, accessKey: auth.access_key, secretKey: auth.secret_key, sessionToken: auth.session_token };
}

async function applyImageUpload({ creds, fileSize, fileExt }) {
  const query = {
    Action: 'ApplyImageUpload',
    Version: '2018-08-01',
    ServiceId: creds.serviceId,
    NeedFallback: 'true',
    FileSize: String(fileSize),
    FileExtension: fileExt,
  };
  const headers = signAws4Request({
    method: 'GET',
    host: IMAGEX_HOST,
    path: '/',
    query,
    body: '',
    accessKey: creds.accessKey,
    secretKey: creds.secretKey,
    sessionToken: creds.sessionToken,
    region: IMAGEX_REGION,
    service: IMAGEX_SERVICE,
  });
  const qs = new URLSearchParams(query).toString();
  const res = await request(`https://${IMAGEX_HOST}/?${qs}`, {
    method: 'GET',
    headers: { ...headers, Host: IMAGEX_HOST, Origin: API_BASE, Referer: `${API_BASE}/`, 'User-Agent': USER_AGENT },
    timeoutMs: 30_000,
    retries: 1,
  });
  const json = await jsonOrThrow(res, 'doubao ApplyImageUpload');
  const storeInfos = json?.Result?.UploadAddress?.StoreInfos;
  const uploadHosts = json?.Result?.UploadAddress?.UploadHosts;
  const sessionKey = json?.Result?.UploadAddress?.SessionKey;
  if (!storeInfos?.length || !uploadHosts?.length) {
    throw new WebaiError(`doubao ApplyImageUpload: empty StoreInfos/UploadHosts (${JSON.stringify(json).slice(0, 300)})`);
  }
  return { storeUri: storeInfos[0].StoreUri, storeAuth: storeInfos[0].Auth, uploadHost: uploadHosts[0], sessionKey };
}

async function putBytes({ uploadHost, storeUri, storeAuth, bytes }) {
  const crc = crc32(bytes);
  const res = await request(`https://${uploadHost}/upload/v1/${storeUri}`, {
    method: 'POST',
    headers: {
      Authorization: storeAuth,
      Origin: API_BASE,
      Referer: `${API_BASE}/`,
      Host: uploadHost,
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="undefined"',
      'Content-Crc32': crc,
      'User-Agent': USER_AGENT,
    },
    body: bytes,
    timeoutMs: 60_000,
    retries: 1,
  });
  const json = await jsonOrThrow(res, 'doubao upload PUT bytes');
  if (json.message !== 'Success') throw new WebaiError(`doubao upload PUT bytes failed: ${JSON.stringify(json)}`);
  return json;
}

async function commitImageUpload({ creds, sessionKey }) {
  const query = { Action: 'CommitImageUpload', Version: '2018-08-01', ServiceId: creds.serviceId };
  const body = JSON.stringify({ SessionKey: sessionKey });
  const headers = signAws4Request({
    method: 'POST',
    host: IMAGEX_HOST,
    path: '/',
    query,
    body,
    accessKey: creds.accessKey,
    secretKey: creds.secretKey,
    sessionToken: creds.sessionToken,
    region: IMAGEX_REGION,
    service: IMAGEX_SERVICE,
  });
  const qs = new URLSearchParams(query).toString();
  const res = await request(`https://${IMAGEX_HOST}/?${qs}`, {
    method: 'POST',
    headers: {
      ...headers,
      Host: IMAGEX_HOST,
      'Content-Type': 'application/json',
      Origin: API_BASE,
      Referer: `${API_BASE}/`,
      'User-Agent': USER_AGENT,
    },
    body,
    timeoutMs: 30_000,
    retries: 1,
  });
  const json = await jsonOrThrow(res, 'doubao CommitImageUpload');
  const result = json?.Result?.PluginResult?.[0];
  if (!result) throw new WebaiError(`doubao CommitImageUpload: empty PluginResult (${JSON.stringify(json).slice(0, 300)})`);
  return result;
}

// Upload a local image file for use as a chat attachment (i2v reference image).
// Returns the attachment object expected in messages[].attachments[].
export async function uploadImage(bytes, fileName, { cookie, dev }) {
  const fileExt = (fileName.match(/\.[^.]+$/) || ['.png'])[0];
  const creds = await prepareUpload({ cookie, dev });
  const applied = await applyImageUpload({ creds, fileSize: bytes.length, fileExt });
  await putBytes({ uploadHost: applied.uploadHost, storeUri: applied.storeUri, storeAuth: applied.storeAuth, bytes });
  const committed = await commitImageUpload({ creds, sessionKey: applied.sessionKey });

  return {
    key: committed.ImageUri,
    name: fileName,
    type: 'image',
    file_review_state: 3,
    file_parse_state: 3,
    identifier: crypto.randomUUID(),
    option: { height: committed.ImageHeight, width: committed.ImageWidth },
    md5: committed.ImageMd5,
    size: committed.ImageSize,
  };
}
