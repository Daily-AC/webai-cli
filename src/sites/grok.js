const URL = 'https://grok.com/';
const COMPOSER = '.ProseMirror[contenteditable=true]';
const SUBMIT = 'button[aria-label="Submit"]';
const BUBBLE = '[data-testid="user-message"], [data-testid="assistant-message"]';
const SIDEBAR_RE = `^/c/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`;

function readyCheck() {
  return `(() => {
    const c = document.querySelector(${JSON.stringify(COMPOSER)});
    return { ready: !!(c && c.editor) };
  })()`;
}

function newChatJs() {
  return `(() => { if (location.pathname !== '/') location.href = ${JSON.stringify(URL)}; return true; })()`;
}

function submitPromptJs(prompt) {
  return `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let composer = null;
    for (let i = 0; i < 14; i++) {
      const c = document.querySelector(${JSON.stringify(COMPOSER)});
      if (c && c.editor) { composer = c; break; }
      await wait(400);
    }
    if (!composer) return { ok: false, reason: 'no-composer' };
    composer.editor.commands.focus();
    composer.editor.commands.clearContent();
    composer.editor.commands.insertContent(${JSON.stringify(prompt)});
    await wait(400);
    let btn = null;
    for (let i = 0; i < 14; i++) {
      btn = Array.from(document.querySelectorAll(${JSON.stringify(SUBMIT)}))
        .find((b) => !b.disabled && b.offsetParent !== null);
      if (btn) break;
      await wait(400);
    }
    if (!btn) return { ok: false, reason: 'no-submit' };
    btn.click();
    return { ok: true };
  })()`;
}

function parseFrames(rawBody) {
  const out = [];
  for (const line of rawBody.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch {}
  }
  return out;
}

function parseResponse(rawBody) {
  let thinking = '', final = '', conversationId = '', responseId = '', title = '', model = '';
  const generatedImageUrls = [];
  const events = [];
  for (const frame of parseFrames(rawBody)) {
    const r = frame?.result;
    if (!r) continue;
    if (r.conversation?.conversationId) conversationId = r.conversation.conversationId;
    if (r.title?.newTitle) title = r.title.newTitle;
    const resp = r.response;
    if (!resp) continue;
    if (resp.token !== undefined) {
      if (resp.isThinking) thinking += resp.token;
      else final += resp.token;
      events.push({ type: resp.isThinking ? 'thinking' : 'token', text: resp.token });
    }
    if (resp.modelResponse) {
      responseId = resp.modelResponse.responseId || responseId;
      model = resp.modelResponse.model || model;
      if (resp.modelResponse.message) final = resp.modelResponse.message;
      for (const u of resp.modelResponse.generatedImageUrls || []) generatedImageUrls.push(u);
    }
  }
  return {
    conversationId, responseId, title, model,
    thinking: thinking.trim(), final: final.trim(),
    images: generatedImageUrls, events,
  };
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

function detailUrl(id) { return `https://grok.com/c/${id}`; }

function scrapeDetailJs(id) {
  return `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const target = ${JSON.stringify('/c/' + id)};
    if (location.pathname !== target) location.href = ${JSON.stringify('https://grok.com' + '/c/' + id)};
    for (let i = 0; i < 40; i++) {
      const bubbles = document.querySelectorAll(${JSON.stringify(BUBBLE)});
      if (location.pathname === target && bubbles.length) break;
      await wait(500);
    }
    const findResponseId = (n) => {
      let p = n.parentElement;
      while (p && p !== document.body) {
        const id = p.getAttribute('id') || '';
        if (id.startsWith('response-')) return id.slice('response-'.length);
        p = p.parentElement;
      }
      return '';
    };
    const out = { id: ${JSON.stringify(id)}, title: (document.title || '').replace(/\\s*[\\u2013\\u2014\\-]\\s*Grok\\s*$/i, '').trim(), messages: [] };
    for (const n of document.querySelectorAll(${JSON.stringify(BUBBLE)})) {
      if (!(n instanceof HTMLElement)) continue;
      const role = n.getAttribute('data-testid') === 'assistant-message' ? 'Assistant' : 'User';
      const text = (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim();
      out.messages.push({ responseId: findResponseId(n), role, text });
    }
    return out;
  })()`;
}

async function submit(helpers, prompt) {
  const res = helpers.eval(submitPromptJs(prompt));
  if (!res || !res.ok) throw new Error(`grok submit failed: ${res?.reason || 'unknown'}`);
}

export const adapter = {
  id: 'grok',
  url: URL,
  domain: 'grok.com',
  chatEndpoint: {
    urlMatcher: 'grok\\.com/rest/app-chat/conversations(/new|/[0-9a-f-]+/responses)',
    methodMatcher: 'POST',
  },
  readyCheck,
  newChatJs,
  submit,
  parseResponse,
  scrapeSidebarJs,
  scrapeDetailJs,
  detailUrl,
  imageAssetReferer: 'https://grok.com/',
};
