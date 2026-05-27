// DeepSeek uses XMLHttpRequest, not fetch.
// Chat endpoint: POST /api/v0/chat/completion (SSE event-stream)
// Submit must be triggered with Enter key (button click no-ops without native input).

const URL = 'https://chat.deepseek.com/';
const COMPOSER = 'textarea[placeholder*="DeepSeek"]';
const BUBBLE = '.ds-message';
const SIDEBAR_RE = `^/a/chat/s/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$`;

function readyCheck() {
  return `(() => {
    const ta = document.querySelector(${JSON.stringify(COMPOSER)});
    const avatar = document.querySelector('img[src*="user-avatar"]');
    return { ready: !!(ta && avatar), hasComposer: !!ta, signedIn: !!avatar };
  })()`;
}

function newChatJs() {
  return `(() => {
    if (location.pathname !== '/') {
      const newBtn = Array.from(document.querySelectorAll('a, button, div[role=button]'))
        .find((n) => /new chat|新对话/i.test((n.textContent || '') + ' ' + (n.getAttribute('aria-label') || '')));
      if (newBtn) newBtn.click();
      else location.href = 'https://chat.deepseek.com/';
    }
    return true;
  })()`;
}

// We trigger the composer via CDP fill (handled by command layer), then submit
// with Enter via opencli's CDP `keys Enter` (also handled at command layer).
function submitPromptJs(prompt) {
  // We still need to focus the textarea; the fill+keys sequence runs externally.
  return `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 16; i++) {
      const ta = document.querySelector(${JSON.stringify(COMPOSER)});
      if (ta) { ta.focus(); return { ok: true }; }
      await wait(400);
    }
    return { ok: false, reason: 'no-textarea' };
  })()`;
}

async function submit(helpers, prompt) {
  helpers.fill(COMPOSER, prompt);
  await new Promise((r) => setTimeout(r, 500));
  const res = helpers.eval(`(() => {
    const t = document.querySelector(${JSON.stringify(COMPOSER)});
    if (!t) return { ok: false, reason: 'no-textarea' };
    let c = t.parentElement;
    while (c && !c.querySelector('div[role=button]')) c = c.parentElement;
    const btns = c ? Array.from(c.querySelectorAll('div[role=button]:not(.ds-toggle-button)')) : [];
    if (!btns.length) return { ok: false, reason: 'no-send-button' };
    const sendBtn = btns[btns.length - 1];
    if (sendBtn.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'send-disabled' };
    sendBtn.click();
    return { ok: true };
  })()`);
  if (!res || !res.ok) throw new Error(`deepseek submit failed: ${res?.reason || 'unknown'}`);
}

// Patch BOTH window.fetch (rare) and XMLHttpRequest (primary) so the generic
// session hook still sees DeepSeek's chat completion requests.
const installExtraHook = `
(() => {
  if (window.__webaiXhrPatched) return false;
  window.__webaiXhrPatched = true;
  const O = window.XMLHttpRequest.prototype.open;
  const S = window.XMLHttpRequest.prototype.send;
  window.XMLHttpRequest.prototype.open = function (method, url) {
    this.__webaiMethod = method; this.__webaiUrl = url; return O.apply(this, arguments);
  };
  window.XMLHttpRequest.prototype.send = function (body) {
    const xhr = this;
    xhr.addEventListener('loadend', () => {
      try {
        const cap = window.__webaiCapture;
        if (!cap) return;
        const matcher = cap.nextMatcher;
        const methodMatcher = cap.nextMethodMatcher;
        const tag = cap.nextTag;
        if (matcher && tag && xhr.__webaiUrl && new RegExp(matcher).test(xhr.__webaiUrl) && (!methodMatcher || methodMatcher === xhr.__webaiMethod)) {
          cap.nextTag = null; cap.nextMatcher = null; cap.nextMethodMatcher = null;
          cap.captures[tag] = {
            url: xhr.__webaiUrl, method: xhr.__webaiMethod, status: xhr.status,
            requestHeaders: {}, requestBody: typeof body === 'string' ? body : null,
            responseBody: xhr.responseText || '', completedAt: Date.now(),
          };
        }
      } catch (e) {}
    });
    return S.apply(this, arguments);
  };
  return true;
})()
`;

// Parse SSE response from /api/v0/chat/completion.
// Frames:
//   event: ready\ndata: {request_message_id, response_message_id, model_type}
//   event: update_session\ndata: {updated_at}
//   data: {v: {response: {message_id, fragments: [{type: THINK|TEXT, content: ""}]}}}   — initial full state
//   data: {p: "response/fragments/-1/content", o: "APPEND", v: " text"}                — patch append
//   data: {v: " text"}                                                                  — short-form (same path as previous)
//   data: {p: "response/fragments", o: "APPEND", v: {type, content: ""}}               — add new fragment
function parseResponse(rawBody) {
  let responseId = '';
  let model = '';
  let title = '';
  const fragments = [];
  let lastPath = '';

  const handlePatch = (path, op, v) => {
    if (path === 'response/fragments' && op === 'APPEND') {
      // v may be a single fragment object or an array of fragments
      const list = Array.isArray(v) ? v : [v];
      for (const f of list) {
        if (f && typeof f === 'object') {
          fragments.push({ type: f.type || 'TEXT', content: String(f.content || '') });
        }
      }
      return;
    }
    const m = /^response\/fragments\/(-?\d+)\/content$/.exec(path || '');
    if (m && fragments.length) {
      const idx = parseInt(m[1], 10);
      const real = idx < 0 ? fragments.length + idx : idx;
      if (real >= 0 && real < fragments.length && typeof v === 'string') {
        if (op === 'APPEND' || op === undefined) fragments[real].content += v;
        else if (op === 'SET') fragments[real].content = v;
      }
      return;
    }
    if (path === 'response' && op === 'BATCH' && Array.isArray(v)) {
      for (const sub of v) {
        if (sub && typeof sub === 'object') handlePatch(`response/${sub.p}`, sub.o, sub.v);
      }
    }
  };

  for (const block of rawBody.split('\n\n')) {
    if (!block.trim()) continue;
    let eventName = null;
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const dataStr = dataLines.join('\n');
    if (!dataStr) continue;
    let data;
    try { data = JSON.parse(dataStr); } catch { continue; }

    if (eventName === 'ready') {
      responseId = String(data.response_message_id || '');
      continue;
    }
    if (eventName === 'title' && data.content) { title = data.content; continue; }
    if (eventName === 'update_session' || eventName === 'close') continue;

    // First payload: full state with v.response containing initial fragments
    if (data.v && typeof data.v === 'object' && data.v.response) {
      const resp = data.v.response;
      model = resp.model || model;
      for (const f of resp.fragments || []) {
        fragments.push({ type: f.type || 'TEXT', content: String(f.content || '') });
      }
      lastPath = 'response/fragments/-1/content';
      continue;
    }

    if (data.p !== undefined) lastPath = data.p;
    if (data.v === undefined) continue;
    handlePatch(lastPath, data.o, data.v);
  }

  const isThink = (t) => t === 'THINK';
  const isFinal = (t) => t === 'RESPONSE' || t === 'TEXT' || t === 'TEXT_REASONING';
  const thinking = fragments.filter((f) => isThink(f.type)).map((f) => f.content).join('').trim();
  const final = fragments.filter((f) => isFinal(f.type)).map((f) => f.content).join('').trim()
    || fragments.filter((f) => !isThink(f.type)).map((f) => f.content).join('').trim();
  return { conversationId: '', responseId, title, model, thinking, final, images: [], events: fragments };
}

function scrapeSidebarJs() {
  // DeepSeek sidebar: <a href="/a/chat/s/<uuid>">title</a>
  return `(() => {
    const re = new RegExp(${JSON.stringify(SIDEBAR_RE)}, 'i');
    const out = new Map();
    for (const a of document.querySelectorAll('a[href*="/a/chat/s/"]')) {
      if (!(a instanceof HTMLElement)) continue;
      const m = (a.getAttribute('href') || '').match(re);
      if (!m) continue;
      const id = m[1].toLowerCase();
      const title = (a.innerText || a.textContent || '').trim();
      if (!out.has(id)) out.set(id, title);
      else if (title && !out.get(id)) out.set(id, title);
    }
    return Array.from(out, ([id, title]) => ({ id, title }));
  })()`;
}

function detailUrl(id) { return `https://chat.deepseek.com/a/chat/s/${id}`; }

function scrapeDetailJs(id) {
  return `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const target = ${JSON.stringify('/a/chat/s/' + id)};
    if (location.pathname !== target) location.href = ${JSON.stringify('https://chat.deepseek.com' + '/a/chat/s/' + id)};
    for (let i = 0; i < 40; i++) {
      const bubbles = document.querySelectorAll(${JSON.stringify(BUBBLE)});
      if (location.pathname === target && bubbles.length) break;
      await wait(500);
    }
    const out = { id: ${JSON.stringify(id)}, title: (document.title || '').replace(/\\s*-\\s*DeepSeek.*$/i, '').trim(), messages: [] };
    for (const n of document.querySelectorAll(${JSON.stringify(BUBBLE)})) {
      if (!(n instanceof HTMLElement)) continue;
      // DeepSeek's user/assistant distinction is by class: ds-message contains
      // role-specific subclass. Look at attribute or children to classify.
      const isUser = n.classList.toString().includes('user') || n.querySelector('[class*="user"]');
      const role = isUser ? 'User' : 'Assistant';
      const text = (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim();
      if (text) out.messages.push({ role, text });
    }
    return out;
  })()`;
}

export const adapter = {
  id: 'deepseek',
  url: URL,
  domain: 'chat.deepseek.com',
  chatEndpoint: {
    urlMatcher: '/api/v0/chat/completion(\\?|$)',
    methodMatcher: 'POST',
  },
  readyCheck,
  newChatJs,
  submit,
  installExtraHook,
  parseResponse,
  scrapeSidebarJs,
  scrapeDetailJs,
  detailUrl,
};
