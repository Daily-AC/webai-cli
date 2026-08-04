// Minimal Tencent COS PUT-object client, enough to upload one reference image
// with the temporary credentials Hunyuan's /api/3d/resource/genUploadInfo hands
// out. Implements the COS v5 (`q-sign-algorithm=sha1`) request signature so no
// cos-js-sdk dependency is needed.
import crypto from 'node:crypto';

function sha1Hex(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function hmacSha1Hex(key, value) {
  return crypto.createHmac('sha1', key).update(value).digest('hex');
}

// COS lowercases header/param names and percent-encodes values with the strict
// RFC3986 set before building the canonical strings.
function encodeValue(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPairs(source = {}) {
  const entries = Object.entries(source)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key.toLowerCase(), value])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    list: entries.map(([key]) => key).join(';'),
    string: entries.map(([key, value]) => `${key}=${encodeValue(value)}`).join('&'),
  };
}

export function buildCosAuthorization({
  method,
  pathname,
  secretId,
  secretKey,
  startTime,
  expiredTime,
  headers = {},
  query = {},
}) {
  const keyTime = `${startTime};${expiredTime}`;
  const signKey = hmacSha1Hex(secretKey, keyTime);
  const headerPairs = canonicalPairs(headers);
  const queryPairs = canonicalPairs(query);
  const formatString = `${method.toLowerCase()}\n${pathname}\n${queryPairs.string}\n${headerPairs.string}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1Hex(formatString)}\n`;
  const signature = hmacSha1Hex(signKey, stringToSign);
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerPairs.list}`,
    `q-url-param-list=${queryPairs.list}`,
    `q-signature=${signature}`,
  ].join('&');
}

// `cosInfo` is the genUploadInfo payload: bucketName, region, location and the
// temporary secret triple. Returns the object's public URL.
export async function putObject(cosInfo, body, { contentType = 'application/octet-stream', request } = {}) {
  const { bucketName, region, location } = cosInfo;
  const secretId = cosInfo.encryptTmpSecretId ?? cosInfo.tmpSecretId;
  const secretKey = cosInfo.encryptTmpSecretKey ?? cosInfo.tmpSecretKey;
  const token = cosInfo.encryptToken ?? cosInfo.sessionToken ?? cosInfo.token;
  if (!bucketName || !region || !location) throw new Error('hunyuan upload: incomplete COS upload info');
  if (!secretId || !secretKey) throw new Error('hunyuan upload: COS upload info has no temporary credentials');

  const host = `${bucketName}.cos.${region}.myqcloud.com`;
  const key = String(location).replace(/^\/+/, '');
  const pathname = `/${key.split('/').map(encodeURIComponent).join('/')}`;
  const now = Math.floor(Date.now() / 1000);
  const startTime = Number(cosInfo.startTime) || now - 60;
  const expiredTime = Number(cosInfo.expiredTime) || now + 3600;

  const signedHeaders = { host };
  const authorization = buildCosAuthorization({
    method: 'PUT',
    pathname,
    secretId,
    secretKey,
    startTime,
    expiredTime,
    headers: signedHeaders,
  });

  const headers = { authorization, host, 'content-type': contentType };
  if (token) headers['x-cos-security-token'] = token;

  const url = `https://${host}${pathname}`;
  const res = await request(url, { method: 'PUT', headers, body, timeoutMs: 120_000, retries: 1 });
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`hunyuan upload: COS PUT failed with HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return url;
}
