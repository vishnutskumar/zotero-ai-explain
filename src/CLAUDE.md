# Source

TypeScript source for the Zotero plugin. Compiled by esbuild into a single IIFE bundle at
`addon/content/zotero-ai-explain.js` that Zotero's bootstrap loads via
`Services.scriptloader.loadSubScript`.

## Structure

```text
src/
  bootstrap.ts           # Plugin entrypoint; wires runtime, proxy lifecycle, onboarding
  project-info.ts        # Plugin name/version metadata baked into the bundle
  conversation/
    conversation-store.ts            # Per-selection popup conversation
    library-conversation-store.ts    # Singleton library-chat conversation
    conversation-types.ts
  indexing/
    library-crawler.ts     # Walks Zotero.Items, chunks text, embeds, persists per-item
    per-source-chunks.ts   # Per-source extraction (metadata / notes / PDF pages / attachments)
    indexing-controller.ts # State machine (idle → running → paused / complete / failed)
    indexing-status.ts     # Status reducer with honest cumulative progress counter
    index-storage.ts       # Atomic JSON read/write + schemaVersion migration + in-memory cache
    index-path.ts          # Per-(provider, model) filename rules + legacy back-compat
    index-search.ts        # Cosine top-K retrieval (optional scopedItemKey); throws on dim mismatch
  platform/
    zotero-runtime.ts          # Runtime dep graph, mounts UI, registers menus + reader commands
    zotero-ui-adapter.ts       # Reader commands, anchored popup, sidebar mounts
    zotero-ui-types.ts         # Narrow types over Zotero chrome objects
    citation-open.ts           # Resolves a library-chat citation click to Zotero.Reader.open
    e2e-driver.ts              # In-process driver used by the e2e suite
    proxy-lifecycle.ts         # Headless lifecycle controller for the llm-proxy child
    wire-proxy-lifecycle.ts    # Wires Subprocess + settings prefs + Node-binary auto-detect; mints a per-spawn `crypto.randomUUID()` auth token, threads it into the child via `LLM_PROXY_AUTH_TOKEN`, exposes a `getProxyAuthToken()` accessor, and threads the bearer into `diagnosticsFetch`
    reader-dom-adapter.ts, reader-integration.ts, zotero-env.ts, token-dump.ts
  preferences/
    provider-profile.ts          # ChatProvider + EmbedProvider + per-provider API keys
    provider-profile-store.ts, provider-profile-validation.ts
    ollama-profile.ts            # Split chat/embed URLs (legacy baseUrl preserved)
    preset-profiles.ts           # Local Ollama / Codex / Claude / OpenAI / Anthropic / Custom
    model-discovery.ts           # Live model-list probe per backend
    onboarding-state.ts          # First-run dialog pref
  providers/
    provider-registry.ts, provider-types.ts, stream-events.ts
    rag-augmented-provider.ts    # Wraps a chat provider with retrieval; fires `onRetrieved` for per-conversation citation lookups
    adapters/
      ollama.ts                  # Chat (NDJSON) + embed against Ollama / proxy; accepts an optional `getProxyAuthHeader(baseUrl)` dep that conditionally adds `Authorization: Bearer <token>` when the request targets the bundled proxy prefix
      openai-chat.ts             # SSE chat-completions against OpenAI
      openai-embed.ts            # OpenAI embeddings + dim cross-check
      claude-api.ts              # Direct Anthropic /v1/messages with SSE parser
      gemini-embed.ts            # Gemini batchEmbedContents
  secrets/
    secret-resolver.ts, secret-types.ts   # Secret references instead of raw API keys
  selection/
    selection-context.ts, normalize-selection.ts
  ui/
    anchored-popup-view.ts       # "Explain with AI" / "Ask a question" anchored popup
    popup-controller.ts
    sidebar-view.ts, sidebar-controller.ts
    library-chat-view.ts         # NotebookLM-style "Ask your library" dialog
    citation-lookup.ts           # Parses [itemKey#chunkIndex] tokens; per-turn lookup table; `resolveCitation` handles full-key hits and bare-key fallback
    citation-click.ts            # Shared delegated click handler (`attachCitationClickHandler`) for popup, sidebar, and library-chat citation anchors
    index-controls-view.ts       # Settings dialog's Library Index controls
    settings-view.ts             # Preset dropdown + provider selectors + proxy controls
    onboarding-view.ts           # First-run onboarding state machine
    markdown.ts                  # XSS-safe streaming markdown renderer; `renderMarkdownWithCitations` swaps in clickable citation anchors when a lookup is provided
    styles.ts                    # Shared style constants + MARKDOWN_CSS for popup + sidebar
    privacy-label.ts
```

## Extending

1. Add domain modules with narrow public interfaces.
2. Keep Zotero integration code in `platform/` separate from provider, indexing, and conversation
   logic.
3. Export behavior through source-level public interfaces that tests can exercise without depending
   on implementation details.
4. New chat or embed backends go under `providers/adapters/` and are wired in `src/bootstrap.ts`'s
   provider-switch plus the relevant `preferences/` files. Add a preset row to
   `preferences/preset-profiles.ts` if the backend has a canonical 1-click configuration.
5. Settings dialog state lives in `ui/settings-view.ts`; persistent prefs live in `preferences/*`
   modules and flow through narrow `StringPrefReader` / `StringPrefWriter` contracts (no Zotero
   globals in the pref modules themselves).
