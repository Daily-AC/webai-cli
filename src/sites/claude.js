// Claude (claude.ai) chat endpoint:
//   POST /api/organizations/<org-uuid>/chat_conversations/<conv-uuid>/completion
//   Content-Type: text/event-stream
//
// Uses the standard Anthropic Messages-API SSE shape:
//   event: message_start    data: {message:{id,model,...}}
//   event: content_block_start  data: {index,content_block:{type:"text",text:""}}
//   event: content_block_delta  data: {index,delta:{type:"text_delta",text:"..."}}
//   event: content_block_stop
//   event: message_delta    data: {delta:{stop_reason,...}}
//   event: message_stop
//
// Uses '\r\n' line endings.

const URL = 'https://claude.ai/new';
const COMPOSER = '[data-testid="chat-input"]';
const SIDEBAR_RE = `^/chat/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`;

function readyCheck() {
  return `(() => {
    const c = document.querySelector(${JSON.stringify(COMPOSER)});
    const userMenu = document.querySelector('[data-testid="user-menu-button"]');
    return { ready: !!(c && userMenu), hasComposer: !!c, signedIn: !!userMenu };
  })()`;
}

function newChatJs() {
  return `(() => { if (location.pathname !== '/new') location.href = 'https://claude.ai/new'; return true; })()`;
}

function submitPromptJs() {
  // After CDP fill, the send button becomes enabled. Click it.
  return `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => {
        const lbl = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toLowerCase();
        if (!/send/.test(lbl)) return false;
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
  await new Promise((r) => setTimeout(r, 500));
  const res = helpers.eval(submitPromptJs());
  if (!res || !res.ok) throw new Error(`claude submit failed: ${res?.reason || 'unknown'}`);
}

function parseResponse(rawBody) {
  let conversationId = '';
  let responseId = '';
  let model = '';
  let final = '';
  let stopReason = '';
  const events = [];

  // Parse SSE blocks (separated by \r\n\r\n or \n\n)
  const blocks = rawBody.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let eventName = null;
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const dataStr = dataLines.join('\n');
    if (!dataStr) continue;
    let data;
    try { data = JSON.parse(dataStr); } catch { continue; }

    if (eventName === 'message_start' && data.message) {
      responseId = data.message.uuid || data.message.id || responseId;
      model = data.message.model || model;
    } else if (eventName === 'content_block_delta' && data.delta) {
      if (data.delta.type === 'text_delta' && typeof data.delta.text === 'string') {
        final += data.delta.text;
        events.push({ type: 'token', text: data.delta.text });
      }
    } else if (eventName === 'message_delta' && data.delta) {
      stopReason = data.delta.stop_reason || stopReason;
    }
  }
  return { conversationId, responseId, title: '', model, thinking: '', final: final.trim(), images: [], events, stopReason };
}

function scrapeSidebarJs() {
  return `(() => {
    const re = new RegExp(${JSON.stringify(SIDEBAR_RE)}, 'i');
    const out = new Map();
    for (const a of document.querySelectorAll('a[href^="/chat/"]')) {
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

function detailUrl(id) { return `https://claude.ai/chat/${id}`; }

function scrapeDetailJs(id) {
  return `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const target = ${JSON.stringify('/chat/' + id)};
    if (location.pathname !== target) location.href = ${JSON.stringify('https://claude.ai' + '/chat/' + id)};
    for (let i = 0; i < 40; i++) {
      const hasMsgs = document.querySelectorAll('.font-claude-response, [data-testid="user-message"]').length > 0;
      if (location.pathname === target && hasMsgs) break;
      await wait(500);
    }
    const out = { id: ${JSON.stringify(id)}, title: (document.title || '').replace(/\\s*-\\s*Claude.*$/i, '').trim(), messages: [] };
    // Claude DOM: human turns lack a special testid but live in .font-user-message
    // assistant turns are .font-claude-response.
    const userTurns = Array.from(document.querySelectorAll('[data-testid="user-message"], .font-user-message'));
    const botTurns = Array.from(document.querySelectorAll('.font-claude-response'));
    const all = [...userTurns.map((n) => ({ n, role: 'User' })), ...botTurns.map((n) => ({ n, role: 'Assistant' }))];
    all.sort((a, b) => {
      const c = a.n.compareDocumentPosition(b.n);
      if (c & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (c & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    for (const { n, role } of all) {
      const text = (n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim();
      if (text) out.messages.push({ role, text });
    }
    return out;
  })()`;
}

export const adapter = {
  id: 'claude',
  url: URL,
  domain: 'claude.ai',
  chatEndpoint: {
    urlMatcher: '/api/organizations/[0-9a-f-]+/chat_conversations/[0-9a-f-]+/completion(\\?|$)',
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
