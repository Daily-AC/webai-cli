// Gemini provider — direct-HTTP implementation of the media contract (spec §4.3).
//   generateImage(prompt, opts) -> { images, meta }
//   submitVideo(prompt, opts)   -> { jobId, meta }
//   pollVideo(jobId)            -> { status, video?, progress? }
//   download(url, destPath, opts) -> localPath   (Gemini 206 polling semantics)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { request, errorForStatus } from '../../http/client.js';
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

// Download a media URL to destPath. Handles Gemini's 206 "still rendering"
// semantics by sleeping and retrying until the file materializes (200).
export async function download(url, destPath, { poll206 = false, timeoutMs = 600_000, sleepMs = 10_000 } = {}) {
  const rec = getProvider('gemini');
  const cookieHeader = rec ? buildCookieHeader(rec.cookies) : '';
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const res = await request(url, {
      headers: { 'User-Agent': UA, Referer: REFERER, Cookie: cookieHeader },
      timeoutMs: 120_000,
      retries: 2,
    });
    if (res.status === 200) {
      const buf = Buffer.from(await res.arrayBuffer());
      mkdirSync(dirname(destPath), { recursive: true });
      writeFileSync(destPath, buf);
      return destPath;
    }
    if (res.status === 206 && poll206) {
      if (Date.now() > deadline) throw new WebaiError('Timed out waiting for video render (repeated 206).');
      await new Promise((r) => setTimeout(r, sleepMs));
      continue;
    }
    // 403 here is NOT an auth problem: the media CDN (contribution.usercontent.
    // google.com) rejects plain undici at the TLS layer. Surface it as a generic
    // error rather than mislabeling it as expired credentials.
    if (res.status === 403) {
      throw new WebaiError(
        `gemini download refused (HTTP 403) by ${new URL(url).host}. This host enforces client ` +
          'fingerprinting; direct-HTTP download is not currently supported for this URL.'
      );
    }
    const httpErr = errorForStatus(res.status, `gemini download ${res.status}`);
    throw httpErr || new WebaiError(`gemini download unexpected HTTP ${res.status}`);
  }
}

export const gemini = {
  id: 'gemini',
  generateImage,
  submitVideo,
  pollVideo,
  download,
};

export default gemini;
