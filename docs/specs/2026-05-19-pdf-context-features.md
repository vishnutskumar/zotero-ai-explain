# PDF Context Features

**Date:** 2026-05-19 **Status:** Approved (rev 3, codex iter-3 findings addressed) **Flow:** forge
full

## Problem

After v0.2.0 the plugin ships chat bubbles, library RAG, and auto-reindex, but it is still PDF-blind
in every place where PDF identity matters. Selection → LLM is anonymous: the prompt frame carries
the selected quote and nothing else, so the model never sees which document, which page, or which
attachment the quote came from. Retrieval-augmented chat triggered from inside an open PDF reader
searches the entire library rather than the document the user is currently reading, which produces
off-topic citations when the user obviously wants in-paper context. Citations rendered in the
library-chat dialog list a title but cannot navigate the reader to the cited page even when that
attachment is open. And the reader has exactly one selection command, "Explain with AI", with no
affordance for the equally common "ask a question grounded in this quote" workflow.

### Background: v0.2.0 E2E regressions

Layered on top of those product gaps, v0.2.0 shipped with five Zotero E2E tests failing in CI. The
failures are concrete log keys, not aggregates. Source: Zotero E2E workflow run 26082106563 on
commit `b7d05d2`, 2026-05-19T07:11:20Z.

From
`tests/e2e/real-pdf-pipeline.e2e.test.ts > real-PDF pipeline (AC2 headline suite) > index: real library crawler against the imported sample PDF`:

1. `> clicking start changes status to running (migration matrix L1709)` — expected `running`,
   observed `idle`.
2. `> index file exists at <dataDir>/zotero-ai-explain-index.json with at least one item` — index
   JSON missing because the crawler never ran (cascades from #1).
3. `> every indexed item carries a non-empty embedding array per chunk` — cascades from #2.
4. `> Pause / Resume / Clear transitions are observable` — log scrape produced
   `'0 / 0 indexed, 0 failed'`, which did not match the expected `/pause/u` pattern.

From `tests/e2e/preset-aware-popup.e2e.test.ts > preset-aware startup (Bug A1 + A2, e2e)`:

5. `> ollama-config debug line reflects the codex preset's chatBaseUrl, not the default Ollama URL (Bug A2)`
   — assertion log scrape mismatch.

The root cause is **suspected** to be v0.2.0's restartable `start()` change interacting with the e2e
driver's initialization order: the controller's first `start()` call appears not to transition to
`running` synchronously, and the downstream assertions that depend on `running` cascade. **This is a
hypothesis. The planner must verify it via `/rca` before writing the fix.** The "all four
real-pdf-pipeline failures cascade from one shared root cause" claim is part of the hypothesis to
verify — it is plausible given the shared symptom (controller not in `running`) but a second
independent regression in the preset-aware-popup path cannot be ruled out from log evidence alone.

The new release-gating workflow requires all three CI workflows green, so v0.3.0 cannot ship without
those tests fixed in source. The user wants those fixes folded into this slice rather than handled
separately.

## Goals

- Add a second reader command, "Ask a question", that opens the anchored popup with the selection
  preloaded as a quote and the input focused (no auto-explain). The command is disabled when there
  is no selection. The selected quote sticks for the entire conversation as system context on every
  turn.
- Populate `selection.source.{itemKey, itemTitle, attachmentKey, pageIndex, pageLabel}` from the
  reader event. `attachmentKey` and `itemKey` come from `event.reader._item` (resolving attachment →
  parent via Zotero's items API). `pageIndex` comes from
  `event.params.annotation.position.pageIndex` (defensive optional-chain; `undefined` when the
  reader event lacks it). `pageLabel` is read from `event.params.annotation.pageLabel` when the
  reader event supplies it; otherwise the prompt frame uses the 1-indexed fallback
  `String(pageIndex + 1)`. **The planner verifies during P2 whether annotation events expose
  `pageLabel` for text-layer (non-annotation) selections; if not, the `String(pageIndex + 1)`
  fallback is the v0.3.0 behavior.** `itemTitle` resolves via Zotero's items API on the parent. All
  five fields are nullable and mirror the existing defensive fallback at
  `src/platform/zotero-ui-adapter.ts:254`.
- Scope RAG retrieval **per-request** based on the originating reader. Reader-triggered popups put
  the parent itemKey of the open attachment on `request.selection.source.scopedItemKey`; the
  retrieval path filters chunks to `chunk.itemKey === scopedItemKey` when present and falls through
  to unscoped retrieval otherwise. The library-chat dialog continues to call `loadIndex` +
  `topKChunks` directly with no scope (`src/platform/zotero-runtime.ts:1029-1048`), and that path
  stays library-wide. `createRagAugmentedProvider(deps)` does **not** gain a constructor parameter —
  the existing single shared `ragProvider` instance at `src/bootstrap.ts:948` continues to back both
  popup and sidebar controllers, and scope is derived on each `streamChat` from the request. Non-PDF
  readers (snapshots, EPUB) follow the same path; if parent-itemKey resolution returns nothing the
  call site simply omits `scopedItemKey` and retrieval is unscoped rather than failing.
- Extend the per-chunk schema with `pageIndex?: number`, `attachmentKey?: string`, and a new
  `sourceKind: 'pdf-page' | 'metadata' | 'note' | 'epub' | 'snapshot' | 'attachment'` discriminator
  so the migration predicate and the citation renderer can tell PDF-page chunks apart from
  intentionally page-less metadata/notes/EPUB/snapshot/other-attachment chunks. Extend the top-level
  `IndexFile` shape with a `schemaVersion: number` field. Post-migration: `schemaVersion: 2`; legacy
  files have no `schemaVersion` (treated as `1`). The crawler is revised to extract PDF text **per
  page via PDF.js** rather than reading the `.zotero-ft-cache` blob; the cache path is retained as
  the fallback for non-PDF attachments and for legacy callers. Each PDF-page chunk's `pageIndex` is
  the index of the page the chunk text _starts_ on (a chunk that crosses a page boundary keeps the
  start-page index) and `sourceKind: 'pdf-page'`. Library-chat citation clicks open the attachment
  via `Zotero.Reader.open(attachmentId, { pageIndex })` — the second positional argument is the
  _location_ directly, per the verified Zotero reader source, not nested under `{ location: ... }`.
  Citations whose chunks have no `pageIndex` (legacy or metadata/note/EPUB) fall back to
  `Zotero.Reader.open(attachmentId)`.
- The library-chat citation protocol expands from `[itemKey]` to **chunk-scoped**
  `[itemKey#chunkIndex]` tokens (e.g., `[ABCD1234#3]`). The system prompt instructs the LLM to cite
  the specific retrieved chunk by index; the renderer parses both halves and resolves `chunkIndex`
  against a per-turn lookup table `{ itemKey, attachmentKey, pageIndex, text }` built from the
  retrieved chunks. The renderer falls back to plain `[itemKey]` (opens attachment at page 0) when
  the LLM emits the old format; legacy indexes without `pageIndex` also fall back.
- Silently migrate persisted indexes whose top-level `schemaVersion ?? 1 < 2` (the canonical
  schema-freshness signal): on first index-read after upgrade, detect the stale schema, build a
  fresh page-aware (PDF.js-extracted, `sourceKind`-stamped, `schemaVersion: 2`) index, and
  atomically swap it in place. No user dialog; the existing status indicator shows progress.
  Migration uses **write-new-then-swap with a persisted pending marker** — see Approach for the
  state machine. The schema-version trigger replaces the rev 1 "any chunk lacks pageIndex" predicate
  (which would have re-fired forever on mixed-source items where metadata/note chunks legitimately
  stay page-less). Atomicity continues to replace the per-provider in-flight RAG counter from rev 0.
- Fix the v0.2.0 Zotero E2E regressions in source: the four `real-pdf-pipeline` failures and the one
  `preset-aware-popup` failure listed in the Background subsection. The planner runs `/rca` to
  confirm the suspected `start()` / driver-initialization hypothesis (or surfaces a different root
  cause) and lands adversarial coverage so the controller's `running` transition cannot regress
  silently again.
- Bump `OLLAMA_VERSION` in `.github/workflows/e2e-cross-platform.yml` (currently pinned at `0.5.7`
  per line 48) to a version that supports the `gemma3:1b` chat model used by the cross-platform
  matrix. The planner researches the current minimum (likely `0.5.13+`) and pins the exact value.
  Cache key continues to interpolate `OLLAMA_VERSION` so the bump invalidates stale model caches.
- Ship at tag `v0.3.0`. All three CI workflows (CI, Zotero E2E, E2E Cross-Platform) must be green
  before the tag is pushed; the release-gating workflow consumes those checks.

## Non-Goals

- Ollama Web Search integration (deferred per session handoff; out of scope for v0.3.0).
- A UI toggle or preference for in-PDF vs whole-library scope. Scope is automatic based on whether
  the popup was triggered from a reader or from the library-chat dialog. No discoverability surface
  for the toggle is added.
- Changing the existing "Explain with AI" reader command behavior. AC1 adds a sibling command; it
  does not modify the existing command's click path.
- New chat backends or new embed providers. The provider matrix stays as v0.2.0 shipped it.
- Migrating, patching, or re-releasing v0.2.0 in any form. v0.3.0 is the next user-visible artifact.
- A page-aware extraction pipeline for any path _other_ than the PDF chunker. Notes, abstracts, and
  EPUB attachments continue through the existing text concatenation in `extractItemText`. Only the
  PDF-fulltext branch in `readChildAttachmentFullText` / `readAttachmentFullText` is revised to
  produce per-page text — the rest of the chunker is unchanged.
- Backfilling `attachmentKey` / `pageIndex` onto chunks that genuinely have no page source (notes,
  abstracts, EPUB). Those chunks legitimately carry `pageIndex: undefined` post-migration; the
  citation renderer falls back to a no-location reader open for them.

## Approach

**Second reader command.** `addReaderCommand` registers an "Ask a question" entry alongside the
existing "Explain with AI". The new command shares the registration path but binds a different click
handler that opens the popup in question-mode: the selection is preloaded as a quote, the textarea
is focused, no auto-explain runs. Submitting the question sends a chat request whose user turn is
`Quote: "<selection>"\n\nQuestion: <user-question>`, and the quote is reapplied as system context on
every subsequent turn so the conversation stays anchored to the selected passage. The command is
disabled (the menu item is hidden, matching the user's "Disabled / no menu item" choice) when the
reader event reports no selection.

**PDF identity in the prompt frame.** `selection.source` gains five optional fields populated from
the reader event: `itemKey` and `attachmentKey` from `event.reader._item` (resolving attachment →
parent through the items API), `pageIndex` from `event.params.annotation.position.pageIndex`,
`pageLabel` from `event.params.annotation.pageLabel` when present, and `itemTitle` from the items
API. When the reader event omits `pageLabel` (the planner verifies during P2 whether text-layer
selections expose it), the prompt frame renders `String(pageIndex + 1)` as the page reference — that
is the v0.3.0 fallback contract. All five fields are nullable and the existing defensive fallback
pattern at `src/platform/zotero-ui-adapter.ts:254` is mirrored so a missing `event.params`,
`annotation`, or `position` degrades gracefully (selection still works, identity fields stay
undefined). The prompt frame renders title and page reference into the user turn when available so
the model can attribute its answer. **Critical: every check on `pageIndex` uses
`pageIndex !== undefined`, never truthiness, because `pageIndex: 0` (the first page) is a valid
citation distinct from "no page".**

**In-PDF RAG scoping — request-scoped, not factory-scoped.** Codex review caught that
`createRagAugmentedProvider` is called exactly once during bootstrap (`src/bootstrap.ts:948`) and
the resulting `ragProvider` is shared by both the popup and sidebar controllers; a constructor
parameter cannot carry per-selection scope. The clean contract is to derive scope on each request:

1. `IndexedItemChunk` already carries `itemKey` through the parent `IndexFile.items[itemKey]`
   structure. `topKChunks(indexFile, queryEmbedding, k, { scopedItemKey })` gains an optional
   options bag; when `scopedItemKey` is supplied, the inner loop skips items whose key does not
   match. Library-chat continues to call `topKChunks(file, queryEmbedding, LIBRARY_CHAT_TOP_K)` with
   no options bag (`src/platform/zotero-runtime.ts:1048`), so its retrieval stays library-wide.
2. `augmentMessages` inside `src/providers/rag-augmented-provider.ts` is revised to read
   `request.selection.source.scopedItemKey` (a new optional field on selection-source) and forward
   it as `topKChunks(file, queryEmbedding, topK, { scopedItemKey })` when present.
3. The reader-triggered popup click handler resolves attachment → parent itemKey and sets
   `selection.source.scopedItemKey = parentKey` on the request it builds. The library-chat dialog
   does not touch `scopedItemKey` (its retrieval path is direct, not through `ragProvider`).
4. Non-PDF readers (snapshot, EPUB) follow the same path; if the parent-itemKey resolution returns
   nothing the call site omits `scopedItemKey` rather than failing the explain — the request goes
   through unscoped retrieval.

This keeps the `createRagAugmentedProvider(deps)` factory signature unchanged and avoids recreating
providers per request. Library chat's explicit independence is part of the contract: the spec
acknowledges that the library-chat retrieval path is a separate consumer of `topKChunks` that the
spec deliberately leaves library-wide.

**Page-aware chunking — PDF.js per-page extraction.** Today, `library-crawler.ts` builds a single
concatenated text blob per item (title + abstract + child-attachment fulltext) and calls
`chunkText(text, DEFAULT_CHUNK_BYTES)` on it. The PDF fulltext path reads `.zotero-ft-cache` through
`readAttachmentFullText` (`src/indexing/library-crawler.ts:233-286`) via either the preferred
`Zotero.FullText.getItemContent(attachment.id)` call or the
`Zotero.File.getContents(cacheFile, ...)` fallback — both return one undelimited text blob with no
page boundaries (empirically verified: a real 32500-byte `.zotero-ft-cache` from a sample attachment
contains zero form-feed `\f` characters, so the rev 1 "form-feed delimiter" hypothesis is
falsified). This is the iter-2 FINDING-1 blocker.

For v0.3.0 the PDF branch of `readChildAttachmentFullText` / `readAttachmentFullText` is rewritten
to extract text **per page via PDF.js** (Mozilla's PDF library, bundled inside the Zotero reader
chrome). The contract:

- For PDF attachments, the crawler resolves the on-disk file path through
  `Zotero.Attachments.getStorageDirectory(attachment)` (or the equivalent path-resolution helper the
  planner verifies during P2 — Zotero exposes the attachment's storage directory under
  `<dataDir>/storage/<key>/`). It then loads the PDF through PDF.js's public document API and
  iterates pages by index.
- PDF.js public API surface used (entry-point name varies with how Zotero exposes the bundled copy —
  the planner verifies during P2 whether it is reached via `pdfjsLib.getDocument`,
  `Zotero.Reader.PDFRenderer`, a chrome-scoped global, or a worker-bridged path):
  - `pdfjsLib.getDocument({ url | data | path }).promise` → `pdfDocument` (a `PDFDocumentProxy`).
  - `pdfDocument.numPages` for the iteration bound.
  - `pdfDocument.getPage(n)` for each `n` in `1..numPages` (PDF.js page numbers are 1-indexed at
    this API; the crawler converts to 0-indexed `pageIndex` for chunk metadata).
  - `page.getTextContent()` returns `{ items: TextItem[], ... }`; the crawler joins
    `items.map(i => i.str)` (interleaving spaces where item geometry implies whitespace; the planner
    pins the join rule against PDF.js's documented `hasEOL` / `transform` heuristics).
- The crawler iterates pages, calls `chunkText(pageText, DEFAULT_CHUNK_BYTES)` per page, and stamps
  each resulting chunk with `pageIndex: <page>` (0-indexed), `attachmentKey: <key>` (the source
  attachment, so multi-attachment parent items keep deterministic chunk identity), and
  `sourceKind: 'pdf-page'`.
- Multi-page chunks (text that crosses a page boundary because a paragraph spans pages) take the
  `pageIndex` of the page the chunk _starts_ on. This is the simplest deterministic rule and matches
  what the user expects when clicking a citation: jump to the page the quoted text begins on.
- Chunks whose source has no page model carry `pageIndex: undefined`, but **always** carry an
  explicit `sourceKind`. Cached-text attachments additionally carry `attachmentKey` (the source
  attachment) so multi-attachment parent items keep deterministic chunk identity; metadata and note
  chunks leave `attachmentKey: undefined`:
  - Title/abstract → `sourceKind: 'metadata'` (no `attachmentKey`).
  - Note bodies (`readNoteBodies`) → `sourceKind: 'note'` (no `attachmentKey`).
  - EPUB attachment fulltext → `sourceKind: 'epub'` (continues through the existing cache-reading
    path; PDF.js is not invoked; `attachmentKey` is stamped).
  - Web snapshot HTML fulltext → `sourceKind: 'snapshot'` (continues through the existing
    cache-reading path; PDF.js is not invoked; `attachmentKey` is stamped).
  - Any other Zotero-cached attachment fulltext (non-PDF, non-EPUB, non-snapshot — any other
    attachment type whose text is reachable through `.zotero-ft-cache`) → `sourceKind: 'attachment'`
    (continues through the existing cache-reading path; `attachmentKey` is stamped). This is the
    generic non-PDF cached-fulltext bucket.

The `.zotero-ft-cache` reading path inside `readAttachmentFullText` is **retained** for non-PDF
attachments (EPUB, snapshot) and for any caller that explicitly asks for the legacy concatenated
blob. The PDF branch swaps from the cache-reading path to PDF.js; the EPUB/snapshot branches do not
change. The chunker contract (`chunkText(text, maxBytes)`) is unchanged; only the _input_ the
crawler feeds it changes from one blob per item to one blob per page (for PDFs) or one blob per
metadata/note/EPUB/snapshot source (with `sourceKind` stamped).

This is a substantive crawler rewrite — meaningfully larger than the rev 1 "swap one read call"
scope — and is reflected in the Goals expansion and the new Risks section.

**Schema — top-level `schemaVersion` and per-chunk `sourceKind`.** Two new schema fields land in
`IndexFile` (`src/indexing/library-crawler.ts:119-122`) and in the per-chunk shape inside
`IndexedItem.chunks`:

- **Top-level `IndexFile.schemaVersion: number`.** Legacy files have no `schemaVersion`; readers
  treat that as `1`. Post-migration files set `schemaVersion: 2`. The constant
  `CURRENT_SCHEMA_VERSION = 2` lives next to the type. This is the canonical schema-freshness signal
  and the migration trigger.
- **Per-chunk `sourceKind: 'pdf-page' | 'metadata' | 'note' | 'epub' | 'snapshot' | 'attachment'`.**
  Every chunk the v0.3.0 crawler emits carries an explicit `sourceKind`. PDF-page chunks
  additionally carry `pageIndex` and `attachmentKey`; other kinds leave `pageIndex` `undefined`. The
  `'attachment'` bucket covers non-PDF cached-fulltext attachments that are neither EPUB nor web
  snapshot (any other Zotero-cached attachment type that goes through `.zotero-ft-cache`); it is the
  generic catch-all for cached-text attachments and is stamped with `attachmentKey` but no
  `pageIndex`. The `sourceKind` field is **additive metadata** for the renderer and for debugging;
  it is **not** the migration trigger (FINDING-2 iter-2 — inferring schema freshness from "every
  chunk has a `sourceKind`" would re-introduce the same predicate problem). `schemaVersion` alone
  gates migration.
- **Per-chunk `pageIndex?: number` and `attachmentKey?: string`** (unchanged from rev 1). All
  per-chunk checks use `!== undefined`, never truthiness, because `pageIndex: 0` is a valid first
  page distinct from "no page".

`isIndexFile` in `src/indexing/index-storage.ts:75` is widened to accept the new optional top-level
field. Existing readers ignore unknown fields (verified by reading the validator), so the schema
bump is backward-compatible from the read-side.

**Citation jump-to-page — chunk-scoped `[itemKey#chunkIndex]` tokens.** Today, the library-chat
citation contract is item-key-only: `buildLibraryPrompt` (`src/ui/library-chat-view.ts:355-369`)
asks the model to cite `[itemKey]`, `appendWithCitations` (`src/ui/library-chat-view.ts:252-267`)
extracts the key with a `[KEY]` regex, and `wireLibraryChatView` dispatches
`onCitationClick(itemKey)` (`src/ui/library-chat-view.ts:286-325`). When the LLM cites `[ABCD1234]`
and two retrieved chunks of `ABCD1234` come from different pages, the renderer has no way to know
which chunk's page to open. That is the iter-2 FINDING-3 blocker.

For v0.3.0 the citation protocol becomes **chunk-scoped**:

1. **Prompt instruction.** `buildLibraryPrompt` is revised to label each excerpt with both the item
   key and the chunk's index within the retrieved-chunks list — e.g.,
   `[ABCD1234#0] <excerpt text>\n\n[ABCD1234#1] <excerpt text>\n\n[QRST5678#2] ...` — and the
   instruction line becomes "Cite the excerpt by `[itemKey#chunkIndex]` in square brackets after
   each claim, e.g. `X is true [ABCD1234#3]`." `chunkIndex` is the chunk's position in the per-turn
   retrieved-chunks list (a unique-id alternative was considered but rejected: chunkIndex is
   simpler, has no collision risk within a single turn's lookup table, and gives the LLM a small
   integer to cite cleanly).
2. **Per-turn lookup table.** The controller that drives library-chat builds a per-turn lookup table
   from the retrieved chunks before formatting the prompt:
   `Map<string, { itemKey: string; attachmentKey?: string; pageIndex?: number; text: string }>`
   keyed by the **full citation token** `${itemKey}#${chunkIndex}` (e.g., `"ABCD1234#3"`). Keying by
   the full token (not by `chunkIndex` alone) defends against the hallucinated-itemKey case: if the
   LLM emits `[WRONGKEY#0]` where `WRONGKEY` is not the itemKey of chunk 0's actual source, the
   lookup `get("WRONGKEY#0")` returns `undefined` and the renderer falls through to legacy
   `[itemKey]` behavior (open at page 0) rather than silently routing the citation to chunk 0's real
   source page. The table is plumbed to the renderer for that assistant turn so the click handler
   can resolve a citation token to its location.
3. **Renderer parsing.** `appendWithCitations` regex is widened from `/\[([A-Z0-9]{8})\]/g` to
   `/\[([A-Z0-9]{8})(?:#(\d+))?\]/g`. When the chunk-index group is present, the renderer composes
   the full-token key `${itemKey}#${chunkIndex}` and consults the per-turn lookup table. When the
   table has a matching entry, the rendered `<a>` element carries `data-item-key`,
   `data-chunk-index`, and (for diagnostics) `data-page-index`. When the chunk-index group is absent
   (LLM emits the legacy `[ABCD1234]` token), or when the composed full-token key misses in the
   table (LLM hallucinated the itemKey, the chunkIndex, or the pairing), the rendered link carries
   only `data-item-key` and the click handler falls back to opening the attachment at page 0 —
   exactly the v0.2.0 behavior. The mismatched-itemKey case (`[WRONGKEY#0]` where `WRONGKEY` is not
   the source itemKey for chunk 0) is structurally a lookup miss under this keying and therefore
   takes the same fallback path; it never silently routes to chunk 0's true source page.
4. **Click dispatch.** `WireLibraryChatInput.onCitationClick` (`src/ui/library-chat-view.ts:286`) is
   widened to receive the resolved chunk metadata, not just the item key. The new shape is
   `onCitationClick(citation: { itemKey: string; attachmentKey?: string; pageIndex?: number })`.
   Legacy callers passing just the item key (via the parsing fallback) get `attachmentKey` and
   `pageIndex` `undefined` and the runtime opens the attachment via
   `Zotero.Reader.open(attachmentId)` — the v0.2.0 behavior.
5. **Reader open shape.** For citations resolved to a `pageIndex !== undefined`, the runtime calls
   `Zotero.Reader.open(attachmentId, { pageIndex })`. Codex verified the reader source: the call is
   `Zotero.Reader.open(itemID, location, options)` where `location` is the **second positional
   argument** and is shaped `{ pageIndex }` directly — _not_ nested inside `{ location: { ... } }`.
   The reader is idempotent on `open()` and navigates the existing tab to the location when one is
   already open.
6. **Forward-compat.** Legacy indexes (`schemaVersion ?? 1 < 2`) trigger migration on first read, so
   steady-state every citation has chunk metadata available. During the migration window,
   `schemaVersion === 1` indexes have no per-chunk `pageIndex`; the renderer falls through to plain
   `[itemKey]` behavior and opens the attachment without a location. The library-chat surface keeps
   working through the migration, just without page jumps.

**Adversarial requirement (iter-2 FINDING-3 explicit ask).** AC5 must include an end-to-end test
case where: (a) two retrieved chunks come from the same item but different pages, (b) the LLM emits
`[ITEM#0]` and `[ITEM#1]` referring to each chunk distinctly, (c) clicking the first citation opens
the reader at chunk 0's page, and (d) clicking the second citation in the _same already-open reader_
navigates to chunk 1's page — confirming that chunk-scoping survives the common
multi-chunk-same-item case.

**Silent re-index migration — write-new-then-swap with persisted pending marker.** The earlier
"in-flight RAG counter" model only protected the popup path through `createRagAugmentedProvider`; it
did not cover the library-chat direct `loadIndex` reader, `hydrate()`, or the crawler itself. Worse,
a plugin reload mid-migration could leave the index file cleared with no signal that a migration was
in progress, so the next launch would see a missing index rather than an index missing `pageIndex`
and the migration trigger would never fire. The revised state machine:

1. **Detect.** On first index-read after upgrade, the index loader inspects the top-level
   `schemaVersion` field. The trigger is `indexFile.schemaVersion ?? 1 < CURRENT_SCHEMA_VERSION`
   where `CURRENT_SCHEMA_VERSION = 2`. The rev 1 "any chunk lacks `pageIndex`" rule is removed (it
   would have re-fired forever on mixed-source items where metadata/note/EPUB chunks legitimately
   keep `pageIndex: undefined` post-migration — iter-2 FINDING-2). `schemaVersion` is the canonical
   and only schema-freshness signal; `sourceKind` is descriptive metadata, not part of the trigger.
2. **Mark pending.** Before any clearing, the loader writes `migrationPending: true` into the index
   file (top-level field; the existing readers ignore unknown fields). The marker is fsynced. On
   next plugin launch, if `migrationPending: true` is observed the migration resumes automatically —
   the marker is the durability boundary.
3. **Crawl into new file.** The crawler writes the new (page-aware) index to a sibling temp file
   `<index-path>.tmp` (or `<index-path>.json.tmp` depending on the existing path scheme — the
   planner verifies the path-generation rules in `index-path.ts`). Readers continue to see the old
   index throughout this phase.
4. **Atomic swap.** When the crawl is complete and fsynced, the loader renames `<...>.tmp` →
   `<index-path>` atomically. The rename replaces the old file in a single filesystem operation, so
   every concurrent reader either sees the old file (fully populated, pre-migration shape) or the
   new file (fully populated, post-migration shape) — never a half-cleared file. The
   `migrationPending` marker is cleared as part of writing the new file (it never appears in the
   post-migration index).
5. **Failure handling.** If the crawl fails partway, the `.tmp` file is discarded but the
   `migrationPending` marker stays in the old index. The next plugin launch retries from step 3. If
   the index file is corrupt or missing entirely (cleared before atomic swap was possible — should
   be unreachable given the swap-not-clear contract, but defensive), the loader treats it as a fresh
   install and the existing v0.2.0 auto-reindex path kicks in. Corrupt JSON is surfaced through the
   existing error path; the migration does not silently overwrite corrupt data.

**The per-RAG-request in-flight counter from rev 0 is removed.** Atomicity at the filesystem layer
plus the persisted marker for reload-resume replaces it. All index consumers (popup RAG,
library-chat, hydrate, crawler) benefit equally because every read goes through the same path that
returns the post-rename file. No new dialog; the existing status indicator wired in v0.2.0's
auto-reindex path renders progress.

**v0.2.0 E2E regression fix.** The five tests listed in the Background subsection are the in-scope
set. The root cause is a **hypothesis** — the planner runs `/rca` to confirm (or refute) the
suspected `start()` / driver-initialization path before writing the fix. Adversarial coverage lands
so reverting the fix turns the affected tests red and the controller's `running` transition cannot
regress silently again. The fix ships in this slice so the release-gating workflow can require
Zotero E2E green at the `v0.3.0` tag.

**Ollama version pin bump for the release gate.** Cross-Platform CI is currently red because the
pinned `OLLAMA_VERSION: "0.5.7"` (`.github/workflows/e2e-cross-platform.yml` line 48) predates
`gemma3:1b` support. The planner researches the minimum Ollama version that supports `gemma3:1b`
(likely `0.5.13` or later) and bumps the pin in this slice. The model cache key in the same workflow
already interpolates `OLLAMA_VERSION`, so the bump invalidates stale model caches automatically.
Verification: the cross-platform workflow is green on the release commit.

## Alternatives Considered

- **Allow "Ask a question" with no selection (whole-page text or empty).** Rejected because the
  scope of "the quote" becomes ambiguous: either we pass the whole page (a large context the user
  did not select) or we pass nothing (the chat becomes a generic chat, indistinguishable from the
  library-chat dialog). The disabled-when-no-selection behavior keeps the command's contract sharp
  and matches the user's explicit choice.
- **Use 1-indexed pageIndex (`String(pageIndex + 1)`) as the page reference unconditionally.**
  Partially rejected: when the reader event supplies `event.params.annotation.pageLabel` the spec
  uses the user-visible label (e.g., "iii", "A-12") because PDFs frequently use roman numerals or
  section prefixes that differ from the 1-indexed position. The 1-indexed rendering is the
  _fallback_ when `pageLabel` is unavailable on text-layer selections — accepted for v0.3.0 because
  dropping page context entirely would be worse than rendering a numeric approximation. The planner
  files a follow-up if a documented label API exists separately.
- **In-flight RAG counter for migration safety (rev 0 design).** Rejected. The counter lives inside
  `createRagAugmentedProvider` and only protects the popup path; library-chat, `hydrate()`, and the
  crawler all read the index through separate paths. Atomic write-new-then-swap at the filesystem
  layer protects every reader uniformly, and a persisted `migrationPending` marker survives plugin
  reload — neither property is achievable with the counter design.
- **Factory-scoped `scopedItemKey` parameter on `createRagAugmentedProvider` (rev 0 design).**
  Rejected. The factory is called once at bootstrap (`src/bootstrap.ts:948`) and the resulting
  provider is shared by popup and sidebar controllers, so a constructor parameter cannot scope
  per-selection. Request-scoped via `request.selection.source.scopedItemKey` is the working
  contract.
- **A visible scope toggle (preferences or in-popup).** Rejected for two reasons: (a) UI clutter on
  an already-dense popup, and (b) discoverability tradeoff — most users in a reader want in-document
  context, so the automatic behavior is the right default and a toggle would be a rarely-used escape
  hatch with disproportionate complexity.
- **Prompt-to-reindex banner.** Rejected because v0.2.0's auto-reindex pattern already conditioned
  users to expect silent background reconciliation; adding a dialog here would be inconsistent and
  introduce friction at every upgrade.
- **Version-pref comparison or migration script.** Rejected because schema-detection on the
  persisted chunks is the canonical "what changed" signal and avoids a parallel source of truth.
  Schema absence is the trigger; the version pref is not consulted.

## Constraints

- Pre-commit hooks must run on every commit. No `--no-verify`, no `SKIP=<hook>`. Fix hook failures
  at the root cause.
- All changes reach `main` via a feature branch and PR. No direct pushes.
- All code reviews go through `mcp__codex__codex` with model `gpt-5.5` per user instruction.
- Code-writing subagents must run `/simplify` on their changes before returning.
- Adversarial reviews mandatory; semi-formal reasoning with file:line citations required.
- `npm run typecheck`, `npm run lint`, `npm run format`, `npm run test`, and `npm run test:e2e` must
  all pass. The release gate requires CI, Zotero E2E, and E2E Cross-Platform green at the tag.
- The plugin ships at `v0.3.0`. Minor bump from `v0.2.0`. No interim patch release.
- New top-level field `IndexFile.schemaVersion: number` (current value `2`; legacy files read as `1`
  when the field is absent). New per-chunk fields `pageIndex?: number`, `attachmentKey?: string`,
  and `sourceKind: 'pdf-page' | 'metadata' | 'note' | 'epub' | 'snapshot' | 'attachment'`.
  `sourceKind` is required on every chunk the v0.3.0 crawler emits but is descriptive metadata,
  **not** the migration trigger. The `'attachment'` value is the generic non-PDF cached-fulltext
  bucket for attachment types that are neither EPUB nor snapshot. Legacy indexes
  (`schemaVersion ?? 1 < 2`) migrate silently on first read via the write-new-then-swap state
  machine.
- The migration trigger is `indexFile.schemaVersion ?? 1 < CURRENT_SCHEMA_VERSION`. No predicate
  over chunk shape (the rev 1 "missing pageIndex" rule is removed because mixed-source items
  legitimately retain page-less metadata/note/EPUB chunks post-migration).
- The library-chat citation token format is `[itemKey#chunkIndex]` (e.g., `[ABCD1234#3]`). The
  `appendWithCitations` regex widens to `/\[([A-Z0-9]{8})(?:#(\d+))?\]/g`. Legacy `[itemKey]` tokens
  are still parsed and dispatched as item-key-only clicks (open attachment at page 0).
- `WireLibraryChatInput.onCitationClick` widens from `(itemKey: string) => void` to
  `(citation: { itemKey: string; attachmentKey?: string; pageIndex?: number }) => void`. Existing
  call sites pass the resolved metadata when available and `attachmentKey`/`pageIndex` `undefined`
  for legacy tokens.
- PDF.js entry-point: the v0.3.0 crawler invokes PDF.js's documented page API
  (`pdfDocument.numPages`, `pdfDocument.getPage(n)`, `page.getTextContent()`) on every PDF
  attachment at crawl time. The planner verifies during P2 the exact bundled-PDF.js access path
  Zotero exposes to plugin code (`pdfjsLib.getDocument`, a chrome-scoped global, or a worker-bridged
  entry) and pins it in the implementation plan before P3 starts.
- `pageIndex` semantics: `0` is the valid first page of a document and must be preserved end-to-end
  (chunk persistence, citation click, prompt frame). Implementations check
  `pageIndex !== undefined`, never truthiness. The `pageLabel`-vs-`String(pageIndex + 1)` fallback
  is consistent with this rule (page 0 renders as `"1"` when label is absent).
- `selection.source` fields are all optional and default to undefined; the defensive fallback
  pattern at `src/platform/zotero-ui-adapter.ts:254` is mirrored for every new field, including the
  new `scopedItemKey`.
- `topKChunks` gains an optional fourth options-bag parameter; the existing 3-arg call sites in the
  library-chat path (`src/platform/zotero-runtime.ts:1048`) remain unchanged. The new
  `scopedItemKey` filter operates inside `topKChunks`, not at a separate filter layer.
- `createRagAugmentedProvider(deps)` signature does not change. Scope is per-request via
  `request.selection.source.scopedItemKey`, not per-factory.
- No nested Agent calls inside subagents.
- The release ships at tag `v0.3.0` only after manual smoke confirmation from the user.

## Open Questions

Rev 2 resolves iter-2 FINDING-1 (per-page text source) by switching to PDF.js extraction. The
remaining open questions are planner-verifiable before P3 implementation starts.

1. **(RESOLVED — rev 2) Per-page PDF text source.** The rev 1 hypothesis (form-feed `\f` delimiters
   in `.zotero-ft-cache`) was falsified empirically (0 form-feeds in a real 32500-byte cache file).
   The chosen source is **PDF.js bundled inside Zotero's reader chrome**, accessed via the
   documented `pdfDocument.numPages` / `pdfDocument.getPage(n)` / `page.getTextContent()` API. The
   planner verifies during P2 the exact entry-point Zotero exposes to plugin code
   (`pdfjsLib.getDocument`, a chrome-scoped global like `Zotero.Reader.PDFRenderer`, or a
   worker-bridged path) and pins it in the implementation plan. The `.zotero-ft-cache` reading path
   is retained for non-PDF (EPUB, snapshot) attachments. No fallback to form-feed parsing.
2. **`pageLabel` exposure on text-layer selections.** The planner verifies whether
   `event.params.annotation.pageLabel` is populated for non-annotation (text-layer) selections. If
   yes, the prompt frame uses the user-visible label. If no, the `String(pageIndex + 1)` fallback is
   the v0.3.0 behavior and a follow-up ticket files the label-API research.
3. **`Zotero.Reader.open` location shape.** Codex verified the second positional argument is the
   location directly (`{ pageIndex }`, not `{ location: { pageIndex } }`). The planner confirms with
   a real-Zotero smoke test before AC5 implementation starts.
4. **E2E regression root cause.** The planner runs `/rca` on the five failures listed in the
   Background subsection. The hypothesis (v0.2.0 restartable `start()` interaction with the e2e
   driver's initialization order) is the starting point, not a foregone conclusion.

The brainstorming session previously resolved empty-selection behavior (disabled command), scope UI
(automatic, no toggle), index handling (force re-index on first launch), v0.2.0 E2E fixes (folded
into this forge run), version bump (v0.3.0), migration trigger (silent detection on first
index-read), AC1 framing (quote sticks for entire conversation), migration safety (atomic
swap-with-marker), and Ollama pin bump (in scope) before approval. Rev 2 additionally resolved the
per-page text source (PDF.js), the schema-freshness signal (top-level `schemaVersion`), and the
citation identity protocol (`[itemKey#chunkIndex]`) based on iter-2 codex findings. Rev 3 tightened
the citation lookup to key by full token (`${itemKey}#${chunkIndex}`) so a hallucinated-itemKey
citation cannot silently route to chunk 0's source, added the generic `'attachment'` value to the
`sourceKind` enum for non-PDF/non-EPUB/non-snapshot cached-fulltext attachments, and noted in Risks
that the Phase 3 PDF.js investigation may surface scope expansion (e.g., bundling PDF.js) requiring
re-approval — based on iter-3 codex findings.

## Risks

- **PDF.js crawl-time cost.** Extracting text from every PDF via PDF.js at crawl time is slower than
  the rev 1 cache-reading path, which simply read pre-extracted text from `.zotero-ft-cache`. PDF.js
  has to parse the PDF stream, iterate every page, and assemble text items per page. For a large
  library (hundreds of PDFs), this materially extends initial indexing latency. Mitigation: the
  existing indexing controller already runs in the background with pause/resume; the progress
  indicator surfaces the longer runtime. The planner pins a reasonable per-page timeout (likely a
  few seconds) and a per-attachment failure mode (log, skip, continue) so a single corrupt PDF
  cannot stall the whole crawl. Quantitative measurement is part of P3 verification — the planner
  records crawl time on a representative sample library before and after the PDF.js switch.
- **PDF.js entry-point variance.** Zotero exposes PDF.js inside the reader chrome but the exact
  access path for plugin code is undocumented. If `pdfjsLib.getDocument` is not reachable from the
  bootstrap-scope bundle, the planner falls back to an alternative path (chrome-scoped global,
  worker bridge, or spawning a Node-side PDF.js through the existing llm-proxy subprocess). The
  fallback adds complexity; the planner pins the chosen path before P3 begins (Open Question 1
  above). The Phase 3 investigation may surface scope expansion — for example, bundling PDF.js into
  `scripts/llm-proxy/` or `addon/` if no in-Zotero access path is viable — in which case the planner
  brings that expansion back for explicit approval before proceeding with implementation.
- **Per-turn lookup table memory.** The chunk-scoped citation protocol builds a per-turn lookup
  table from retrieved chunks. With `LIBRARY_CHAT_TOP_K = 8` (per ADR 0005), the table is small and
  not a memory concern. The risk is purely correctness — the table must be plumbed to the renderer
  for the _correct_ assistant turn (a re-render of an older turn must use that turn's table, not the
  current one). The planner pins the table to the assistant-message record so re-renders stay
  consistent.
- **LLM citation-format compliance.** Instructing the LLM to emit `[itemKey#chunkIndex]` instead of
  `[itemKey]` is a prompt-engineering ask. Strong models comply reliably; weaker models may emit the
  legacy `[itemKey]` token or hallucinate a non-existent chunk index. The renderer's fallback
  handles both gracefully (legacy token → open at page 0; unknown chunkIndex → open at page 0). The
  cost is a degraded UX on weaker models, not a broken UX.

## Success Criteria

1. **Ask-question reader command.** A second reader command labeled "Ask a question" appears
   alongside "Explain with AI". With a real PDF selection it opens the anchored popup with the
   selection preloaded as a quote and the textarea focused; no auto-explain runs. The command is
   absent from the menu when there is no selection. The quote is reapplied as system context on
   every conversation turn.
2. **PDF identity in prompt frame.** Explain and ask-question requests originating from a reader
   selection include `itemKey`, `itemTitle`, `attachmentKey`, `pageIndex`, and a rendered page
   reference (`pageLabel` when the reader event supplies it, else `String(pageIndex + 1)`) in
   `selection.source` and in the LLM prompt frame. Missing reader-event params degrade gracefully —
   selection still works without identity fields. `pageIndex: 0` is preserved end-to-end and is not
   conflated with `undefined`.
3. **In-PDF RAG auto-scope, request-scoped.** RAG retrieval triggered from inside an open PDF reader
   filters to the parent itemKey of that attachment via `request.selection.source.scopedItemKey`
   flowing into `topKChunks(..., { scopedItemKey })`. Retrieval from the library-chat dialog stays
   library-wide because that path calls `topKChunks` directly without an options bag. Non-PDF
   readers fall back to unscoped retrieval. The `createRagAugmentedProvider(deps)` factory signature
   is unchanged.
4. **Page-aware chunking via PDF.js.** For every PDF attachment the crawler resolves the
   attachment's on-disk path, loads the document through PDF.js (`pdfDocument.numPages` /
   `pdfDocument.getPage(n)` / `page.getTextContent()`), and emits one or more chunks per page. Each
   PDF-page chunk carries `pageIndex` (the page the chunk _starts_ on, 0-indexed), `attachmentKey`
   (the source attachment), and `sourceKind: 'pdf-page'`. Chunks from non-PDF sources carry
   `pageIndex: undefined` and an explicit `sourceKind`
   (`'metadata' | 'note' | 'epub' | 'snapshot' | 'attachment'`). Cached-fulltext attachment chunks
   (`'epub'`, `'snapshot'`, `'attachment'`) carry `attachmentKey`; `'metadata'` and `'note'` chunks
   leave it `undefined`. `pageIndex: 0` (first page) is a valid value distinct from `undefined`;
   implementations check `pageIndex !== undefined`, never truthiness. The `.zotero-ft-cache` reading
   path is retained for non-PDF attachments and is not used for PDFs.
5. **Citation jump-to-page with chunk-scoped tokens.** The library-chat system prompt instructs the
   LLM to cite as `[itemKey#chunkIndex]` (e.g., `[ABCD1234#3]`). `appendWithCitations` parses both
   halves; the renderer resolves `chunkIndex` against a per-turn lookup table built from the
   retrieved chunks. Citations with `pageIndex !== undefined` open the attachment at that page when
   clicked via `Zotero.Reader.open(attachmentId, { pageIndex })` — the second positional argument is
   the location directly. An already-open reader navigates within its existing tab. The renderer
   falls back to plain `[itemKey]` parsing (opens attachment at page 0 via
   `Zotero.Reader.open(attachmentId)`) when the LLM emits the legacy token format or when the cited
   chunk has no `pageIndex` (legacy index, metadata/note/EPUB).
6. **Silent re-index migration triggered by `schemaVersion`.** On first index-read after the
   upgrade, an index with `schemaVersion ?? 1 < 2` is detected, the loader writes
   `migrationPending: true` and crawls into `<index-path>.tmp`, and the temp file is atomically
   renamed over the old index when the crawl completes. The post-migration file has
   `schemaVersion: 2` and every chunk carries `sourceKind`. Every concurrent reader sees either the
   old or the new index, never a half-cleared file. A plugin reload mid-migration resumes from the
   persisted marker. No user dialog; the existing status indicator renders progress. **Adversarial
   1: killing the plugin mid-migration and reopening completes the migration on the next launch.
   Adversarial 2: on the read immediately following a successful migration, the loader observes
   `schemaVersion: 2` and does NOT re-fire the migration — confirming FINDING-2 iter-2 (mixed-source
   items with metadata/note chunks no longer re-trigger).**
7. **v0.2.0 E2E regressions fixed.** The five failures listed in the Background subsection are
   resolved at root cause in source code, not by adjusting the tests away. The planner's `/rca`
   establishes the actual root cause (it may or may not match the suspected `start()` /
   driver-initialization hypothesis). Reverting the fix turns the affected tests red; restoring it
   turns them green. Adversarial coverage lands so the controller's `running` transition cannot
   regress silently again.
8. **Ollama pin bump for cross-platform CI.** `OLLAMA_VERSION` in
   `.github/workflows/e2e-cross-platform.yml` is bumped from `0.5.7` to a version that supports
   `gemma3:1b`. The cross-platform workflow is green on the release commit.
9. **Adversarial chunk-collision citation test.** A library-chat test where two retrieved chunks
   come from the same parent item but different pages (e.g., chunk #0 → page 2, chunk #1 → page 17)
   verifies that: (a) the prompt presents both chunks with distinct `[itemKey#chunkIndex]` labels,
   (b) clicking the citation for chunk #0 opens the reader at page 2, (c) clicking the citation for
   chunk #1 in the _same already-open reader_ navigates to page 17, NOT page 2, and (d) when the LLM
   emits a hallucinated token like `[WRONGKEY#0]` where `WRONGKEY` is not the itemKey of chunk 0's
   actual source, the full-token lookup (`get("WRONGKEY#0")`) misses and the renderer falls back to
   legacy `[itemKey]` behavior (opens the attachment for `WRONGKEY` at page 0, when that itemKey
   resolves to a real item; or renders as inert if it does not). The misrouted citation does NOT
   silently open the chunk-0 item's wrong page. This is the iter-2 FINDING-3 + iter-3 FINDING-2
   explicit acceptance check; without it the citation protocol is unverified for the common
   multi-chunk-same-item case and the hallucinated-pairing case.
10. **Release gate green at `v0.3.0`.** CI, Zotero E2E, and E2E Cross-Platform workflows all pass on
    the release tag. (This is the consequence of #7 and #8 succeeding — listed separately so the
    release-gating workflow has a single criterion to consume.)
11. **Manual smoke.** The user installs the resulting XPI in their personal Zotero 9 and confirms
    ask-question, in-PDF scoping, citation jump-to-page (including the multi-chunk-same-item case),
    and silent re-index migration all hold in their real library.
