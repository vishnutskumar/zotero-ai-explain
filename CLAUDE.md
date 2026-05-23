# Zotero AI Explain

Zotero AI Explain is a PDF-aware Zotero plugin for selected-text explanations, a focused "Ask a
question" reader command, sidebar follow-up chat, and NotebookLM-style "Ask your library" retrieval
over per-provider on-disk indexes. Reader-triggered requests carry PDF identity (item title + page)
into the prompt and auto-scope RAG to the open document; library-chat citations are chunk-scoped and
jump the reader to the cited page. Chat and embedding backends are configured independently; a
bundled local LLM proxy lets the plugin route through the Codex or Claude Code CLIs (using the
user's ChatGPT/Claude subscription) or pass through to a real Ollama daemon.

## Structure

```text
zotero_ai/
  addon/                 # Zotero extension assets and browser-facing files (staged into the XPI)
    bootstrap.js         # Zotero bootstrap entrypoint; loads the IIFE bundle
    content/             # Built bundle output
    llm-proxy/           # (staged at build time from scripts/llm-proxy; ships in the XPI)
  docs/
    decisions/           # Architectural Decision Records (ADRs)
    specs/               # Approved Forge specs
    manual-verification/ # Human smoke-test checklists
    superpowers/         # Brainstorming + planning artefacts
  scripts/               # Build, packaging, and runtime automation
    llm-proxy/           # Bundled Node HTTP service (codex / claude / ollama backends)
    zotero-e2e/          # Real-Zotero spawn harness + fake-Ollama fixture
  src/
    bootstrap.ts         # Entrypoint; wires runtime, proxy lifecycle, onboarding
    conversation/        # Conversation stores (per-selection popup + singleton library chat)
    indexing/            # Library crawler, per-source chunker, per-provider index storage + migration, retrieval
    platform/            # Zotero adapters, citation-open, e2e driver, proxy lifecycle, subprocess wiring
    preferences/         # Provider profiles, preset dropdown, model discovery, onboarding pref
    providers/           # Chat + embed adapters (ollama, openai, claude-api, gemini)
    secrets/             # Secret references (no raw API keys in pref storage)
    selection/           # Selection context normalization (incl. PDF identity + RAG scope)
    ui/                  # Anchored popup, sidebar, library chat, citation lookup, settings, markdown
  tests/                 # Vitest test suite (unit, integration, e2e, e2e-local)
  .forge/                # Forge phase state and learnings (mostly gitignored)
```

## Build & Test

```bash
npm install
npm run typecheck
npm run lint
npm run format
npm run test            # unit + integration suite
npm run test:e2e        # real Zotero + fake Ollama; runs in CI
npm run test:e2e:local  # real Zotero + real Ollama; auto-skips when Ollama is offline
npm run build           # esbuild → addon/content/zotero-ai-explain.js
npm run package         # zip addon/ + bundled llm-proxy/ into zotero-ai-explain.xpi
npm run proxy:llm       # run scripts/llm-proxy/server.mjs out of the source tree
npm run verify          # typecheck + lint + format + test
pre-commit run --all-files
```

## Lint & Format

| Tool             | Command                      | Config                             |
| ---------------- | ---------------------------- | ---------------------------------- |
| TypeScript       | `npm run typecheck`          | `tsconfig.json`                    |
| ESLint           | `npm run lint`               | `eslint.config.js`                 |
| Prettier         | `npm run format`             | `.prettierrc`                      |
| Vitest           | `npm run test`               | `package.json`, `vitest.config.ts` |
| Vitest e2e       | `npm run test:e2e`           | `vitest.e2e.config.ts`             |
| Vitest e2e-local | `npm run test:e2e:local`     | `vitest.e2e-local.config.ts`       |
| Pre-commit       | `pre-commit run --all-files` | `.pre-commit-config.yaml`          |

Pre-commit hooks must run before commits. Fix hook failures at the root cause.

When widening a scanner's scope (e.g., narrowing `detect-secrets` excludes), refresh the scanner's
baseline in the same commit. Otherwise CI surfaces legacy findings that local pre-commit on the
staged diff would never see.

## Key Files

| File                                       | Purpose                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `package.json`                             | Node scripts and TypeScript test/lint dependencies.                                  |
| `tsconfig.json`                            | Strict TypeScript compiler settings.                                                 |
| `.pre-commit-config.yaml`                  | Universal and TypeScript project hooks.                                              |
| `README.md`                                | Human-facing project overview.                                                       |
| `addon/bootstrap.js`                       | Zotero bootstrap entrypoint; loads the IIFE bundle, threads rootURI.                 |
| `src/bootstrap.ts`                         | Plugin entrypoint; wires runtime, proxy lifecycle, onboarding probe.                 |
| `src/platform/zotero-runtime.ts`           | Runtime dependency graph and UI mounting.                                            |
| `src/platform/proxy-lifecycle.ts`          | Headless lifecycle controller for the bundled llm-proxy subprocess.                  |
| `src/platform/wire-proxy-lifecycle.ts`     | Wires Subprocess + settings prefs + Node-binary auto-detect.                         |
| `src/preferences/preset-profiles.ts`       | Preset dropdown table (Local Ollama / Codex / Claude / OpenAI / Anthropic / Custom). |
| `src/preferences/provider-profile.ts`      | Independent chat/embed provider selectors + per-provider API keys.                   |
| `src/preferences/model-discovery.ts`       | Live model-list probe per backend (Ollama, proxy, OpenAI, Anthropic, Gemini).        |
| `src/indexing/index-path.ts`               | Per-(provider, model) index filename rules + legacy back-compat.                     |
| `src/indexing/index-storage.ts`            | JSON read/write, schemaVersion migration, in-memory parse cache.                     |
| `src/indexing/index-search.ts`             | Cosine top-K retrieval (optional `scopedItemKey`); throws on dimension mismatch.     |
| `src/indexing/per-source-chunks.ts`        | Per-source extraction: metadata / notes / per-page PDF text / non-PDF attachments.   |
| `src/ui/library-chat-view.ts`              | NotebookLM-style "Ask your library" dialog with chunk-scoped citation rendering.     |
| `src/ui/citation-lookup.ts`                | Parses `[itemKey#chunkIndex]` tokens against a per-turn lookup table.                |
| `src/platform/citation-open.ts`            | Resolves a citation click to `Zotero.Reader.open(attachmentId, { pageIndex })`.      |
| `scripts/llm-proxy/server.mjs`             | Node HTTP service (Ollama wire protocol; codex/claude/ollama backends).              |
| `scripts/package-xpi.mjs`                  | Stages `scripts/llm-proxy/` into `addon/llm-proxy/`, zips the XPI.                   |
| `.github/workflows/e2e-cross-platform.yml` | Three-OS release-gate matrix with real Ollama + real Zotero.                         |
| `docs/decisions/`                          | Architectural Decision Records for the major design decisions.                       |

## Navigation

- [addon/](addon/CLAUDE.md) -- Zotero extension assets.
- [src/](src/CLAUDE.md) -- TypeScript source.
- [tests/](tests/CLAUDE.md) -- Test suite.
- [docs/](docs/CLAUDE.md) -- Specs, ADRs, and documentation.
- [scripts/](scripts/CLAUDE.md) -- Build and packaging automation.
