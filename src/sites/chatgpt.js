// ChatGPT chat endpoint:
//   POST https://chatgpt.com/backend-api/f/conversation
//   Content-Type: text/event-stream
//
// Delta encoding v1: each `event: delta` carries either
//   data: {"p":"","o":"add","v":{"message":{...,author:{role},content:{parts:[]}}},"c":<idx>}
//   data: {"o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"text"}], "c":<idx>}
//   data: {"v":"text"}   (short-form append to last path)
// Stream terminates with `data: [DONE]`.

const URL = 'https://chatgpt.com/';
const COMPOSER = '#prompt-textarea';
const SIDEBAR_RE = `^/c/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`;

function readyCheck() {
  return `(() => {
    const c = document.querySelector(${JSON.stringify(COMPOSER)});
    return { ready: !!c, hasComposer: !!c };
  })()`;
}

function newChatJs() {
  return `(() => { if (location.pathname !== '/') location.href = 'https://chatgpt.com/'; return true; })()`;
}

function submitPromptJs() {
  return `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) {
      const btn = document.querySelector('button[data-testid="send-button"]:not([disabled])')
        || document.querySelector('#composer-submit-button:not([disabled])');
      if (btn) { btn.click(); return { ok: true }; }
      await wait(400);
    }
    return { ok: false, reason: 'no-send-button' };
  })()`;
}

async function submit(helpers, prompt) {
  helpers.fill(COMPOSER, prompt);
  await new Promise((r) => setTimeout(r, 500));
  const res = helpers.eval(submitPromptJs());
  if (!res || !res.ok) throw new Error(`chatgpt submit failed: ${res?.reason || 'unknown'}`);
}

function parseResponse(rawBody) {
  // Track messages keyed by 'c' channel index, plus a parallel store of the
  // last-touched message for patches that omit c (they implicitly target the
  // last channel that received a `v.message` payload).
  const byChannel = new Map();   // c-index (string) -> { role, parts, id, contentType }
  let lastChannel = null;
  let lastPath = null;
  let model = '';
  let conversationId = '';
  let title = '';

  const upsertMessage = (channel, msg) => {
    const role = msg?.author?.role;
    const ct = msg?.content?.content_type;
    const parts = (msg?.content?.parts || []).slice();
    byChannel.set(channel, { id: msg.id, role, contentType: ct, parts });
    lastChannel = channel;
  };

  const applySubPatch = (sub) => {
    if (!sub || typeof sub !== 'object') return;
    if (sub.p) lastPath = sub.p;
    if (sub.p === '/message/content/parts/0' && sub.o === 'append' && typeof sub.v === 'string') {
      const m = lastChannel != null ? byChannel.get(lastChannel) : null;
      if (m) m.parts[0] = (m.parts[0] || '') + sub.v;
    }
  };

  for (const block of rawBody.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let eventName = null;
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const dataStr = dataLines.join('\n').trim();
    if (!dataStr || dataStr === '[DONE]' || dataStr === '"v1"') continue;
    let data;
    try { data = JSON.parse(dataStr); } catch { continue; }

    if (data.conversation_id && !conversationId) conversationId = data.conversation_id;
    if (data.type === 'title_generation' && data.title) title = data.title;
    if (data.v?.message?.metadata?.model_slug && !model) model = data.v.message.metadata.model_slug;
    if (data.v?.message?.metadata?.resolved_model_slug && !model) model = data.v.message.metadata.resolved_model_slug;

    // Form 1: full add — `{p:"", o:"add", v:{message,...}, c:N}`
    if (data.o === 'add' && data.p === '' && data.v?.message) {
      const ch = String(data.c ?? lastChannel ?? 0);
      upsertMessage(ch, data.v.message);
      continue;
    }

    // Form 2: short-form add — `{v:{message,...}, c:N}` (no o, no p)
    if (data.o === undefined && data.p === undefined && data.v?.message && data.c !== undefined) {
      upsertMessage(String(data.c), data.v.message);
      continue;
    }

    // Form 3: patch batch — `{o:"patch", v:[<sub>,...], c?:N}`
    if (data.o === 'patch' && Array.isArray(data.v)) {
      if (data.c !== undefined) lastChannel = String(data.c);
      for (const sub of data.v) applySubPatch(sub);
      continue;
    }

    // Form 4: single sub-patch at top level — `{p:"/path", o:"append"|"replace", v:...}`
    if (data.p && data.o) {
      applySubPatch({ p: data.p, o: data.o, v: data.v });
      continue;
    }

    // Form 5: short-form continuation — `{v:"text"}` after a patch on /message/content/parts/0
    if (data.v !== undefined && data.p === undefined && data.o === undefined
        && lastPath === '/message/content/parts/0' && typeof data.v === 'string') {
      const m = lastChannel != null ? byChannel.get(lastChannel) : null;
      if (m) m.parts[0] = (m.parts[0] || '') + data.v;
    }
  }

  const assistantTextMsgs = Array.from(byChannel.values()).filter(
    (m) => m.role === 'assistant' && m.contentType === 'text'
  );
  const final = assistantTextMsgs.map((m) => (m.parts || []).filter((p) => typeof p === 'string').join('')).join('').trim();
  return { conversationId, responseId: assistantTextMsgs[0]?.id || '', title, model, thinking: '', final, images: [], events: [] };
}

function scrapeSidebarJs() {
  return `(() => {
    const re = new RegExp(${JSON.stringify(SIDEBAR_RE)}, 'i');
    const out = new Map();
    for (const a of document.querySelectorAll('a[href^="/c/"]')) {
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

function detailUrl(id) { return `https://chatgpt.com/c/${id}`; }

function scrapeDetailJs(id) {
  return `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const target = ${JSON.stringify('/c/' + id)};
    if (location.pathname !== target) location.href = ${JSON.stringify('https://chatgpt.com' + '/c/' + id)};
    for (let i = 0; i < 40; i++) {
      const turns = document.querySelectorAll('[data-message-author-role]');
      if (location.pathname === target && turns.length) break;
      await wait(500);
    }
    const out = { id: ${JSON.stringify(id)}, title: (document.title || '').replace(/\\s*[\\u2014-]\\s*ChatGPT.*$/i, '').trim(), messages: [] };
    for (const n of document.querySelectorAll('[data-message-author-role]')) {
      if (!(n instanceof HTMLElement)) continue;
      const role = n.getAttribute('data-message-author-role') === 'assistant' ? 'Assistant' : 'User';
      const text = (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim();
      if (text) out.messages.push({ role, text });
    }
    return out;
  })()`;
}

export const adapter = {
  id: 'chatgpt',
  url: URL,
  domain: 'chatgpt.com',
  chatEndpoint: {
    urlMatcher: 'chatgpt\\.com/backend-api/f/conversation(\\?|$|[^/])',
    methodMatcher: 'POST',
  },
  readyCheck,
  newChatJs,
  submit,
  parseResponse,
  scrapeSidebarJs,
  scrapeDetailJs,
  detailUrl,
};
