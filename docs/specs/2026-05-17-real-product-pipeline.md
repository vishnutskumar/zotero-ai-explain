# Real Product Pipeline

**Date:** 2026-05-17 **Status:** Approved — "yes /goal this till we have a working plugin tested e2e
in a real environment" **Flow:** forge full

## Problem

The Zotero AI Explain plugin does not work in a real Zotero 9 install. Several iterative rounds of
"tests pass" (most recently the AC1–AC7 e2e suite at 22/22 green) were false positives: the
in-process e2e driver synthesized chrome-document buttons and dispatched against them, bypassing the
real reader → iframe → chrome pipeline that ships to the user. When v0.1.3 was manually installed in
the user's personal Zotero 9, the popup mounted at iframe-relative coordinates and rendered inside
the reader's selection popup with the body clipped — only the close button was visible. Separately,
library indexing was feature-flagged off behind a "Coming soon" placeholder, even though the user
wanted real Phase 2 indexing exercised end-to-end.

The user has a Zotero 9 install with a personal library and wants the plugin to demonstrably work
when installed by hand: real selection → anchored popup at the correct chrome-window position →
streamed explanation → optional follow-up chat, plus real library indexing that actually crawls
items and produces embeddings. The e2e suite must back this up by exercising the real product
surface (real PDF reader, real iframe, real reader-event dispatch) so future regressions on the
iframe-offset pathway cannot pass.

## Goals

- E2E driver opens a real Zotero PDF reader against a committed sample PDF and exercises the plugin
  through `Zotero.Reader._dispatchEvent` with the real iframe `doc` and a real `append` targeting
  the iframe's selection-popup container.
- `addReaderCommand` click handler in `src/platform/zotero-ui-adapter.ts` computes iframe offset
  (`event.doc.defaultView.frameElement?.getBoundingClientRect()`) and adds it to the button rect
  before plumbing into `SelectionContext.anchor`, so the popup mounts at chrome-window-correct
  screen coordinates.
- Real Phase 2 library indexing replaces the "Coming soon" placeholder: enumerate
  `Zotero.Items.getAll(libraryID)`, extract `title` + `abstractNote`
  - child note contents, chunk into ~2 KB chunks, POST each through the existing Ollama provider's
    `/api/embed`, persist results to `<Zotero data dir>/zotero-ai-explain-index.json`, and wire
    Pause/Resume/Clear to do the real thing.
- Remove the `extensions.zotero-ai-explain.indexing-preview` feature flag and every "Coming soon"
  string tied to it.
- Adversarial tests for the iframe-offset fix demonstrably fail when the offset addition is reverted
  and pass when it is restored.
- The seven user-facing acceptance criteria below all hold against a real spawned Zotero process AND
  the user reports a successful manual smoke test.

## Non-Goals

- PDF fulltext indexing (deferred to v0.2; this slice indexes title + abstract
  - child notes only).
- Retrieval-augmented chat that consults the index (deferred to v0.2; the index is written but not
  read by chat in this slice).
- Reviving Marionette as the e2e transport (`WebDriver:NewSession` hangs on Zotero 9 / FF 140 ESR
  per `scripts/zotero-e2e/marionette-smoke.mjs`; the in-process diagnostic driver continues to be
  the e2e transport, just upgraded to use real iframe context).
- GitHub release, git tag, or version bump — the plugin stays at `0.1.3`. The user gates publishing
  after their manual smoke.
- Real Ollama daemon dependency in CI. The existing fake Ollama HTTP server
  (`scripts/zotero-e2e/fake-ollama-server.mjs`) speaks the real Ollama protocol over real HTTP and
  remains the test double.
- New providers. Only Ollama is exercised in this slice.
- SQLite or any durable DB for embeddings. A plain JSON file is the storage for v0.1.x.
- Nested Agent calls inside subagents.

## Approach

**E2E real-PDF flow.** Commit a 1-page public-domain PDF (under 50 KB) at
`tests/fixtures/sample.pdf`. The e2e driver programmatically imports it as a Zotero attachment,
opens it in the real reader, retrieves the real iframe document, and dispatches selection events
through `Zotero.Reader._dispatchEvent` with the real `doc` and an `append` that targets the iframe's
selection-popup container. This replaces the previous synthetic chrome-document button shortcut that
produced false positives. The flow exercises the real registration path through
`Zotero.Reader._registeredListeners`.

**Iframe-offset fix.** The `addReaderCommand` click handler currently passes the button's
`getBoundingClientRect()` straight through to `SelectionContext.anchor`, which produces iframe-local
coordinates. The fix reads `event.doc.defaultView.frameElement?.getBoundingClientRect()` (falling
back to `{left: 0, top: 0}` when the document has no frame element) and adds those offsets to the
button rect before constructing the anchor. The resulting coordinates are relative to the chrome
window, which is where the anchored popup mounts.

**Real Phase 2 indexing.** Walk `Zotero.Items.getAll(libraryID)`. For each item, read
`getField("title")`, `getField("abstractNote")`, and child notes via
`Zotero.Items.get(noteID).getNote()`. Concatenate, chunk into ~2 KB chunks, send each chunk through
the existing Ollama provider's `/api/embed`, and persist the output to
`<Zotero data dir>/zotero-ai-explain-index.json` with shape
`{ items: { [itemID]: { title, chunks: [{text, embedding: number[]}] } }, indexedAt: ISO }`. Pause
halts the loop, Resume continues from the last unprocessed item, Clear deletes the JSON file. The
`extensions.zotero-ai-explain.indexing-preview` pref and every "Coming soon" string tied to it are
removed; the controls live in settings unconditionally.

**Adversarial test discipline.** Before declaring done, temporarily revert the iframe-offset
addition in `zotero-ui-adapter.ts` and confirm the relevant e2e tests go red. Restore the fix and
confirm green. This proves the test exercises the real fix and not an unrelated path.

## Alternatives Considered

- **Synthetic-iframe-in-chrome e2e fidelity.** Would let us keep the current driver shape but would
  not catch iframe-offset bugs because the iframe geometry would not be real. Rejected because that
  is exactly the class of bug that shipped in v0.1.3.
- **Investigate a Zotero test-only API for `renderTextSelectionPopup`.** Surveyed during
  brainstorming; no public test-only API exists. `Zotero.Reader` exposes the private
  `_registeredListeners` registry and `_dispatchEvent` dispatcher. We use the private hooks because
  they let us supply the real iframe `doc` and `append`, which is what the production code paths
  receive.
- **Defer indexing to a separate slice.** Rejected because the user asked for a working plugin, and
  the existing "Coming soon" placeholder is a visible defect that contradicts the v0.1.3 settings UI
  promise. Including real Phase 2 indexing in this slice keeps scope honest.
- **Index with retrieval in the same slice.** Rejected as too large. The index is written but not
  consulted by chat; retrieval-augmented chat is its own v0.2 slice.

## Constraints

- Pre-commit hooks must run on every commit. No `--no-verify`, no `SKIP=<hook>`. Fix hook failures
  at the root cause.
- All changes reach `main` via a feature branch and PR. No direct pushes.
- Plugin version stays at `0.1.3`. No release, no tag, no push of release artifacts.
- Adversarial tests must demonstrably fail before the fix and pass after.
- Marionette is unusable on Zotero 9 / FF 140 ESR; the e2e transport is the in-process diagnostic
  driver upgraded to use the real reader iframe.
- Fake Ollama HTTP server stays; no live `localhost:11434` dependency in CI.
- No nested Agent calls inside subagents.
- Embedding storage is a JSON file at `<Zotero data dir>/zotero-ai-explain-index.json`. No SQLite,
  no other DB.
- Indexing scope is title + abstract + child notes only. PDF fulltext is out of scope.

## Open Questions

- None. The brainstorming session resolved sample PDF location (`tests/fixtures/sample.pdf`),
  private Zotero API choice (`Zotero.Reader._registeredListeners` + `_dispatchEvent`), storage shape
  (JSON file at the documented path), and indexing scope (no fulltext, no retrieval) before
  approval.

## Success Criteria

1. **Popup anchor position.** Selecting text in a real PDF reader and triggering the explain command
   mounts the popup at chrome-window-correct screen coordinates next to the selection, not inside
   the reader's selection popup or clipped by the iframe.
2. **Popup body renders streamed content.** Streamed explanation tokens appear visibly in the popup
   body next to the selection, driven by the real streaming pipeline (no synthetic content injection
   in the e2e harness).
3. **Real Phase 2 library indexing.** Indexing runs against `Zotero.Items` for the active library,
   persists embeddings to `<Zotero data dir>/zotero-ai-explain-index.json`, and Pause/Resume/Clear
   each take their documented effect against the real persisted file.
4. **Popup close affordances.** The popup is dismissible via the close (×) button, Escape key, and
   outside-click against the real PDF reader.
5. **Popup scrollability.** Long streamed responses scroll inside the popup body without the body
   being clipped by the iframe or the reader's selection popup.
6. **Inline follow-up.** A textarea and submit control inside the popup send a second `/api/chat`
   request and render the follow-up response inline.
7. **Click feedback.** The toolbar/selection button shows visible click feedback before the popup
   mounts so the user knows the command was received.
8. **Adversarial proof.** Reverting the iframe-offset addition turns the relevant e2e tests red;
   restoring it turns them green.
9. **Manual smoke.** The user installs the resulting XPI in their personal Zotero 9 and reports the
   seven user-facing criteria above hold.
10. **Real-provider coverage.** A local-only e2e suite (`npm run test:e2e:local`) exercises the
    plugin against a live Ollama daemon so the streaming chat and embedding paths are validated
    against real model output at least once before each release. The suite auto-skips in CI and on
    contributor machines without a running Ollama, and surfaces real provider errors (bad model
    name, unreachable URL) as failed-status popup content instead of silent no-ops.
