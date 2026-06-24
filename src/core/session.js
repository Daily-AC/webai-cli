import * as crypto from 'node:crypto';
import { openUrl, evalInTab, runOpencli } from './opencli.js';

// Page-side fetch hook. Captures outgoing request + cloned response body for any
// fetch matching an armed regex, keyed by `tag`. We re-arm before each operation
// because a single hook can only buffer one outstanding capture per tag.
const HOOK_VERSION = 3;
const INSTALL_HOOK = `
(() => {
  if (window.__webaiHookVersion === ${HOOK_VERSION}) return { installed: false };
  window.__webaiHookVersion = ${HOOK_VERSION};
  window.__webaiCapture = window.__webaiCapture || { captures: {}, nextTag: null, nextMatcher: null, nextMethodMatcher: null };
  window.__webaiCapture.nextTag = null; window.__webaiCapture.nextMatcher = null; window.__webaiCapture.nextMethodMatcher = null;
  const cap = window.__webaiCapture;
  const orig = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    let url = '';
    let method = 'GET';
    let reqHeaders = {};
    let reqBody = null;
    try {
      url = typeof input === 'string' ? input : input.url;
      method = (init && init.method) || (typeof input !== 'string' && input.method) || 'GET';
      const hSrc = (init && init.headers) || (typeof input !== 'string' && input.headers) || null;
      if (hSrc) {
        if (typeof hSrc.forEach === 'function') hSrc.forEach((v, k) => { reqHeaders[k] = v; });
        else for (const k of Object.keys(hSrc)) reqHeaders[k] = hSrc[k];
      }
      const rawBody = (init && init.body) || null;
      if (rawBody) {
        if (typeof rawBody === 'string') reqBody = rawBody;
        else try { reqBody = await new Response(rawBody).text(); } catch (e) { reqBody = String(rawBody); }
      }
    } catch (e) {}
    const matcher = cap.nextMatcher;
    const methodMatcher = cap.nextMethodMatcher;
    const tag = cap.nextTag;
    const hit = matcher && url && new RegExp(matcher).test(url) && (!methodMatcher || methodMatcher === method);
    const resp = await orig(input, init);
    if (hit && tag) {
      cap.nextTag = null;
      cap.nextMatcher = null;
      cap.nextMethodMatcher = null;
      const status = resp.status;
      // Drain the clone explicitly via the stream reader so SSE / chunked
      // responses are captured even when the page is also consuming the body.
      (async () => {
        try {
          const reader = resp.clone().body.getReader();
          const chunks = [];
          while (true) {
            const r = await reader.read();
            if (r.done) break;
            chunks.push(r.value);
          }
          const total = chunks.reduce((s, c) => s + c.length, 0);
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) { merged.set(c, off); off += c.length; }
          cap.captures[tag] = {
            url, method, status,
            requestHeaders: reqHeaders, requestBody: reqBody,
            responseBody: new TextDecoder('utf-8').decode(merged), completedAt: Date.now(),
          };
        } catch (err) {
          cap.captures[tag] = { url, method, status, error: String(err), completedAt: Date.now() };
        }
      })();
    }
    return resp;
  };

  // Also patch XMLHttpRequest. Some sites (DeepSeek, Claude) use XHR.
  const OX = window.XMLHttpRequest.prototype.open;
  const SX = window.XMLHttpRequest.prototype.send;
  window.XMLHttpRequest.prototype.open = function (method, url) {
    this.__webaiMethod = method; this.__webaiUrl = url;
    return OX.apply(this, arguments);
  };
  window.XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    xhr.addEventListener('loadend', () => {
      try {
        const c = window.__webaiCapture;
        if (!c) return;
        const m = c.nextMatcher, mm = c.nextMethodMatcher, tag = c.nextTag;
        if (m && tag && xhr.__webaiUrl && new RegExp(m).test(xhr.__webaiUrl) && (!mm || mm === xhr.__webaiMethod)) {
          c.nextTag = null; c.nextMatcher = null; c.nextMethodMatcher = null;
          c.captures[tag] = {
            url: xhr.__webaiUrl, method: xhr.__webaiMethod, status: xhr.status,
            requestHeaders: {}, requestBody: typeof body === 'string' ? body : null,
            responseBody: xhr.responseText || '', completedAt: Date.now(),
          };
        }
      } catch (e) {}
    });
    return SX.apply(this, arguments);
  };

  return { installed: true };
})()
`;

export async function ensureSession(adapter, { url } = {}) {
  const session = process.env.WEBAI_SESSION || `webai-${adapter.id}`;
  const tabId = openUrl(session, url || adapter.url);
  evalInTab(session, tabId, INSTALL_HOOK);
  if (adapter.installExtraHook) evalInTab(session, tabId, adapter.installExtraHook);
  for (let i = 0; i < 50; i++) {
    const ready = evalInTab(session, tabId, adapter.readyCheck());
    if (ready && ready.ready) return { session, tabId, helpers: makeHelpers(session, tabId) };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `webai: ${adapter.id} not ready in the browser tab. Sign in at ${adapter.url} (in Chrome) and retry.`
  );
}

function makeHelpers(session, tabId) {
  return {
    eval: (js) => evalInTab(session, tabId, js),
    fill: (selector, text) => {
      const out = runOpencli(['browser', session, 'fill', '--tab', tabId, selector, text]);
      try { return JSON.parse(out); } catch { return out; }
    },
    keys: (key) => runOpencli(['browser', session, 'keys', '--tab', tabId, key]),
    click: (selector) => runOpencli(['browser', session, 'click', '--tab', tabId, selector]),
    goto: (url) => runOpencli(['browser', session, 'open', url]),
  };
}

export async function captureNext(session, tabId, { urlMatcher, methodMatcher, action, timeoutMs = 180_000 }) {
  const tag = 'cap-' + crypto.randomUUID();
  const armJs = `(() => {
    const c = window.__webaiCapture;
    c.nextMatcher = ${JSON.stringify(urlMatcher)};
    c.nextMethodMatcher = ${JSON.stringify(methodMatcher || null)};
    c.nextTag = ${JSON.stringify(tag)};
    return true;
  })()`;
  evalInTab(session, tabId, armJs);
  await action();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cap = evalInTab(session, tabId, `(window.__webaiCapture.captures[${JSON.stringify(tag)}] || null)`);
    if (cap && cap.completedAt) return cap;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`webai: timed out waiting for fetch matching /${urlMatcher}/${methodMatcher ? ` (${methodMatcher})` : ''}`);
}

export function evalSession(session, tabId, js) {
  return evalInTab(session, tabId, js);
}
