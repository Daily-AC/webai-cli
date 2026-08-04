// Credential store: persists provider cookies to ~/.config/webai-cli/creds.json
// (0600), imports Google cookies from a local Chrome profile (macOS v10
// decryption), and drives Gemini session init + 1PSIDTS rotation.
//
// Decryption ported from the P0 spike (decrypt-cookies.mjs): macOS Chrome v10
// cookies use PBKDF2-HMAC-SHA1(key, "saltysalt", 1003, 16) + AES-128-CBC with a
// 16-byte 0x20 IV. Some recent Chrome builds prepend a 32-byte SHA256(domain)
// hash to the plaintext; we strip it when the head is non-printable.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { AuthError, WebaiError } from '../errors.js';
import { request, errorForStatus } from '../http/client.js';
import { ENDPOINTS } from '../providers/gemini/reqbuild.js';
import {
  COOKIE_IMPORT_SPECS,
  buildCookieHeader,
  normalizeCookie,
  parseCookieInput,
  toCookieMap,
  upsertCookieValue,
  validateCookieJar,
} from './cookies.js';

export { COOKIE_IMPORT_SPECS, buildCookieHeader, parseCookieInput } from './cookies.js';

export const CONFIG_DIR = join(homedir(), '.config', 'webai-cli');
export const CREDS_PATH = join(CONFIG_DIR, 'creds.json');

export function getConfigDir() {
  return process.env.WEBAI_CONFIG_DIR || CONFIG_DIR;
}

export function getCredsPath() {
  return join(getConfigDir(), 'creds.json');
}

const SALT = 'saltysalt';
const ITERATIONS = 1003;
const KEY_LEN = 16;
const rotationInFlight = new Map();

function providerCookieJar(cookies, provider) {
  const spec = COOKIE_IMPORT_SPECS[provider];
  if (!spec?.url) return cookies;
  const target = new URL(spec.url);
  return cookies.filter((cookie) => {
    const probe = new URL(target);
    probe.pathname = cookie.path || '/';
    return buildCookieHeader([cookie], { url: probe }).length > 0;
  });
}

// ---- v10 cookie decryption (pure) ----
export function deriveKey(password) {
  return crypto.pbkdf2Sync(password, SALT, ITERATIONS, KEY_LEN, 'sha1');
}

// Decrypt a single Chrome-encrypted cookie value. `enc` is the raw bytes
// including the "v10"/"v11" prefix; `key` is the 16-byte derived key.
export function decryptChromeCookie(enc, key) {
  if (!enc || enc.length < 4) return null;
  const version = enc.slice(0, 3).toString('latin1');
  if (version !== 'v10' && version !== 'v11') return null;
  const iv = Buffer.alloc(16, 0x20);
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  d.setAutoPadding(false);
  let out = Buffer.concat([d.update(enc.slice(3)), d.final()]);
  // Strip PKCS7 padding.
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) out = out.slice(0, out.length - pad);
  const asIs = out.toString('utf8');
  const printable = (s) => /^[\x20-\x7E]*$/.test(s);
  return printable(asIs) ? asIs : out.slice(32).toString('utf8');
}

// ---- creds.json read/write ----
export function readCreds() {
  const path = getCredsPath();
  if (!existsSync(path)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new WebaiError(`Credential store at ${path} is invalid JSON; refusing to overwrite it`);
    }
    throw error;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebaiError(`Credential store at ${path} must contain a JSON object; refusing to overwrite it`);
  }
  return parsed;
}

export function writeCreds(creds) {
  if (creds === null || typeof creds !== 'object' || Array.isArray(creds)) {
    throw new WebaiError('Credential store must be a JSON object');
  }
  const dir = getConfigDir();
  const path = getCredsPath();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const tempPath = join(dir, `.creds.json.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, JSON.stringify(creds, null, 2), { mode: 0o600, flag: 'wx' });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { rmSync(tempPath, { force: true }); } catch { /* ignore cleanup errors */ }
    throw error;
  }
}

export function getProvider(id) {
  return readCreds()[id] || null;
}

export function setProvider(id, data) {
  const creds = readCreds();
  creds[id] = { ...(creds[id] || {}), ...data };
  writeCreds(creds);
  return creds[id];
}

export function replaceProvider(id, data) {
  const creds = readCreds();
  creds[id] = data;
  writeCreds(creds);
  return creds[id];
}

// ---- Chrome import ----
function chromeCookiesPath(profile) {
  return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', profile, 'Cookies');
}

function chromeSafeStorageKey() {
  try {
    const pw = execFileSync(
      'security',
      ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'],
      { encoding: 'utf8' }
    ).trim();
    if (!pw) throw new Error('empty');
    return pw;
  } catch (e) {
    throw new AuthError(
      'Could not read the Chrome Safe Storage key from Keychain (needed to decrypt cookies). ' +
        'Ensure Chrome is installed and you approve the Keychain prompt.'
    );
  }
}

// Per-provider Chrome cookie import: which host_key suffix to match and which
// cookie must be present for the login to count. All matching cookies are stored
// (keyed by name) regardless; `require` is just a sanity gate.
export const CHROME_IMPORT_SPECS = {
  gemini: { ...COOKIE_IMPORT_SPECS.gemini, hostFilter: '.google.com', loginUrl: 'gemini.google.com' },
  jimeng: { ...COOKIE_IMPORT_SPECS.jimeng, hostFilter: 'jianying.com', loginUrl: 'jimeng.jianying.com' },
  doubao: { ...COOKIE_IMPORT_SPECS.doubao, hostFilter: 'doubao.com', loginUrl: 'doubao.com' },
  // Hunyuan 3D's session lives on .tencent.com (hunyuan_token/hunyuan_user)
  // plus a host-only hy_user on 3d.hunyuan.tencent.com, so the filter has to be
  // the apex domain; providerCookieJar then drops the sibling-subdomain noise
  // (cloud./meeting.) that cannot be sent to 3d.hunyuan.tencent.com anyway.
  hunyuan: { ...COOKIE_IMPORT_SPECS.hunyuan, hostFilter: 'tencent.com', loginUrl: '3d.hunyuan.tencent.com' },
};

function chromeExpiresToUnix(value) {
  const chromeMicros = Number(value);
  if (!Number.isFinite(chromeMicros) || chromeMicros <= 0) return null;
  const unixSeconds = Math.floor(chromeMicros / 1_000_000 - 11_644_473_600);
  return unixSeconds > 0 ? unixSeconds : null;
}

// Read a provider's cookies from a Chrome profile and store them under that
// provider id. Copies the (possibly WAL-locked) Cookies DB to a temp path and
// opens it read-only, so Chrome can stay running.
export async function importFromChrome({ profile = 'Profile 1', provider = 'gemini', hostFilter } = {}) {
  const spec = CHROME_IMPORT_SPECS[provider];
  if (!spec) {
    throw new WebaiError(
      `webai auth: unknown provider "${provider}" (expected one of: ${Object.keys(CHROME_IMPORT_SPECS).join(', ')})`
    );
  }
  const filter = hostFilter || spec.hostFilter;
  const src = chromeCookiesPath(profile);
  if (!existsSync(src)) {
    throw new AuthError(`Chrome Cookies DB not found for profile "${profile}" at ${src}`);
  }
  const password = chromeSafeStorageKey();
  const key = deriveKey(password);

  const tmp = join(tmpdir(), `webai-cookies-${process.pid}-${crypto.randomUUID()}.sqlite`);
  const cookieJar = [];
  let db;
  try {
    let DatabaseSync;
    try {
      ({ DatabaseSync } = await import('node:sqlite'));
    } catch {
      throw new WebaiError(
        'Chrome cookie import requires a Node.js runtime with node:sqlite; use --stdin or --file on this runtime'
      );
    }
    copyFileSync(src, tmp);
    // Copy WAL/SHM too if present so the read-only snapshot is consistent.
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(src + ext)) {
        try { copyFileSync(src + ext, tmp + ext); } catch { /* best effort */ }
      }
    }

    db = new DatabaseSync(tmp, { readOnly: true });
    const columns = new Set(db.prepare('PRAGMA table_info(cookies)').all().map((column) => column.name));
    const optionalColumns = ['value', 'path', 'expires_utc', 'is_secure', 'is_httponly', 'samesite']
      .filter((column) => columns.has(column));
    // expires_utc is microseconds since 1601, which for far-future cookies (some
    // Tencent ones sit past year 2100) exceeds Number.MAX_SAFE_INTEGER — node:sqlite
    // refuses to return those as numbers. Read it as text and let
    // chromeExpiresToUnix parse it.
    const selectColumns = ['host_key', 'name', 'encrypted_value', ...optionalColumns].map((column) =>
      column === 'expires_utc' ? 'CAST(expires_utc AS TEXT) AS expires_utc' : column
    );
    const rows = db
      .prepare(`SELECT ${selectColumns.join(', ')} FROM cookies WHERE host_key LIKE ?`)
      .all('%' + filter);
    for (const r of rows) {
      const val = r.value || decryptChromeCookie(Buffer.from(r.encrypted_value), key);
      if (val === null) continue;
      cookieJar.push(
        normalizeCookie({
          name: r.name,
          value: val,
          domain: r.host_key,
          path: r.path || '/',
          expires: chromeExpiresToUnix(r.expires_utc),
          secure: Boolean(r.is_secure),
          httpOnly: Boolean(r.is_httponly),
          sameSite: r.samesite,
          hostOnly: !String(r.host_key).startsWith('.'),
        })
      );
    }
  } catch (e) {
    throw new WebaiError(`Failed to read Chrome cookies: ${e.message || e}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
    for (const ext of ['', '-wal', '-shm']) {
      try { rmSync(tmp + ext, { force: true }); } catch { /* ignore cleanup errors */ }
    }
  }

  const filteredCookieJar = providerCookieJar(cookieJar, provider);
  const cookies = toCookieMap(filteredCookieJar);
  try {
    validateCookieJar(filteredCookieJar, provider);
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    throw new AuthError(
      `No usable ${spec.require} cookie found for ${filter} in Chrome profile "${profile}". ` +
        `Log in to ${spec.loginUrl} in that profile first.`
    );
  }

  replaceProvider(provider, {
    cookies,
    cookieJar: filteredCookieJar,
    profile,
    importedAt: new Date().toISOString(),
    importedFrom: 'chrome',
  });
  return {
    count: Object.keys(cookies).length,
    provider,
    require: spec.require,
    hasRequire: true,
    // Gemini-specific extras (kept for the existing auth CLI message).
    has1PSID: !!cookies['__Secure-1PSID'],
    has1PSIDTS: !!cookies['__Secure-1PSIDTS'],
  };
}

// Import a Cookie header, browser-export JSON, or Netscape cookie file without
// involving a browser process. The legacy map stays alongside the structured
// jar until all existing provider implementations consume the jar directly.
const DOUBAO_DEVICE_FIELDS = new Set([
  'deviceId',
  'webId',
  'teaUuid',
  'webTabId',
  'samanthaWebId',
  'fp',
  'roomId',
]);

const CLAUDE_CREDENTIAL_FIELDS = new Map([
  ['sessionKey', ['sessionKey', 'session_key', 'token']],
  ['deviceId', ['deviceId', 'device_id', 'anthropicDeviceId']],
  ['activitySessionId', ['activitySessionId', 'activity_session_id']],
  ['organizationId', ['organizationId', 'organization_id', 'orgId']],
  ['userAgent', ['userAgent', 'user_agent']],
  ['locale', ['locale']],
  ['timezone', ['timezone']],
  ['model', ['model']],
  ['tlsProfile', ['tlsProfile', 'tls_profile']],
]);

const CHATGPT_CREDENTIAL_FIELDS = new Map([
  ['deviceId', ['deviceId', 'device_id']],
  ['accountId', ['accountId', 'account_id']],
  ['userAgent', ['userAgent', 'user_agent']],
  ['clientVersion', ['clientVersion', 'client_version', 'buildId', 'build_id']],
  ['clientBuildNumber', ['clientBuildNumber', 'client_build_number']],
  ['language', ['language']],
  ['tlsProfile', ['tlsProfile', 'tls_profile']],
]);

function credentialString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new WebaiError(`webai auth: credential field "${field}" must be a non-empty string`);
  }
  const normalized = value.trim();
  if (/[\r\n\x00]/.test(normalized)) {
    throw new WebaiError(`webai auth: credential field "${field}" contains invalid characters`);
  }
  return normalized;
}

function credentialBundle(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8').trim() : String(input || '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'cookies')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function selectedCredentialFields(bundle, fields) {
  const metadata = {};
  for (const [target, aliases] of fields) {
    const source = aliases.find((candidate) => bundle[candidate] !== undefined);
    if (source !== undefined) metadata[target] = credentialString(bundle[source], source);
  }
  return metadata;
}

function validateChatGptSessionCookies(cookies) {
  const names = Object.keys(cookies).filter((name) =>
    /^__Secure-next-auth\.session-token(?:\.\d+)?$/.test(name)
  );
  if (names.length === 0) {
    throw new AuthError(
      'webai auth: chatgpt credentials require __Secure-next-auth.session-token or its numbered chunks'
    );
  }

  const hasWhole = names.includes('__Secure-next-auth.session-token');
  const chunks = names
    .filter((name) => name !== '__Secure-next-auth.session-token')
    .map((name) => Number(name.slice(name.lastIndexOf('.') + 1)))
    .sort((left, right) => left - right);
  if ((hasWhole && chunks.length > 0) || chunks.some((value, index) => value !== index)) {
    throw new AuthError('webai auth: ChatGPT session-token cookie chunks are incomplete or conflicting');
  }
}

function credentialMetadata(provider, bundle) {
  if (!bundle) return {};
  if (provider === 'deepseek') {
    const rawToken = bundle.token ?? bundle.accessToken ?? bundle.bearerToken ?? bundle.authorization;
    const metadata = {};
    if (rawToken !== undefined) {
      metadata.token = credentialString(rawToken, 'token').replace(/^Bearer\s+/i, '');
      if (!metadata.token) throw new WebaiError('webai auth: DeepSeek token is empty');
    }
    const hifDliq = bundle.hifDliq ?? bundle.hif_dliq;
    const hifLeim = bundle.hifLeim ?? bundle.hif_leim;
    if (hifDliq !== undefined) metadata.hifDliq = credentialString(hifDliq, 'hifDliq');
    if (hifLeim !== undefined) metadata.hifLeim = credentialString(hifLeim, 'hifLeim');
    return metadata;
  }
  if (provider === 'doubao' && bundle.device !== undefined) {
    if (!bundle.device || typeof bundle.device !== 'object' || Array.isArray(bundle.device)) {
      throw new WebaiError('webai auth: Doubao device must be an object');
    }
    const device = {};
    for (const [key, value] of Object.entries(bundle.device)) {
      if (!DOUBAO_DEVICE_FIELDS.has(key)) {
        throw new WebaiError(`webai auth: unsupported Doubao device field "${key}"`);
      }
      device[key] = credentialString(value, `device.${key}`);
    }
    return { device };
  }
  if (provider === 'claude') return selectedCredentialFields(bundle, CLAUDE_CREDENTIAL_FIELDS);
  if (provider === 'chatgpt') return selectedCredentialFields(bundle, CHATGPT_CREDENTIAL_FIELDS);
  return {};
}

export function prepareCredentialInput({ provider, input } = {}) {
  if (!COOKIE_IMPORT_SPECS[provider]) {
    throw new WebaiError(
      `webai auth: unknown provider "${provider}" (expected one of: ${Object.keys(COOKIE_IMPORT_SPECS).join(', ')})`
    );
  }
  const parsedCookieJar = parseCookieInput(input, { provider });
  const cookieJar = providerCookieJar(parsedCookieJar, provider);
  validateCookieJar(cookieJar, provider);
  const cookies = toCookieMap(cookieJar);
  const spec = COOKIE_IMPORT_SPECS[provider];
  if (provider === 'chatgpt') {
    const sessionCookies = cookieJar.filter((cookie) =>
      buildCookieHeader([cookie], { url: spec.url }).length > 0
    );
    validateChatGptSessionCookies(toCookieMap(sessionCookies));
  }
  const metadata = credentialMetadata(provider, credentialBundle(input));
  if (provider === 'deepseek' && !metadata.token) {
    throw new AuthError(
      'webai auth: DeepSeek requires a credential bundle containing cookies and token'
    );
  }
  const credential = {
    cookies,
    cookieJar,
    ...metadata,
  };
  const summary = {
    count: cookieJar.length,
    provider,
    require: spec.require || null,
    hasRequire: spec.require ? Boolean(cookies[spec.require]) : null,
    has1PSID: Boolean(cookies['__Secure-1PSID']),
    has1PSIDTS: Boolean(cookies['__Secure-1PSIDTS']),
    ...(provider === 'deepseek' ? { hasToken: true } : {}),
  };
  return { credential, summary };
}

export function saveProviderCredential(
  provider,
  credential,
  { source = 'stdin', verified = false, updates = {} } = {}
) {
  const now = new Date().toISOString();
  return replaceProvider(provider, {
    ...credential,
    ...updates,
    importedAt: now,
    importedFrom: source,
    ...(verified ? { verifiedAt: now } : {}),
  });
}

export function importFromCookieInput({ provider, input, source = 'stdin' } = {}) {
  const { credential, summary } = prepareCredentialInput({ provider, input });
  saveProviderCredential(provider, credential, {
    source: source === 'file' ? 'file' : 'stdin',
  });
  return summary;
}

// ---- Gemini session init ----
// GET /app and scrape SNlM0e (access token / "at") + bl (build label) + sid/lang.
export async function initGeminiSession(cookies) {
  const res = await request(ENDPOINTS.INIT, {
    headers: { Cookie: buildCookieHeader(cookies, { url: ENDPOINTS.INIT }), Referer: 'https://gemini.google.com/' },
    timeoutMs: 60_000,
  });
  const httpErr = errorForStatus(res.status, 'gemini init (GET /app)');
  if (httpErr) throw httpErr;
  const html = await res.text();
  const at = (html.match(/"SNlM0e":"(.*?)"/) || [])[1];
  const bl = (html.match(/"cfb2h":"(.*?)"/) || [])[1];
  const sessionId = (html.match(/"FdrFJe":"(.*?)"/) || [])[1];
  const language = (html.match(/"TuX5cc":"(.*?)"/) || [])[1] || 'en';
  if (!at) {
    throw new AuthError(
      'gemini init succeeded but no SNlM0e token found — the profile is likely not logged in, ' +
        'or the session expired. Run webai auth login gemini with fresh cookies.'
    );
  }
  return { at, bl, sessionId, language };
}

// ---- 1PSIDTS rotation ----
// POST accounts.google.com/RotateCookies to refresh __Secure-1PSIDTS. Debounced
// to 60s. On 401 the session is dead → AuthError. Persists the new value.
export function rotate1PSIDTS(provider = 'gemini') {
  const current = rotationInFlight.get(provider);
  if (current) return current;
  const pending = perform1PSIDTSRotation(provider).finally(() => {
    if (rotationInFlight.get(provider) === pending) rotationInFlight.delete(provider);
  });
  rotationInFlight.set(provider, pending);
  return pending;
}

async function perform1PSIDTSRotation(provider) {
  const rec = getProvider(provider);
  const storedCookies = rec?.cookies || (Array.isArray(rec?.cookieJar) ? toCookieMap(rec.cookieJar) : null);
  if (!storedCookies || !storedCookies['__Secure-1PSID']) {
    throw new AuthError('No stored credentials to rotate. Run: webai auth login gemini');
  }
  const now = Date.now();
  if (rec.lastRotate && now - rec.lastRotate < 60_000) {
    return storedCookies['__Secure-1PSIDTS'] || null; // debounce
  }

  const res = await request(ENDPOINTS.ROTATE_COOKIES, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://accounts.google.com',
      Cookie: buildCookieHeader(rec.cookieJar || rec.cookies, {
        only: ['__Secure-1PSID', '__Secure-1PSIDTS'],
        url: ENDPOINTS.ROTATE_COOKIES,
      }),
    },
    body: '[000,"-0000000000000000000"]',
    timeoutMs: 30_000,
    retries: 0,
  });
  if (res.status === 401) {
    throw new AuthError(
      'RotateCookies returned 401 — cookies invalidated. Run webai auth login gemini with fresh cookies.'
    );
  }
  const httpErr = errorForStatus(res.status, 'RotateCookies');
  if (httpErr) throw httpErr;

  const setCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
  let newVal = null;
  for (const sc of setCookies) {
    const m = sc.match(/__Secure-1PSIDTS=([^;]+)/);
    if (m) newVal = m[1];
  }
  const updated = { ...storedCookies };
  if (newVal) updated['__Secure-1PSIDTS'] = newVal;
  let cookieJar = rec.cookieJar;
  if (newVal && Array.isArray(cookieJar)) {
    cookieJar = upsertCookieValue(cookieJar, '__Secure-1PSIDTS', newVal, {
      domain: '.google.com',
      path: '/',
      expires: null,
      secure: true,
      httpOnly: true,
      hostOnly: false,
    });
  }
  setProvider(provider, { cookies: updated, ...(cookieJar ? { cookieJar } : {}), lastRotate: now });
  return newVal || updated['__Secure-1PSIDTS'] || null;
}
