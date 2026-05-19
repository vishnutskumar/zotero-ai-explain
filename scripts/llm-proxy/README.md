# Ollama-Compatible LLM Proxy

A small Node HTTP server that speaks the Ollama `/api/chat` wire protocol on the front side and
routes each request to one of three backends:

- **Codex CLI** (`POST /codex/api/chat`) — spawns `codex exec --json -` (or
  `codex exec resume <SESSION_ID> --json -` for follow-up turns) and translates Codex's JSON event
  stream into Ollama-format NDJSON chunks.
- **Claude Code CLI** (`POST /claude/api/chat`) — spawns
  `claude -p --output-format json --allowedTools "" -` (or
  `claude --resume <SESSION_ID> -p --output-format json --allowedTools "" -` for follow-up turns)
  and translates Claude's JSON output into Ollama-format NDJSON chunks. Tool use is hard-disabled
  via the empty `--allowedTools` allowlist so Claude behaves as a pure chat model.
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
  /codex   → Codex CLI (multi-turn session_id resume)
  /claude  → Claude Code CLI (multi-turn --resume)
  /ollama  → http://localhost:11434
```

## Routes

| Method | Path                | Behaviour                                                    |
| ------ | ------------------- | ------------------------------------------------------------ |
| POST   | `/codex/api/chat`   | Ollama-compatible chat backed by `codex exec`.               |
| POST   | `/claude/api/chat`  | Ollama-compatible chat backed by `claude -p`.                |
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

| Variable                 | Default                  | Purpose                                                  |
| ------------------------ | ------------------------ | -------------------------------------------------------- |
| `LLM_PROXY_PORT`         | `11400`                  | Listen port on `127.0.0.1`.                              |
| `OLLAMA_BASE_URL`        | `http://localhost:11434` | Real Ollama daemon for the passthrough backend.          |
| `CODEX_DEFAULT_MODEL`    | `gpt-5.2-codex`          | Model passed via `codex exec --model` when none in body. |
| `CODEX_IDLE_TIMEOUT_MS`  | `60000`                  | Kill `codex` after this long with no output activity.    |
| `CODEX_HARD_TIMEOUT_MS`  | `300000`                 | Kill `codex` after this long regardless of activity.     |
| `CLAUDE_BINARY`          | `claude` (search `PATH`) | Path to the `claude` CLI executable.                     |
| `CLAUDE_DEFAULT_MODEL`   | _(empty)_                | Model passed via `claude --model` when none in body.     |
| `CLAUDE_IDLE_TIMEOUT_MS` | `60000`                  | Kill `claude` after this long with no output activity.   |
| `CLAUDE_HARD_TIMEOUT_MS` | `300000`                 | Kill `claude` after this long regardless of activity.    |

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
(truncated to 16 hex chars). For each unique fingerprint, it stores the Codex `session_id` returned
by the first invocation:

1. **First turn** — `codex exec --json --skip-git-repo-check --model <M> -` with the latest user
   message on stdin.
2. **Subsequent turn** — `codex exec resume <SESSION_ID> --json --skip-git-repo-check --model <M> -`
   with the latest user message on stdin.

Session state lives in-memory only — restarting the proxy starts every conversation fresh, which
matches the plugin's behaviour of treating each pop-up as a new conversation by default.

### Session-ID discovery

Codex's `--json` event stream evolves between releases. The proxy is defensive about it:

1. Every stdout line is parsed as JSON; for each parsed object we recursively search **all keys**
   for `session_id` and accept the first hit. This covers top-level shapes
   (`{"type":"session_configured","session_id":"…"}`) as well as nested shapes
   (`{"msg":{"session_id":"…"}}`).
2. If stdout does not expose a `session_id` by the time the child exits, the proxy scans
   `~/.codex/sessions/**` for the newest `*.jsonl` file modified after the spawn began and extracts
   the UUID from either the filename (`rollout-<TIMESTAMP>-<SESSION_ID>.jsonl` — the Codex
   documented convention) or the first JSONL line.

If neither mechanism produces a `session_id`, follow-up turns simply fall back to starting a fresh
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
claude -p --output-format json --allowedTools ""

# Subsequent turn (same conversation key — see "Multi-turn" below)
claude --resume <SESSION_ID> -p --output-format json --allowedTools ""
```

- `-p` puts the CLI in print mode (one-shot, non-interactive).
- `--output-format json` returns one structured object containing `session_id` and the result text.
- `--allowedTools ""` passes an **empty allowlist** — this disables ALL built-in tools
  (Read/Bash/Edit/etc.), so Claude behaves as a pure chat model. This is a hard requirement of the
  Zotero plugin's contract (the popup and sidebar are conversational explainers, not agents) and is
  enforced by `buildClaudeArgs` in `scripts/llm-proxy/backends/claude.mjs`.
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

| Symptom                                  | Likely cause                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `Ollama unreachable at …`                | `ollama serve` not running, or wrong `OLLAMA_BASE_URL`.                                           |
| `codex: authentication failed`           | Run `codex login`.                                                                                |
| `codex exited with code 127`             | `codex` not on `PATH`. Install via Homebrew or the official installer.                            |
| `claude exited with code 127`            | `claude` not on `PATH`. Set `CLAUDE_BINARY=/full/path/to/claude` or install the CLI globally.     |
| `claude` errors with "not authenticated" | Run `claude login` in the shell that launches the proxy, then restart the proxy.                  |
| Empty popup with no error                | Should not happen anymore — the proxy emits a `done_reason: "error"` chunk on failure.            |
| `gpt-5.2-codex` not recognised by Codex  | Set `CODEX_DEFAULT_MODEL` to a model your `codex` CLI supports, or pass `model` in the chat body. |

## Security

- Binds to `127.0.0.1` only — never the public network.
- No authentication on the proxy itself; assumes a single-user developer machine.
- Forwards request bodies verbatim. Do not place the proxy behind a public reverse proxy without
  adding authentication first.

## Implementation notes

- Pure Node built-ins (`node:http`, `node:child_process`, `node:fs`, `node:crypto`, `node:os`,
  `node:path`). No new npm dependencies.
- All four modules (codex, claude, ollama, server) accept dependency injection (`spawn`, `fetch`,
  `fs`) so the unit tests in `tests/scripts/llm-proxy.test.ts` exercise the full HTTP surface
  without ever spawning real `codex` / `claude` or hitting real Ollama.
