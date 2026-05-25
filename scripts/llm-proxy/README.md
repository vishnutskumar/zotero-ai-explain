# Ollama-Compatible LLM Proxy

A small Node HTTP server that speaks the Ollama `/api/chat` wire protocol on the front side and
routes each request to one of three backends:

- **Codex CLI** (`POST /codex/api/chat`) — spawns `codex mcp-server -c mcp_servers={}` and drives it
  with a three-frame JSON-RPC handshake (`initialize` → `notifications/initialized` →
  `tools/call codex` for first turns, `tools/call codex-reply { threadId }` for follow-up turns).
  Per-token deltas arrive as `codex/event` notifications carrying
  `msg.type === "agent_message_content_delta"` and are translated into Ollama-format NDJSON chunks.
  The `-c mcp_servers={}` override suppresses any user-configured MCP sidecars (which would
  otherwise add 1-3 s of avoidable per-turn startup) since the proxy uses `codex mcp-server` purely
  as a streaming chat backend. Spawned in an isolated environment (`HOME` + `CODEX_HOME` + `cwd`
  pointed at a per-backend tmpdir; see [Subprocess isolation](#subprocess-isolation)) so the user's
  `~/.codex/AGENTS.md` and bundled skills do not bleed into Zotero responses.
- **Claude Code CLI** (`POST /claude/api/chat`) — spawns
  `claude -p --output-format stream-json --verbose --include-partial-messages --allowedTools "" --setting-sources user --strict-mcp-config --disable-slash-commands --system-prompt <NEUTRAL_PREFACE> -`
  (or the same with a leading `--resume <SESSION_ID>` for follow-up turns) and translates the
  incremental `content_block_delta` text frames into Ollama-format NDJSON chunks. Tool use is
  hard-disabled via the empty `--allowedTools` allowlist so Claude behaves as a pure chat model; the
  trailing four isolation flags suppress user-config sources, MCP sidecars, and slash commands and
  inject a neutral system prompt (see [Subprocess isolation](#subprocess-isolation)). `cwd` is set
  to a per-backend tmpdir; `HOME` is **not** overridden because subscription auth resolves through
  the OS keychain.
- **Real Ollama** (`POST /ollama/api/chat`) — forwards verbatim to a real Ollama daemon (default
  `http://localhost:11434`).

The Zotero AI Explain plugin's existing `OllamaProvider` (see `src/providers/adapters/ollama.ts`)
talks to this proxy unchanged — set the plugin's Ollama profile **Base URL** to
`http://127.0.0.1:11400/codex`, `http://127.0.0.1:11400/claude`, or `http://127.0.0.1:11400/ollama`
and everything else just works.

## Quick start

```bash
npm run proxy:llm
```

Output:

```text
zotero-ai-llm-proxy listening on http://127.0.0.1:11400
  /codex   → Codex CLI (multi-turn via codex-reply { threadId })
  /claude  → Claude Code CLI (multi-turn --resume)
  /ollama  → http://localhost:11434
```

## Routes

| Method | Path                | Behaviour                                                    |
| ------ | ------------------- | ------------------------------------------------------------ |
| POST   | `/codex/api/chat`   | Ollama-compatible chat backed by `codex mcp-server`.         |
| POST   | `/claude/api/chat`  | Ollama-compatible chat backed by `claude -p` (stream-json).  |
| POST   | `/ollama/api/chat`  | Passthrough to a real Ollama daemon.                         |
| POST   | `/ollama/api/embed` | Passthrough Ollama embeddings (Codex/Claude do not support). |
| POST   | `/codex/api/embed`  | 501 — Codex does not support embeddings.                     |
| POST   | `/claude/api/embed` | 501 — Claude backend does not support embeddings.            |
| GET    | `/codex/api/tags`   | Fixed list of Codex model identifiers.                       |
| GET    | `/claude/api/tags`  | Fixed list of Claude model identifiers.                      |
| GET    | `/ollama/api/tags`  | Forwarded from real Ollama `/api/tags`.                      |
| GET    | `/api/tags`         | Union of Ollama-real + Codex + Claude tag lists.             |
| GET    | `/`                 | Self-describing JSON listing the routes above.               |

## Configuration

All settings are environment variables read at startup.

| Variable                   | Default                  | Purpose                                                                                                                       |
| -------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `LLM_PROXY_PORT`           | `11400`                  | Listen port on `127.0.0.1`.                                                                                                   |
| `LLM_PROXY_AUTH_TOKEN`     | _(unset)_                | Bearer token the proxy requires on the auth-gated routes. Unset → no-auth dev mode (canary log). See [Auth](#authentication). |
| `LLM_PROXY_MAX_BODY_BYTES` | `1048576` (1 MiB)        | Per-request body cap; overflow returns `413 Payload Too Large` and destroys the socket.                                       |
| `OLLAMA_BASE_URL`          | `http://localhost:11434` | Real Ollama daemon for the passthrough backend.                                                                               |
| `CODEX_DEFAULT_MODEL`      | `gpt-5.5`                | Model passed via `-c model=<name>` to `codex mcp-server` when none in body.                                                   |
| `CODEX_IDLE_TIMEOUT_MS`    | `60000`                  | Kill `codex` after this long with no output activity.                                                                         |
| `CODEX_HARD_TIMEOUT_MS`    | `300000`                 | Kill `codex` after this long regardless of activity.                                                                          |
| `CLAUDE_BINARY`            | `claude` (search `PATH`) | Path to the `claude` CLI executable.                                                                                          |
| `CLAUDE_DEFAULT_MODEL`     | _(empty)_                | Model passed via `claude --model` when none in body.                                                                          |
| `CLAUDE_IDLE_TIMEOUT_MS`   | `60000`                  | Kill `claude` after this long with no output activity.                                                                        |
| `CLAUDE_HARD_TIMEOUT_MS`   | `300000`                 | Kill `claude` after this long regardless of activity.                                                                         |

The env-var names that cross the parent/child boundary (`LLM_PROXY_AUTH_TOKEN`,
`LLM_PROXY_MAX_BODY_BYTES`) are exported as constants from
`scripts/llm-proxy/protocol-constants.mjs` so the plugin-side wiring
(`src/platform/wire-proxy-lifecycle.ts`) and the server consume the same literal — a typo on either
side would silently downgrade to no-auth mode and is caught by a round-trip test.

## Authentication

The proxy enforces three defense layers on the sensitive routes (`/codex|claude|ollama/api/chat`,
`/codex|claude|ollama/api/tags`, `/api/tags`, `/codex|claude|ollama/api/embed`, `/api/diagnostics`):

1. **Host header gate.** The `Host` header must match `127.0.0.1:<port>` or `localhost:<port>`
   (using the OS-assigned port after `listen()` resolves). A foreign Host returns `403`. This blocks
   DNS-rebinding attacks where a browser is tricked into resolving an attacker-controlled name to
   `127.0.0.1` and posting to the proxy from a malicious page.
2. **Origin header gate.** When an `Origin` header is present it must match the loopback host
   (`http://127.0.0.1:<port>` / `http://localhost:<port>`) or be omitted. A foreign Origin
   (`https://attacker.example`) returns `403` even with a valid bearer token.
3. **Bearer-token gate.** When `LLM_PROXY_AUTH_TOKEN` is set, every auth-gated route requires
   `Authorization: Bearer <token>` and the proxy compares with `crypto.timingSafeEqual` (with a
   length pre-check). Missing bearer → `401 missing bearer`; wrong token → `401 invalid token`.

Two routes are **exempt from bearer auth** (still Host/Origin gated):

- `POST /api/shutdown` — preserves the orphan-takeover path. When the plugin starts after a Zotero
  crash leaves an old proxy listening on the configured port, it cannot know the orphan's token; the
  Host/Origin gates still prevent network attackers, and DoS via shutdown is acceptable on a
  single-user desktop.
- `GET /` — the route catalogue is intentionally unauthenticated so a developer poking at the proxy
  with `curl` can discover the surface.

**No-auth dev mode.** When `LLM_PROXY_AUTH_TOKEN` is unset (e.g. `npm run proxy:llm` or existing
integration-test paths that spawn the proxy without the env var), the bearer gate is a no-op and the
proxy emits a loud `console.warn` on startup:

```text
llm-proxy: AUTH DISABLED — set LLM_PROXY_AUTH_TOKEN to enable bearer auth
```

When the token IS set, the corresponding canary is
`llm-proxy: auth enabled on 127.0.0.1:<port> (token length <N>)`. Both canaries are the first line
of process output so a misconfigured production spawn (env var dropped on the floor) shouts loudly
in the Zotero error console.

When the plugin auto-spawns the proxy via `src/platform/wire-proxy-lifecycle.ts`, a fresh
`crypto.randomUUID()` token is minted per spawn and threaded into the child's environment under
`LLM_PROXY_AUTH_TOKEN`; the chrome-side ollama adapter conditionally adds the
`Authorization: Bearer <token>` header when its base URL matches the proxy's
`http://127.0.0.1:<port>` prefix, and the lifecycle's diagnostics fetch threads the bearer too.

## Wire contract

The proxy speaks Ollama's wire format on the front side. Requests look like:

```json
{
  "model": "gpt-5.2-codex",
  "messages": [
    { "role": "system", "content": "You are an academic explainer." },
    { "role": "user", "content": "Explain mitochondria in two sentences." }
  ],
  "stream": true
}
```

When `stream: true` (the Ollama default), the response is `application/x-ndjson` — one JSON object
per line:

```json
{"model":"gpt-5.2-codex","created_at":"…","message":{"role":"assistant","content":"Mitochondria "},"done":false}
{"model":"gpt-5.2-codex","created_at":"…","message":{"role":"assistant","content":"are…"},"done":false}
{"model":"gpt-5.2-codex","created_at":"…","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}
```

Errors surface as a terminal chunk with `done_reason: "error"` and an `error` field — this is the
contract the plugin's popup relies on (see `BUG-AC8-1` in the result records):

```json
{"model":"gpt-5.2-codex","…","done":true,"done_reason":"error","error":"codex: authentication failed — please run `codex login`"}
```

When `stream: false`, the response is a single JSON object of the same shape with `done:true`.

## Codex multi-turn

The proxy correlates conversations using **the SHA-256 of the first user message in `messages[]`**
(truncated to 16 hex chars). For each unique fingerprint, it stores the Codex `threadId` returned by
the first invocation's `tools/call` response:

1. **First turn** — spawn `codex mcp-server -c mcp_servers={}` (plus an optional `-c model=<M>`) and
   write three JSON-RPC frames to stdin: `initialize`, `notifications/initialized`, and `tools/call`
   with `name: "codex"` whose `arguments` carry the latest user message as `prompt` (plus
   `sandbox: "read-only"`, `approval-policy: "never"`, and `cwd: <isolationDir>` — the same
   per-backend tmpdir the spawn's `cwd`/`HOME`/`CODEX_HOME` point at; see
   [Subprocess isolation](#subprocess-isolation)).
2. **Subsequent turn** — same `initialize` / `notifications/initialized` framing, but the
   `tools/call` arguments use `name: "codex-reply"` with `{ threadId: "<stored>", prompt: "…" }`.

`threadId` is the MCP-server's name for what `codex exec resume <SESSION_ID>` used to consume — the
UUID shape is unchanged, only the transport. After the `id:1 tools/call` response arrives the proxy
closes stdin so the MCP-server child exits cleanly.

Session state lives in-memory only — restarting the proxy starts every conversation fresh, which
matches the plugin's behaviour of treating each pop-up as a new conversation by default.

### Thread-ID discovery

The MCP envelope shape evolves between releases. The proxy is defensive about it:

1. The `tools/call` response carries `result.structuredContent.threadId` — this is the documented
   MCP result shape and the primary source.
2. Every incoming JSON-RPC frame is also walked recursively; the walker accepts any string-valued
   `threadId` (camelCase, e.g. `params._meta.threadId`), `thread_id`, or `session_id` field. This
   covers nested shapes some Codex releases emit via `codex/event` notifications.
3. If neither mechanism produces an id by the time the child exits, the proxy scans
   `~/.codex/sessions/**` for the newest `*.jsonl` file modified after the spawn began and extracts
   the UUID from either the filename (`rollout-<TIMESTAMP>-<UUID>.jsonl` — `codex mcp-server` writes
   the same rollout files as `codex exec`) or the first JSONL line.

If none of the three mechanisms produces an id, follow-up turns simply fall back to starting a fresh
session (the next request still works, it just can't resume).

## Claude Code backend

The Claude backend mirrors the Codex one: same Ollama wire shape on the front, same in-memory
conversation map for multi-turn, same NDJSON-with-terminal-`done` contract.

### Setup

1. Install the Claude Code CLI (see <https://claude.com/claude-code>).
2. Authenticate the CLI in the shell you'll launch the proxy from:

   ```bash
   claude login
   ```

   The proxy inherits the CLI's auth — there is no separate API key configuration.

3. Wire the Zotero plugin: set the Ollama profile **Base URL** to `http://127.0.0.1:11400/claude`.
   The plugin appends `/api/chat` and `/api/tags` itself.

### Invocation

Per request the proxy spawns the CLI with the prompt on stdin:

```text
# First turn
claude -p --output-format stream-json --verbose --include-partial-messages --allowedTools "" \
  --setting-sources user --strict-mcp-config --disable-slash-commands \
  --system-prompt <NEUTRAL_PREFACE>

# Subsequent turn (same conversation key — see "Multi-turn" below)
claude --resume <SESSION_ID> -p --output-format stream-json --verbose --include-partial-messages --allowedTools "" \
  --setting-sources user --strict-mcp-config --disable-slash-commands \
  --system-prompt <NEUTRAL_PREFACE>
```

- `-p` puts the CLI in print mode (one-shot, non-interactive).
- `--output-format stream-json` emits a sequence of JSON objects — `system_init`, `stream_event`
  (carrying incremental `content_block_delta` text fragments every ~300-500 ms), the terminal
  `assistant` envelope with the full assembled message, and a final `result` envelope with
  `session_id` and usage. The proxy extracts only the per-token deltas; the terminal `assistant` /
  `system` / `result` envelopes are denied so the assembled response is not re-emitted.
- `--verbose` is mandatory whenever `--output-format stream-json` is used — the Claude CLI rejects
  stream-json without it.
- `--include-partial-messages` is what turns on the per-chunk `content_block_delta` frames; without
  it stream-json would only emit the final assembled `assistant` envelope.
- `--allowedTools ""` passes an **empty allowlist** — this disables ALL built-in tools
  (Read/Bash/Edit/etc.), so Claude behaves as a pure chat model. This is a hard requirement of the
  Zotero plugin's contract (the popup and sidebar are conversational explainers, not agents) and is
  enforced by `buildClaudeArgs` in `scripts/llm-proxy/backends/claude.mjs`.
- `--setting-sources user --strict-mcp-config --disable-slash-commands --system-prompt <NEUTRAL>`
  are the **isolation flags** — they suppress user-config layers (CLAUDE.md / settings.json), MCP
  sidecars, and slash commands, and replace the user's default system prompt with a short neutral
  preface so the model treats the proxy turn as a plain chat request. See
  [Subprocess isolation](#subprocess-isolation) for the full rationale and accepted limitations.
- `--model` is added only when `CLAUDE_DEFAULT_MODEL` is set (or the request body specifies one); by
  default the CLI picks the model from the user's `claude` config.

### Multi-turn behaviour

The proxy correlates conversations using **the SHA-256 of the first user message in `messages[]`**
(truncated to 16 hex chars) — same scheme as the Codex backend.

1. **First turn** — spawn without `--resume`. Parse `session_id` out of the JSON object on stdout
   (recursive walk of every key, so both top-level `{"session_id":"…"}` and nested shapes like
   `{"meta":{"session_id":"…"}}` are accepted). Store it under the conversation key.
2. **Subsequent turn** — look up the stored `session_id` and prepend `--resume <id>` to the argv.
   The latest user message in `messages[]` is sent on stdin.

Session state lives in-memory only — restarting the proxy starts every conversation fresh, matching
the plugin's behaviour of treating each pop-up as a new conversation by default.

### Troubleshooting

| Symptom                                             | Likely cause                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `claude exited with code 127`                       | `claude` not on `PATH`. Set `CLAUDE_BINARY=/full/path/to/claude` or install the CLI globally.                           |
| `Error: not authenticated. Run \`claude login\`.`   | Auth missing or expired. Run `claude login` in the shell that launched the proxy and restart the proxy.                 |
| Popup shows nothing for >60s then times out         | Hard timeout fired (default 5min) or idle timeout (default 60s). Increase `CLAUDE_*_TIMEOUT_MS` env vars.               |
| `done_reason: "timeout"` chunk arrives unexpectedly | The CLI is being killed by idle/hard timeout. Slow models may need `CLAUDE_IDLE_TIMEOUT_MS` bumped.                     |
| Claude tries to read files / run commands           | Should not happen — `--allowedTools ""` is always passed. If it does, file a bug; tool use is disabled.                 |
| Follow-up turn loses context                        | The proxy was restarted (in-memory session map cleared) or the conversation key changed (different first user message). |

### Smoke test

```bash
curl -N -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"say hi in 3 words"}],"stream":true}' \
  http://127.0.0.1:11400/claude/api/chat
```

Expected: zero or more `done:false` chunks followed by exactly one `done:true` chunk. On a non-zero
exit the terminal chunk will have `done_reason:"error"` and an `error` field — never a silent
`done_reason:"stop"` (this is the BUG-AC8-1 contract).

## Subprocess isolation

Both the Codex and Claude backends spawn CLIs that, by default, load extensive user developer
configuration — `~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, settings files, MCP sidecars, custom
skills, slash commands. None of that is appropriate for Zotero responses: a user's "act as a senior
code reviewer" CLAUDE.md instruction would warp every popup explanation. The proxy isolates each CLI
from that configuration at spawn time.

### Codex isolation

The codex backend lazily creates a per-backend tmpdir (`/tmp/zotero-ai-codex-*` via `mkdtemp`) on
first use and best-effort copies `~/.codex/auth.json` into it (silently skipped on `ENOENT`).
`codex mcp-server` is then spawned with:

- `env.HOME = <tmpdir>` and `env.CODEX_HOME = <tmpdir>` — codex reads `AGENTS.md`, `config.toml`,
  and per-project skills relative to `$CODEX_HOME`/`$HOME`; pointing both at a fresh empty directory
  neutralises them.
- `cwd = <tmpdir>` — also reflected in the `tools/call codex` arguments' `cwd` field so the model
  cannot see the user's actual working directory.

Copying `auth.json` is what lets codex remain authenticated against the user's ChatGPT login while
running out of the isolated `$CODEX_HOME`.

### Claude isolation

The claude backend lazily creates a per-backend tmpdir (`/tmp/zotero-ai-claude-*`) and spawns
`claude -p …` with:

- `cwd = <tmpdir>` — keeps the CLI from picking up the user's project CLAUDE.md / .claude config.
- `--setting-sources user` — restricts settings to the user-global layer only (no project/local).
- `--strict-mcp-config` — refuses to load MCP sidecars from the user's settings.
- `--disable-slash-commands` — turns off slash-command dispatch entirely.
- `--system-prompt <NEUTRAL_PREFACE>` — replaces the user's default system prompt with a short
  neutral preface; biases the model against treating any residual pollution as instructions.

`HOME` is **deliberately not overridden** for claude. Subscription auth resolves through the OS
keychain (macOS Keychain / libsecret / Windows Credential Manager) which the CLI accesses via
`$HOME`-scoped paths; isolating `HOME` would break authentication.

### Accepted limitations

Two pollution sources are not blocked by this isolation:

- **Bundled `.system` skills (codex).** Codex ships 5 baked-in skills (imagegen, openai-docs,
  plugin-creator, skill-creator, skill-installer). They are compiled into the binary and cannot be
  suppressed by environment isolation.
- **SessionStart hooks (claude).** `--setting-sources user` + `--strict-mcp-config` +
  `--disable-slash-commands` do not prevent SessionStart hooks from firing. The neutral
  `--system-prompt` is the bias against the model treating any hook output as instructions.

Both are documented as accepted limitations in ADR
[0001 — LLM proxy architecture](../../docs/decisions/0001-llm-proxy-architecture.md).

## Smoke tests

### Codex backend

```bash
curl -N -H 'content-type: application/json' \
  -d '{"model":"gpt-5.2-codex","messages":[{"role":"user","content":"say hi in 3 words"}],"stream":true}' \
  http://127.0.0.1:11400/codex/api/chat
```

Expected: zero or more `done:false` lines followed by one `done:true` line.

### Ollama passthrough

```bash
curl -N -H 'content-type: application/json' \
  -d '{"model":"gemma4:e2b","messages":[{"role":"user","content":"hello"}],"stream":true}' \
  http://127.0.0.1:11400/ollama/api/chat
```

Expected: byte-identical to the response you would get from `curl http://localhost:11434/api/chat`
with the same body.

### Tags

```bash
curl http://127.0.0.1:11400/codex/api/tags
curl http://127.0.0.1:11400/ollama/api/tags
curl http://127.0.0.1:11400/api/tags
```

## Troubleshooting

| Symptom                                           | Likely cause                                                                                                                                                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Ollama unreachable at …`                         | `ollama serve` not running, or wrong `OLLAMA_BASE_URL`.                                                                                                                                                                                                                     |
| `codex: authentication failed`                    | Run `codex login`. If you have authenticated but isolation broke OAuth, confirm `~/.codex/auth.json` exists before the proxy spawns codex — the proxy copies it into the isolation tmpdir at spawn time.                                                                    |
| `codex exited with code 127`                      | `codex` not on `PATH`. Install via Homebrew or the official installer.                                                                                                                                                                                                      |
| `claude exited with code 127`                     | `claude` not on `PATH`. Set `CLAUDE_BINARY=/full/path/to/claude` or install the CLI globally.                                                                                                                                                                               |
| `claude` errors with "not authenticated"          | Run `claude login` in the shell that launches the proxy, then restart the proxy.                                                                                                                                                                                            |
| Empty popup with no error                         | Should not happen anymore — the proxy emits a `done_reason: "error"` chunk on failure.                                                                                                                                                                                      |
| `gpt-5.2-codex` not recognised by Codex           | Set `CODEX_DEFAULT_MODEL` to a model your `codex` CLI supports, or pass `model` in the chat body.                                                                                                                                                                           |
| `401 missing bearer` / `401 invalid token`        | The proxy is in auth-enabled mode (`LLM_PROXY_AUTH_TOKEN` set) and the caller did not present the matching bearer. Plugin auto-spawn handles this; manual `curl` callers need `Authorization: Bearer <token>` or to start the proxy without the env var (no-auth dev mode). |
| `403 host not allowed` / `403 origin not allowed` | Host/Origin defense-in-depth rejected the request. The proxy only accepts `Host: 127.0.0.1:<port>` / `localhost:<port>` and (when present) the same loopback Origin. Browser-origin requests from arbitrary pages are intentionally refused.                                |
| `413 Payload Too Large`                           | The request body exceeded `LLM_PROXY_MAX_BODY_BYTES` (1 MiB default). Raise the env var if you legitimately need bigger payloads.                                                                                                                                           |

## Security

- Binds to `127.0.0.1` only — never the public network.
- Plugin-spawned: bearer-token auth is enforced. The plugin mints a fresh `crypto.randomUUID()` per
  spawn and threads it via `LLM_PROXY_AUTH_TOKEN` so each proxy instance has a unique token; the
  plugin's ollama adapter and diagnostics fetch carry the matching `Authorization: Bearer <token>`
  header. The proxy also gates every auth-gated route on `Host` + `Origin` headers (blocks browser
  DNS-rebinding attacks) and caps request bodies at 1 MiB by default (memory DoS).
- Dev mode (`npm run proxy:llm`, integration tests): the bearer gate is permissively disabled when
  `LLM_PROXY_AUTH_TOKEN` is unset; the proxy emits a loud `console.warn` canary at startup so a
  misconfigured production spawn is impossible to miss. Host/Origin gates and the body cap remain in
  force.
- `POST /api/shutdown` and `GET /` (route catalogue) are bearer-exempt by design — see
  [Authentication](#authentication) for the orphan-takeover rationale. They remain Host/Origin
  gated.
- Forwards request bodies verbatim. Do not place the proxy behind a public reverse proxy.

## Implementation notes

- Pure Node built-ins (`node:http`, `node:child_process`, `node:fs`, `node:crypto`, `node:os`,
  `node:path`). No new npm dependencies.
- All four modules (codex, claude, ollama, server) accept dependency injection (`spawn`, `fetch`,
  `fs`) so the unit tests in `tests/scripts/llm-proxy.test.ts` exercise the full HTTP surface
  without ever spawning real `codex` / `claude` or hitting real Ollama.
