// Gemini media generation (Veo video + image) over the live UI.
//
// Reverse-engineered 2026-06-24 — see docs/superpowers/recon/gemini-media-recon.md.
// Both video and image generation go through the same StreamGenerate endpoint
// the chat adapter uses; the difference is the "Create video" / "Create image"
// tool mode selected from the composer's "Upload & tools" (+) menu.
//
// Driving the real UI means the page's own SDK builds the anti-abuse token and
// the resumable image upload — we only stage inputs and read results.

import { evalSession } from '../core/session.js';
import { runOpencli } from '../core/opencli.js';

const URL = 'https://gemini.google.com/app';
const COMPOSER = '.ql-editor[contenteditable="true"]';
// Gemini exposes dedicated routes for the generation composers — far more stable
// than driving the "Upload & tools" (+) menu, whose items re-render on click.
const MODE_URL = {
  video: 'https://gemini.google.com/videos',
  image: 'https://gemini.google.com/images',
};

// Extra page-side hook layered on top of core INSTALL_HOOK: swallow the click
// that a dynamically-created <input type=file> fires, so no native OS file
// dialog opens, and keep a handle to it for DataTransfer-based file injection.
const INSTALL_EXTRA_HOOK = `
(() => {
  if (window.__webaiMediaHook) return false;
  window.__webaiMediaHook = true;
  window.__capturedFI = null;
  const origClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if ((this.type || '').toLowerCase() === 'file') {
      window.__capturedFI = this;
      this.setAttribute('data-webai-fi', '1');
      return;
    }
    return origClick.apply(this, arguments);
  };
  return true;
})()
`;

function readyCheck() {
  return `(() => {
    const c = document.querySelector(${JSON.stringify(COMPOSER)});
    return { ready: !!c };
  })()`;
}

function newChatJs() {
  return `(() => { if (!/^\\/app\\/?$/.test(location.pathname)) location.href = '${URL}'; return true; })()`;
}

// Locate (and tag) the reference-image button in the video composer: the first
// button with no aria-label/text sitting in the aspect-ratio row.
function tagImageButtonJs() {
  return `(() => {
    const aspect = Array.from(document.querySelectorAll('button'))
      .find((b) => /Landscape|Portrait|16:9|9:16|Square/.test(b.textContent || ''));
    let row = aspect && aspect.parentElement;
    for (let i = 0; i < 4 && row; i++) { if (row.querySelectorAll('button').length >= 2) break; row = row.parentElement; }
    const btn = row && Array.from(row.querySelectorAll('button'))
      .find((b) => !(b.textContent || '').trim() && !b.getAttribute('aria-label'));
    if (!btn) return { ok: false };
    btn.setAttribute('data-webai-imgbtn', '1');
    return { ok: true };
  })()`;
}

// Inject real file bytes (base64) onto the captured <input type=file> via a
// DataTransfer, then fire input/change so the app uploads it. We can't use
// opencli's `upload` command (its evaluateWithArgs double-declares a marker var
// in v1.8.4) and the native picker is suppressed by INSTALL_EXTRA_HOOK.
function injectFileJs(base64, name, mime) {
  return `(() => {
    const inp = document.querySelector('[data-webai-fi]') || window.__capturedFI;
    if (!inp) return { ok: false, reason: 'no-file-input' };
    const bin = atob(${JSON.stringify(base64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const f = new File([arr], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} });
    const dt = new DataTransfer();
    dt.items.add(f);
    inp.files = dt.files;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, n: inp.files.length };
  })()`;
}

// The staged reference image renders as a blob: <img> in the composer once its
// upload completes (avatar is lh3, templates are googleusercontent — only the
// preview is a blob: of meaningful size).
function stagedPreviewJs() {
  return `(() => {
    const img = Array.from(document.querySelectorAll('img'))
      .find((i) => (i.src || '').startsWith('blob:') && i.naturalWidth >= 256);
    const send = Array.from(document.querySelectorAll('button'))
      .find((b) => /Send message/.test(b.getAttribute('aria-label') || ''));
    const sendOn = send ? (!send.disabled && send.getAttribute('aria-disabled') !== 'true') : false;
    return { staged: !!(img && sendOn) };
  })()`;
}

function findSendButtonJs() {
  return `(() => {
    const b = Array.from(document.querySelectorAll('button,[role=button]'))
      .find((x) => /send message|send/i.test(x.getAttribute('aria-label') || '') && x.offsetParent !== null
        && !x.disabled && x.getAttribute('aria-disabled') !== 'true');
    if (!b) return { ok: false };
    b.click();
    return { ok: true };
  })()`;
}

// After a video submit the SPA routes to /app/<convHex>. Read it back.
function conversationIdJs() {
  return `(() => { const m = (location.pathname || '').match(/\\/app\\/([0-9a-f]{8,})/i); return m ? m[1] : null; })()`;
}

// On the conversation page, report whether the video is ready and its src.
function videoStatusJs() {
  return `(() => {
    const v = document.querySelector('video[src*="usercontent"], video[src*="googleusercontent"]');
    const dl = !!document.querySelector('button[aria-label="Download video"]');
    const txt = (document.body.innerText || '');
    const failed = /can'?t (create|generate)|couldn'?t (create|generate)|violates|safety|blocked|something went wrong/i.test(txt);
    return { ready: !!(v && dl), videoUrl: v ? v.src : null, failed };
  })()`;
}

// Wait for a generated image (rendered as a blob: <img>) plus its download
// button to appear in the latest response. Synchronous-ish (~10s).
function imageStatusJs() {
  return `(() => {
    // The download button is the reliable readiness signal; a freshly loaded
    // conversation may not expose the image as a blob: <img> yet.
    const dl = !!document.querySelector('button[aria-label="Download full size image"]');
    const img = Array.from(document.querySelectorAll('img'))
      .find((i) => (i.src || '').startsWith('blob:') && i.naturalWidth >= 256);
    const txt = (document.body.innerText || '');
    const failed = /can'?t (create|generate)|couldn'?t (create|generate)|violates|safety|blocked|something went wrong/i.test(txt);
    return { ready: dl, width: img ? img.naturalWidth : 0, failed };
  })()`;
}

export const geminiMedia = {
  id: 'gemini-media',
  url: URL,
  domain: 'gemini.google.com',
  // StreamGenerate is the same endpoint the chat adapter captures.
  chatEndpoint: {
    urlMatcher: '/_/BardChatUi/data/assistant\\.lamda\\.BardFrontendService/StreamGenerate',
    methodMatcher: 'POST',
  },
  readyCheck,
  newChatJs,
  installExtraHook: INSTALL_EXTRA_HOOK,
  modeUrl: (mode) => MODE_URL[mode],
  // JS builders, used by the command layer via evalSession.
  tagImageButtonJs,
  injectFileJs,
  findSendButtonJs,
  conversationIdJs,
  videoStatusJs,
  imageStatusJs,
  COMPOSER,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stage a reference image into the (video) composer and wait for its resumable
// upload to finish before the prompt is submitted.
export async function stageImage(session, tabId, base64, name, mime) {
  // The aspect-ratio toolbar (and its reference-image button) renders a beat
  // after the composer itself, so poll for it before tagging.
  let tagged = false;
  for (let i = 0; i < 30; i++) {
    const tag = evalSession(session, tabId, tagImageButtonJs());
    if (tag && tag.ok) { tagged = true; break; }
    await sleep(500);
  }
  if (!tagged) throw new Error('gemini: reference-image button not found in video composer');
  // Click via opencli (CDP native click = trusted gesture); the app then creates
  // its <input type=file> and fires .click() on it, which our hook swallows and
  // captures. A programmatic el.click() does NOT open the picker / create input.
  runOpencli(['browser', session, 'click', '--tab', tabId, '[data-webai-imgbtn]']);
  await new Promise((r) => setTimeout(r, 800));
  const inj = evalSession(session, tabId, injectFileJs(base64, name, mime));
  if (!inj || !inj.ok) throw new Error(`gemini: failed to attach image (${inj?.reason || 'unknown'})`);
  // Wait until the upload finishes and the composer shows the reference-image
  // preview (a blob: <img>) — the reliable readiness signal. The resumable
  // upload itself may go over XHR, so we watch the rendered preview, not fetch.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const ok = evalSession(session, tabId, stagedPreviewJs());
    if (ok && ok.staged) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('gemini: timed out waiting for the reference image to upload');
}

export async function pollMedia(session, tabId, kind, { timeoutMs = 600_000, intervalMs = 4000 } = {}) {
  const statusJs = kind === 'video' ? videoStatusJs() : imageStatusJs();
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = evalSession(session, tabId, statusJs);
    if (last && last.ready) return last;
    if (last && last.failed) throw new Error(`gemini: ${kind} generation was rejected (safety filter or error on the page)`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last || { ready: false };
}
