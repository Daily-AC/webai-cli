import { AuthError, WebaiError } from '../errors.js';

export const COOKIE_IMPORT_SPECS = {
  gemini: {
    domain: '.google.com',
    url: 'https://gemini.google.com/',
    require: '__Secure-1PSID',
  },
  jimeng: {
    domain: '.jianying.com',
    url: 'https://jimeng.jianying.com/',
    require: 'sessionid',
  },
  doubao: {
    domain: '.doubao.com',
    url: 'https://www.doubao.com/',
    require: 'sessionid',
  },
  hunyuan: {
    domain: '.tencent.com',
    url: 'https://3d.hunyuan.tencent.com/',
    require: 'hunyuan_token',
  },
  chatgpt: { domain: '.chatgpt.com', url: 'https://chatgpt.com/api/auth/session' },
  claude: { domain: '.claude.ai', url: 'https://claude.ai/api/organizations', require: 'sessionKey' },
  grok: { domain: '.grok.com', url: 'https://grok.com/' },
  deepseek: { domain: '.deepseek.com', url: 'https://chat.deepseek.com/' },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSameSite(value) {
  if (value === undefined || value === null || value === '' || value === -1) return null;
  if (value === 0) return 'none';
  if (value === 1) return 'lax';
  if (value === 2) return 'strict';
  const normalized = String(value).toLowerCase().replace(/[-_ ]/g, '');
  if (normalized === 'none' || normalized === 'norestriction') return 'none';
  if (normalized === 'lax' || normalized === 'laxmode') return 'lax';
  if (normalized === 'strict' || normalized === 'strictmode') return 'strict';
  if (normalized === 'unspecified') return null;
  return String(value);
}

function normalizeExpires(value) {
  if (value === undefined || value === null || value === '' || value === 0 || value === '0') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
    const millis = Date.parse(value);
    if (!Number.isFinite(millis)) throw new WebaiError('webai auth: cookie has an invalid expires value');
    return Math.floor(millis / 1000);
  }
  let seconds = Number(value);
  if (seconds === -1) return null;
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new WebaiError('webai auth: cookie has an invalid expires value');
  }
  if (seconds > 10_000_000_000) seconds = Math.floor(seconds / 1000);
  return Math.floor(seconds);
}

function assertCookieToken(name, value) {
  if (!name || /[\s;=\x00-\x1f\x7f]/.test(name)) {
    throw new WebaiError('webai auth: cookie has an invalid name');
  }
  if (/[;\r\n\x00]/.test(value)) {
    throw new WebaiError(`webai auth: cookie "${name}" has an invalid value`);
  }
}

export function normalizeCookie(cookie, defaults = {}) {
  if (!isPlainObject(cookie)) throw new WebaiError('webai auth: expected each cookie to be an object');
  const name = cookie.name === undefined ? '' : String(cookie.name).trim();
  const value = cookie.value === undefined || cookie.value === null ? '' : String(cookie.value);
  assertCookieToken(name, value);

  const rawDomain = cookie.domain ?? defaults.domain ?? '';
  const domain = String(rawDomain).trim().toLowerCase();
  const path = String(cookie.path ?? defaults.path ?? '/') || '/';
  const explicitHostOnly = cookie.hostOnly ?? cookie.host_only;
  const hostOnly =
    explicitHostOnly === undefined ? (domain ? !domain.startsWith('.') : true) : Boolean(explicitHostOnly);

  return {
    name,
    value,
    domain,
    path: path.startsWith('/') ? path : `/${path}`,
    expires: normalizeExpires(cookie.expires ?? cookie.expirationDate ?? cookie.expiry),
    secure: Boolean(cookie.secure ?? defaults.secure ?? true),
    httpOnly: Boolean(cookie.httpOnly ?? cookie.httponly ?? defaults.httpOnly ?? false),
    sameSite: normalizeSameSite(cookie.sameSite ?? cookie.samesite ?? defaults.sameSite),
    hostOnly,
  };
}

function cookiesFromMap(map, defaults) {
  return Object.entries(map).map(([name, value]) => normalizeCookie({ name, value }, defaults));
}

function parseJsonCookies(text, defaults) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON parser messages may include a source excerpt, which can contain
    // credential bytes. Keep auth errors deliberately content-free.
    throw new WebaiError('webai auth: invalid cookie JSON');
  }

  const value = isPlainObject(parsed) && Object.hasOwn(parsed, 'cookies') ? parsed.cookies : parsed;
  if (typeof value === 'string') return parseCookieHeader(value, defaults);
  if (Array.isArray(value)) return value.map((cookie) => normalizeCookie(cookie, defaults));
  if (isPlainObject(value)) return cookiesFromMap(value, defaults);
  throw new WebaiError(
    'webai auth: cookie JSON must be an array, a cookie map, or an object whose "cookies" field is a Cookie header, array, or map'
  );
}

function parseNetscapeCookies(text) {
  const cookies = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;

    const fields = line.split('\t');
    if (fields.length < 7) throw new WebaiError('webai auth: invalid Netscape cookie line');
    let [domain, includeSubdomains, path, secure, expires, name, ...valueParts] = fields;
    let httpOnly = false;
    if (domain.startsWith('#HttpOnly_')) {
      domain = domain.slice('#HttpOnly_'.length);
      httpOnly = true;
    }
    cookies.push(
      normalizeCookie({
        name,
        value: valueParts.join('\t'),
        domain,
        path,
        expires,
        secure: secure.toUpperCase() === 'TRUE',
        httpOnly,
        hostOnly: includeSubdomains.toUpperCase() !== 'TRUE',
      })
    );
  }
  if (cookies.length === 0) throw new WebaiError('webai auth: Netscape cookie file contains no cookies');
  return cookies;
}

function parseCookieHeader(text, defaults) {
  const cookies = [];
  const header = text.replace(/^Cookie\s*:\s*/i, '');
  for (const part of header.split(';')) {
    const segment = part.trim();
    if (!segment) continue;
    const separator = segment.indexOf('=');
    if (separator <= 0) throw new WebaiError('webai auth: invalid Cookie header');
    cookies.push(
      normalizeCookie(
        { name: segment.slice(0, separator).trim(), value: segment.slice(separator + 1).trim() },
        defaults
      )
    );
  }
  if (cookies.length === 0) throw new WebaiError('webai auth: Cookie header contains no cookies');
  return cookies;
}

export function parseCookieInput(input, { provider } = {}) {
  if (typeof input !== 'string' && !Buffer.isBuffer(input)) {
    throw new WebaiError('webai auth: cookie input must be text');
  }
  const text = input.toString('utf8').trim();
  if (!text) throw new WebaiError('webai auth: cookie input is empty');

  const spec = COOKIE_IMPORT_SPECS[provider] || {};
  const defaults = { domain: spec.domain || '', path: '/', secure: true };
  let cookies;
  if (text.startsWith('{') || text.startsWith('[')) {
    cookies = parseJsonCookies(text, defaults);
  } else if (/^# Netscape HTTP Cookie File/im.test(text) || text.split(/\r?\n/).some((line) => line.split('\t').length >= 7)) {
    cookies = parseNetscapeCookies(text);
  } else {
    cookies = parseCookieHeader(text, defaults);
  }

  validateCookieJar(cookies, provider);
  return cookies;
}

export function validateCookieJar(cookies, provider) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new AuthError('webai auth: no cookies found in input');
  }
  const spec = COOKIE_IMPORT_SPECS[provider];
  const required = spec?.require;
  const requiredCandidates = required
    ? cookies.filter((cookie) => cookie.name === required && cookie.value)
    : [];
  const usableRequiredCookie =
    required && buildCookieHeader(requiredCandidates, { only: [required], url: spec.url }).length > 0;
  if (required && !usableRequiredCookie) {
    throw new AuthError(
      `webai auth: ${provider} credentials require a non-expired ${required} cookie valid for ${new URL(spec.url).hostname}`
    );
  }
  if (spec?.url && !buildCookieHeader(cookies, { url: spec.url })) {
    throw new AuthError(
      `webai auth: ${provider} credentials contain no non-expired cookie valid for ${new URL(spec.url).hostname}`
    );
  }
}

export function toCookieMap(cookies) {
  return Object.fromEntries((cookies || []).map(({ name, value }) => [name, value]));
}

export function upsertCookieValue(cookies, name, value, defaults = {}) {
  let found = false;
  const updated = (cookies || []).map((cookie) => {
    if (cookie.name !== name) return cookie;
    found = true;
    return normalizeCookie({ ...cookie, ...defaults, name, value });
  });
  if (!found) updated.push(normalizeCookie({ ...defaults, name, value }));
  return updated;
}

function domainMatches(hostname, cookie) {
  if (!cookie.domain) return true;
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  if (cookie.hostOnly) return hostname === domain;
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function pathMatches(requestPath, cookiePath) {
  const path = cookiePath || '/';
  if (requestPath === path) return true;
  if (!requestPath.startsWith(path)) return false;
  return path.endsWith('/') || requestPath[path.length] === '/';
}

function isStructuredCookieCollection(value) {
  return Array.isArray(value);
}

export function buildCookieHeader(cookieCollection, { only = null, url = null, now = Date.now() } = {}) {
  let collection = cookieCollection || {};
  if (!Array.isArray(collection) && collection && typeof collection === 'object') {
    if (Array.isArray(collection.cookieJar)) collection = collection.cookieJar;
    else if (collection.cookies && typeof collection.cookies === 'object') collection = collection.cookies;
  }
  const onlyNames = only ? new Set(only) : null;

  if (!isStructuredCookieCollection(collection)) {
    return Object.entries(collection)
      .filter(([name]) => !onlyNames || onlyNames.has(name))
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  let target = null;
  if (url) {
    try {
      target = url instanceof URL ? url : new URL(url);
    } catch {
      throw new WebaiError(`webai auth: invalid cookie target URL "${url}"`);
    }
  }
  const nowSeconds = now > 10_000_000_000 ? Math.floor(now / 1000) : Math.floor(now);

  return collection
    .map((cookie, index) => ({ cookie: normalizeCookie(cookie), index }))
    .filter(({ cookie }) => !onlyNames || onlyNames.has(cookie.name))
    .filter(({ cookie }) => cookie.expires === null || cookie.expires > nowSeconds)
    .filter(({ cookie }) => !target || (!cookie.secure || target.protocol === 'https:'))
    .filter(({ cookie }) => !target || domainMatches(target.hostname.toLowerCase(), cookie))
    .filter(({ cookie }) => !target || pathMatches(target.pathname || '/', cookie.path))
    .sort((a, b) => b.cookie.path.length - a.cookie.path.length || a.index - b.index)
    .map(({ cookie }) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}
