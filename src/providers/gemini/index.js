// Gemini provider — direct-HTTP implementation of the media contract (spec §4.3).
//   generateImage(prompt, opts) -> { images, meta }
//   submitVideo(prompt, opts)   -> { jobId, meta }
//   pollVideo(jobId)            -> { status, video?, progress? }
//   download(url, destPath, opts) -> localPath   (Gemini 206 polling semantics)
import { writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { request, errorForStatus } from '../../http/client.js';
import { ensureSession, evalSession } from '../../core/session.js';
import { getAdapter } from '../../sites/index.js';
import {
  getProvider,
  initGeminiSession,
  rotate1PSIDTS,
  buildCookieHeader,
} from '../../auth/store.js';
import { AuthError, QuotaError, ContentRejectedError, WebaiError } from '../../errors.js';
import {
  ENDPOINTS,
  GRPC,
  buildGenerateBody,
  buildGenerateQuery,
  buildGenerateHeaders,
  buildBatchExecuteBody,
  buildBatchExecuteQuery,
  buildReadChatPayload,
} from './reqbuild.js';
import { parseGenerateResponse, parseReadChat } from './parse.js';

const REFERER = 'https://gemini.google.com/';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

function reqid() {
  return 100000 + Math.floor(Math.random() * 800000);
}

// Load cookies + a fresh init session, rotating 1PSIDTS once on auth failure.
async function loadSession() {
  const rec = getProvider('gemini');
  if (!rec || !rec.cookies || !rec.cookies['__Secure-1PSID']) {
    throw new AuthError('No Gemini credentials found. Run: webai auth import chrome');
  }
  try {
    const session = await initGeminiSession(rec.cookies);
    return { ...session, cookies: rec.cookies };
  } catch (err) {
    if (err instanceof AuthError) {
      // 1PSIDTS may just be stale — rotate once and retry.
      await rotate1PSIDTS('gemini');
      const rec2 = getProvider('gemini');
      const session = await initGeminiSession(rec2.cookies);
      return { ...session, cookies: rec2.cookies };
    }
    throw err;
  }
}

async function streamGenerate(prompt, session) {
  const { body, uuid } = buildGenerateBody({
    prompt,
    at: session.at,
    language: session.language,
  });
  const url = `${ENDPOINTS.GENERATE}?${buildGenerateQuery({
    bl: session.bl,
    reqid: reqid(),
    language: session.language,
    sessionId: session.sessionId,
  })}`;
  const res = await request(url, {
    method: 'POST',
    headers: {
      ...buildGenerateHeaders({ uuid }),
      Cookie: buildCookieHeader(session.cookies),
      Referer: REFERER,
    },
    body,
    // Image generation and video *submit* both return within seconds (video is
    // async — the first response is a placeholder chip), so a tight ceiling
    // avoids multi-minute hangs on a stalled connection.
    timeoutMs: 120_000,
    retries: 1,
  });
  const text = await res.text();
  const httpErr = errorForStatus(res.status, 'gemini StreamGenerate', text);
  if (httpErr) throw httpErr;
  return parseGenerateResponse(text);
}

// Turn a preview image URL into a full-size one (image.py fallback logic).
function fullSizeImageUrl(url) {
  if (url.includes('=s2048-rj')) return url;
  if (url.includes('=s1024-rj')) return url.replace('=s1024-rj', '=s2048-rj');
  return url + '=s2048-rj';
}

export async function generateImage(prompt, _opts = {}) {
  const session = await loadSession();
  const parsed = await streamGenerate(prompt, session);

  if (parsed.quotaExceeded) {
    throw new QuotaError(
      'Gemini image generation limit reached for this account today. Try again later or use another account.'
    );
  }
  if (parsed.blocked) {
    throw new ContentRejectedError(`Gemini refused the prompt: ${parsed.text || '(policy)'}`);
  }
  if (!parsed.images.length) {
    // Completed with only text and no image → treat as a refusal/failure.
    if (parsed.text) {
      throw new ContentRejectedError(`Gemini returned text instead of an image: ${parsed.text.slice(0, 200)}`);
    }
    throw new WebaiError('Gemini returned no image and no error signal (possible protocol drift).');
  }

  return {
    images: parsed.images.map((img) => ({ url: fullSizeImageUrl(img.url), imageId: img.imageId, alt: img.alt })),
    meta: { cid: parsed.cid, rid: parsed.rid, rcid: parsed.rcid },
  };
}

export async function submitVideo(prompt, _opts = {}) {
  const session = await loadSession();
  const parsed = await streamGenerate(prompt, session);

  if (parsed.quotaExceeded) {
    throw new QuotaError('Gemini video generation limit reached for this account.');
  }
  if (parsed.blocked) {
    throw new ContentRejectedError(`Gemini refused the video prompt: ${parsed.text || '(policy)'}`);
  }
  if (!parsed.cid) {
    throw new WebaiError('Gemini video submit returned no conversation id (protocol drift or refusal).');
  }
  // Occasionally the mp4 URL is already present in the first response.
  const video = parsed.videos[0] || null;
  return { jobId: parsed.cid, meta: { rid: parsed.rid, rcid: parsed.rcid }, video };
}

export async function pollVideo(jobId) {
  const session = await loadSession();
  const payload = buildReadChatPayload(jobId, 5);
  const url = `${ENDPOINTS.BATCH_EXEC}?${buildBatchExecuteQuery({
    rpcid: GRPC.READ_CHAT,
    bl: session.bl,
    reqid: reqid(),
    language: session.language,
    sessionId: session.sessionId,
  })}`;
  const res = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      Origin: 'https://gemini.google.com',
      Referer: REFERER,
      'X-Same-Domain': '1',
      Cookie: buildCookieHeader(session.cookies),
    },
    body: buildBatchExecuteBody({ rpcid: GRPC.READ_CHAT, payload, at: session.at }),
    timeoutMs: 60_000,
    retries: 1,
  });
  const text = await res.text();
  const httpErr = errorForStatus(res.status, 'gemini read_chat', text);
  if (httpErr) throw httpErr;

  const r = parseReadChat(text);
  if (r.status === 'ready' && r.video) return { status: 'ready', video: r.video };
  if (r.status === 'failed') {
    return { status: 'failed', reason: r.reason || r.text || 'generation stopped' };
  }
  return { status: 'pending' };
}

// Download a media URL to destPath.
//
// Google's media CDNs reject every headless HTTP client (undici, curl-impersonate
// with a real-Chrome JA3, …) with 403 — they validate a Chrome binary/device
// signature (x-browser-validation) that cannot be forged off-browser. So we drive
// the user's real logged-in Chrome via opencli and take the bytes from there:
//   - contribution.usercontent.google.com (video): sends credentialed CORS headers,
//     so an in-page fetch() can read the bytes directly (exfil as base64).
//   - lh3.googleusercontent.com (image): sends NO CORS headers, so fetch/canvas are
//     blocked; instead we trigger Chrome's native download and read it back from
//     ~/Downloads.
// Generation stays pure-HTTP; only this byte-fetch step needs the browser.
export async function download(url, destPath, _opts = {}) {
  mkdirSync(dirname(destPath), { recursive: true });
  const host = new URL(url).host;
  if (host.endsWith('usercontent.google.com')) {
    return downloadViaBrowserFetch(url, destPath);
  }
  return downloadViaBrowserNative(url, destPath);
}

// In-page fetch (credentials included) → arrayBuffer → base64, exfiltrated back to
// Node. Works for hosts that return credentialed CORS headers (video CDN).
async function downloadViaBrowserFetch(url, destPath) {
  const { session, tabId } = await ensureSession(getAdapter('gemini'));
  const js = `(async () => {
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
        if (!r.ok) { if (a < 2) { await new Promise((x) => setTimeout(x, 1500)); continue; } return { ok: false, status: r.status }; }
        const buf = new Uint8Array(await r.arrayBuffer());
        let bin = ''; const CH = 8192;
        for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
        return { ok: true, len: buf.length, b64: btoa(bin) };
      } catch (e) { if (a < 2) { await new Promise((x) => setTimeout(x, 1500)); continue; } return { ok: false, error: String(e).slice(0, 150) }; }
    }
  })()`;
  const r = evalSession(session, tabId, js);
  if (!r || !r.ok) {
    const why = r ? r.error || `HTTP ${r.status}` : 'no result from browser';
    throw new WebaiError(`gemini download via browser failed (${new URL(url).host}): ${why}`);
  }
  const bytes = Buffer.from(r.b64, 'base64');
  if (bytes.length !== r.len) {
    throw new WebaiError(`gemini download size mismatch (${bytes.length} != ${r.len}) — transfer truncated.`);
  }
  writeFileSync(destPath, bytes);
  return destPath;
}

// googleusercontent (lh3) doesn't allow programmatic reads, so let Chrome download
// the file natively and pick it up from ~/Downloads. `=s0-d` forces full-resolution
// download disposition (attachment) so navigation saves rather than renders.
function forceDownloadUrl(url) {
  const replaced = url.replace(/=s\d+(-rj)?$/, '=s0-d');
  if (replaced !== url) return replaced;
  if (/=s\d/.test(url)) return url;
  return url + '=s0-d';
}

async function downloadViaBrowserNative(url, destPath, { timeoutMs = 90_000 } = {}) {
  const dlDir = join(homedir(), 'Downloads');
  const dlUrl = forceDownloadUrl(url);
  const before = new Set(readdirSync(dlDir));
  const { session, tabId } = await ensureSession(getAdapter('gemini'));
  // Trigger exactly ONE download via an anchor click. The =s0-d attachment
  // disposition makes this a download (not a navigation), so the tab stays put.
  // A single download needs no permission; issuing a second one (e.g. an iframe
  // too) is what makes Chrome prompt "allow multiple downloads?".
  const js = `(() => {
    const a = document.createElement('a'); a.href = ${JSON.stringify(dlUrl)}; a.download = 'gemini_download';
    document.body.appendChild(a); a.click();
    return true;
  })()`;
  evalSession(session, tabId, js);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const fresh = readdirSync(dlDir).filter((f) => !before.has(f) && !f.endsWith('.crdownload'));
    for (const f of fresh) {
      const p = join(dlDir, f);
      if (!existsSync(p)) continue;
      const s1 = statSync(p).size;
      await new Promise((r) => setTimeout(r, 300));
      if (!existsSync(p)) continue;
      // Stable size + non-empty ⇒ download finished.
      if (s1 > 0 && statSync(p).size === s1) {
        copyFileSync(p, destPath);
        rmSync(p, { force: true });
        return destPath;
      }
    }
  }
  throw new WebaiError(
    `gemini image download timed out: no file appeared in ${dlDir}. ` +
      'On first use Chrome may ask to allow automatic downloads from gemini.google.com — click Allow, then retry. ' +
      'Also ensure Chrome is signed in and its download folder is the default ~/Downloads.'
  );
}

export const gemini = {
  id: 'gemini',
  generateImage,
  submitVideo,
  pollVideo,
  download,
};

export default gemini;
