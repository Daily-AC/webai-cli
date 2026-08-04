# CLIProxyAPI integration

`webai serve` is a local OpenAI Chat-compatible upstream. CLIProxyAPI connects
to it through its built-in `openai-compatibility` provider. Cookies and upstream
tokens stay in webai-cli's credential store and are never written to
CLIProxyAPI config.

This configuration was verified against CLIProxyAPI `v7.2.94`.

## Provider status

| Sidecar model | Default server | `--experimental` | Live validation |
|---|---:|---:|---|
| `gemini-web` | yes | yes | valid-login completion |
| `doubao-web` | yes | yes | valid-login completion and stream |
| `deepseek-web` | no | yes | PoW solve only; valid-login completion pending |
| `claude-web` | no | yes | direct TLS/auth response only; valid-login completion pending |
| `chatgpt-web` | no | yes | known Sentinel/Conduit drift; valid-login completion pending |

The experimental providers are intentionally not advertised by the default
server. Unit fixtures and rejected-credential responses are not substitutes for
a valid-login completion. ChatGPT is currently a protocol scaffold with known
differences from recent web captures, not merely an implementation waiting for
a cookie.

## 1. Log in and verify web credentials

Use the interactive login for normal setup. It hides input, sends a minimal
chat request through the same direct provider used by the sidecar, and saves
only after a complete text response:

```bash
webai auth login gemini
webai auth login doubao
webai auth login deepseek
webai auth login claude
webai auth login chatgpt
```

DeepSeek asks for its Cookie header and `localStorage.userToken` separately.
The probe can add one short conversation to provider history. If verification
fails, any previously stored credential remains unchanged.

For Claude, a `403` HTML response with `cf-mitigated: challenge` is reported as
an upstream Cloudflare block, not as an invalid `sessionKey`. Cookie injection
does not solve the JavaScript challenge, and a `cf_clearance` cookie can remain
bound to the visitor/device that received it. Do not advertise `claude-web`
until a valid-login completion succeeds from the deployment host.

For password-manager or agent automation, `auth login` also accepts stdin and
private files while retaining the live verification step:

```bash
credential-command | webai auth login gemini --stdin --json
webai auth login claude --file ./claude-credentials.json --json
```

`auth import` remains an offline, parse-only escape hatch. It does not establish
that the provider can complete a chat request:

Export each provider's cookies as JSON, Netscape format, or a raw `Cookie`
header. Gemini input must include `__Secure-1PSID`; Doubao input must include
`sessionid`.

```bash
webai auth import gemini --file ./gemini-cookies.json
webai auth import doubao --file ./doubao-cookies.json
```

For offline import through a pipe:

```bash
credential-command | webai auth import gemini --stdin
```

The direct providers accept these input shapes:

| Provider | Required input |
|---|---|
| Gemini | Cookie header/jar containing `__Secure-1PSID` |
| Doubao | Cookie header/jar containing `sessionid`; device fields are optional |
| DeepSeek | JSON bundle containing `cookies` and the bearer value from `localStorage.userToken` as `token` |
| Claude | Full Cookie header/jar containing `sessionKey`; Cloudflare clearance may also be required |
| ChatGPT | Cookie header/jar containing `__Secure-next-auth.session-token` or all numbered chunks |

Credential bundles may keep the cookies as a raw header:

```json
{
  "cookies": "ds_session_id=placeholder; other_cookie=placeholder",
  "token": "DeepSeek localStorage.userToken placeholder"
}
```

Claude and ChatGPT use pinned local TLS profiles by default. They can be made
explicit in a bundle:

```json
{
  "cookies": "sessionKey=placeholder",
  "tlsProfile": "chrome142"
}
```

```json
{
  "cookies": "__Secure-next-auth.session-token=placeholder",
  "tlsProfile": "firefox144"
}
```

Offline-import a bundle with the same stdin/file interface:

```bash
credential-command | webai auth import deepseek --stdin
credential-command | webai auth import claude --stdin
credential-command | webai auth import chatgpt --stdin
```

Do not put a Cookie header or token directly in the command line. Shell history
and the process list are not credential stores. The imported store is private
(`~/.config/webai-cli/creds.json`, mode `0600`).

## 2. Start the webai sidecar

Create a local bearer token shared only by webai and CLIProxyAPI:

```bash
install -d -m 700 ~/.config/webai-cli
umask 077
openssl rand -hex 32 > ~/.config/webai-cli/server-token
chmod 600 ~/.config/webai-cli/server-token
webai serve --token-file ~/.config/webai-cli/server-token
```

The sidecar binds `127.0.0.1:8787` by default and refuses non-loopback binds.
Add `--experimental` only when testing the three providers whose valid-login
completion has not been verified yet.

Check the direct endpoint before adding the relay:

```bash
TOKEN="$(tr -d '\n' < ~/.config/webai-cli/server-token)"
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"doubao-web","messages":[{"role":"user","content":"Reply exactly: pong"}],"stream":false}'
```

## 3. Configure CLIProxyAPI

Use the same sidecar token as `api-key` below. `proxy-client-secret` is a
separate credential used by clients calling CLIProxyAPI.

```yaml
host: "127.0.0.1"
port: 8317
request-retry: 0
disable-cooling: true

api-keys:
  - "proxy-client-secret"

openai-compatibility:
  - name: "webai"
    base-url: "http://127.0.0.1:8787/v1"
    api-key-entries:
      - api-key: "replace-with-the-webai-sidecar-token"
    models:
      - name: "gemini-web"
        alias: "gemini-web"
        display-name: "Gemini Web (webai)"
        input-modalities: [text]
        output-modalities: [text]
      - name: "doubao-web"
        alias: "doubao-web"
        display-name: "Doubao Web (webai)"
        input-modalities: [text]
        output-modalities: [text]
```

Start CLIProxyAPI with that config, then test the full relay:

```bash
curl http://127.0.0.1:8317/v1/chat/completions \
  -H 'Authorization: Bearer proxy-client-secret' \
  -H 'Content-Type: application/json' \
  -d '{"model":"doubao-web","messages":[{"role":"user","content":"Reply exactly: pong"}],"stream":true}'
```

The credential boundary is:

```text
OpenAI/Anthropic client -> CLIProxyAPI -> webai serve -> provider Web endpoint
client API key             sidecar token  cookie/token store
```

## Current compatibility boundary

The current sidecar is text-only. Requests containing non-empty `tools`, an
active `tool_choice`, tool-result messages, or legacy function-calling fields
are rejected with `422 unsupported_feature`. `/responses/compact` returns an
explicit `501` response.

That is sufficient to verify the relay and use ordinary chat clients. It is not
yet sufficient for Claude Code or Codex agent loops, which require structured
tool calls, tool-result replay, and Codex compaction. Those features must be
implemented against a real upstream protocol before those clients are marked
supported; prompt-generated JSON is intentionally not treated as tool support.

CLIProxyAPI can translate OpenAI and Anthropic request envelopes, but it cannot
turn an upstream text-only web request into native tool calling. Consequently,
Claude Code and Codex may connect and perform ordinary text requests, but their
normal agent loops fail at the first structured tool request.

Provider web APIs also do not share a reliable contract for sampling parameters,
token limits, attachments, or usage accounting. Treat those fields as unsupported
unless a provider implementation and a live test explicitly cover them.

DeepSeek, Doubao, and Claude create remote sessions or conversations per
sidecar request, which can add entries to the account history. OpenAI multi-turn
messages are serialized into one prompt; the relay does not resume a native web
conversation.

One verified CLIProxyAPI behavior differs from direct sidecar behavior: an
unknown model is `404 model_not_found` from webai, but CLIProxyAPI `v7.2.94`
wraps it as `502 internal_server_error`. Provider auth and unsupported-tool
statuses are preserved by the relay.
