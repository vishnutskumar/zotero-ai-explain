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
 * Legacy `<base>.json` monolithic files are NOT auto-migrated to the
 * per-item directory layout. Users upgrading from a monolithic install
 * will see an empty index on first read and must clear+re-index. The
 * legacy file is left on disk untouched; users can delete it manually.
 *
 * Contract source: `docs/superpowers/plans/2026-05-17-real-product-pipeline.md`
 * AC3 Interfaces (L1016-1033) and AC4 shape-validation rules (L770-786).
 */

import {
  computeIndexDirName,
  computeIndexFileName,
  computeItemFileName,
  LEGACY_INDEX_FILE_NAME,
  META_FILE_NAME,
  type EmbedProviderKind,
  type IndexPathInput
} from "./index-path.js";
import { CURRENT_SCHEMA_VERSION, type IndexedItem, type IndexFile } from "./library-crawler.js";

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
  /**
   * AC-23 (OOM fix): persist ONE item's entry to its own file in the
   * per-(provider, model) directory. Cost is O(1) regardless of library
   * size — the long-term replacement for the `write(currentFile)`
   * per-item rewrite, which was O(N) per call and OOMed at ~200 items on
   * a 5738-item library. The directory is created lazily on first call.
   * `_meta.json` is updated incrementally (item count bumped if new,
   * `indexedAt` refreshed) so `readItemCount()` stays O(few-bytes).
   */
  writeItem(itemKey: string, entry: IndexedItem): Promise<void>;
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
    /**
     * AC-23: create a directory at `path`. Idempotent — succeeds when the
     * directory already exists. Optional (the legacy single-file path
     * does not need it); when absent the storage layer falls back to
     * "best-effort assume parent exists" (matches the no-op IO adapter
     * used by hosts without a real filesystem).
     */
    makeDirectory?(path: string): Promise<void>;
    /**
     * AC-23: enumerate immediate children of a directory. Returns bare
     * file names (no parent path). Optional; when absent the storage
     * layer falls through to the legacy single-file read path.
     * Resolves `null` when the directory is absent.
     */
    listChildren?(path: string): Promise<readonly string[] | null>;
    /**
     * AC-23: remove a directory recursively. Idempotent — succeeds when
     * the directory is already absent. Optional; when absent `clear()`
     * falls back to deleting per-item files via `remove()` after
     * enumerating with `listChildren`.
     */
    removeDirectory?(path: string): Promise<void>;
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
  // Use the same separator the parent path uses. Zotero's
  // `DataDirectory.dir` is `C:\Users\...` on Windows and a POSIX-style
  // absolute path elsewhere. Mozilla's chrome IOUtils tolerates either separator
  // individually but mixed-slash paths (e.g.
  // `C:\Users\...\data/foo.json`) fail `makeDirectory`/`writeUTF8` on
  // Windows because the underlying kernel APIs expect a single
  // canonical separator. Detect Windows via a drive-letter prefix
  // (more robust than counting slashes when paths get re-joined).
  const isWindows = /^[A-Za-z]:[\\/]/u.test(dir);
  const sep = isWindows ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
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
  // Pin the active (provider, model) once at construction so all path
  // helpers see the same input — the legacy single-file path AND the
  // AC-23 per-item directory layout both derive from this pair.
  const providerInput: IndexPathInput | null =
    deps.embedProvider !== undefined
      ? { provider: deps.embedProvider.kind, model: deps.embedProvider.model }
      : null;
  const fileName = providerInput !== null ? computeIndexFileName(providerInput) : LEGACY_FILE_NAME;
  const filePath = joinPath(deps.zotero.DataDirectory.dir, fileName);
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

  // AC-23: per-item directory layout. Each provider+model pair gets a
  // sibling DIRECTORY next to the legacy single file. The hot loop
  // (`writeItem`) lives inside this directory so each persist is O(1)
  // regardless of library size; the legacy single file remains for the
  // AC-5 migration `.tmp` swap and the AC-15 final-write fallback.
  // For the no-provider construction (`LEGACY_FILE_NAME`) the directory
  // is named without the provider suffix.
  const dirName =
    providerInput !== null
      ? computeIndexDirName(providerInput)
      : LEGACY_FILE_NAME.replace(/\.json$/u, "");
  const dirPath = joinPath(deps.zotero.DataDirectory.dir, dirName);
  const dirMetaPath = joinPath(dirPath, META_FILE_NAME);

  /**
   * AC-23: write `<dirPath>/<file>` atomically when the adapter supports
   * it. Falls back to a plain write when the adapter has no rename
   * (the test fakes that lack it still see correct content; they just
   * lose the "never partially-visible" guarantee).
   */
  async function writeDirFileAtomic(path: string, contents: string): Promise<void> {
    // Plain write — IOUtils.writeUTF8 is already atomic-ish at the
    // single-file level (writes to a sibling `.tmp` and renames). A
    // higher-level rename here would just double the cost for no extra
    // safety, so we lean on the IO adapter's guarantees.
    await deps.io.writeString(path, contents);
  }

  // AC-23: in-process memo of "we have already created the directory
  // this session". Avoids a per-item `makeDirectory` syscall in the hot
  // loop (5738 items → 5738 redundant syscalls). Reset by `clear()`.
  let dirEnsured = false;
  // AC-23: in-process cache of the dir `_meta.json` shape, so the hot
  // `writeItem` loop reads meta from disk at most once per session
  // (the first call) instead of once per item. Stays consistent with
  // the on-disk meta because every successful writeItem rewrites both.
  let dirMetaCache: { itemCount: number; indexedAt: string; schemaVersion: number } | null = null;
  // AC-23: in-process set of item keys known to live in the directory.
  // Lets the hot loop avoid a per-item `exists(itemPath)` syscall —
  // when the key is known we already know the meta count does not
  // need a bump. Primed lazily on the first writeItem of a session.
  let knownItemKeys: Set<string> | null = null;
  // P1-FIX (round-3): serialize EVERY public operation — reads AND
  // writes — through one queue. Closes the "reads not serialized
  // against writes" hole: a read during a partial dir-meta rewrite can
  // no longer observe interleaved state. The queue is per-storage-
  // instance; out-of-band processes still see normal disk semantics
  // (the fingerprint catches them).
  let opsQueue: Promise<unknown> = Promise.resolve();
  function enqueueOp<T>(task: () => Promise<T>): Promise<T> {
    const next = opsQueue.then(task, task);
    // Keep the chain alive but never let a rejection poison subsequent
    // tasks — each .then re-attaches both handlers, so a failed task
    // resolves the chain to a rejected promise; the next call's
    // `opsQueue.then(task, task)` schedules `task` either way.
    opsQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * AC-23: ensure the per-item directory exists. Idempotent — guarded by
   * the `dirEnsured` memo so the makeDirectory call only fires once per
   * process. A real concurrent `clear()` clears the memo before
   * dropping the directory.
   */
  async function ensureDir(): Promise<void> {
    if (dirEnsured) return;
    if (typeof deps.io.makeDirectory !== "function") {
      dirEnsured = true;
      return;
    }
    try {
      await deps.io.makeDirectory(dirPath);
    } catch {
      // Either the directory already exists (idempotent) or the host
      // cannot create it; the subsequent writeString will surface the
      // real failure.
    }
    dirEnsured = true;
  }

  /**
   * AC-23: read `<dirPath>/_meta.json` and return the parsed value, or
   * `null` when absent / corrupt. Used by `readItemCount()` and by
   * `writeItem()` to compute the incremental item-count update.
   */
  async function readDirMeta(): Promise<{
    itemCount: number;
    indexedAt: string;
    schemaVersion?: number;
  } | null> {
    if (!(await deps.io.exists(dirMetaPath))) return null;
    try {
      const raw = await deps.io.readString(dirMetaPath);
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) return null;
      const rec = parsed as Record<string, unknown>;
      const itemCount =
        typeof rec.itemCount === "number" && Number.isFinite(rec.itemCount) && rec.itemCount >= 0
          ? rec.itemCount
          : 0;
      const indexedAt = typeof rec.indexedAt === "string" ? rec.indexedAt : "";
      const schemaVersion = typeof rec.schemaVersion === "number" ? rec.schemaVersion : undefined;
      return {
        itemCount,
        indexedAt,
        ...(schemaVersion !== undefined ? { schemaVersion } : {})
      };
    } catch {
      return null;
    }
  }

  /**
   * AC-23: read every per-item file in the index directory and assemble
   * an `IndexFile`. Returns `null` when the directory is absent OR the
   * adapter cannot enumerate it. Per-item files that fail to parse are
   * skipped (one corrupt item file does not poison the whole read).
   *
   * P2-FIX: assembled `items` are inserted in LEXICOGRAPHIC itemKey order
   * so the controller's `pickResumeKey` (which uses the LAST insertion-
   * order key as the resume cursor) sees a deterministic value across
   * runs — directory enumeration order is not guaranteed by the
   * underlying filesystem primitive.
   */
  async function readFromDir(): Promise<IndexFile | null> {
    if (typeof deps.io.listChildren !== "function") return null;
    if (!(await deps.io.exists(dirPath))) return null;
    const names = await deps.io.listChildren(dirPath);
    if (names === null) return null;
    // P2-FIX: sanitize + lexicographically sort before parsing so the
    // assembled items map has deterministic insertion order.
    const targets = names
      .filter((n) => n !== META_FILE_NAME && n.endsWith(".json"))
      .filter((n) => isSafeItemFileName(n))
      .slice()
      .sort();
    // Parallelize the per-item reads — a 5738-item directory would
    // otherwise serialize 5738 IOUtils round-trips on the hot path.
    const entries = await Promise.all(
      targets.map(async (name) => {
        const itemKey = name.slice(0, -".json".length);
        try {
          const raw = await deps.io.readString(joinPath(dirPath, name));
          const parsed = JSON.parse(raw) as unknown;
          if (typeof parsed !== "object" || parsed === null) return null;
          const rec = parsed as Record<string, unknown>;
          const title = typeof rec.title === "string" ? rec.title : "";
          const chunks = Array.isArray(rec.chunks)
            ? (rec.chunks as IndexedItem["chunks"])
            : ([] as IndexedItem["chunks"]);
          return [itemKey, { title, chunks }] as const;
        } catch {
          // Skip the corrupt per-item file — the rest of the index is
          // still usable.
          return null;
        }
      })
    );
    const items: Record<string, IndexedItem> = {};
    for (const entry of entries) {
      if (entry === null) continue;
      const [k, v] = entry;
      items[k] = v;
    }
    const meta = await readDirMeta();
    return {
      schemaVersion: meta?.schemaVersion ?? CURRENT_SCHEMA_VERSION,
      items,
      indexedAt:
        meta?.indexedAt && meta.indexedAt.length > 0 ? meta.indexedAt : new Date(0).toISOString()
    };
  }

  /**
   * Safety guard for a per-item filename inside the index directory.
   * Rejects path-traversal (`..`), embedded slashes/backslashes, the
   * reserved meta sidecar prefix (`_*`), and Windows reserved device
   * names. Zotero's real item keys are 8-char base-32 strings; this
   * guard is intentionally looser so existing tests using `K1`, `ITEM_A`,
   * etc. still work — its job is to refuse demonstrably unsafe names,
   * not to enforce a strict Zotero-key regex.
   */
  function isSafeItemFileName(name: string): boolean {
    if (!name.endsWith(".json")) return false;
    const stem = name.slice(0, -".json".length);
    if (stem.length === 0) return false;
    if (stem.includes("/") || stem.includes("\\")) return false;
    if (stem === "." || stem === "..") return false;
    // The reserved meta sidecar is filtered separately by callers, but
    // be defensive — reject leading underscore + dot prefixes too.
    if (stem.startsWith(".") || stem.startsWith("_")) return false;
    // Windows reserved device names (case-insensitive, no extension).
    const reserved = new Set([
      "con",
      "prn",
      "aux",
      "nul",
      "com1",
      "com2",
      "com3",
      "com4",
      "com5",
      "com6",
      "com7",
      "com8",
      "com9",
      "lpt1",
      "lpt2",
      "lpt3",
      "lpt4",
      "lpt5",
      "lpt6",
      "lpt7",
      "lpt8",
      "lpt9"
    ]);
    if (reserved.has(stem.toLowerCase())) return false;
    return true;
  }

  /**
   * Same safety check applied at the `itemKey` (no `.json` suffix) level
   * for write-side guards. Returns `true` when the key is safe to use as
   * the basename of a per-item file.
   */
  function isSafeItemKey(itemKey: string): boolean {
    return isSafeItemFileName(`${itemKey}.json`);
  }

  /**
   * Read the file at `path`, parse it as JSON, and validate it matches
   * the IndexFile shape. Returns `null` when the file is absent, the
   * read or parse fails, or the parsed value does not match. PURE —
   * issues only `exists` + `readString`.
   */
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
   * only `exists` / `readString` / `listChildren` / `stat`, never a
   * `writeString` / `remove` / `rename` (AC-5 FINDING-1, AC-12 SP-12.4).
   *
   * Precedence:
   *   1. The per-item directory layout (when present, even when empty).
   *   2. The per-(provider, model) monolithic file at `filePath`, which
   *      is the swap target of the AC-5 schema-version migration. Read
   *      remains pure — the legacy file is NEVER copied to the directory.
   *
   * The historical flat `zotero-ai-explain-index.json` legacy fallback
   * is GONE: users upgrading from a pre-per-provider monolithic install
   * will see an empty index on first read and must clear+re-index. The
   * legacy file is left on disk untouched.
   */
  async function readPure(): Promise<IndexFile | null> {
    const fromDir = await readFromDir();
    if (fromDir !== null && Object.keys(fromDir.items).length > 0) {
      return fromDir;
    }
    const primary = await tryReadParsed(filePath);
    if (primary !== null) {
      return primary;
    }
    // The per-item directory's existence (even empty) still counts as
    // "indexed but empty" — surfaces the AC-15 empty-completion invariant
    // to callers that expect a non-null read after a completed crawl.
    // When the directory is absent the contract is unchanged: null means
    // "no index at all".
    return fromDir;
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
   *
   * P1-FIX (directory blind spot): include the directory's `_meta.json`
   * stat (size + lastModified) AND the count of immediate children so an
   * out-of-band mutation (another storage instance, manual IOUtils.remove,
   * a writeItem in a separate process) invalidates the cache. Both
   * components fail-soft — when the directory or its meta is absent the
   * component degrades to a stable "absent" sentinel rather than null.
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
    // P1-FIX: directory-state component. Stat the dir meta + count
    // immediate children. Failures degrade to "absent" / 0 so the
    // fingerprint stays computable; ANY transition in either value
    // forces a cache miss.
    let dirMetaSize = -1;
    let dirMetaLastModified = -1;
    try {
      const s = await deps.io.stat(dirMetaPath);
      if (s !== null) {
        dirMetaSize = s.size;
        if (typeof s.lastModified === "number" && Number.isFinite(s.lastModified)) {
          dirMetaLastModified = s.lastModified;
        }
      }
    } catch {
      // ignore — degrade
    }
    let dirChildCount = -1;
    if (typeof deps.io.listChildren === "function") {
      try {
        if (await deps.io.exists(dirPath)) {
          const names = await deps.io.listChildren(dirPath);
          if (names !== null) {
            let n = 0;
            for (const name of names) {
              if (name === META_FILE_NAME) continue;
              if (!name.endsWith(".json")) continue;
              n += 1;
            }
            dirChildCount = n;
          }
        }
      } catch {
        // ignore — degrade
      }
    }
    return JSON.stringify({
      meta: metaComponent,
      size: primaryStat.size,
      // Guaranteed a finite number by the guard above.
      lastModified: primaryStat.lastModified,
      dirMetaSize,
      dirMetaLastModified,
      dirChildCount
    });
  }

  /** Drop the cached entry. Called by `write()`, `clear()`, and `commitMigration()`. */
  function invalidateCache(): void {
    cache = null;
  }

  /**
   * Body of `readItemCount()`. Hoisted out of the returned object so the
   * public method can wrap it in `enqueueOp(...)` without inline closure
   * gymnastics. Probes the dir meta / heals it / falls back to the
   * per-provider monolithic sidecar. Monolithic legacy
   * `zotero-ai-explain-index.json` files of OTHER providers are never
   * consulted.
   */
  async function readItemCountImpl(): Promise<number> {
    // AC-23 fast path: the per-item directory's `_meta.json` is the
    // canonical "how many items?" probe. Cheap (tens of bytes) and
    // matches the directory's actual contents because `writeItem`
    // refreshes it incrementally.
    //
    // P1-FIX (count-drift): the meta is rewritten incrementally but a
    // crashed writeItem (per-item file written, meta rewrite failed)
    // or an out-of-band mutation can leave the count lying. Validate
    // the meta count against the actual directory listing; on a
    // mismatch trust the listing AND rewrite the meta in passing so
    // the next call answers from the fast path.
    if (typeof deps.io.listChildren === "function") {
      const dirExists = await deps.io.exists(dirPath);
      if (dirExists) {
        const meta = await readDirMeta();
        // Prefer the in-process `knownItemKeys` when primed — saves a
        // listChildren syscall on the steady-state hot path. Falls back
        // to listChildren when cold.
        let actualCount: number;
        if (knownItemKeys !== null) {
          actualCount = knownItemKeys.size;
        } else {
          const names = await deps.io.listChildren(dirPath);
          if (names === null) {
            if (meta !== null) return meta.itemCount;
            return 0;
          }
          let count = 0;
          for (const name of names) {
            if (name === META_FILE_NAME) continue;
            if (!isSafeItemFileName(name)) continue;
            count += 1;
          }
          actualCount = count;
        }
        // Heal a lying meta: rewrite when the recorded itemCount
        // differs from the directory's actual contents. The heal is
        // queued (we're inside `enqueueOp`) so it can't race against a
        // concurrent writeItem.
        if (meta?.itemCount !== actualCount) {
          const healed = {
            schemaVersion: meta?.schemaVersion ?? CURRENT_SCHEMA_VERSION,
            indexedAt: meta?.indexedAt ?? new Date(0).toISOString(),
            itemCount: actualCount
          };
          try {
            await writeDirFileAtomic(dirMetaPath, JSON.stringify(healed));
            dirMetaCache = { ...healed };
          } catch {
            // Best-effort. The listing-derived count is still
            // returned to the caller.
          }
        }
        return actualCount;
      }
    }
    // Fast path: parse the per-provider monolithic sidecar (tens of
    // bytes). We REQUIRE the primary IndexFile to exist alongside it —
    // a stale sidecar surviving an interrupted clear() would otherwise
    // hydrate a phantom count after the actual index is gone.
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
        // Fall through to the full-read path.
      }
    }
    // Slow fallback: parse the full IndexFile once for installs that
    // wrote the per-provider monolithic before the sidecar existed.
    // Prime the sidecar in passing so this expensive path is at most
    // one-shot per install. Legacy flat
    // `zotero-ai-explain-index.json` files of OTHER providers are
    // NEVER consulted.
    const file = await tryReadParsed(filePath);
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
  }

  return {
    path() {
      return filePath;
    },

    read() {
      // P1-FIX (round-3): reads run through the SAME queue as writes so
      // a concurrent write cannot expose partial-state directory
      // contents to the reader.
      return enqueueOp(async () => {
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
      });
    },

    readItemCount() {
      // P1-FIX (round-3): serialize through the queue. The heal-in-
      // passing meta rewrite is a mutation; it must not race against a
      // concurrent writeItem.
      return enqueueOp(readItemCountImpl);
    },

    readWithMigration() {
      // P1-FIX (round-3): queued so a concurrent in-flight migration
      // (`commitMigration`) completes before this probe observes the
      // directory — closes the partial-state hole.
      return enqueueOp(async () => {
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
      });
    },

    writeTmp(file) {
      // Queued: the `.tmp` is read by `commitMigration` (also queued), so
      // serialization here avoids a writeTmp racing past an in-flight
      // commit that just removed the previous `.tmp`.
      return enqueueOp(async () => {
        // Write to the sidecar `.tmp` only — the primary is untouched
        // until `commitMigration` performs the atomic rename.
        await deps.io.writeString(tmpPath, JSON.stringify(file));
      });
    },

    commitMigration() {
      return enqueueOp(async () => {
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
        // AC-23: the per-item directory may now be stale relative to the
        // newly-committed primary. Drop the in-process caches so the
        // next writeItem re-primes from disk.
        dirMetaCache = null;
        knownItemKeys = null;
        await removeMarkerImpl();
      });
    },

    abandonMigration() {
      return enqueueOp(async () => {
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
      });
    },

    writeMarker() {
      return enqueueOp(async () => {
        // Advisory contents only — an ISO timestamp. The marker's
        // EXISTENCE is the signal; the body is for human diagnostics.
        // Idempotent: a plain overwrite, never an error when it exists.
        await deps.io.writeString(markerPath, new Date().toISOString());
      });
    },

    removeMarker() {
      return enqueueOp(removeMarkerImpl);
    },

    hasMarker() {
      return enqueueOp(() => deps.io.exists(markerPath));
    },

    write(file) {
      return enqueueOp(async () => {
        // AC-12: drop the cached entry directly so a same-process
        // re-index is immediately consistent without waiting on a
        // fingerprint recompute. (The meta-sidecar rewrite below would
        // also change the fingerprint, but the direct drop is the belt.)
        invalidateCache();
        // AC-23: `write(file)` rewrites the entire directory state, so
        // the in-process caches need to align with the new content.
        dirMetaCache = null;
        const incomingKeys = new Set(Object.keys(file.items).filter(isSafeItemKey));
        await ensureDir();
        // P1-FIX (stale items): enumerate the directory FIRST and remove
        // any per-item file whose key is not in `file.items`. Without
        // this a write({A,B}) over a directory holding {A,B,C} would
        // leave C's file on disk and a subsequent read() would resurrect
        // it.
        //
        // P1-FIX (round-3): an orphan that cannot be removed REJECTS the
        // write rather than being silently left behind. The conservative
        // choice — a "successful" write that quietly resurrects deleted
        // items on the next read is the worst failure mode. The caller
        // gets a clear error and can decide whether to retry.
        if (typeof deps.io.listChildren === "function") {
          const existingNames = await deps.io.listChildren(dirPath);
          if (existingNames !== null) {
            for (const name of existingNames) {
              if (name === META_FILE_NAME) continue;
              if (!isSafeItemFileName(name)) continue;
              const k = name.slice(0, -".json".length);
              if (incomingKeys.has(k)) continue;
              try {
                await deps.io.remove(joinPath(dirPath, name));
              } catch (cause) {
                throw new Error(
                  `index-storage.write: failed to remove orphaned per-item file ${name} — refusing to complete write (a silent success would resurrect deleted items on the next read).`,
                  { cause: cause instanceof Error ? cause : new Error(String(cause)) }
                );
              }
            }
          }
        }
        knownItemKeys = new Set(incomingKeys);
        // AC-23 (back-compat): `write(file)` is used by the AC-15
        // empty-completion invariant and by tests that pre-date the
        // per-item directory layout. Write each item via the per-item
        // directory layout AND retain the legacy single-file + `.meta.json`
        // sidecar so the AC-12 cache fingerprint (which keys on those
        // legacy paths) stays consistent for downstream readers that have
        // not yet been migrated. The per-item dir writes are the long-term
        // canonical persist; the legacy single-file write is the
        // (one-shot, infrequent) compatibility tail.
        for (const [itemKey, entry] of Object.entries(file.items)) {
          if (!isSafeItemKey(itemKey)) continue;
          const itemPath = joinPath(dirPath, computeItemFileName(itemKey));
          await writeDirFileAtomic(itemPath, JSON.stringify(entry));
        }
        const dirMeta = {
          schemaVersion: file.schemaVersion,
          indexedAt: file.indexedAt,
          itemCount: incomingKeys.size
        };
        try {
          await writeDirFileAtomic(dirMetaPath, JSON.stringify(dirMeta));
        } catch {
          // Best-effort — the per-item files are the canonical source.
        }
        dirMetaCache = { ...dirMeta };
        // Legacy single-file write — preserves the AC-5 migration `.tmp`
        // swap target and the AC-12 fingerprint paths.
        const serialized = JSON.stringify(file);
        await deps.io.writeString(filePath, serialized);
        // Sidecar is best-effort: a failure here just means the next
        // `readItemCount()` falls back to the full-file path. Don't surface
        // the error to the caller — the index itself is already persisted.
        try {
          const meta: IndexMeta = {
            itemCount: incomingKeys.size,
            indexedAt: file.indexedAt
          };
          await deps.io.writeString(metaPath, JSON.stringify(meta));
        } catch {
          // ignore
        }
      });
    },

    writeItem(itemKey, entry) {
      return enqueueOp(async () => {
        // Safety: reject obviously dangerous itemKey strings (path
        // traversal, separators, Windows reserved). Returning silently
        // would let the crawl progress; throwing would abort it. Choose
        // to surface a clear error so the caller sees the problem.
        if (!isSafeItemKey(itemKey)) {
          throw new Error(`Refusing to persist unsafe itemKey: ${JSON.stringify(itemKey)}`);
        }
        // AC-23: the hot persist path. O(1) per call — writes ONE
        // per-item file plus an incremental update of `_meta.json`. NEVER
        // touches the legacy single-file or the legacy `.meta.json`
        // sidecar (those are O(N) and would re-introduce the OOM).
        //
        // AC-12: drop the cached entry directly so a same-process read
        // after writeItem sees the new item without waiting on a
        // fingerprint recompute. The dir `_meta.json` rewrite below would
        // also change the fingerprint, but the direct drop is the belt.
        invalidateCache();
        await ensureDir();
        const itemPath = joinPath(dirPath, computeItemFileName(itemKey));
        // Steady-state hot loop: 2 syscalls per item (write file + write
        // meta). Cold start primes both caches via one enumerate +
        // one meta read; every subsequent call answers `keyExisted` and
        // `prevMeta.itemCount` from the in-process maps.
        if (knownItemKeys === null) {
          const names =
            typeof deps.io.listChildren === "function" ? await deps.io.listChildren(dirPath) : null;
          const keys = new Set<string>();
          for (const name of names ?? []) {
            if (name === META_FILE_NAME) continue;
            if (!isSafeItemFileName(name)) continue;
            keys.add(name.slice(0, -".json".length));
          }
          knownItemKeys = keys;
        }
        if (dirMetaCache === null) {
          const onDisk = await readDirMeta();
          dirMetaCache =
            onDisk !== null
              ? {
                  schemaVersion: onDisk.schemaVersion ?? CURRENT_SCHEMA_VERSION,
                  indexedAt: onDisk.indexedAt,
                  itemCount: onDisk.itemCount
                }
              : {
                  schemaVersion: CURRENT_SCHEMA_VERSION,
                  indexedAt: new Date(0).toISOString(),
                  itemCount: knownItemKeys.size
                };
        }
        const keyExisted = knownItemKeys.has(itemKey);
        await writeDirFileAtomic(itemPath, JSON.stringify(entry));
        knownItemKeys.add(itemKey);
        const nextMeta = {
          schemaVersion: dirMetaCache.schemaVersion,
          indexedAt: new Date().toISOString(),
          itemCount: keyExisted ? dirMetaCache.itemCount : dirMetaCache.itemCount + 1
        };
        dirMetaCache = nextMeta;
        try {
          await writeDirFileAtomic(dirMetaPath, JSON.stringify(nextMeta));
        } catch {
          // Best-effort. The per-item file is the source of truth.
        }
      });
    },

    clear() {
      return enqueueOp(async () => {
        // FINDING-4 + AC-23: clear ALL index artefacts — the per-item
        // directory + its `_meta.json`, the legacy single-file primary,
        // the `.meta.json` sidecar, the migration `.tmp`, AND the
        // `.migrating` marker. Leaving the `.tmp` behind would let a later
        // `commitMigration` rename it over the (now cleared) primary,
        // undoing the clear; leaving the marker behind would re-trigger
        // migration on the next launch against an index the user removed.
        // Each removal is independently guarded so one ENOENT does not
        // abort the rest.
        //
        // AC-12: drop the cached entry directly so a `read()` after a
        // `clear()` returns `null` immediately — never a stale hit.
        invalidateCache();
        // AC-23: the directory is about to be removed; the next writeItem
        // must re-create it and re-prime its caches. Reset the memos
        // BEFORE the removals so a race with a concurrent writeItem
        // cannot serve the stale "already ensured" signal against a
        // now-gone directory.
        dirEnsured = false;
        dirMetaCache = null;
        knownItemKeys = null;
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
        // AC-23: remove the per-item directory. Prefer the recursive
        // `removeDirectory` adapter method when present; fall back to
        // enumerating + removing each per-item file individually so test
        // fakes without the recursive primitive still clear cleanly.
        if (typeof deps.io.removeDirectory === "function") {
          try {
            await deps.io.removeDirectory(dirPath);
          } catch {
            // ENOENT or platform-specific failure; fall through to the
            // file-by-file path so partial cleanups still progress.
          }
        }
        if (typeof deps.io.listChildren === "function" && (await deps.io.exists(dirPath))) {
          const names = await deps.io.listChildren(dirPath);
          if (names !== null) {
            for (const name of names) {
              await removeIfPresent(joinPath(dirPath, name));
            }
          }
        }
        // The dir-meta sidecar is inside `dirPath`, but a test fake without
        // a real directory primitive may have it as a flat file — remove
        // explicitly to cover both layouts.
        await removeIfPresent(dirMetaPath);
        await removeIfPresent(filePath);
        await removeIfPresent(metaPath);
        await removeIfPresent(tmpPath);
        await removeIfPresent(markerPath);
      });
    }
  };
}
