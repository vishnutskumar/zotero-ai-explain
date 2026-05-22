# ADR 0006 — Per-page PDF text extraction via Zotero.PDFWorker

- **Status:** Accepted
- **Date:** 2026-05-22
- **Phase:** pdf-context-features (v0.3.0)

## Context

Through v0.2.0 the library crawler indexed PDF attachments by reading Zotero's `.zotero-ft-cache`
file — the flat plain-text cache Zotero produces when it indexes an attachment for full-text search.
That cache is a single concatenated string with no page boundaries. Chunks built from it therefore
carried no provenance: a retrieved chunk could be cited by `[itemKey]`, but the citation could only
open the PDF at page 1. There was no way to know which page a chunk's text physically lived on.

v0.3.0's chunk-scoped citations (ADR-adjacent, AC-6/AC-7 of the plan) and the "jump to the cited
page" feature both require a per-chunk `pageIndex`. They cannot be built on a page-blind text
source. A second problem: relying on `.zotero-ft-cache` means a PDF the user just added — before
Zotero has run its own background full-text indexing — is invisible to our crawler.

## Decision

For every PDF child (and standalone PDF) attachment, the crawler calls
`Zotero.PDFWorker.getFullText(attachment.id)` — the chrome-side PDF.js worker that ships bundled
with Zotero. Its returned `text` already delimits pages with the form-feed character `\f`. The new
`src/indexing/per-source-chunks.ts` helper splits on `\f` (`splitPdfWorkerText`) and emits one text
source per physical page; `library-crawler.ts` then runs the existing `chunkText` helper over each
page and stamps every resulting chunk with `pageIndex` (0-indexed), `attachmentKey`, and
`sourceKind: "pdf-page"`.

`splitPdfWorkerText` preserves empty pages — a trailing `\f`, a `\f\f` run, or a leading `\f` each
yield an empty page string rather than being collapsed — so `result[n]` is always the text of
physical page `n` and the chunk `pageIndex` never desyncs from the real page number.
`extractPerSourceChunks` yields all of an item's text sources in a fixed order — metadata → notes →
PDF pages → non-PDF attachments — each tagged with a `sourceKind` (`metadata` / `note` / `pdf-page`
/ `epub` / `snapshot` / `attachment`). Non-PDF attachments continue through the existing
`readAttachmentFullText` cached-fulltext path.

When `getFullText` rejects (corrupt or password-protected PDF, or a non-PDF attachment the worker
refuses), the per-attachment catch returns `null`; the crawler logs, counts a skip, and continues to
the next source — one bad attachment never aborts the crawl.

## Consequences

- **Citations can point at a page.** Every PDF chunk carries `pageIndex`, so a library-chat citation
  can jump the reader to the exact cited page (`Zotero.Reader.open(attachmentId, { pageIndex })`).
- **No dependency on Zotero's own indexing run.** `getFullText` extracts text on demand; a PDF the
  user just imported is indexable immediately, with no wait for `.zotero-ft-cache` to be produced.
- **Page-boundary chunks are approximate.** `chunkText` is page-scoped but byte-bounded — a chunk
  that starts on page N keeps `pageIndex: N` even if a few sentences physically spill onto page N+1.
  The chunker does not know about page boundaries; the citation lands on the chunk's starting page.
- **Schema bump required.** Per-chunk `pageIndex` / `attachmentKey` / `sourceKind` are new fields,
  which forced the `schemaVersion: 2` index format and its migration (see ADR-0007).
- **Worker availability.** `Zotero.PDFWorker` is a chrome global; the helper threads it through a
  `PerSourceAccess.PDFWorker` slot that tolerates `undefined`, so non-reader and test contexts that
  lack the worker degrade to the non-PDF text path rather than crashing.
- **Cost.** Extraction runs PDF.js per attachment at crawl time. It is part of an explicit,
  user-initiated (or auto-reindex) crawl, not the chat hot path, so the cost is acceptable.

## Alternatives considered

- **Keep reading `.zotero-ft-cache`.** Page-blind by construction — cannot satisfy the per-page
  citation requirement at all, and invisible for un-indexed attachments. Rejected.
- **Bundle our own PDF.js copy.** Duplicates a parser Zotero already ships and maintains, inflates
  the XPI, and risks version drift against Zotero's reader. `Zotero.PDFWorker` is the supported
  in-tree extraction surface. Rejected.
- **Parse the `.zotero-ft-cache` and re-derive pages heuristically.** The cache has no reliable page
  delimiter; any heuristic would be brittle and silently misattribute pages. Rejected.
- **Per-page chunking with hard page-boundary chunk splits.** Would forbid a chunk from spanning a
  `\f`, producing many tiny end-of-page chunks and degrading retrieval quality. The chosen approach
  chunks page text independently and accepts the small starting-page approximation instead.
