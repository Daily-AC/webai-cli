// Doubao (豆包) request signer — pure-JS port of doubao-free-api/pure_signer.py.
// Produces the `a_bogus` query signature (SM3 + RC4 + custom base64) that the
// samantha/chat/completion endpoint validates. msToken can be faked; a_bogus
// cannot. The signature embeds randomness, so output is non-deterministic —
// correctness is validated by the SM3 known-answer test + a live request.
import crypto from 'node:crypto';

export const AID = 497858;
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const B64 = 'Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=';
const S3 = 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe';
const S4 = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe';
const MSTOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';

const u32 = (x) => x >>> 0;
const rotl = (x, n) => {
  n %= 32;
  return u32((x << n) | (x >>> (32 - n)));
};
const rnd = (n) => Math.floor(Math.random() * n);

export function fakeMsToken(length = 172) {
  if (length <= 1) return '';
  let s = '';
  for (let i = 0; i < length - 1; i++) s += MSTOKEN_ALPHABET[rnd(MSTOKEN_ALPHABET.length)];
  return s + '=';
}

// --- SM3 ---
const P0 = (x) => x ^ rotl(x, 9) ^ rotl(x, 17);
const P1 = (x) => x ^ rotl(x, 15) ^ rotl(x, 23);

// utf-8 bytes for hashing (matches Python _to_bytes_for_hash for strings).
function utf8Bytes(x) {
  if (x == null) return [];
  if (Array.isArray(x)) return x.map((v) => v & 255);
  return [...Buffer.from(String(x), 'utf8')];
}

export function sm3Digest(data) {
  const msg = utf8Bytes(data);
  const bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  // 8-byte big-endian bit length (bitLen < 2^53).
  for (let i = 7; i >= 0; i--) msg.push(Math.floor(bitLen / 2 ** (8 * i)) & 255);

  let v = [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e];
  for (let off = 0; off < msg.length; off += 64) {
    const w = [];
    for (let i = 0; i < 64; i += 4) w.push(u32((msg[off + i] << 24) | (msg[off + i + 1] << 16) | (msg[off + i + 2] << 8) | msg[off + i + 3]));
    for (let j = 16; j < 68; j++) w.push(u32(P1(w[j - 16] ^ w[j - 9] ^ rotl(w[j - 3], 15)) ^ rotl(w[j - 13], 7) ^ w[j - 6]));
    const w1 = [];
    for (let j = 0; j < 64; j++) w1.push(u32(w[j] ^ w[j + 4]));
    let [a, b, c, d, e, f, g, h] = v;
    for (let j = 0; j < 64; j++) {
      const tj = j <= 15 ? 0x79cc4519 : 0x7a879d8a;
      const ss1 = rotl(u32(rotl(a, 12) + e + rotl(tj, j)), 7);
      const ss2 = ss1 ^ rotl(a, 12);
      const ff = j <= 15 ? a ^ b ^ c : (a & b) | (a & c) | (b & c);
      const gg = j <= 15 ? e ^ f ^ g : (e & f) | (~e & g);
      const tt1 = u32(ff + d + ss2 + w1[j]);
      const tt2 = u32(gg + h + ss1 + w[j]);
      d = c;
      c = rotl(b, 9);
      b = a;
      a = tt1;
      h = g;
      g = rotl(f, 19);
      f = e;
      e = P0(tt2);
    }
    v = [a, b, c, d, e, f, g, h].map((x, i) => u32(v[i] ^ x));
  }
  const out = [];
  for (const x of v) out.push((x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255);
  return out;
}

const sm3Bytes = (data) => sm3Digest(data);
const sm3Twice = (data) => sm3Bytes(sm3Bytes(data));

// utf-16-be-ish byte expansion (matches Python bytes_of for strings).
function bytesOf(x) {
  if (Array.isArray(x)) return x.map((v) => v & 255);
  if (Buffer.isBuffer(x)) return [...x];
  const s = String(x == null ? '' : x);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const hi = (c >> 8) & 255;
    const lo = c & 255;
    if (hi) out.push(hi, lo);
    else out.push(lo);
  }
  return out;
}

function rc4Long(keyBytes, dataBytes) {
  const key = bytesOf(keyBytes);
  const data = bytesOf(dataBytes);
  const s = [];
  for (let i = 0; i < 256; i++) s.push(255 - i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] * j + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  let a = 0;
  j = 0;
  const out = [];
  for (const b of data) {
    a = (a + 1) & 255;
    j = (j + s[a]) & 255;
    [s[a], s[j]] = [s[j], s[a]];
    out.push((b ^ s[(s[a] + s[j]) & 255]) & 255);
  }
  return out;
}

export function customBase64(data, alphabet = B64) {
  const out = [];
  let i = 0;
  while (data.length >= i + 3) {
    const n = ((data[i] & 255) << 16) | ((data[i + 1] & 255) << 8) | (data[i + 2] & 255);
    i += 3;
    out.push(alphabet[(0xfc0000 & n) >> 18], alphabet[(0x3f000 & n) >> 12], alphabet[(0xfc0 & n) >> 6], alphabet[0x3f & n]);
  }
  if (data.length - i > 0) {
    const n = ((data[i] & 255) << 16) | (data.length > i + 1 ? (data[i + 1] & 255) << 8 : 0);
    out.push(alphabet[(0xfc0000 & n) >> 18], alphabet[(0x3f000 & n) >> 12], data.length > i + 1 ? alphabet[(0xfc0 & n) >> 6] : '=', '=');
  }
  return out.join('');
}

function envBase64(envcode, ubcode, ua) {
  const key = String.fromCharCode((Math.floor(envcode / 256)) & 255) + String.fromCharCode(envcode % 256) + String.fromCharCode(ubcode % 256);
  return customBase64(rc4Long(key, ua), S3);
}

function parseVersionBytes(version) {
  if (version === '1.0.1.20-alpha.14') return [1, 0, 0, 0, 129, 4, 170, 84];
  if (version === '1.0.1.20-alpha.13') return [1, 0, 0, 0, 129, 4, 170, 78];
  const parts = String(version || '').split('.').map((x) => (/^\d+$/.test(x) ? parseInt(x, 10) : 0));
  while (parts.length < 5) parts.push(0);
  return [parts[0] & 255, parts[1] & 255, parts[2] & 255, parts[3] & 255, 129, 4, 170, (parts[4] * 6) & 255];
}

function ob4(pair, mode = 0) {
  const p = bytesOf(pair);
  const lo = rnd(65535) & 255;
  let hi = (rnd(65535) >> 8) & 255;
  if (mode === 1) hi = rnd(40);
  const x0 = p[0] || 0;
  const x1 = p[1] || 0;
  return [(lo & 170) | (x0 & 85), (lo & 85) | (x0 & 170), (hi & 170) | (x1 & 85), (hi & 85) | (x1 & 170)];
}

function obChunk3(data) {
  const a = bytesOf(data);
  const out = [];
  let i = 0;
  while (i < a.length) {
    if (i + 2 < a.length) {
      const r = rnd(1000) & 255;
      const x0 = a[i];
      const x1 = a[i + 1];
      const x2 = a[i + 2];
      out.push((r & 145) | (x0 & 110), (r & 66) | (x1 & 189), (r & 44) | (x2 & 211), (x0 & 145) | (x1 & 66) | (x2 & 44));
      i += 3;
    } else {
      out.push(a[i] & 255);
      i += 1;
      if (i < a.length && a[i]) out.push(a[i] & 255);
      i += 1;
    }
  }
  return out;
}

const byteAt = (n, k) => Math.floor(n / 256 ** k) & 255;

export function longABogus(queryString, body, opts = {}) {
  const ua = opts.userAgent || USER_AGENT;
  const pageId = opts.pageId ?? 26930;
  const aid = opts.aid ?? AID;
  const version = opts.sdkVersion || '1.0.1.20-alpha.14';
  const now = opts.now ?? Date.now();
  const envcode = opts.envcode ?? 129;
  const ubcode = opts.ubcode ?? 14;
  const envObj = opts.envObj || [0, 0, 0, 0, 79];
  const salt = 'dhzx';

  const qh = sm3Twice(String(queryString || '') + salt);
  const bh = sm3Twice(String(body || '') + salt);
  const envStr = envBase64(envcode, ubcode, ua);
  const eh = sm3Bytes(envStr);
  const ink = opts.ink ?? now - 1;
  const day = Math.floor((Date.now() - 1721836800000) / 1000 / 60 / 60 / 24 / 14);
  const perf = opts.perf ?? 6;
  const delta = opts.delta ?? 3;
  const t = now;

  const timeBytes = [0, 1, 2, 3, 4, 5].map((i) => byteAt(t, i));
  const inkBytes = [0, 1, 2, 3, 4, 5].map((i) => byteAt(ink, i));
  const aidBytes = [0, 1, 2, 3].map((i) => byteAt(aid, i));
  const pageBytes = [0, 1, 2, 3].map((i) => byteAt(pageId, i));
  const envCodeBytes = [envcode & 255, (envcode >> 8) & 255];
  const env4 = Number(envObj[4] || 0);
  const envBytes = [env4 & 255, (env4 >> 8) & 255, Number(envObj[0] || 0), Number(envObj[1] || 0), Number(envObj[2] || 0), Number(envObj[3] || 0)];
  const ubBytes = [ubcode & 255, (ubcode >> 8) & 255, (ubcode >> 16) & 255, (ubcode >> 24) & 255];

  let h51 = qh[3];
  while (h51 === 11) h51 = 12;
  if (env4 & 2) h51 = 11;
  let h55 = bh[4];
  while (h55 === 8) h55 = 9;
  if (env4 & 4) h55 = 8;
  let h59 = eh[5];
  while (h59 === 12) h59 = 13;
  if (env4 & 8) h59 = 12;

  const screenStr = `${opts.innerWidth || 0}|${opts.innerHeight || 0}|${opts.outerWidth || 0}|${opts.outerHeight || 0}|${opts.availWidth || 1440}|${opts.availHeight || 900}|${opts.sizeWidth || 1440}|${opts.sizeHeight || 900}|${opts.platform || 'MacIntel'}`;
  const screenBytes = bytesOf(screenStr);
  const screenLen = screenBytes.length;
  const commaBytes = bytesOf(`${(t + 3) & 255},`);
  const commaLen = commaBytes.length;
  const vbytes = parseVersionBytes(version);

  let xorv = 0;
  for (const b of vbytes) xorv ^= b;
  const xorSrc = [41, day, perf, delta, ...timeBytes, ...envCodeBytes, 3, ...envBytes, ...ubBytes, qh[9], qh[18], h51, bh[10], bh[19], h55, eh[11], eh[21], h59, ...inkBytes, ...pageBytes, ...aidBytes, screenLen & 255, (screenLen >> 8) & 255, commaLen & 255, (commaLen >> 8) & 255];
  for (const b of xorSrc) xorv ^= b & 255;

  const base50 = [
    timeBytes[5], ubBytes[0], eh[11], inkBytes[1], aidBytes[2], timeBytes[0], pageBytes[3], ubBytes[1],
    envCodeBytes[0], qh[18], envBytes[0], 3, h51, pageBytes[1], delta, qh[9],
    inkBytes[4], ubBytes[3], timeBytes[1], aidBytes[0], day, h55, timeBytes[2], pageBytes[2],
    h59, envBytes[2], inkBytes[2], inkBytes[3], perf, aidBytes[1], envBytes[3], aidBytes[3],
    eh[21], bh[10], envBytes[4], envBytes[1], timeBytes[4], pageBytes[0], bh[19], envBytes[5],
    inkBytes[5], ubBytes[2], envCodeBytes[1], 41, inkBytes[0], timeBytes[3], screenLen & 255, screenLen >> 8, commaLen & 255, commaLen >> 8,
  ];
  const packet = base50.map((x) => x & 255).concat(screenBytes, commaBytes, [xorv & 255]);
  const prefix = ob4([3, 82], 1);
  const mid = obChunk3(packet);
  const encrypted = rc4Long(String.fromCharCode(211), bytesOf(vbytes).concat(mid));
  return customBase64(prefix.concat(encrypted), S4);
}

// Build the samantha URL query params (excluding a_bogus).
export function buildUrlParams({ deviceId, webId, teaUuid, webTabId, msToken, pcVersion = '3.17.3' }) {
  return {
    aid: '497858',
    device_id: deviceId || '',
    device_platform: 'web',
    language: 'zh',
    pc_version: pcVersion,
    pkg_type: 'release_version',
    real_aid: '497858',
    region: 'CN',
    samantha_web: '1',
    sys_region: 'CN',
    tea_uuid: teaUuid || '',
    'use-olympus-account': '1',
    version_code: '20800',
    web_id: webId || '',
    web_tab_id: webTabId || crypto.randomUUID(),
    msToken: msToken || fakeMsToken(),
  };
}

// Sign a samantha request: returns the fully signed URL (with a_bogus appended).
export function signSamanthaUrl(baseUrl, params, bodyJson) {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const aBogus = longABogus(query, bodyJson, { userAgent: USER_AGENT });
  return `${baseUrl}?${query}&${new URLSearchParams({ a_bogus: aBogus }).toString()}`;
}

// Query params for /im/chain/single (and other /im/* endpoints) — unlike the
// samantha completion endpoint, these do NOT need msToken/a_bogus signing
// (confirmed against a real captured request).
export function buildImParams({ deviceId, webId, teaUuid, webTabId, pcVersion = '3.26.0' }) {
  return {
    version_code: '20800',
    language: 'zh',
    device_platform: 'web',
    aid: '497858',
    real_aid: '497858',
    pkg_type: 'release_version',
    device_id: deviceId || '',
    pc_version: pcVersion,
    web_id: webId || '',
    tea_uuid: teaUuid || '',
    region: 'CN',
    sys_region: 'CN',
    samantha_web: '1',
    web_platform: 'browser',
    'use-olympus-account': '1',
    web_tab_id: webTabId || crypto.randomUUID(),
  };
}

export function generateXFlowTrace() {
  const hex = (n) => [...crypto.randomBytes(n)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `00-${hex(16)}-${hex(8)}-01`;
}
