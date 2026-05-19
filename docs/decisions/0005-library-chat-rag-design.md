# ADR 0005 — Library chat RAG design

- **Status:** Accepted
- **Date:** 2026-05-17
- **Phase:** real-product-pipeline (Phase 4)

## Context

Per-provider library indexes are persisted (ADR 0002). The next step was a NotebookLM-style "Ask
your library" experience: a chat surface that retrieves relevant chunks and synthesises an answer
with clickable citations. Constraints: no hallucination when the index is empty; citations must be
clickable into Zotero; XSS-safe rendering of streaming model output; reuse the existing chat
provider adapters; stale-index detection (dimension mismatch surfaced clearly).

## Decision

Flat-ranking cosine retrieval over the persisted per-provider index, threaded into a grounded
prompt, streamed by the active chat provider, rendered with hand-rolled DOM construction (no
`innerHTML`).

- **Retrieval** (`src/indexing/index-search.ts`). `cosineSimilarity(a, b)` is pure cosine; zero
  vectors return `0` (not `NaN`); length mismatch throws `EmbeddingDimensionMismatchError` eagerly.
  `topKChunks(indexFile, queryEmbedding, k)` walks every chunk, scores by cosine, flat-sorts
  descending, returns the first `K`. **K = 8** (constant `LIBRARY_CHAT_TOP_K`) — ~16 KB of context,
  comfortable under any reasonable model's window.
- **Flat ranking, no per-item dedup.** Multiple chunks from one item can win adjacent slots — the
  right behaviour for "explain the methodology in paper X".
- **Prompt construction.** `buildLibraryPrompt(question, chunks)` lists `[itemKey] <chunk text>`
  excerpts and instructs the model to cite `[itemKey]` after each claim. Prior turns within the
  session are preserved; each submit retrieves fresh top-K.
- **Citation rendering** (`appendWithCitations`). Regex `/\[([A-Za-z0-9_]{3,32})\]/gu` matches
  bracketed keys. The renderer walks the source string with `RegExp.exec` and emits alternating
  `createTextNode(slice)` / `createElement('a')` nodes. Plain text never touches `innerHTML`. An XSS
  payload like `[<img src=x onerror=alert(1)>]` falls through the regex (content isn't an
  alphanumeric key) and surfaces as literal text — an adversarial test asserts
  `querySelector('img')` returns null.
- **Citation clicks.** `<a data-item-key="KEY" href="#">KEY</a>` delegated to the dialog's root
  listener; `preventDefault()` blocks navigation; `onCitationClick(key)` calls
  `Zotero.Items.getByLibraryAndKey` → `Zotero.getActiveZoteroPane().selectItems`.
- **Empty / error paths.** No index file or zero retrieved chunks →
  `store.fail("No indexed content found — index your library first.")`. Dim mismatch →
  `store.fail(err.message)` containing "dimension".
- **Lifecycle.** `LibraryConversationStore` is a singleton (distinct from per-selection popup
  conversations). "New conversation" calls `store.reset()`. In-memory only — does not survive plugin
  restarts.

## Consequences

- **Predictable cost per question.** One embed call + one chat call. No iterative retrieval, no
  agentic loops.
- **Cross-paper questions work.** Flat ranking surfaces relevant excerpts regardless of item origin;
  the model decides which to cite.
- **Citations are real.** Every clickable link maps to an actual item key the regex saw in the
  rendered text — the model cannot fabricate a key.
- **Provider-switch behaviour is honest.** Stale-index dim mismatch surfaces a clear in-dialog
  error, not a generic stack trace and not silently-wrong scores.

## Alternatives considered

- **Per-item dedup.** Loses the "methodology in paper X" use case. May revisit if user feedback
  shows monoculture answers.
- **Larger K with a re-ranker.** Second model call per question — rejected on cost/latency.
- **Mid-stream re-retrieval (agentic).** Over-engineered for v1; the one-shot retrieval meets the
  AC.
- **External vector store.** ADR 0002 covers why JSON persistence suffices at current library sizes;
  a linear cosine scan over a few thousand chunks completes in single-digit milliseconds.
- **Render citations via the markdown renderer.** Mixing markdown parsing with the citation regex
  either drops citations inside code spans or forces the markdown parser to know about citations.
