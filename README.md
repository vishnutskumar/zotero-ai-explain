# Zotero AI Explain

![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ESM-f7df1e?logo=javascript&logoColor=222222)
![CSS](https://img.shields.io/badge/CSS-UI%20Surfaces-1572b6?logo=css3&logoColor=white)
![Zotero](https://img.shields.io/badge/Zotero-8.0%E2%80%939.99-990000)
![Tests](https://img.shields.io/badge/tests-vitest-6e9f18?logo=vitest&logoColor=white)

**Zotero AI Explain** is a Zotero plugin that turns a passage in the PDF reader into an AI
conversation and lets you ask NotebookLM-style questions across your whole library — with answers
that cite the items and pages they came from. It is PDF-aware: it knows which document and page you
are reading, scopes retrieval to the open PDF, and jumps the reader to a cited page when you click a
citation.

You bring the model. Chat and embeddings are configured independently and can run fully locally
(Ollama), against your ChatGPT or Claude subscription (through a bundled local proxy that drives the
Codex or Claude Code CLIs), or against the OpenAI / Anthropic / Gemini APIs — without the plugin
ever holding an API key in plaintext preferences.

![Animated preview of Zotero AI Explain inside Zotero](docs/assets/readme-zotero-ai-preview.svg)

## Features

### Selected-text explanation — "Explain with AI"

Select a passage in the Zotero PDF reader and choose **Explain with AI** from the reader context
menu (or press **Cmd/Ctrl+Shift+E**). An anchored popup appears above the selection and streams a
markdown explanation in place. The popup is positioned at chrome-window coordinates so it floats
above the reader without stealing focus.

### "Ask a question" — focused reader chat

A second reader command, **Ask a question**, opens the same anchored popup but with the textarea
focused and _no_ auto-explanation: you type your own question about the selected passage. The
selection is pinned as a sticky quote — every turn of the conversation re-applies the quote as a
system message, so a five-turn chat stays anchored to the text you started from. Both reader
commands are hidden when the reader reports no active selection.

### Sidebar follow-up chat

While a popup is open, **Continue in sidebar** hands the conversation off to a persistent sidebar
pane. The reader stays in view and you keep asking follow-ups without the popup covering the page.
Popup and sidebar share a single markdown stylesheet, so headings, lists, code blocks, and
blockquotes render identically across both surfaces and track the OS theme.

### PDF identity in the prompt

Reader-triggered explain and ask-question requests carry the document's identity into the prompt
frame: the item title, the attachment key, and the page reference (the reader's page label, or the
1-based page number as a fallback). The model knows it is answering about _"<paper title>, p. 14"_
rather than an anonymous block of text.

### "Ask your library" — NotebookLM-style RAG chat

**Tools → Ask your library** (or **Cmd/Ctrl+Shift+L**) opens a retrieval-augmented chat dialog over
your indexed library. You type a question; the plugin embeds it, cosine-ranks every chunk in the
on-disk index, threads the top **K = 8** chunks into a grounded prompt, and streams an answer whose
bracketed `[itemKey#chunkIndex]` citations render as clickable links.

### In-PDF RAG scoping

Retrieval is context-aware. When you ask a question from a reader popup, RAG is **auto-scoped to the
open document** — only chunks from that PDF are retrieved, so the answer stays grounded in what you
are reading. The library-chat dialog stays **library-wide**. The scope is request-scoped: two reader
windows asking questions about two different PDFs never cross-contaminate.

### Citation jump-to-page

Citations are chunk-scoped and clickable from every chat surface — the library-chat dialog, the
reader popup, and the sidebar. Each chunk knows its source PDF page, so clicking a citation opens
(or navigates an already-open reader to) the exact cited page via
`Zotero.Reader.open(attachmentId, { pageIndex })`. Two citations from different pages of the same
paper navigate the same reader tab rather than spawning duplicates. A hallucinated or legacy
citation token falls back gracefully — it opens the item at page 1 or renders inert, never silently
routing to the wrong source.

### Per-page PDF text extraction

The library indexer extracts PDF text **per page** via Zotero's bundled
`Zotero.PDFWorker.getFullText` worker, splitting on the form-feed delimiter so every chunk carries
the page it came from. Metadata, child notes, and non-PDF attachments (EPUB, snapshots) are indexed
alongside, each tagged with its source kind.

### Per-provider on-disk indexes with schema-versioned migration

Each `(embedding-provider, model)` pair gets its own index file under the Zotero data directory, so
switching providers never corrupts cosine scores by mixing embedding spaces. The index carries a
`schemaVersion`; upgrading to v0.3.0 triggers a one-time, crash-safe migration that re-crawls into a
sibling temp file and atomically swaps it in — a plugin reload mid-migration resumes cleanly from a
sidecar marker, and concurrent readers always see a fully-populated file.

### Local LLM proxy — use your ChatGPT / Claude subscription

A small Node HTTP service ships inside the XPI. It speaks the Ollama wire protocol on the front side
and routes each request to the **Codex CLI**, the **Claude Code CLI**, or a real **Ollama** daemon.
The plugin auto-spawns it from the settings dialog. This lets you plug a ChatGPT or Claude
subscription into the plugin without ever pasting an API key. The proxy binds to `127.0.0.1` only,
authenticates plugin requests with a per-spawn bearer token (`crypto.randomUUID()` threaded into the
child via `LLM_PROXY_AUTH_TOKEN`), rejects requests from foreign Hosts or Origins (blocks browser
DNS-rebinding), and caps request bodies at 1 MiB. It also spawns each CLI in an isolated environment
so the user's developer config (`~/.codex/AGENTS.md`, `~/.claude/CLAUDE.md`, custom skills, MCP
sidecars, slash commands) does not bleed into Zotero responses — see
[`scripts/llm-proxy/README.md#subprocess-isolation`](scripts/llm-proxy/README.md#subprocess-isolation).

### Keyboard shortcuts

| Shortcut             | Action                                   |
| -------------------- | ---------------------------------------- |
| **Cmd/Ctrl+Shift+E** | Explain the current reader selection.    |
| **Cmd/Ctrl+Shift+L** | Open the "Ask your library" chat dialog. |

### Compatibility

Zotero **8.0 – 9.99.99** (the plugin manifest's `strict_min_version` / `strict_max_version`).

![Screenshot-style preview of the Zotero reader popup and sidebar](docs/assets/readme-sidebar-screenshot.svg)

## Install

### Download the latest release (recommended)

1. Open <https://github.com/vishnutskumar/zotero-ai-explain/releases/latest>.
2. Download the `zotero-ai-explain-v<version>.xpi` asset.
3. In Zotero: **Tools → Plugins → gear menu → Install Plugin From File…** and pick the `.xpi`.
4. Restart Zotero if prompted.

Future versions arrive automatically for Zotero installs with automatic-update enabled — the plugin
manifest's `update_url` points at
`https://github.com/vishnutskumar/zotero-ai-explain/releases/latest/download/updates.json`.

If you intend to use the Codex or Claude backends, you also need **Node.js ≥ 22** installed on the
machine — the bundled proxy runs under your system Node (see [Configuration](#configuration)).

### Build from source (contributors / unreleased changes)

If you want to install the latest unreleased changes or you are developing against the plugin, build
the XPI from this repository:

```bash
npm install
npm run build      # esbuild → addon/content/zotero-ai-explain.js
npm run package    # zip addon/ + bundled llm-proxy/ → zotero-ai-explain.xpi
```

Then install the freshly built `zotero-ai-explain.xpi` via the same **Tools → Plugins → gear menu →
Install Plugin From File…** flow.

Local builds carry a `-dev` suffix on the manifest version (e.g. `0.4.0-dev`). `npm run package`
runs without arguments and reads that version verbatim, producing
`dist/zotero-ai-explain-v0.4.0-dev.xpi` plus the `zotero-ai-explain.xpi` latest-alias. Zotero's
auto-updater silently replaces locally-installed XPIs with the GitHub release version when both
share the same version number — the `-dev` suffix makes Zotero treat the local install as strictly
newer than the latest release, so it is left alone across restarts. Strip the suffix only when
prepping a release tag (see [Releasing](#releasing)).

## Configuration

Open the plugin settings from **Tools → Zotero AI Explain Settings**. The dialog opens with a single
**Preset** dropdown at the top: pick the preset that matches your install and it writes URLs,
providers, and model names into every field for you. Manual edits flip the dropdown to **Custom**
without discarding what you typed.

| Preset               | What it does                                                          | What you need                                                             |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Local Ollama**     | Chat + embeddings on your machine.                                    | [Ollama](https://ollama.com) installed; chat + embedding models pulled.   |
| **Codex via Proxy**  | Chat via Codex CLI (your ChatGPT login); embed on Ollama.             | Codex CLI installed and `codex login` run; Ollama for embeddings.         |
| **Claude via Proxy** | Chat via Claude Code CLI (your Claude subscription); embed on Ollama. | Claude Code CLI installed and `claude login` run; Ollama for embeddings.  |
| **OpenAI Direct**    | Chat + embed against the OpenAI REST API.                             | An OpenAI API key.                                                        |
| **Anthropic Direct** | Chat against the Anthropic API; embed on Ollama.                      | An Anthropic API key; Ollama for embeddings (Anthropic has no embed API). |
| **Custom**           | Keep whatever you have configured.                                    | Whatever the previous configuration required.                             |

### Provider matrix

Chat and embed backends are chosen **independently**. A common setup is `chat=codex-cli` (your
ChatGPT login, via the proxy) with `embed=ollama` (free, local, private).

| Backend          | Chat | Embed | API key |   Subscription / CLI auth   | Local?                               |
| ---------------- | :--: | :---: | :-----: | :-------------------------: | ------------------------------------ |
| `ollama`         | yes  |  yes  |   no    |             no              | yes (your machine)                   |
| `codex-cli`      | yes  |  no   |   no    | ChatGPT (via `codex login`) | yes (via bundled proxy + Codex CLI)  |
| `claude-cli`     | yes  |  no   |   no    | Claude (via `claude login`) | yes (via bundled proxy + Claude CLI) |
| OpenAI           | yes  |  yes  |   yes   |             no              | no                                   |
| `claude-api`     | yes  |  no   |   yes   |             no              | no                                   |
| `gemini` (embed) |  no  |  yes  |   yes   |             no              | no                                   |

API keys are never stored as plaintext preferences — the plugin holds a **secret reference** and
resolves the key at request time.

### The local LLM proxy

For the **Codex via Proxy**, **Claude via Proxy**, and **Anthropic Direct** presets, the bundled LLM
proxy must be running. Click **Start** in the settings dialog's _Local LLM Proxy_ section and the
plugin spawns it for you via Mozilla's `Subprocess.sys.mjs`. It auto-detects a Node binary
(`/opt/homebrew/bin/node` first to match Apple Silicon, then `which node`, then a fallback list); if
auto-detection fails the dialog reveals a **Node binary path** field. The child is sent SIGTERM
(with a 3 s grace before SIGKILL) on plugin shutdown.

For the **Local Ollama** preset you instead need `ollama serve` running on `http://localhost:11434`.

See [`scripts/llm-proxy/README.md`](scripts/llm-proxy/README.md) for the proxy's full configuration
reference, environment overrides, wire-format details, and troubleshooting.

### Library indexing

The settings dialog's **Library Index** controls walk every item in the active library, extract
title + abstract + child notes + per-page PDF text + non-PDF attachment text, chunk it, embed each
chunk via the configured embedding provider, and persist the vectors to a per-`(provider, model)`
JSON file under the Zotero data directory. Use **Index library** to start a crawl, **Pause** /
**Resume** to control it, and **Clear index** (two-stage confirm) to delete the current index. The
plugin also auto-reindexes incrementally as your library changes.

## Usage

1. **Explain a passage.** Open a PDF in the Zotero reader, select text, and choose **Explain with
   AI** (or press **Cmd/Ctrl+Shift+E**). Read the streamed answer in the anchored popup.
2. **Ask your own question about a passage.** Select text and choose **Ask a question** — type a
   question; the selection is pinned as a sticky quote for the whole conversation.
3. **Keep chatting.** Click **Continue in sidebar** to move the conversation into a sidebar pane.
4. **Index your library.** Open settings, pick a preset, and click **Index library**.
5. **Ask your library.** Press **Cmd/Ctrl+Shift+L** (or **Tools → Ask your library**), type a
   question, and click the `[itemKey#chunkIndex]` citations in the answer to jump to the cited PDF
   page.

## Architecture

Zotero AI Explain is composed of five user-visible surfaces and one bundled subprocess:

- **Anchored popup** — floats above the reader selection at chrome-window coordinates; serves both
  the "Explain with AI" auto-explanation and the "Ask a question" focused-input modes; streams
  markdown with citation links.
- **Sidebar chat** — a persistent pane the popup hands its conversation off to; shares the popup's
  markdown stylesheet.
- **Library indexing** — crawls the active library, extracts per-page PDF text via
  `Zotero.PDFWorker.getFullText` plus metadata / notes / non-PDF attachments, chunks and embeds, and
  persists per-`(provider, model)` JSON indexes (schema-versioned, with crash-safe migration and an
  in-memory parse cache).
- **"Ask your library" dialog** — embeds the question, cosine-ranks the persisted chunks (top K = 8;
  auto-scoped to the open PDF when launched from a reader, library-wide from the Tools menu),
  threads a grounded prompt, and renders chunk-scoped citations that jump the reader to the cited
  page.
- **Settings dialog** — preset dropdown + independent chat/embed selectors + live model discovery +
  Library Index controls + Local LLM Proxy controls.
- **Local LLM proxy** (bundled subprocess) — a Node HTTP service inside the XPI that speaks the
  Ollama `/api/chat` wire protocol and routes to the Codex CLI, the Claude Code CLI, or a real
  Ollama daemon.

The major design decisions are recorded as short ADRs under [`docs/decisions/`](docs/decisions/):

- [0001 — LLM proxy architecture](docs/decisions/0001-llm-proxy-architecture.md)
- [0002 — Per-provider index files](docs/decisions/0002-per-provider-index-files.md)
- [0003 — Provider profile abstraction](docs/decisions/0003-provider-profile-abstraction.md)
- [0004 — Bootstrap chrome subprocess](docs/decisions/0004-bootstrap-chrome-subprocess.md)
- [0005 — Library chat RAG design](docs/decisions/0005-library-chat-rag-design.md)
- [0006 — Per-page PDF text extraction via `Zotero.PDFWorker`](docs/decisions/0006-pdf-worker-per-page-extraction.md)
- [0007 — Schema-versioned write-new-then-swap index migration](docs/decisions/0007-schema-versioned-index-migration.md)

## Development

```bash
npm install
pre-commit install
npm run build      # esbuild → addon/content/zotero-ai-explain.js
npm run verify     # typecheck + lint + format + unit/integration tests
npm run test:e2e   # real Zotero + fake Ollama end-to-end suite
pre-commit run --all-files
```

The build emits the Zotero bootstrap bundle at `addon/content/zotero-ai-explain.js` as an IIFE that
exposes `ZoteroAiExplain.startup` / `ZoteroAiExplain.shutdown`. The bundle is loaded into the
plugin's bootstrap scope via `Services.scriptloader.loadSubScript`; Firefox ESR refuses
`ChromeUtils.importESModule` for non-trusted-scheme URLs, so the IIFE form is required.

### Tests

| Command                  | What it runs                                                                |
| ------------------------ | --------------------------------------------------------------------------- |
| `npm run test`           | Unit + integration suite (fast; runs in CI on every commit).                |
| `npm run test:e2e`       | Real Zotero spawn + fake-Ollama HTTP fixture end-to-end suite (runs in CI). |
| `npm run test:e2e:local` | Real Zotero + a real Ollama daemon; **auto-skips** when Ollama is offline.  |

The local-only e2e suite points the plugin at a real Ollama daemon so the streaming chat and
embedding paths are validated against a live model before each release:

```bash
ollama serve
ollama pull gemma4:e4b      # OLLAMA_CHAT_MODEL default; override via the env var
ollama pull embeddinggemma  # OLLAMA_EMBED_MODEL default
npm run build && npm run package
npm run test:e2e:local
```

If Ollama is unreachable or a model is missing, every test in the suite skips with a clear
`console.warn` — contributors without a local Ollama install never see false negatives.

### Continuous integration

Three GitHub Actions workflows gate changes:

| Workflow             | File                                       | What it validates                                                                         |
| -------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `CI`                 | `.github/workflows/ci.yml`                 | Typecheck, lint, format, unit tests, `npm audit`, pre-commit hooks. Fast required check.  |
| `Zotero E2E`         | `.github/workflows/e2e.yml`                | Real Zotero spawn + fake-Ollama e2e under Xvfb on Linux. Required check.                  |
| `E2E Cross-Platform` | `.github/workflows/e2e-cross-platform.yml` | Full gate suite + real-Ollama e2e against a real Zotero install on Linux, macOS, Windows. |

The cross-platform workflow pins `ZOTERO_VERSION` and `OLLAMA_VERSION` for reproducibility; treat it
as a release gate rather than a fast per-PR gate.

### Manual verification

Use [`docs/manual-verification/zotero.md`](docs/manual-verification/zotero.md) for the human
acceptance pass after building and packaging the `addon/` directory.

## Releasing

The feature branch's manifest version carries a `-dev` suffix (e.g. `0.4.0-dev`) so Zotero's
auto-updater treats locally-installed XPIs as strictly newer than the latest GitHub release. To cut
a release:

1. Edit `addon/manifest.json` and `package.json` — strip the `-dev` suffix from both versions in the
   same commit (the `version-guards` test enforces that the pair moves together).
2. Commit with a release-prep message and open a pull request against `main`.
3. Merge the release-prep PR to `main`, then wait for all required checks (`CI`, `Zotero E2E`,
   `E2E Cross-Platform`) to report green on the merge commit. The release workflow itself re-gates
   on these three checks against the tagged SHA and aborts after 60 minutes if any is missing or
   red, so tagging before `main` is green wastes a release-workflow run.
4. Tag the green `main` commit and push: `git tag v<MAJOR>.<MINOR>.<PATCH> && git push --tags`.
5. The release workflow's `v[0-9]+.[0-9]+.[0-9]+` tag filter accepts only clean semver — `-dev` tags
   never trigger a release. `validateReleaseVersions` then asserts that the tag, `package.json`, and
   `addon/manifest.json` all agree.
6. After the release, open a follow-up PR that bumps both files to `v<MAJOR>.<MINOR+1>.0-dev` (or
   `<MAJOR>.<MINOR>.<PATCH+1>-dev` for a patch line) so the next feature branch advances past the
   release again.

## Project layout

| Path       | Purpose                                                                   |
| ---------- | ------------------------------------------------------------------------- |
| `src/`     | TypeScript source for plugin logic.                                       |
| `tests/`   | Vitest test suite (unit + integration + e2e + e2e-local).                 |
| `addon/`   | Zotero extension assets and browser-facing files (staged into the XPI).   |
| `docs/`    | Design specs, ADRs, manual verification, and supporting documentation.    |
| `scripts/` | Build and packaging automation; bundled `llm-proxy` server.               |
| `.forge/`  | Local Forge state is ignored; `.forge/learnings.jsonl` remains trackable. |

</content>
</invoke>
