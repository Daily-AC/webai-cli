# webai-cli

Reverse-engineered CLI for the web chat apps of Grok, ChatGPT, Claude, Gemini, and DeepSeek.

Built on top of [opencli](https://www.npmjs.com/package/@jackwener/opencli)'s browser bridge: each command opens a live Chrome tab via the opencli daemon, installs a `window.fetch` + `XMLHttpRequest` hook, drives the site's UI to submit a prompt, then sniffs the streaming chat response from the page-side hook.

This means:

- You stay logged-in in your real Chrome profile — no API keys, no scraping cookies into a file.
- Site anti-bot tokens (Statsig, PoW challenges) are handled by the site's own client SDK; we only piggy-back on the requests it emits.
- We capture the *full* streaming response (thinking traces, token stream, model metadata, generated image URLs), not just the rendered DOM bubble that opencli's stock adapters return.

## Install

```bash
git clone git@github.com:Daily-AC/webai-cli.git
cd webai-cli
npm link        # exposes `webai` globally
```

Prerequisites:
- Node ≥ 20
- [opencli](https://www.npmjs.com/package/@jackwener/opencli) daemon running (`opencli doctor` should report OK)
- Logged-in tab for whichever site(s) you want to use, in the same Chrome profile opencli drives

## Usage

```bash
webai ask <site> <prompt...>        # final answer
webai stream <site> <prompt...>     # tokens / full stream
webai history <site>                # sidebar conversation list
webai detail <site> <id-or-url>     # transcript of one conversation
```

`<site>` is one of: `grok`, `chatgpt`, `claude`, `gemini`, `deepseek`.

Common flags:
- `--json` — JSON output
- `--verbose` — print site / conversationId / model on stderr (for `ask`)
- `--thinking` — include the model's thinking trace (Grok, DeepSeek)
- `--raw` — emit the raw streaming body (for `stream`)
- `--new-chat` — start a fresh conversation before sending
- `--limit <n>` — page size for `history` (default 20, max 100)

Environment:
- `WEBAI_SESSION` — override the opencli browser session name (defaults to `webai-<site>`)

## Architecture

```
bin/webai.js
  └─ src/commands/{ask,stream,history,detail}.js
       └─ src/core/session.js      (open tab + install fetch/XHR hook + arm capture)
       └─ src/sites/<site>.js      (per-site adapter: selectors + SSE parser + DOM scraper)
```

Per-site adapter contract:
- `url` — homepage to land on
- `readyCheck()` — JS predicate `{ ready: boolean }`
- `submit(helpers, prompt)` — fills composer + clicks send via opencli helpers
- `chatEndpoint` — `{ urlMatcher, methodMatcher }` regex for the streaming POST
- `parseResponse(rawBody)` — extracts `{ conversationId, model, thinking, final, images, ... }`
- `scrapeSidebarJs()` / `scrapeDetailJs(id)` / `detailUrl(id)` — DOM-based history and detail

## Endpoint cheat-sheet

| Site | Composer | Submit | Chat endpoint | Response shape |
|---|---|---|---|---|
| Grok | `.ProseMirror[contenteditable]` (TipTap) | `button[aria-label="Submit"]` | `POST /rest/app-chat/conversations/new` | newline-JSON |
| ChatGPT | `#prompt-textarea` | `button[data-testid="send-button"]` | `POST /backend-api/f/conversation` | SSE + JSON-patch deltas |
| Claude | `[data-testid="chat-input"]` | `button[aria-label*="Send"]` | `POST /api/organizations/<org>/chat_conversations/<id>/completion` | Anthropic Messages SSE |
| Gemini | `.ql-editor[contenteditable]` (Quill) | `button[aria-label*="send"]` | `POST /_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate` | wrb.fr chunked |
| DeepSeek | `textarea[placeholder*="DeepSeek"]` | last `div[role="button"]` (XHR) | `POST /api/v0/chat/completion` | SSE + JSON-patch deltas |

## Limitations

- Driven by the live UI: each request needs a focused Chrome tab signed in to the site.
- One concurrent prompt per site (the fetch hook is single-armed per tab).
- Detail/history use DOM scraping because all sites bind their GET endpoints to per-URL Statsig/PoW signatures that aren't reusable across endpoints.
- ChatGPT requires an active (non-deactivated) account; Gemini's history command auto-expands the sidebar.

## License

MIT
