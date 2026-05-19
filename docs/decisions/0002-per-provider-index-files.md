# ADR 0002 — Per-provider index files

- **Status:** Accepted
- **Date:** 2026-05-17
- **Phase:** real-product-pipeline (Phase 4)

## Context

The library index persists `{items: {[itemKey]: {title, chunks: [{text, embedding}]}}}` JSON under
the Zotero data directory. The shape is identical across embedding providers, but vector dimensions
and embedding spaces are not (Ollama `embeddinggemma` 768, OpenAI `text-embedding-3-small` 1536,
`3-large` 3072, Gemini `text-embedding-004` 768).

With Phase 4 adding the OpenAI and Gemini direct-API embed adapters plus the preset dropdown, users
will switch providers in settings. Mixing vectors from different providers in one file would
silently corrupt cosine-similarity scores: dim mismatches throw, but matching dims from different
spaces (Ollama and Gemini both 768) score plausibly while being wrong.

## Decision

Each `(embedding-provider, model)` pair gets its own on-disk index file:

```text
<dataDir>/zotero-ai-explain-index-ollama-embeddinggemma.json
<dataDir>/zotero-ai-explain-index-openai-3-small.json
<dataDir>/zotero-ai-explain-index-openai-3-large.json
<dataDir>/zotero-ai-explain-index-gemini-004.json
```

`src/indexing/index-path.ts` owns the naming. `slugifyModel(model)` strips provider-redundant
prefixes (`text-embedding-`, `embedding-`, `models/`) and any Ollama `name:tag` suffix, then
lowercases and replaces unsafe runs with single dashes (Ollama's colon would break Windows
filenames). `computeIndexPath` joins; `parseIndexPath` is the inverse for diagnostics.

Switching providers in settings flips the active filename; previously persisted files stay on disk
so the user can switch back without re-indexing. The legacy `zotero-ai-explain-index.json` name is
preserved as a back-compat alias for `ollama / embeddinggemma`.

## Consequences

- **No silent corruption.** Structurally impossible to mix two providers in one file.
- **Switching is cheap.** Provider swap loads a different file; full re-crawl is only needed when no
  file exists yet for the new pair. A user can A/B test embedding quality across providers.
- **Disk cost.** N (provider, model) pairs use N times the disk space. Typical home libraries with
  ~1k items index to ~10–50 MB per provider — acceptable for the safety property.
- **Settings can surface stale indexes.** `parseIndexPath` lets the dialog show "index for this
  (provider, model) exists / is N days old / doesn't exist" and offer a clear next action.
- **Cleanup is user-managed.** Stale per-(provider, model) files accumulate harmlessly; the user can
  delete them from `<dataDir>` directly.
- **Defence in depth.** Even within one file, the cosine retrieval still throws
  `EmbeddingDimensionMismatchError` when the query embedding length doesn't match the persisted
  chunks — guards against a file that survived an upstream model dimension change.

## Alternatives considered

- **Single file with a `provider`/`model` header per chunk.** Still possible to mix same-dimension
  embeddings from different spaces and produce wrong scores; also slower retrieval (filter per
  query) and writes contended.
- **In-memory cache + recompute on switch.** Re-indexing takes minutes to hours; blocking provider
  switches on that is hostile to experimentation.
- **One file per provider only (model goes inside).** Forces a re-index when the user upgrades from
  `3-small` to `3-large` — exactly the kind of switch users want to try cheaply.
- **External vector store (sqlite, hnsw).** Out of scope for v1. The JSON file is human-inspectable,
  the chunk count is small enough that a flat cosine scan is fast, and the persistence model matches
  Zotero's "single data directory" idiom.
