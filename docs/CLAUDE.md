# Documentation

Design specs, Architectural Decision Records (ADRs), implementation plans, and human-facing
documentation.

## Structure

```text
docs/
  decisions/              # Architectural Decision Records (ADRs)
  specs/                  # Approved Forge specs (dated)
  manual-verification/    # Human smoke-test checklists (zotero.md etc.)
  superpowers/
    specs/                # Brainstorming / pre-approval spec drafts
    plans/                # Implementation plans linked to approved specs
  assets/                 # Diagrams, README preview images
```

## ADRs (`docs/decisions/`)

Lightweight Architectural Decision Records — one file per major design choice. Format: Context ·
Decision · Consequences · Alternatives considered. The Phase 4 real-product-pipeline work landed the
first five; the pdf-context-features (v0.3.0) work added two more:

- `0001-llm-proxy-architecture.md` — local HTTP proxy with codex/claude/ollama backends.
- `0002-per-provider-index-files.md` — one index file per (embed-provider, model) pair.
- `0003-provider-profile-abstraction.md` — independent chat/embed selectors + preset layer.
- `0004-bootstrap-chrome-subprocess.md` — `Subprocess.sys.mjs` for the in-plugin proxy lifecycle.
- `0005-library-chat-rag-design.md` — cosine top-K=8 retrieval with citation rendering.
- `0006-pdf-worker-per-page-extraction.md` — per-page PDF text via `Zotero.PDFWorker.getFullText`.
- `0007-schema-versioned-index-migration.md` — crash-safe write-new-then-swap index migration.

Add a new ADR when a future change makes one of these decisions obsolete (mark the old ADR
**Superseded** and reference the new one) or when a new decision of similar weight is made.

## Implementation history

Per-feature implementation history (per-AC subagent records, review notes, revert-proof artefacts)
lives under `.forge/phases/<feature>/`. For the real-product-pipeline feature the records are at
`.forge/phases/real-product-pipeline/` and document every AC implementation, code review, and
verification pass in chronological order. The ADRs under `docs/decisions/` summarize the
load-bearing decisions from that history; consult the `.forge/` records for the full design
trajectory.

## Extending

1. Store approved design specs in `docs/specs/` (dated filenames).
2. Keep implementation plans in `docs/superpowers/plans/` linked from their corresponding spec.
3. Major architectural decisions get an ADR in `docs/decisions/` with the next sequential four-digit
   number.
4. Update README diagrams in `docs/assets/` when architecture or workflows change.
