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

## Addendum — 2026-05-24: Subprocess isolation

Both CLIs load extensive user developer configuration by default (`~/.codex/AGENTS.md`,
`~/.claude/CLAUDE.md`, settings layers, MCP sidecars, custom skills, slash commands). Any of these
can warp Zotero responses — e.g. a user "act as a senior code reviewer" CLAUDE.md instruction
reframes every popup explanation. The proxy now isolates each CLI from that configuration at spawn
time.

**Codex.** Each backend instance lazily creates `/tmp/zotero-ai-codex-*` via `mkdtemp` and
best-effort copies `~/.codex/auth.json` into it (silently skipped on `ENOENT`). `codex mcp-server`
is then spawned with `env.HOME = <tmpdir>`, `env.CODEX_HOME = <tmpdir>`, and `cwd = <tmpdir>` (also
reflected in the `tools/call codex` arguments' `cwd` field). Pointing both `HOME` and `CODEX_HOME`
at a fresh empty directory neutralises `AGENTS.md`, `config.toml`, and per-project skills lookup;
copying `auth.json` preserves the user's ChatGPT OAuth.

**Claude.** Each backend instance lazily creates `/tmp/zotero-ai-claude-*`. `claude -p …` is spawned
with `cwd = <tmpdir>` plus four argv flags: `--setting-sources user` (restricts to the user-global
settings layer), `--strict-mcp-config` (refuses to load MCP sidecars from settings),
`--disable-slash-commands` (turns off slash dispatch entirely), and
`--system-prompt <NEUTRAL_PREFACE>` (replaces the user's default system prompt). `HOME` is
**deliberately not overridden** because subscription auth resolves through the OS keychain via
`$HOME`-scoped paths; overriding it would break authentication.

**Accepted limitations.** Two pollution sources remain:

- _Bundled codex `.system` skills._ Codex ships five baked-in skills (imagegen, openai-docs,
  plugin-creator, skill-creator, skill-installer) compiled into the binary that environment
  isolation cannot suppress.
- _Claude SessionStart hooks._ The four isolation flags do not block SessionStart hooks from firing;
  the neutral `--system-prompt` is the bias against the model treating any resulting output as
  instructions.

Both are acceptable because the residual surface is narrow relative to the unisolated state, and
plugging them would require either upstream changes to the CLIs or chrome-side spawning (which the
original decision rejected on blast-radius grounds).

## Addendum — 2026-05-24: Proxy authentication

The proxy now enforces bearer-token authentication on the sensitive routes, plus two defense layers
(Host/Origin header gates and a 1 MiB body cap) that hold even on the bearer-exempt routes. The
contract between the plugin and the proxy is:

- **Per-spawn token.** `src/platform/wire-proxy-lifecycle.ts` mints a fresh `crypto.randomUUID()`
  the first time it starts the child (and any time it starts after a `stop()` or unsolicited exit),
  threads it into the child's environment under `LLM_PROXY_AUTH_TOKEN`, and clears the parent-side
  copy on stop / exit / start-failure so `getProxyAuthToken()` correctly reports "no running proxy".
  The token is regenerated on every fresh spawn; the same UUID is never reused across process
  lifetimes.
- **Shared env-var constant.** Both ends import `LLM_PROXY_AUTH_TOKEN_ENV` from
  `scripts/llm-proxy/protocol-constants.mjs` (a new dependency-free `.mjs` with a sidecar `.d.mts`)
  so the literal `"LLM_PROXY_AUTH_TOKEN"` is never duplicated. A typo on either side would silently
  downgrade to no-auth mode; the round-trip test in `tests/platform/wire-proxy-lifecycle.test.ts`
  reads the env value the parent wrote, constructs a real proxy with the same env, and asserts the
  bearer gate accepts the wired-side token.
- **Constant-time comparison.** The bearer check uses `crypto.timingSafeEqual` with a length
  pre-check (to avoid `timingSafeEqual` throwing on differing-length buffers). The `Buffer.from` of
  the configured token is precomputed at server construction time; only the per-request presented
  token is allocated fresh.
- **No-auth dev mode (permitted).** When `LLM_PROXY_AUTH_TOKEN` is unset (e.g. `npm run proxy:llm`
  or existing integration tests that spawn the proxy without the env var), the bearer gate is a
  no-op. The proxy emits a loud `console.warn` canary as the first line of process output:
  `llm-proxy: AUTH DISABLED — set LLM_PROXY_AUTH_TOKEN to enable bearer auth`. A misconfigured
  production spawn (env var dropped on the floor) therefore shouts in the Zotero error console
  rather than failing silently-permissively. The dev path is preserved because forcing auth on
  hand-run developer invocations would break the smoke-test ergonomics for negligible safety gain on
  a single-user developer machine.
- **Per-route carve-outs.** Two routes are exempt from the bearer gate (they remain Host/Origin
  gated):
  - `POST /api/shutdown` — preserves the orphan-takeover path. When the plugin starts after a Zotero
    crash leaves an old proxy listening on the configured port, it cannot know the orphan's token
    (the orphan was spawned by a now-dead Zotero process whose UUID was never persisted). Without
    the carve-out, the plugin would either (a) leak orphans every time Zotero crashed, or (b)
    require persisting the token across Zotero sessions — which would weaken the rotation guarantee.
    Host/Origin gates still prevent network attackers, and DoS via shutdown is acceptable on a
    single-user desktop where the worst-case is the user manually killing the proxy and restarting
    the plugin.
  - `GET /` (route catalogue) — kept unauthenticated so a developer poking at the proxy with `curl`
    can discover the surface, and so trivial liveness probes do not need to know the token.

The plugin-side wiring exposes a shared `buildProxyAuthHeader(baseUrl)` helper (exported from
`src/bootstrap.ts`) that URL-parses the request URL and returns the `Authorization: Bearer <token>`
header only when the hostname is either `127.0.0.1` or `localhost` at the running proxy's configured
port. All four chrome-side callers consult it — the ollama chat/embed adapter, the settings-dialog
model-list `discoverModels`, the Save-button `probeOneUrl` validation, and the first-run
`probeOllamaForOnboarding` probe — so a user who picked the Codex/Claude Proxy preset (which seeds
the base URL as `http://localhost:11400/codex` or `…/claude`) authenticates cleanly without the
plugin requiring the URL be hand-edited to `127.0.0.1`. Legacy callers, real-Ollama-daemon paths,
and tests that omit the dep remain backward-compatible — no Authorization header is sent. The
lifecycle's `diagnosticsFetch` threads the same bearer into the `/api/diagnostics` probe.
