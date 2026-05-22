/**
 * IndexFile persistence — the AC3 storage module of the
 * real-product-pipeline plan.
 *
 * Stores the indexing artefact at
 * `<Zotero data dir>/zotero-ai-explain-index.json`. Read returns `null`
 * on a missing file, malformed JSON, OR a JSON-parseable value that
 * doesn't match the IndexFile shape (FINDING-13). Write serializes
 * atomically via a `.tmp` + rename when the injected io adapter
 * supports it; otherwise plain writeString.
 *
 * Contract source: `docs/superpowers/plans/2026-05-17-real-product-pipeline.md`
 * AC3 Interfaces (L1016-1033) and AC4 shape-validation rules (L770-786).
 */

import {
  computeIndexFileName,
  LEGACY_INDEX_FILE_NAME,
  type EmbedProviderKind
} from "./index-path.js";
import { CURRENT_SCHEMA_VERSION, type IndexFile } from "./library-crawler.js";

/**
 * Sidecar metadata persisted alongside the IndexFile. Lets the
 * controller seed `previouslyIndexed` at startup by reading tens of
 * bytes instead of parsing the full multi-megabyte JSON.
 */
export type IndexMeta = {
  readonly itemCount: number;
  readonly indexedAt: string;
};

export type IndexStorage = {
  /**
   * PURE read — no side effects, no migration trigger. Returns the
   * on-disk IndexFile or `null`. This is the production read path
   * (popup RAG, library chat, crawler resume); it must never mutate the
   * filesystem so a read DURING a migration is always safe.
   */
  read(): Promise<IndexFile | null>;
  /**
   * Read + migration-pending detection. The SOLE migration-probe entry
   * point — only `IndexingController.hydrate()` calls it. Returns the
   * primary file (via the pure `read()`) plus a `migrationPending`
   * boolean that is true when the sidecar `<index>.migrating` marker
   * exists OR when the file's `schemaVersion` is below
   * `CURRENT_SCHEMA_VERSION` (a legacy file with no field counts as 1).
   */
  readWithMigration(): Promise<{
    readonly file: IndexFile | null;
    readonly migrationPending: boolean;
  }>;
  /**
   * Cheap "how many items are persisted?" probe. Reads the sidecar
   * `<index>.meta.json` and returns its `itemCount`. Falls back to a
   * full `read()` + `Object.keys(items).length` only when the sidecar
   * is missing (i.e., legacy installs that wrote the index before the
   * sidecar existed); subsequent writes populate the sidecar so the
   * fallback only happens once. Returns 0 when no index exists at all.
   */
  readItemCount(): Promise<number>;
  write(file: IndexFile): Promise<void>;
  /** Write the serialized file to `<index>.tmp`; never touches the primary. */
  writeTmp(file: IndexFile): Promise<void>;
  /**
   * Atomically rename `<index>.tmp` over the primary, then remove the
   * sidecar marker. Throws (without touching the primary) when no
   * `.tmp` exists.
   */
  commitMigration(): Promise<void>;
  /** Remove a stale `<index>.tmp` (idempotent). Does NOT touch the marker. */
  abandonMigration(): Promise<void>;
  /** Create the `<index>.migrating` sidecar marker (idempotent). */
  writeMarker(): Promise<void>;
  /** Delete the `<index>.migrating` sidecar marker (idempotent). */
  removeMarker(): Promise<void>;
  /** Existence check on the `<index>.migrating` sidecar marker. */
  hasMarker(): Promise<boolean>;
  clear(): Promise<void>;
  path(): string;
};

/**
 * Cheap stat probe over the primary index file, used by the AC-12
 * in-memory cache to fingerprint the on-disk file. Maps to `IOUtils.stat`.
 */
export type IndexFileStat = {
  /** Byte size of the file. */
  readonly size: number;
  /** Last-modified epoch-ms, when the platform exposes it. */
  readonly lastModified?: number;
};

export type CreateIndexStorageDeps = {
  readonly zotero: { readonly DataDirectory: { readonly dir: string } };
  readonly io: {
    readString(path: string): Promise<string>;
    writeString(path: string, contents: string): Promise<void>;
    remove(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    /** Atomic move `src` → `dst` (maps to `IOUtils.move`). */
    rename(src: string, dst: string): Promise<void>;
    /**
     * AC-12: cheap stat for the cache fingerprint. Resolves `null` when
     * the file is absent OR the adapter cannot stat (the no-op fallback
     * adapter always returns `null`, which degrades the cache to
     * "never cache" — correctness is preserved, only the optimization
     * is lost).
     */
    stat(path: string): Promise<IndexFileStat | null>;
  };
  /**
   * Phase 4 direct-API: each (provider, model) gets its own index file.
   * When omitted the legacy single filename is used so a host that
   * hasn't been migrated still works.
   */
  readonly embedProvider?: {
    readonly kind: EmbedProviderKind;
    readonly model: string;
  };
};

/** Legacy file name kept for back-compat when no provider info is supplied. */
const LEGACY_FILE_NAME = LEGACY_INDEX_FILE_NAME;

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function isIndexFile(value: unknown): value is IndexFile {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.indexedAt !== "string") return false;
  const items = record.items;
  if (typeof items !== "object" || items === null || Array.isArray(items)) return false;
  return true;
}

export function createIndexStorage(deps: CreateIndexStorageDeps): IndexStorage {
  const fileName =
    deps.embedProvider !== undefined
      ? computeIndexFileName({
          provider: deps.embedProvider.kind,
          model: deps.embedProvider.model
        })
      : LEGACY_FILE_NAME;
  const filePath = joinPath(deps.zotero.DataDirectory.dir, fileName);
  const legacyFilePath = joinPath(deps.zotero.DataDirectory.dir, LEGACY_FILE_NAME);
  // Sidecar lives next to the index file with a `.meta.json` suffix in
  // place of the trailing `.json`. We rewrite it on every `write()` so
  // `readItemCount()` answers in O(few-bytes) instead of O(full-parse).
  const metaPath = `${filePath.replace(/\.json$/u, "")}.meta.json`;
  // AC-5 atomic migration sidecars. `tmpPath` holds the freshly-crawled
  // v2 file until the atomic rename swaps it over the primary;
  // `markerPath` is the pending signal that survives a mid-migration
  // crash so the next launch knows to resume.
  const tmpPath = `${filePath}.tmp`;
  const markerPath = `${filePath}.migrating`;

  /**
   * Legacy migration: the old single-file install wrote
   * `zotero-ai-explain-index.json` for the only embed pairing that
   * existed at the time (ollama + embeddinggemma). After Phase 4 added
   * per-(provider, model) filenames, that file becomes orphaned for
   * existing installs even though the new active filename would
   * resolve to the same vectors. To preserve months-old indexes we
   * fall back to the legacy filename ONLY when the new file is absent
   * AND the active embed provider matches the historical default.
   */
  function isLegacyEligible(): boolean {
    if (deps.embedProvider === undefined) return false;
    if (deps.embedProvider.kind !== "ollama") return false;
    return deps.embedProvider.model.trim().toLowerCase() === "embeddinggemma";
  }

  async function tryReadParsed(path: string): Promise<IndexFile | null> {
    if (!(await deps.io.exists(path))) {
      return null;
    }
    let raw: string;
    try {
      raw = await deps.io.readString(path);
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isIndexFile(parsed)) {
      return null;
    }
    return parsed;
  }

  /**
   * Read the persisted IndexFile from disk. GENUINELY PURE — it issues
   * only `exists` / `readString`, never a `writeString` / `remove` /
   * `rename` (AC-5 FINDING-1, AC-12 SP-12.4). A `read()` DURING a
   * migration — or against a legacy install — is therefore always
   * side-effect free.
   *
   * Legacy back-compat: when the per-provider file is absent and the
   * active embed provider is the historical (ollama, embeddinggemma)
   * pairing, the parsed contents of the legacy flat
   * `zotero-ai-explain-index.json` are RETURNED so months-old indexes
   * keep working. The legacy file is NOT copied to the per-provider
   * name here — that copy was a read-path filesystem mutation, a
   * purity violation (FINDING-2). The per-provider file is (re)created
   * naturally by the next real `write()` (a manual re-index) or by the
   * AC-5 schema migration that `hydrate()` runs for a pre-v2 legacy
   * file; until then `read()` keeps returning the correct legacy data
   * via this fallback. Correctness is unchanged; only the (purely
   * cosmetic) one-time fast-path copy is gone.
   */
  async function readPure(): Promise<IndexFile | null> {
    // Prefer the new per-provider file. If both legacy and new exist,
    // the new file wins because the legacy data is by definition stale.
    const primary = await tryReadParsed(filePath);
    if (primary !== null) {
      return primary;
    }
    // Legacy fallback: only kicks in for the historical (ollama,
    // embeddinggemma) pairing — legacy never held any other vectors.
    if (filePath === legacyFilePath || !isLegacyEligible()) {
      return null;
    }
    // Return the legacy payload directly — no copy. `read()` stays pure.
    return tryReadParsed(legacyFilePath);
  }

  /** Delete the `<index>.migrating` sidecar marker (idempotent). */
  async function removeMarkerImpl(): Promise<void> {
    if (await deps.io.exists(markerPath)) {
      try {
        await deps.io.remove(markerPath);
      } catch {
        // Vanished between the exists check and the remove call; the
        // post-condition (no marker) still holds.
      }
    }
  }

  // ------------------------------------------------------------------
  // AC-12: in-memory cache of the parsed IndexFile.
  //
  // `read()` profiles at a full 71MB JSON parse per call (popup RAG and
  // library chat both call it directly). The cache memoizes the parsed
  // file keyed on a cheap fingerprint — the pair (meta-sidecar contents
  // OR an "absent" sentinel, primary-file stat OR an "unstattable"
  // sentinel). A cache HIT returns the parsed file with NO `readString`
  // of the primary and NO `JSON.parse`.
  //
  // The fingerprint catches both invalidation paths:
  //   - a normal re-index rewrites `<index>.meta.json` (new `indexedAt`)
  //     → the meta component changes (SP-12.1);
  //   - an AC-5 `commitMigration` renames the primary but leaves the
  //     meta sidecar untouched → the primary `stat` component changes
  //     (SP-12.2) — AND `commitMigration` drops the cached entry
  //     directly (FINDING-1), so a same-process migration is never
  //     served stale even when the fingerprint cannot prove the swap.
  // When no fingerprint is computable (the no-op adapter's `stat`
  // returns `null`, OR the stat lacks a reliable `lastModified` change
  // token — FINDING-1) every `read()` is a MISS — the cache degrades
  // to "never cache" so it can never serve stale data. A bare byte
  // `size` is NOT a sound change token: a migrated file with the same
  // length as the cached file would share a fingerprint, so size-only
  // stats disable the cache rather than risk a stale hit.
  //
  // `read()` stays PURE (AC-5 FINDING-1): the fingerprint compute issues
  // only an `io.readString` of the tiny meta sidecar and an `io.stat` —
  // no `writeString`, `remove`, or `rename`.
  // ------------------------------------------------------------------
  type CacheEntry = { readonly fingerprint: string; readonly file: IndexFile };
  let cache: CacheEntry | null = null;

  /**
   * Compute the cheap cache fingerprint, or `null` when no fingerprint
   * can be derived (no `stat` available → the cache must never hit).
   * Pure: reads the meta sidecar + stats the primary, never mutates.
   */
  async function computeFingerprint(): Promise<string | null> {
    const primaryStat = await deps.io.stat(filePath);
    if (primaryStat === null) {
      // No stat → no fingerprint → the cache degrades to never-cache.
      return null;
    }
    // FINDING-1: `lastModified` is the ONLY reliable change token an
    // atomic rename moves — `commitMigration` swaps the primary without
    // touching the meta sidecar, and a migrated file can share the byte
    // `size` of the cached one. A stat that lacks a numeric
    // `lastModified` therefore cannot soundly fingerprint the primary,
    // so we treat it exactly like the no-stat path: return `null` to
    // disable the cache rather than fingerprint on `(meta, size)` alone.
    if (
      typeof primaryStat.lastModified !== "number" ||
      !Number.isFinite(primaryStat.lastModified)
    ) {
      return null;
    }
    // Read the meta sidecar directly and treat ANY failure (absent file,
    // malformed JSON) as the "absent" sentinel — no separate `exists`
    // pre-check, which would be a redundant round-trip and a TOCTOU gap.
    let metaComponent = "absent";
    try {
      const rawMeta = await deps.io.readString(metaPath);
      // Validate the sidecar parses; a corrupt meta degrades to the
      // "absent" sentinel rather than poisoning the fingerprint.
      JSON.parse(rawMeta);
      metaComponent = rawMeta;
    } catch {
      metaComponent = "absent";
    }
    return JSON.stringify({
      meta: metaComponent,
      size: primaryStat.size,
      // Guaranteed a finite number by the guard above.
      lastModified: primaryStat.lastModified
    });
  }

  /** Drop the cached entry. Called by `write()`, `clear()`, and `commitMigration()`. */
  function invalidateCache(): void {
    cache = null;
  }

  return {
    path() {
      return filePath;
    },

    async read() {
      // AC-12 memoized read. Compute the cheap fingerprint; on a HIT
      // return the cached parsed file without re-reading the primary.
      const fingerprint = await computeFingerprint();
      if (fingerprint !== null && cache !== null && cache.fingerprint === fingerprint) {
        return cache.file;
      }
      // MISS (fingerprint differs OR no fingerprint computable) — fall
      // through to the full pure parse, then cache it against the fresh
      // fingerprint. A `null` fingerprint (no stat) is never cached, so
      // the cache stays effectively disabled and can never serve stale.
      const file = await readPure();
      if (fingerprint !== null && file !== null) {
        cache = { fingerprint, file };
      } else {
        cache = null;
      }
      return file;
    },

    async readItemCount() {
      // Fast path: parse the sidecar (tens of bytes). We REQUIRE the
      // primary IndexFile to exist alongside it — a stale sidecar
      // surviving an interrupted clear() would otherwise hydrate a
      // phantom count after the actual index is gone.
      const primaryExists = await deps.io.exists(filePath);
      if (primaryExists && (await deps.io.exists(metaPath))) {
        try {
          const raw = await deps.io.readString(metaPath);
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === "object" && parsed !== null && "itemCount" in parsed) {
            const candidate = parsed.itemCount;
            if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
              return candidate;
            }
          }
        } catch {
          // Fall through to the legacy full-read path.
        }
      }
      // Legacy fallback: parse the full IndexFile once for installs that
      // wrote the index before the sidecar existed. Prime the sidecar in
      // passing so this expensive path is at most one-shot per install.
      const file = await (async (): Promise<IndexFile | null> => {
        const primary = await tryReadParsed(filePath);
        if (primary !== null) return primary;
        if (filePath === legacyFilePath || !isLegacyEligible()) return null;
        return tryReadParsed(legacyFilePath);
      })();
      if (file === null) return 0;
      const itemCount = Object.keys(file.items).length;
      if (itemCount > 0) {
        try {
          const meta: IndexMeta = { itemCount, indexedAt: file.indexedAt };
          await deps.io.writeString(metaPath, JSON.stringify(meta));
        } catch {
          // Best-effort prime — failure just means next call retries.
        }
      }
      return itemCount;
    },

    async readWithMigration() {
      // `read()` stays pure — reuse it verbatim, then layer the
      // migration-pending detection on top. A corrupt primary makes
      // `read()` return null; `migrationPending` then falls back to the
      // marker check (and the `?? 1 < 2` legacy default), so a corrupt
      // file is never silently overwritten here.
      const file = await readPure();
      const markerPresent = await deps.io.exists(markerPath);
      const schemaVersion = file?.schemaVersion ?? 1;
      const migrationPending = markerPresent || schemaVersion < CURRENT_SCHEMA_VERSION;
      return { file, migrationPending };
    },

    async writeTmp(file) {
      // Write to the sidecar `.tmp` only — the primary is untouched
      // until `commitMigration` performs the atomic rename.
      await deps.io.writeString(tmpPath, JSON.stringify(file));
    },

    async commitMigration() {
      // Atomic swap: the rename is the ONLY mutation of the primary, so
      // a concurrent `read()` always sees either the fully-old or the
      // fully-new file. A rename throws (ENOENT) when no `.tmp` exists —
      // that surfaces to the caller WITHOUT touching the primary.
      await deps.io.rename(tmpPath, filePath);
      // AC-12 / FINDING-1: an atomic rename over the primary makes the
      // cached entry unconditionally stale. Drop it directly — exactly
      // as `write()` and `clear()` do — rather than relying on the
      // fingerprint to catch the swap. The fingerprint's primary-stat
      // component normally catches it, but a stat that lacks a reliable
      // `lastModified` token cannot, and a migrated file may share the
      // cached file's byte size. The direct invalidation is the belt;
      // the fingerprint is the suspenders.
      invalidateCache();
      await removeMarkerImpl();
    },

    async abandonMigration() {
      // Remove a stale `.tmp` left by a previous crash. Idempotent — a
      // no-op when absent. The marker is deliberately preserved so the
      // next launch still knows a migration is pending.
      if (await deps.io.exists(tmpPath)) {
        try {
          await deps.io.remove(tmpPath);
        } catch {
          // The file may have vanished between the exists check and the
          // remove call; the post-condition (no `.tmp`) still holds.
        }
      }
    },

    async writeMarker() {
      // Advisory contents only — an ISO timestamp. The marker's
      // EXISTENCE is the signal; the body is for human diagnostics.
      // Idempotent: a plain overwrite, never an error when it exists.
      await deps.io.writeString(markerPath, new Date().toISOString());
    },

    removeMarker() {
      return removeMarkerImpl();
    },

    hasMarker() {
      return deps.io.exists(markerPath);
    },

    async write(file) {
      // AC-12: drop the cached entry directly so a same-process
      // re-index is immediately consistent without waiting on a
      // fingerprint recompute. (The meta-sidecar rewrite below would
      // also change the fingerprint, but the direct drop is the belt.)
      invalidateCache();
      const serialized = JSON.stringify(file);
      await deps.io.writeString(filePath, serialized);
      // Sidecar is best-effort: a failure here just means the next
      // `readItemCount()` falls back to the full-file path. Don't surface
      // the error to the caller — the index itself is already persisted.
      try {
        const meta: IndexMeta = {
          itemCount: Object.keys(file.items).length,
          indexedAt: file.indexedAt
        };
        await deps.io.writeString(metaPath, JSON.stringify(meta));
      } catch {
        // ignore
      }
    },

    async clear() {
      // FINDING-4: clear ALL four index artefacts — the primary, the
      // `.meta.json` sidecar, the migration `.tmp`, AND the `.migrating`
      // marker. Leaving the `.tmp` behind would let a later
      // `commitMigration` rename it over the (now cleared) primary,
      // undoing the clear; leaving the marker behind would re-trigger
      // migration on the next launch against an index the user removed.
      // Each removal is independently guarded so one ENOENT does not
      // abort the rest.
      //
      // AC-12: drop the cached entry directly so a `read()` after a
      // `clear()` returns `null` immediately — never a stale hit.
      invalidateCache();
      const removeIfPresent = async (path: string): Promise<void> => {
        if (await deps.io.exists(path)) {
          try {
            await deps.io.remove(path);
          } catch {
            // The file may have vanished between the exists check and
            // the remove call; the post-condition (absent) still holds.
          }
        }
      };
      await removeIfPresent(filePath);
      await removeIfPresent(metaPath);
      await removeIfPresent(tmpPath);
      await removeIfPresent(markerPath);
    }
  };
}
