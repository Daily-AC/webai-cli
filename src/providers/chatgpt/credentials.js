import { createHash } from 'node:crypto';
import { buildCookieHeader } from '../../auth/store.js';
import { AuthError } from '../../errors.js';

export const CHATGPT_BASE_URL = 'https://chatgpt.com';
export const CHATGPT_SESSION_COOKIE = '__Secure-next-auth.session-token';

const SESSION_COOKIE_RE = /^__Secure-next-auth\.session-token(?:\.(\d+))?$/;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0';

function normalizeRawCookie(value) {
  const raw = String(value || '').trim().replace(/^Cookie\s*:\s*/i, '');
  if (!raw) return '';
  if (/(?:^|;\s*)__Secure-next-auth\.session-token(?:\.\d+)?\s*=/.test(raw)) return raw;
  return `${CHATGPT_SESSION_COOKIE}=${raw}`;
}

function cookiePairs(header) {
  const value = String(header || '').replace(/^Cookie\s*:\s*/i, '').trim();
  const pairs = [];
  for (const part of value.split(';')) {
    const segment = part.trim();
    if (!segment) continue;
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;
    pairs.push({ name: segment.slice(0, separator).trim(), value: segment.slice(separator + 1) });
  }
  return pairs;
}

function sessionParts(header) {
  return cookiePairs(header)
    .map((pair) => ({ ...pair, match: SESSION_COOKIE_RE.exec(pair.name) }))
    .filter((pair) => pair.match)
    .map((pair) => ({ ...pair, index: pair.match[1] === undefined ? null : Number(pair.match[1]) }));
}

function assertSessionCookie(header) {
  const parts = sessionParts(header);
  if (parts.length === 0 || parts.some((part) => !part.value)) {
    throw new AuthError(
      `ChatGPT credential is missing ${CHATGPT_SESSION_COOKIE} or its numbered chunks.`
    );
  }

  const unchunked = parts.filter((part) => part.index === null);
  const chunked = parts.filter((part) => part.index !== null).sort((a, b) => a.index - b.index);
  if (unchunked.length > 1 || (unchunked.length > 0 && chunked.length > 0)) {
    throw new AuthError('ChatGPT credential contains conflicting session-token cookie variants.');
  }
  if (chunked.length > 0) {
    for (let index = 0; index < chunked.length; index++) {
      if (chunked[index].index !== index) {
        throw new AuthError(`ChatGPT credential is missing session-token chunk ${index}.`);
      }
    }
  }
  return parts;
}

export function cookieHeaderFromCredential(credential, targetUrl = `${CHATGPT_BASE_URL}/`) {
  if (typeof credential === 'string') return normalizeRawCookie(credential);
  if (!credential || typeof credential !== 'object') return '';
  if (typeof credential.cookieHeader === 'string') return normalizeRawCookie(credential.cookieHeader);
  if (typeof credential.cookie === 'string') return normalizeRawCookie(credential.cookie);
  const source = credential.cookieJar ?? credential.cookies;
  if (typeof source === 'string') return normalizeRawCookie(source);
  if (!source || typeof source !== 'object') return '';
  return buildCookieHeader(source, { url: targetUrl });
}

function stableDeviceId(parts) {
  const material = parts
    .slice()
    .sort((a, b) => (a.index ?? -1) - (b.index ?? -1))
    .map(({ value }) => value)
    .join('');
  const bytes = Buffer.from(createHash('sha256').update(material).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeChatGptCredential(credential) {
  const record = typeof credential === 'string' ? { cookie: credential } : credential;
  if (!record || typeof record !== 'object') {
    throw new AuthError('No ChatGPT credentials found. Inject the full chatgpt.com Cookie header.');
  }
  const cookieHeader = cookieHeaderFromCredential(record);
  const parts = assertSessionCookie(cookieHeader);
  const did = cookiePairs(cookieHeader).find(({ name }) => name === 'oai-did')?.value;
  return {
    cookieHeader,
    deviceId: String(record.deviceId ?? record.device_id ?? did ?? stableDeviceId(parts)),
    accountId: String(record.accountId ?? record.account_id ?? ''),
    userAgent: String(record.userAgent ?? record.user_agent ?? DEFAULT_USER_AGENT),
    clientVersion: String(record.clientVersion ?? record.client_version ?? record.buildId ?? record.build_id ?? ''),
    clientBuildNumber: String(record.clientBuildNumber ?? record.client_build_number ?? ''),
    language: String(record.language ?? 'en-US'),
    tlsProfile: String(record.tlsProfile ?? record.tls_profile ?? 'firefox144'),
  };
}

function setCookieValues(headersOrValues) {
  if (!headersOrValues) return [];
  if (Array.isArray(headersOrValues)) return headersOrValues.flatMap(setCookieValues);
  if (typeof headersOrValues === 'string') return [headersOrValues];
  if (typeof headersOrValues.getSetCookie === 'function') return headersOrValues.getSetCookie();
  if (typeof headersOrValues.get === 'function') {
    const value = headersOrValues.get('set-cookie');
    return value ? [value] : [];
  }
  const key = Object.keys(headersOrValues).find((candidate) => candidate.toLowerCase() === 'set-cookie');
  return key ? setCookieValues(headersOrValues[key]) : [];
}

export function mergeSessionCookieRotation(cookieHeader, headersOrValues) {
  const refreshed = new Map();
  for (const value of setCookieValues(headersOrValues)) {
    for (const match of String(value).matchAll(/(__Secure-next-auth\.session-token(?:\.\d+)?)=([^;,\s]*)/g)) {
      if (match[2]) refreshed.set(match[1], match[2]);
    }
  }
  if (refreshed.size === 0) return null;

  const existing = new Map(sessionParts(cookieHeader).map(({ name, value }) => [name, value]));
  if (
    existing.size === refreshed.size &&
    Array.from(refreshed).every(([name, value]) => existing.get(name) === value)
  ) {
    return null;
  }

  const retained = cookiePairs(cookieHeader).filter(({ name }) => !SESSION_COOKIE_RE.test(name));
  const next = [
    ...retained.map(({ name, value }) => `${name}=${value}`),
    ...Array.from(refreshed, ([name, value]) => `${name}=${value}`),
  ].join('; ');
  assertSessionCookie(next);
  return next;
}

function decodeJwtPayload(token) {
  const payload = String(token || '').split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function accountIdFromAccessToken(token) {
  const payload = decodeJwtPayload(token);
  return String(
    payload?.['https://api.openai.com/auth']?.chatgpt_account_id ??
      payload?.['https://api.openai.com/auth/chatgpt_account_id'] ??
      ''
  );
}
