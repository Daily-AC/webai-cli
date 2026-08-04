# webai-cli

Direct-HTTP and browser-assisted CLI for web AI services.

`webai-cli` owns browser-session credentials and the provider-specific web
protocols. Its direct chat path does not start Chrome or opencli. A local
OpenAI-compatible sidecar can sit behind
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), which acts only as a
protocol relay and never receives the upstream cookies.

Gemini and Doubao are exposed by the stable sidecar. DeepSeek, Claude, and
ChatGPT have direct transports but remain behind `webai serve --experimental`
until each implementation has passed a valid-login completion against its live
web service. Grok, history/detail, and some media paths remain legacy
browser-assisted commands.

The direct path provides:

- Secure interactive login with a live text round-trip before credentials are saved.
- Cookie and token-bundle import from stdin or file without browser automation.
- A structured, domain/path/expiry-aware cookie jar stored with owner-only permissions.
- Direct streaming HTTP transports for Gemini, Doubao, DeepSeek, Claude, and ChatGPT.
- Local TLS browser impersonation for Claude and ChatGPT without a browser process.
- OpenAI `/v1/chat/completions` streaming and non-streaming endpoints.
- A narrow credential boundary: CLIProxyAPI sees only a local bearer token.

## Install

```bash
git clone git@github.com:Daily-AC/webai-cli.git
cd webai-cli
npm link        # exposes `webai` globally
```

Prerequisites:

- Node ≥ 20
- An exported web login session for each provider you enable
- Optional: [opencli](https://www.npmjs.com/package/@jackwener/opencli) and Chrome only for legacy browser commands

## Usage

### Log in and verify

The normal path is interactive. Credential input is hidden, a minimal real chat
request verifies the complete provider path, and the credential store is changed
only after that request returns text and finishes successfully:

```bash
webai auth login gemini
webai auth login doubao
webai auth login deepseek
webai auth login claude
webai auth login chatgpt
```

DeepSeek prompts separately for the full Cookie header and
`localStorage.userToken`. The other providers prompt once for a full Cookie
header. Prompts and progress go to stderr, so `--json` keeps stdout
machine-readable.

Automation can use the same verified login transaction:

```bash
credential-command | webai auth login gemini --stdin --json
webai auth login claude --file ./claude-credentials.json --json
```

Do not place credential values in command arguments; they can leak through shell
history and process listings. Verified credentials are written atomically to
`~/.config/webai-cli/creds.json` with mode `0600`. A failed verification leaves
the previous provider credential byte-for-byte unchanged.

The verifier sends a short `webai-ok` prompt through the same direct provider
used by `ask` and the sidecar. Gemini uses a temporary chat, but other services
may add the probe to account history.

Claude can return a Cloudflare challenge before its application sees the
request. `auth login` reports that as `cloudflare_blocked`, separately from an
invalid `sessionKey`, and does not save the candidate. A copied Cookie header is
only sufficient when Cloudflare accepts the new client session; a
`cf_clearance` cookie, when issued, can be tied to the source visitor/device and
may not transfer to the local TLS transport. The no-browser transport detects
this condition but does not execute Cloudflare's JavaScript challenge.

### Offline credential import

`auth import` parses and stores credentials without contacting the provider. It
is useful for migration and debugging, but it does not prove that chat works:

```bash
cookie-export-command | webai auth import gemini --stdin
cookie-export-command | webai auth import doubao --stdin
```

DeepSeek needs both the full Cookie header and the bearer value from
`localStorage.userToken`. Claude and ChatGPT accept credential bundles too:

```json
{"cookies":"full Cookie header","token":"DeepSeek bearer token"}
{"cookies":"sessionKey=Claude session value"}
{"cookies":"__Secure-next-auth.session-token=ChatGPT session value"}
```

Pass one JSON object through stdin or a private file:

```bash
credential-command | webai auth import deepseek --stdin
credential-command | webai auth import claude --stdin
credential-command | webai auth import chatgpt --stdin
```

For a verified automated setup, replace `auth import` with `auth login` in the
commands above.

### Direct chat

```bash
webai ask doubao "Reply exactly: pong"
webai stream gemini "Explain direct HTTP in one sentence"
webai ask deepseek --thinking "Check 17 * 23"
```

| Model | Direct CLI | Sidecar | Credential | Verification |
|---|---|---|---|---|
| `gemini-web` | yes | stable | Google Cookie header/jar | valid-login live completion |
| `doubao-web` | yes | stable | Doubao Cookie header/jar | valid-login live completion and stream |
| `deepseek-web` | experimental | experimental | Cookie header + `localStorage.userToken` | live PoW verified; valid-login completion pending |
| `claude-web` | experimental | experimental | full Cookie header containing `sessionKey` | live Cloudflare classification verified; valid-login completion pending |
| `chatgpt-web` | scaffold | experimental | NextAuth session cookie | known Sentinel/Conduit drift; valid-login completion pending |

"Stable" describes the implementation, not the lifetime of a web login. Expired
or remotely invalidated cookies return a typed `401 upstream_auth_error`; rerun
`webai auth login <provider>` with a fresh browser session.

### OpenAI-compatible sidecar

```bash
webai serve --token-file ~/.config/webai-cli/server-token
webai serve --experimental --token-file ~/.config/webai-cli/server-token
```

The server binds `127.0.0.1:8787`. The first command exposes only
`gemini-web` and `doubao-web`; the second also advertises the three experimental
models. See [docs/cliproxyapi.md](docs/cliproxyapi.md) for the complete
CLIProxyAPI config and compatibility boundary.

### Legacy browser commands

```bash
webai ask <site> <prompt...>        # final answer
webai stream <site> <prompt...>     # tokens / full stream
webai history <site>                # sidebar conversation list
webai detail <site> <id-or-url>     # transcript of one conversation
```

`<site>` is one of: `grok`, `chatgpt`, `claude`, `gemini`, `deepseek`, `doubao`.
`ask` and `stream` use direct HTTP for every site except Grok. `history` and
`detail` remain browser-assisted.

### Media generation (Gemini)

Generate video (Veo) and images, downloading the result locally:

```bash
# Text -> image (synchronous)
webai image gemini "a red maple leaf on still water" --out ./leaf.png

# Text -> video (async: submit returns a job id, status downloads when ready)
webai video gemini submit "a paper boat down a rainy gutter"   # -> <job-id>
webai video gemini status <job-id> --out ./boat.mp4

# Image + prompt -> video (animate a photo)
webai video gemini submit "gentle morning light, slow push-in" --image ./photo.jpg
webai video gemini status <job-id> --out ./out.mp4
```

Flags: `--image <path>` (reference image for image→video), `--out <path>` (file or
dir), `--once` (one-shot non-blocking `status` check; exit 3 = still generating),
`--json`. Requires the Gemini account to have Veo/video access.

#### `gemini-media` skill (Claude Code / Codex)

`skills/gemini-media/` wraps these commands as a skill. Install by symlinking it
into your skills dir:

```bash
ln -s "$PWD/skills/gemini-media" ~/.claude/skills/gemini-media
```

Common flags:

- `--json` — JSON output
- `--verbose` — print site / conversationId / model on stderr (for `ask`)
- `--thinking` — include the model's thinking trace (Grok, DeepSeek)
- `--raw` — emit the raw streaming body (for `stream`)
- `--new-chat` — start a fresh conversation before sending
- `--limit <n>` — page size for `history` (default 20, max 100)

Environment:

- `WEBAI_SERVER_TOKEN` — bearer token for `webai serve` (a private `--token-file` is preferred)
- `WEBAI_SESSION` — override the opencli browser session name (defaults to `webai-<site>`)

## Architecture

```
bin/webai.js
  ├─ src/commands/serve.js
  │    ├─ src/server/openai.js
  │    └─ src/providers/{gemini,doubao,deepseek,claude,chatgpt}/
  │         ├─ direct provider protocol
  │         └─ src/auth/{store,cookies}.js
  ├─ src/commands/{ask,stream}.js                 (direct-first)
  └─ src/commands/{history,detail}.js             (legacy browser path)
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

- The sidecar currently supports text chat only. Structured tools and
  `/responses/compact` are explicitly rejected, so Claude Code and Codex agent
  loops are not yet supported even though CLIProxyAPI can translate their wire
  protocols. A relay cannot manufacture upstream tool-call semantics.
- Sampling, token-limit, attachment, and multimodal fields are not portable
  across these web endpoints and are currently rejected or ignored.
- DeepSeek, Doubao, and Claude create server-side sessions/conversations for a
  request. They may appear in account history, and the sidecar does not
  currently delete them. Multi-turn OpenAI messages are serialized into one new
  web prompt rather than resumed as a native upstream conversation.
- The ChatGPT transport is an experimental protocol scaffold with known
  Sentinel/Conduit and browser-fingerprint differences from recent captures. It
  must not be treated as working until those differences are resolved and a
  valid-login completion succeeds.
- Grok `ask`/`stream`, all `history`/`detail`, and legacy adapters still use the
  browser bridge. One concurrent prompt per browser-backed site is supported.
- Gemini generation is direct HTTP, but current media CDN downloads still use
  the user's existing Chrome session because Google validates browser/device state.
- Web protocols and cookies are unofficial and can change without notice.

## Protocol research

The direct implementations reuse protocol knowledge and architecture patterns
from permissively licensed projects, then validate the behavior locally instead
of adding their browser/CDP runtimes:

- [apify/impit](https://github.com/apify/impit) (Apache-2.0) supplies the local TLS transport.
- [ForgetMeAI/FreeDeepseekAPI](https://github.com/ForgetMeAI/FreeDeepseekAPI) and [andeya/token-free-gateway](https://github.com/andeya/token-free-gateway) (MIT) informed DeepSeek session and PoW handling.
- [aurorax-neo/chat2api](https://github.com/aurorax-neo/chat2api) (MIT) informed ChatGPT session and SSE handling.
- [cyber-wojtek/Claude-API](https://github.com/cyber-wojtek/Claude-API) (MIT) informed Claude organization and completion handling.
- [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute) (MIT) informed the provider/relay boundary.

GPL implementations were used only to compare public protocol behavior; their
code was not copied into this MIT project.

## License

MIT
