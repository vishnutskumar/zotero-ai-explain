# ADR 0007 — Schema-versioned write-new-then-swap index migration

- **Status:** Accepted
- **Date:** 2026-05-22
- **Phase:** pdf-context-features (v0.3.0)

## Context

v0.3.0's per-page PDF extraction (ADR-0006) and chunk-scoped citations add new per-chunk fields —
`pageIndex`, `attachmentKey`, `sourceKind` — and a new top-level `schemaVersion` field on the index
file. Existing installs hold v0.2.0 index files (no `schemaVersion`, page-blind chunks). Those files
must be upgraded so the new citation features work, but a home library can index to tens of
megabytes (one profiled index was 71 MB), and the migration re-crawls and re-embeds the whole
library — a multi-second to multi-minute operation.

Two failure modes had to be designed out:

1. **A mid-migration crash leaving a corrupt index.** If the plugin (or Zotero) is killed while the
   index file is being rewritten in place, the user is left with a truncated, unreadable index.
2. **A concurrent reader seeing a half-written file.** The popup-RAG and library-chat read paths
   call `IndexStorage.read()` at any time, including while a migration is running. They must never
   observe a partially-populated index.

A v0.2.0 design that mutated the primary file in place — or that flagged migration state as a field
inside the primary file — fails both: an in-place rewrite is not atomic, and a `migrationPending`
field inside the file cannot be read until the file itself is whole.

## Decision

Migration is **write-new-then-swap** with an out-of-band sidecar marker:

- `CURRENT_SCHEMA_VERSION = 2` (`library-crawler.ts`). A file with no `schemaVersion`, or a value
  below the constant, is treated as legacy and triggers migration.
- The migration probe is a **single canonical entry point**: `IndexStorage.readWithMigration()`,
  called **only** from `IndexingController.hydrate()` at startup. It returns
  `{ file, migrationPending }`, where `migrationPending` is true when the sidecar marker exists OR
  the primary file's `schemaVersion` is below `CURRENT_SCHEMA_VERSION`.
- The plain `IndexStorage.read()` stays **genuinely pure** — it issues only `exists` / `readString`,
  never a `writeString` / `remove` / `rename`. Every production read path (popup RAG, library chat)
  uses `read()` and therefore never triggers a migration and never mutates the filesystem.
- `runMigration()` (a) writes the sidecar marker `<index-path>.migrating` (idempotent — a no-op if
  it already exists), (b) clears any stale `<index-path>.tmp` from a previous crashed attempt, (c)
  runs a fresh crawl into `<index-path>.tmp` producing `schemaVersion: 2` chunks, (d) on success
  `commitMigration()` **atomically renames** `.tmp` over the primary, then removes the marker.
- The primary index file is **never mutated in place** during migration. Across the single atomic
  rename, every concurrent `read()` observes either the fully-populated old file or the
  fully-populated new file — never an intermediate state.
- A reload mid-migration is detected by the sidecar marker's presence on the next launch. The five
  crash windows (during marker create, after marker before `.tmp`, during `.tmp` write, after `.tmp`
  before rename, during/after rename) all resolve to "the next `hydrate()` re-runs or finishes the
  migration", because POSIX/Windows `rename` is atomic and the marker is the durable resume signal.
  The one exception — rename completed but marker removal was interrupted — is detected when
  `hydrate()` sees `schemaVersion: 2` _and_ the marker; it then just removes the stale marker and
  skips the re-crawl.

## Consequences

- **Crash-safe.** At every instant the primary file is either fully old or fully new. No crash can
  produce a truncated index; the worst case is a re-crawl on the next launch.
- **Concurrent reads are always safe.** `read()` is pure and the swap is atomic, so the popup and
  library chat keep working — against the legacy file — for the whole duration of a migration.
- **Resumable.** The sidecar marker survives a process death, so a migration interrupted by a Zotero
  restart finishes on the next launch with no user action and no data loss.
- **No migration-state field in the file.** The pending signal lives in a separate marker file, so
  it is observable even when the primary file is mid-rewrite — and it does not bloat or version-lock
  the index schema itself.
- **Migration cost is a full re-crawl.** Rather than transform legacy chunks in place (which cannot
  recover the page provenance that the legacy format never stored), the migration re-crawls and
  re-embeds. This is slower but produces a correct v2 index; partial in-place upgrades are rejected.
- **One probe entry point.** Only `hydrate()` calls `readWithMigration()`. Every other caller uses
  `read()`. This keeps the "what can trigger a migration" surface to exactly one line of code.

## Alternatives considered

- **In-place rewrite of the primary file.** Not atomic; a crash mid-write corrupts the index.
  Rejected — this is precisely the failure mode the swap design exists to remove.
- **A `migrationPending` boolean field inside the primary index file.** Cannot be read while the
  file is being rewritten, and couples migration state to the schema. Replaced by the sidecar
  marker. Rejected.
- **Transform legacy chunks in place to v2 (no re-crawl).** The legacy format never stored page
  provenance; an in-place transform cannot synthesize `pageIndex` / `attachmentKey`, so the upgraded
  index would still be page-blind. A re-crawl is the only way to a correct v2 index. Rejected.
- **Migrate lazily on each read.** Would make `read()` impure and put migration cost on the chat hot
  path; also races between concurrent readers. Rejected in favour of the single startup probe.
- **Block all reads during migration.** Hostile to the user — the popup and library chat would be
  dead for the whole crawl. The pure-`read()` + atomic-swap design keeps them live instead.
