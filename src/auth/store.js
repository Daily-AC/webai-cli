// Credential store: persists provider cookies to ~/.config/webai-cli/creds.json
// (0600), imports Google cookies from a local Chrome profile (macOS v10
// decryption), and drives Gemini session init + 1PSIDTS rotation.
//
// Decryption ported from the P0 spike (decrypt-cookies.mjs): macOS Chrome v10
// cookies use PBKDF2-HMAC-SHA1(key, "saltysalt", 1003, 16) + AES-128-CBC with a
// 16-byte 0x20 IV. Some recent Chrome builds prepend a 32-byte SHA256(domain)
// hash to the plaintext; we strip it when the head is non-printable.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AuthError, WebaiError } from '../errors.js';
import { request, errorForStatus } from '../http/client.js';
import { ENDPOINTS } from '../providers/gemini/reqbuild.js';

export const CONFIG_DIR = join(homedir(), '.config', 'webai-cli');
export const CREDS_PATH = join(CONFIG_DIR, 'creds.json');

const SALT = 'saltysalt';
const ITERATIONS = 1003;
const KEY_LEN = 16;

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
  if (!existsSync(CREDS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CREDS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function writeCreds(creds) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
  chmodSync(CREDS_PATH, 0o600);
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

// Read `.google.com` cookies from a Chrome profile and store them under the
// given provider id. Copies the (possibly WAL-locked) Cookies DB to a temp path
// and opens it read-only, so Chrome can stay running.
export function importFromChrome({ profile = 'Profile 1', provider = 'gemini', hostFilter = '.google.com' } = {}) {
  const src = chromeCookiesPath(profile);
  if (!existsSync(src)) {
    throw new AuthError(`Chrome Cookies DB not found for profile "${profile}" at ${src}`);
  }
  const password = chromeSafeStorageKey();
  const key = deriveKey(password);

  const tmp = join(tmpdir(), `webai-cookies-${Date.now()}.sqlite`);
  copyFileSync(src, tmp);
  // Copy WAL/SHM too if present so the read-only snapshot is consistent.
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(src + ext)) {
      try { copyFileSync(src + ext, tmp + ext); } catch { /* best effort */ }
    }
  }

  const cookies = {};
  let db;
  try {
    db = new DatabaseSync(tmp, { readOnly: true });
    const rows = db
      .prepare('SELECT host_key, name, encrypted_value FROM cookies WHERE host_key LIKE ?')
      .all('%' + hostFilter);
    for (const r of rows) {
      const val = decryptChromeCookie(Buffer.from(r.encrypted_value), key);
      if (val) cookies[r.name] = val;
    }
  } catch (e) {
    throw new WebaiError(`Failed to read Chrome cookies: ${e.message || e}`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }

  if (!cookies['__Secure-1PSID']) {
    throw new AuthError(
      `No __Secure-1PSID cookie found for .google.com in Chrome profile "${profile}". ` +
        'Log in to gemini.google.com in that profile first.'
    );
  }

  setProvider(provider, {
    cookies,
    profile,
    importedAt: new Date().toISOString(),
  });
  return { count: Object.keys(cookies).length, has1PSID: true, has1PSIDTS: !!cookies['__Secure-1PSIDTS'] };
}

// ---- cookie header helpers ----
export function buildCookieHeader(cookies, { only = null } = {}) {
  const entries = Object.entries(cookies || {}).filter(([k]) => (only ? only.includes(k) : true));
  return entries.map(([k, v]) => `${k}=${v}`).join('; ');
}

// ---- Gemini session init ----
// GET /app and scrape SNlM0e (access token / "at") + bl (build label) + sid/lang.
export async function initGeminiSession(cookies) {
  const res = await request(ENDPOINTS.INIT, {
    headers: { Cookie: buildCookieHeader(cookies), Referer: 'https://gemini.google.com/' },
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
        'or the session expired. Run: webai auth import chrome'
    );
  }
  return { at, bl, sessionId, language };
}

// ---- 1PSIDTS rotation ----
// POST accounts.google.com/RotateCookies to refresh __Secure-1PSIDTS. Debounced
// to 60s. On 401 the session is dead → AuthError. Persists the new value.
export async function rotate1PSIDTS(provider = 'gemini') {
  const rec = getProvider(provider);
  if (!rec || !rec.cookies || !rec.cookies['__Secure-1PSID']) {
    throw new AuthError('No stored credentials to rotate. Run: webai auth import chrome');
  }
  const now = Date.now();
  if (rec.lastRotate && now - rec.lastRotate < 60_000) {
    return rec.cookies['__Secure-1PSIDTS'] || null; // debounce
  }

  const res = await request(ENDPOINTS.ROTATE_COOKIES, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://accounts.google.com',
      Cookie: buildCookieHeader(rec.cookies, { only: ['__Secure-1PSID', '__Secure-1PSIDTS'] }),
    },
    body: '[000,"-0000000000000000000"]',
    timeoutMs: 30_000,
    retries: 0,
  });
  if (res.status === 401) {
    throw new AuthError('RotateCookies returned 401 — cookies invalidated. Run: webai auth import chrome');
  }
  const httpErr = errorForStatus(res.status, 'RotateCookies');
  if (httpErr) throw httpErr;

  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  let newVal = null;
  for (const sc of setCookies) {
    const m = sc.match(/__Secure-1PSIDTS=([^;]+)/);
    if (m) newVal = m[1];
  }
  const updated = { ...rec.cookies };
  if (newVal) updated['__Secure-1PSIDTS'] = newVal;
  setProvider(provider, { cookies: updated, lastRotate: now });
  return newVal || updated['__Secure-1PSIDTS'] || null;
}
