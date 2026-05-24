# ADR 0001 — LLM proxy architecture

- **Status:** Accepted
- **Date:** 2026-05-17
- **Phase:** real-product-pipeline (Phase 4)

## Context

Phase 4 needed to let users plug in their existing ChatGPT or Claude subscriptions without holding
raw API keys and without writing a full chat adapter per subprocess CLI. Each subscription ships a
command-line tool (`codex`, `claude`) that handles auth, model selection, and session resume — but
neither speaks an HTTP wire protocol the plugin's existing `OllamaProvider` can talk to.

## Decision

Ship a small Node HTTP service (`scripts/llm-proxy/server.mjs`) that exposes the **Ollama
`/api/chat` wire protocol on the front side** and routes to one of three backends:

- `POST /codex/api/chat` — `codex mcp-server -c mcp_servers={}` driven by a three-frame JSON-RPC
  handshake (`initialize` → `notifications/initialized` → `tools/call codex` for first turns;
  `tools/call codex-reply { threadId }` for follow-ups). Per-token deltas arrive as `codex/event`
  notifications carrying `msg.type === "agent_message_content_delta"` and are translated into
  Ollama-format NDJSON. The `-c mcp_servers={}` override suppresses user-configured MCP sidecars
  since the proxy uses `codex mcp-server` purely as a streaming chat backend. The MCP server is the
  only Codex subcommand that streams per-token; `codex exec --json` emits a single terminal envelope
  at the end of the turn and was rejected for that reason.
- `POST /claude/api/chat` —
  `claude -p --output-format stream-json --verbose --include-partial-messages --allowedTools "" -`.
  The stream-json output format emits per-chunk `content_block_delta` text frames every ~300-500 ms;
  `--verbose` is mandatory for stream-json and `--include-partial-messages` is what enables the
  per-chunk deltas. The empty `--allowedTools` allowlist hard-disables every Claude Code tool so the
  CLI behaves as a pure chat model. Multi-turn via `claude --resume <ID>`.
- `POST /ollama/api/chat` — passthrough to a real Ollama daemon.

Multi-turn correlation is in the proxy: the SHA-256 of the first user message in `messages[]`
(truncated to 16 hex chars) becomes the conversation key; the proxy stores the backend's
conversation id under that key in memory (the Codex `threadId` from `tools/call`'s
`result.structuredContent`, or the Claude `session_id` from the stream-json `result` envelope).
Restarting the proxy drops all resume state — matching the plugin's "each popup is a fresh
conversation" behaviour. The plugin's `OllamaProvider` needs zero changes; an Ollama profile's Base
URL is set to `.../codex`, `.../claude`, or `.../ollama`.

## Consequences

- **Plugin code stays untouched.** All three backends share one provider adapter and one wire
  format. Adding a fourth backend means one `backends/<name>.mjs` module and one route.
- **Errors surface honestly.** Every backend emits a terminal NDJSON chunk with `done: true`. On
  failure, `done_reason: "error"` plus an `error` field — never a silent empty completion. This is
  the BUG-AC8-1 contract (`tests/scripts/llm-proxy.test.ts:711`).
- **No new npm dependencies.** Pure Node built-ins only, so the proxy can be bundled into the XPI.
- **Auth lives in the CLI.** The proxy never sees API keys for codex or claude; the user runs
  `codex login` / `claude login` once.
- **Embedding asymmetry.** Codex and Claude have no embeddings; those `/api/embed` routes
  return 501. The preset dropdown pairs each chat-only backend with an embed backend (Ollama by
  default).

## Alternatives considered

- **Native MCP client inside the plugin.** Requires a second wire protocol on the chat adapter and a
  Zotero-side transport implementation. Rejected as too much surface for "different transport, same
  chat semantics".
- **Bespoke chat adapter per CLI in the bundle.** Forces each backend to re-implement streaming,
  error contracts, and multi-turn resume in TypeScript inside the bundle. Centralising subprocess
  fiddling in one Node service keeps the bundle untouched.
- **Spawn the CLIs directly from chrome-side code.** Chrome `Subprocess.sys.mjs` does not expose
  convenient stdout-line streaming, and the resume logic is non-trivial state to maintain in the
  privileged scope. Keeping the proxy as a sibling process limits the blast radius of any
  subprocess-handling bug.
