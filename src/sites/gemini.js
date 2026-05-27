// Gemini chat endpoint: POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
// Response is Google's wrb.fr chunked format: ")]}'\n\n<size>\n<json>\n<size>\n<json>..."
// Each JSON chunk is [["wrb.fr", null, "<inner-JSON-string>"]].
// Inner JSON: [null, ["c_<conv>", "r_<resp>"], null, null, [["rc_<id>", [<text>], ...]], ...]

const URL = 'https://gemini.google.com/app';
const COMPOSER = '.ql-editor[contenteditable="true"]';
const SIDEBAR_RE = `^/app/([0-9a-f]{8,})$`;

function readyCheck() {
  return `(() => {
    const c = document.querySelector(${JSON.stringify(COMPOSER)});
    return { ready: !!c, hasComposer: !!c };
  })()`;
}

function newChatJs() {
  return `(() => { if (!/^\\/app\\/?$/.test(location.pathname)) location.href = 'https://gemini.google.com/app'; return true; })()`;
}

function submitPromptJs(prompt) {
  // Composer fill handled externally via CDP (opencli fill). Then we look for
  // the Send button. This script focuses + click-fires after.
  return `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 16; i++) {
      const c = document.querySelector(${JSON.stringify(COMPOSER)});
      if (c) { c.focus(); break; }
      await wait(400);
    }
    // Click send button: look for aria-label or text matching "send"
    for (let i = 0; i < 24; i++) {
      const btn = Array.from(document.querySelectorAll('button, [role=button]')).find((b) => {
        const lbl = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toLowerCase();
        if (!/send|发送|submit/.test(lbl)) return false;
        if (b.disabled) return false;
        if (b.getAttribute('aria-disabled') === 'true') return false;
        if (b.offsetParent === null) return false;
        return true;
      });
      if (btn) { btn.click(); return { ok: true }; }
      await wait(400);
    }
    return { ok: false, reason: 'no-send-button' };
  })()`;
}

async function submit(helpers, prompt) {
  helpers.fill(COMPOSER, prompt);
  await new Promise((r) => setTimeout(r, 400));
  const res = helpers.eval(submitPromptJs(prompt));
  if (!res || !res.ok) throw new Error(`gemini submit failed: ${res?.reason || 'unknown'}`);
}

// Parse wrb.fr chunked response. The size prefixes use UTF-8 byte counts which
// don't align with JS string slicing, so we ignore them and bracket-match each
// `[["wrb.fr", ...]]` block instead.
function* iterChunks(rawBody) {
  let pos = 0;
  while (pos < rawBody.length) {
    const idx = rawBody.indexOf('[["wrb.fr"', pos);
    if (idx === -1) break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = idx; i < rawBody.length; i++) {
      const c = rawBody[i];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end === -1) break;
    const chunk = rawBody.slice(idx, end);
    pos = end;
    try { yield JSON.parse(chunk); } catch {}
  }
}

function parseResponse(rawBody) {
  let conversationId = '';
  let responseId = '';
  let model = '';
  let final = '';
  let title = '';
  const images = [];
  const events = [];

  for (const outer of iterChunks(rawBody)) {
    // outer: [ ["wrb.fr", null, "<inner-json-string>", ...], ... ]
    if (!Array.isArray(outer)) continue;
    for (const entry of outer) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue;
      const innerStr = entry[2];
      if (typeof innerStr !== 'string') continue;
      let inner;
      try { inner = JSON.parse(innerStr); } catch { continue; }
      if (!Array.isArray(inner)) continue;
      // inner[1] = [conv_id, resp_id]
      if (Array.isArray(inner[1])) {
        if (inner[1][0]) conversationId = String(inner[1][0]).replace(/^c_/, '');
        if (inner[1][1]) responseId = String(inner[1][1]).replace(/^r_/, '');
      }
      // inner[4] = [[rc_id, [text_array], ...candidates_metadata]]
      const candidates = inner[4];
      if (Array.isArray(candidates) && candidates.length) {
        const first = candidates[0];
        if (Array.isArray(first) && Array.isArray(first[1]) && typeof first[1][0] === 'string') {
          final = first[1][0];
          events.push({ type: 'candidate', text: final });
        }
        // Model name often at first[37] or similar — search for 'Flash' / 'Pro'
        for (const v of first || []) {
          if (typeof v === 'string' && /\b(flash|pro|nano|gemini)\b/i.test(v) && v.length < 60) {
            model = model || v;
          }
        }
      }
    }
  }
  return { conversationId, responseId, title, model, thinking: '', final, images, events };
}

function scrapeSidebarJs() {
  return `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    // Gemini collapses its sidebar by default; click "Open sidebar" so the
    // conversation anchors render with href + aria-label.
    const opener = document.querySelector('button[aria-label="Open sidebar"]');
    if (opener) { opener.click(); await wait(800); }
    const re = new RegExp(${JSON.stringify(SIDEBAR_RE)}, 'i');
    const out = new Map();
    for (const a of document.querySelectorAll('a[href*="/app/"]')) {
      if (!(a instanceof HTMLElement)) continue;
      const m = (a.getAttribute('href') || '').match(re);
      if (!m) continue;
      const id = m[1];
      const title = (a.getAttribute('aria-label') || a.innerText || a.textContent || '').trim();
      if (!out.has(id)) out.set(id, title);
      else if (title && !out.get(id)) out.set(id, title);
    }
    return Array.from(out, ([id, title]) => ({ id, title }));
  })()`;
}

function detailUrl(id) { return `https://gemini.google.com/app/${id}`; }

function scrapeDetailJs(id) {
  return `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const target = ${JSON.stringify('/app/' + id)};
    if (location.pathname !== target) location.href = ${JSON.stringify('https://gemini.google.com' + '/app/' + id)};
    for (let i = 0; i < 40; i++) {
      const userTurns = document.querySelectorAll('user-query, .user-query-bubble-with-background, [data-test-id="user-query"]');
      const botTurns = document.querySelectorAll('message-content, model-response, .model-response-text');
      if (location.pathname === target && (userTurns.length || botTurns.length)) break;
      await wait(500);
    }
    const out = { id: ${JSON.stringify(id)}, title: (document.title || '').replace(/\\s*-\\s*Gemini.*$/i, '').trim(), messages: [] };
    // Gemini turns: alternating user-query and model-response components
    const containers = document.querySelectorAll('user-query, .user-query-bubble-with-background, [data-test-id="user-query"], model-response, message-content, .model-response-text');
    for (const n of containers) {
      if (!(n instanceof HTMLElement)) continue;
      const tag = (n.tagName || '').toLowerCase();
      const cls = n.className || '';
      const isUser = tag.includes('user-query') || /user/.test(cls);
      const role = isUser ? 'User' : 'Assistant';
      const text = (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim();
      if (text) out.messages.push({ role, text });
    }
    return out;
  })()`;
}

export const adapter = {
  id: 'gemini',
  url: URL,
  domain: 'gemini.google.com',
  chatEndpoint: {
    urlMatcher: '/_/BardChatUi/data/assistant\\.lamda\\.BardFrontendService/StreamGenerate',
    methodMatcher: 'POST',
  },
  readyCheck,
  newChatJs,
  submit,
  // Same XHR patch as deepseek so the generic capture sees StreamGenerate.
  installExtraHook: `
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
            const m = cap.nextMatcher, mm = cap.nextMethodMatcher, tag = cap.nextTag;
            if (m && tag && xhr.__webaiUrl && new RegExp(m).test(xhr.__webaiUrl) && (!mm || mm === xhr.__webaiMethod)) {
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
  `,
  parseResponse,
  scrapeSidebarJs,
  scrapeDetailJs,
  detailUrl,
};
