# Zotero AI Explain

![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-f7df1e?logo=javascript&logoColor=222222)
![CSS](https://img.shields.io/badge/CSS-UI%20Surfaces-1572b6?logo=css3&logoColor=white)
![Zotero](https://img.shields.io/badge/Zotero-Plugin-990000)
![Tests](https://img.shields.io/badge/tests-vitest-6e9f18?logo=vitest&logoColor=white)

Zotero AI Explain is a Zotero plugin for explaining selected text in-place, holding follow-up
conversations in a sidebar, and asking NotebookLM-style questions across your entire library. Select
a passage in the Zotero reader, ask for an explanation, review the answer in an anchored popup above
the text, move the conversation into a sidebar when you want to keep chatting, and ask "Ask your
library" questions that cite the items they came from.

![Animated preview of Zotero AI Explain inside Zotero](docs/assets/readme-zotero-ai-preview.svg)

## Extension Preview

![Screenshot-style preview of the Zotero reader popup and sidebar](docs/assets/readme-sidebar-screenshot.svg)

## Architecture overview

Zotero AI Explain is composed of five user-visible surfaces and one bundled subprocess:

- **Anchored "Explain with AI" popup** — appears at chrome-window coordinates above the selected
  text in the Zotero PDF reader. Streams the explanation in markdown with citation links.
- **Sidebar follow-up chat** — when the popup is open, "Continue in sidebar" hands the conversation
  off to a persistent sidebar pane so the user can keep asking follow-ups while the reader stays in
  view.
- **Library indexing** — the settings dialog's Index controls walk every item in the active library,
  extract title + abstract + child notes + cached PDF text (`.zotero-ft-cache` when Zotero has
  already indexed the attachment), chunk to ~2 KB, embed each chunk via the configured embedding
  provider, and persist the resulting vectors + chunk text to a JSON file under the Zotero data
  directory.
- **"Ask your library"** (Tools menu) — a NotebookLM-style chat surface that takes a question,
  cosine-ranks the persisted chunks, threads the top K into a grounded prompt, streams the answer,
  and renders `[ITEM_KEY]` citations as clickable links that select the cited item in Zotero.
- **Settings dialog** — preset dropdown ("Local Ollama", "Codex via Proxy", "Claude via Proxy",
  "OpenAI Direct", "Anthropic Direct", "Custom") + independent chat/embed provider selectors + live
  model discovery (probes the configured URL/API on every URL or key change to populate the model
  dropdowns) + the Library Index controls + the Local LLM Proxy controls.
- **Local LLM proxy** (bundled subprocess) — a small Node HTTP service shipped inside the XPI that
  speaks the Ollama `/api/chat` wire protocol and routes each request to either the Codex CLI, the
  Claude Code CLI, or a real Ollama daemon. Auto-spawned by the plugin via Mozilla's
  `Subprocess.sys.mjs` when the user clicks Start in settings. Lets users plug ChatGPT and Claude
  subscriptions into the plugin without ever holding an API key.

## Quick start

The settings dialog opens with a single **Preset** dropdown at the top. Pick the preset that matches
your install and the dropdown writes URLs, providers, and model names into every field for you.
Manual edits flip the dropdown to **Custom** without touching the values you typed.

| Preset               | What it does                                                          | What you need                                                                   |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Local Ollama**     | Chat + embeddings on your machine.                                    | [Ollama](https://ollama.com) installed; `gemma4:e4b` + `embeddinggemma` pulled. |
| **Codex via Proxy**  | Chat via Codex CLI (your ChatGPT login); embed on Ollama.             | Codex CLI installed and `codex login` run; Ollama for embeddings.               |
| **Claude via Proxy** | Chat via Claude Code CLI (your Claude subscription); embed on Ollama. | Claude Code CLI installed and `claude login` run; Ollama for embeddings.        |
| **OpenAI Direct**    | Chat + embed against the OpenAI REST API.                             | An OpenAI API key.                                                              |
| **Anthropic Direct** | Chat against the Anthropic API; embed on Ollama.                      | An Anthropic API key; Ollama for embeddings (Anthropic has no embed API).       |
| **Custom**           | Keep whatever you have configured.                                    | Whatever the previous configuration required.                                   |

For the Codex/Claude/Anthropic presets, the bundled LLM proxy must be running. Click **Start** in
the settings dialog's "Local LLM Proxy" section and the plugin spawns it for you (see
[LLM proxy](#llm-proxy) below). For the Local Ollama preset you need `ollama serve` running on
`http://localhost:11434`.

## Provider matrix

| Backend              | Chat | Embed | API key |   Subscription / CLI auth   | Local?                               |
| -------------------- | :--: | :---: | :-----: | :-------------------------: | ------------------------------------ |
| `ollama`             | yes  |  yes  |   no    |             no              | yes (your machine)                   |
| `codex-cli`          | yes  |  no   |   no    | ChatGPT (via `codex login`) | yes (via bundled proxy + Codex CLI)  |
| `claude-cli`         | yes  |  no   |   no    | Claude (via `claude login`) | yes (via bundled proxy + Claude CLI) |
| `codex-api` / OpenAI | yes  |  yes  |   yes   |             no              | no                                   |
| `claude-api`         | yes  |  no   |   yes   |             no              | no                                   |
| `gemini` (embed)     |  no  |  yes  |   yes   |             no              | no                                   |

Chat and embed providers are chosen independently. A common configuration is `chat=codex-cli` (uses
your ChatGPT login through the proxy) with `embed=ollama` (free, local, private). The preset
dropdown is the shortcut; advanced users can pick any combination directly in the Chat Backend and
Embedding Backend selectors.

## Library chat ("Ask your library")

`Tools → Ask your library` opens a NotebookLM-style dialog hosted in a Zotero window. The flow:

1. The user types a question.
2. The active embedding provider embeds the question.
3. Every chunk in the persisted index is scored by cosine similarity to the query embedding.
4. The top **K = 8** chunks (≈ 16 KB of context) are threaded into a grounded prompt that asks the
   chat model to cite the source `[itemKey]` after each claim.
5. The chat provider streams the answer.
6. Bracketed citations in the streamed text render as clickable links — clicking `[ABC1234]` selects
   the matching Zotero item via `Zotero.Items.getByLibraryAndKey(...)` +
   `Zotero.getActiveZoteroPane().selectItems(...)`.

The retrieval is **flat across chunks** (no per-item dedup), so a question that hits multiple
sections of a single paper can legitimately surface several chunks from the same item. "New
conversation" resets the in-memory thread; messages persist across follow-ups within a session but
not across plugin restarts. When the index doesn't exist or the query embedding has a different
dimension than the persisted vectors (provider switched without re-indexing), a clear in-dialog
error surfaces rather than a fabricated answer.

See
[`docs/decisions/0005-library-chat-rag-design.md`](docs/decisions/0005-library-chat-rag-design.md)
for the rationale.

## Per-provider indexes

Each `(embedding-provider, model)` pair gets its own on-disk index file under the Zotero data
directory:

```text
zotero-ai-explain-index-ollama-embeddinggemma.json
zotero-ai-explain-index-openai-3-small.json
zotero-ai-explain-index-openai-3-large.json
zotero-ai-explain-index-gemini-004.json
```

Mixing vectors from different providers in one file would silently corrupt cosine-similarity scores
(different embedding spaces, sometimes different dimensions: Ollama `embeddinggemma` is 768, OpenAI
`text-embedding-3-large` is 3072, etc.). The plugin avoids this by writing one file per (provider,
model). Switching providers in settings instantly loads the matching index — re-indexing is only
required when the file for the chosen (provider, model) pair doesn't yet exist or when the user
clicks **Clear** in the Library Index controls.

The legacy `zotero-ai-explain-index.json` filename is honoured as a back-compat alias for
`ollama / embeddinggemma` so existing installs don't lose their index on upgrade.

See
[`docs/decisions/0002-per-provider-index-files.md`](docs/decisions/0002-per-provider-index-files.md)
for the rationale.

## LLM proxy

`scripts/llm-proxy/server.mjs` is a Node HTTP service that speaks the Ollama `/api/chat` wire
protocol on the front side and routes each request to one of three backends:

- `/codex` — spawns `codex exec --json -` (first turn) or `codex exec resume <SESSION_ID> --json -`
  (follow-ups) and translates Codex's JSON event stream into Ollama-format NDJSON.
- `/claude` — spawns `claude -p --output-format json --allowedTools "" -` (first turn) or
  `claude --resume <SESSION_ID> -p --output-format json --allowedTools "" -` (follow-ups). The empty
  `--allowedTools` allowlist hard-disables every Claude Code tool so the CLI behaves as a pure chat
  model.
- `/ollama` — forwards verbatim to a real Ollama daemon at `OLLAMA_BASE_URL` (default
  `http://localhost:11434`).

**The proxy is bundled inside the XPI.** When the user clicks **Start** in the settings dialog's
Local LLM Proxy section, `src/bootstrap.ts` resolves the bundled `addon/llm-proxy/server.mjs` path
from the plugin's `rootURI`, auto-detects a Node binary (`/opt/homebrew/bin/node` first to match
Apple Silicon defaults, then `which node`, then a fallback list), and spawns the child via Mozilla's
`Subprocess.sys.mjs`. The child is sent SIGTERM (with a 3 s grace before SIGKILL) on plugin
shutdown. If auto-detection can't find Node, the settings dialog reveals a "Node binary path" field
with a copy-pasteable banner.

The proxy can also be run by hand for development:

```bash
npm run proxy:llm
# zotero-ai-llm-proxy listening on http://127.0.0.1:11400
#   /codex   → Codex CLI (multi-turn session_id resume)
#   /claude  → Claude Code CLI (multi-turn --resume)
#   /ollama  → http://localhost:11434
```

Environment overrides (all optional):

- `LLM_PROXY_PORT` — default `11400`.
- `OLLAMA_BASE_URL` — default `http://localhost:11434`.
- `CODEX_DEFAULT_MODEL` — default `gpt-5.2-codex`.
- `CLAUDE_BINARY` — explicit path to `claude` when not on `PATH`.
- `CODEX_IDLE_TIMEOUT_MS` / `CODEX_HARD_TIMEOUT_MS` — default 60 s / 300 s.
- `CLAUDE_IDLE_TIMEOUT_MS` / `CLAUDE_HARD_TIMEOUT_MS` — default 60 s / 300 s.

Configure the Zotero plugin to use the proxy by setting an Ollama provider profile's **Base URL** to
one of:

- `http://127.0.0.1:11400/codex` — Codex backend
- `http://127.0.0.1:11400/claude` — Claude backend
- `http://127.0.0.1:11400/ollama` — passthrough

(The preset dropdown writes these URLs for you.) The plugin appends `/api/chat` (and `/api/embed`
for the Ollama route) itself.

Smoke test the streaming wire format with `curl`:

```bash
curl -N -H 'content-type: application/json' \
  -d '{"model":"gpt-5.2-codex","messages":[{"role":"user","content":"say hi in 3 words"}],"stream":true}' \
  http://127.0.0.1:11400/codex/api/chat
```

The response is NDJSON: zero or more `{"message":{"role":"assistant","content":"…"},"done":false}`
lines followed by a single `{…,"done":true,"done_reason":"stop"}` line. Errors surface as
`{…,"done":true,"done_reason":"error","error":"…"}` so the plugin's popup renders them instead of
silently completing with empty content.

See [`scripts/llm-proxy/README.md`](scripts/llm-proxy/README.md) for the full configuration
reference and troubleshooting tips, and
[`docs/decisions/0001-llm-proxy-architecture.md`](docs/decisions/0001-llm-proxy-architecture.md) for
the architectural rationale.

## Development

```bash
npm install
pre-commit install
npm run build
npm run verify
pre-commit run --all-files
```

The build emits the Zotero bootstrap bundle at `addon/content/zotero-ai-explain.js` as an IIFE that
exposes `ZoteroAiExplain.startup` / `ZoteroAiExplain.shutdown`. The bundle is loaded into the
plugin's bootstrap scope via `Services.scriptloader.loadSubScript`; Firefox 140 ESR refuses
`ChromeUtils.importESModule` for non-trusted-scheme URLs, so the IIFE form is required.

## Manual Verification

Use `docs/manual-verification/zotero.md` for the manual acceptance pass after building and packaging
the `addon/` directory.

### Test with Ollama

```bash
ollama serve
ollama pull gemma4:e4b
ollama pull embeddinggemma
npm run build
node scripts/package-xpi.mjs v0.1.3
```

Install `zotero-ai-explain.xpi` in Zotero, open the plugin settings, pick the **Local Ollama**
preset, and run a manual smoke test.

### Local-only e2e tests

`npm run test:e2e` exercises the plugin against a fake Ollama HTTP server and runs in CI on every
commit. A second suite, `npm run test:e2e:local`, points the plugin at a real Ollama daemon so the
streaming chat and embedding paths are validated against a live model at least once before each
release. **CI never runs the local suite**; it auto-skips when Ollama is unreachable.

Prerequisites:

```bash
ollama serve                 # daemon listening on http://localhost:11434
ollama pull gemma4:e4b       # chat model
ollama pull embeddinggemma   # embedding model
npm run build && npm run package
npm run test:e2e:local
```

Environment overrides (all optional):

- `OLLAMA_BASE_URL` — default `http://localhost:11434`.
- `OLLAMA_CHAT_MODEL` — default `gemma4:e4b`.
- `OLLAMA_EMBED_MODEL` — default `embeddinggemma`.

If Ollama is unreachable or a required model is missing, every test in the suite is skipped with a
clear `console.warn` explaining why. Contributors without a local Ollama install never see false
negatives.

## Continuous Integration

Three GitHub Actions workflows gate changes:

| Workflow             | File                                       | Trigger                                                   | Runs on                                                                | What it validates                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CI`                 | `.github/workflows/ci.yml`                 | push to `main`, pull requests                             | `ubuntu-latest`                                                        | Typecheck, lint, format, unit tests, `npm audit`, pre-commit hooks. Fast required check (~2 min).                                                                                                                                        |
| `Zotero E2E`         | `.github/workflows/e2e.yml`                | push to `main`, pull requests                             | `ubuntu-latest`                                                        | Real Zotero spawn + fake-Ollama e2e under Xvfb. Confirms the bootstrap, manifest, and harness still work on Linux. Required check (~5 min).                                                                                              |
| `E2E Cross-Platform` | `.github/workflows/e2e-cross-platform.yml` | push to `main`, pull requests, manual `workflow_dispatch` | `ubuntu-latest`, `macos-latest`, `windows-latest` (`fail-fast: false`) | Full gate suite (typecheck → lint → unit → build → package → fake-Ollama e2e → real-Ollama e2e with `gemma3:1b` + `embeddinggemma`) against a real Zotero install on each OS. Release gate (~10–15 min/OS on cold cache; ~3–5 min warm). |

The cross-platform workflow pins `ZOTERO_VERSION` and `OLLAMA_VERSION` at the top of the file for
reproducibility. Bump both values together when adopting a new Zotero release, and re-validate
locally first. The Ollama model blobs (~1.6 GB) are cached via `actions/cache@v4` keyed on OS +
Ollama version + model names, so subsequent runs skip the slow pull unless one of those keys
changes.

Because the cross-platform suite is materially slower than the linux-only `Zotero E2E` job, treat it
as a release gate rather than a fast per-PR gate. To block every PR on it, add
`cross-platform-e2e (ubuntu-latest)`, `cross-platform-e2e (macos-latest)`, and
`cross-platform-e2e (windows-latest)` to the branch protection required-checks list for `main`. On
failure, the workflow uploads `/tmp/zotero-e2e-latest.log`, the built XPI, and the Ollama daemon
logs as an `e2e-cross-platform-<os>-failure` artifact (7-day retention).

## Architectural decisions

The major design decisions made during the Phase 4 real-product-pipeline work are recorded as short
ADRs under [`docs/decisions/`](docs/decisions/):

- [0001 — LLM proxy architecture](docs/decisions/0001-llm-proxy-architecture.md)
- [0002 — Per-provider index files](docs/decisions/0002-per-provider-index-files.md)
- [0003 — Provider profile abstraction](docs/decisions/0003-provider-profile-abstraction.md)
- [0004 — Bootstrap chrome subprocess](docs/decisions/0004-bootstrap-chrome-subprocess.md)
- [0005 — Library chat RAG design](docs/decisions/0005-library-chat-rag-design.md)

## Project Layout

| Path       | Purpose                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| `src/`     | TypeScript source for plugin logic.                                       |
| `tests/`   | Vitest test suite (unit + integration + e2e + e2e-local).                 |
| `addon/`   | Zotero extension assets and browser-facing files (staged into the XPI).   |
| `docs/`    | Design specs, ADRs, manual verification, and supporting documentation.    |
| `scripts/` | Build and packaging automation; bundled `llm-proxy` server.               |
| `.forge/`  | Local Forge state is ignored; `.forge/learnings.jsonl` remains trackable. |
