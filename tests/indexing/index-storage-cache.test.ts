/**
 * Adversarial unit tests for AC-12 — the memoized in-memory index cache
 * inside `createIndexStorage`.
 *
 * Plan: `docs/superpowers/plans/2026-05-19-pdf-context-features.md`
 *   AC-12 description          L677-728 (Adv-1 .. Adv-8)
 *   AC-12 interface contract   L1166-1216
 *
 * --------------------------------------------------------------------
 * Fault Localization (Template 4 — AC-12 memoized read)
 * --------------------------------------------------------------------
 *
 * 1. Spec semantics (premises):
 *    P1.  `CreateIndexStorageDeps.io` gains `stat(path)` →
 *         `Promise<IndexFileStat | null>`. `IndexFileStat` carries a
 *         required `size: number` and optional `lastModified?: number`.
 *         `stat` resolves `null` when the file is absent OR the adapter
 *         cannot stat (the no-op adapter always resolves `null`).
 *    P2.  `read()` keeps its `Promise<IndexFile | null>` signature AND
 *         its AC-5 purity contract: only `exists` / `readString` /
 *         `stat` — NEVER `writeString` / `remove` / `rename`.
 *    P3.  Each `read()` computes a fingerprint = the pair
 *         (`<index>.meta.json` contents OR the "absent" sentinel,
 *          `io.stat(<index>.json)` size+lastModified OR the
 *          "unstattable" sentinel).
 *    P4.  Cache HIT — fingerprint equals the cached fingerprint →
 *         `read()` returns the cached parsed `IndexFile` WITHOUT a
 *         `readString` of the (71MB) primary and WITHOUT a JSON.parse.
 *    P5.  Cache MISS — fingerprint differs OR no fingerprint can be
 *         computed (stat returns null) → `read()` falls through to the
 *         existing `readPure()`, stores the result against the new
 *         fingerprint, and returns it.
 *    P6.  `write()` rewrites `<index>.meta.json` (a new `indexedAt`), so
 *         the meta component of the fingerprint changes → the next
 *         `read()` is a MISS. `write()` ALSO drops the cached entry
 *         directly so a same-process re-index is immediately consistent.
 *    P7.  `commitMigration()` renames the primary but does NOT refresh
 *         `<index>.meta.json` (SP-12.2). The primary-file `stat`
 *         component of the fingerprint catches the swap → MISS. A
 *         meta-sidecar-only fingerprint would FAIL this case.
 *    P8.  `clear()` drops the cached entry → the next `read()` returns
 *         `null` (the index is gone), never a stale hit.
 *    P9.  No-stat adapter (`io.stat` always `null`) → no fingerprint is
 *         ever computable → every `read()` is a MISS (cache disabled).
 *         Correctness preserved: never a stale read, only the lost
 *         optimization.
 *    P10. A corrupt `<index>.meta.json` (malformed JSON) → the meta
 *         component degrades to the "absent" sentinel; `read()` never
 *         throws and never serves stale.
 *
 * 2. Code path trace (against the contract — bodies NOT inspected):
 *    - `read()` → compute fingerprint (meta read + io.stat) → compare
 *      to cached fingerprint → HIT returns cached value; MISS calls
 *      `readPure()` (exists + readString + parse), caches, returns.
 *    - `write()` / `clear()` → invalidate the cached entry directly.
 *
 * 3. Divergence analysis (likely bugs the tests target):
 *    D1 [HIGH]   cache HIT still issues a `readString` of the primary
 *                (no real memoization — the 71MB re-parse is not skipped).
 *    D2 [HIGH]   fingerprint keyed ONLY on the meta sidecar → a
 *                `commitMigration` swap (meta untouched) is missed and
 *                `read()` returns the STALE pre-migration file.
 *    D3 [HIGH]   `write()` does not invalidate → a same-process
 *                re-index then `read()` returns the OLD file.
 *    D4 [HIGH]   `clear()` does not invalidate → `read()` after a clear
 *                returns the cleared-away file instead of `null`.
 *    D5 [HIGH]   no-stat adapter serves a stale cache hit (the cache is
 *                NOT disabled when no fingerprint is computable).
 *    D6 [MEDIUM] `read()` issues a `writeString` / `remove` / `rename`
 *                (purity broken — the cache added a mutation).
 *    D7 [MEDIUM] corrupt meta JSON makes `read()` throw instead of
 *                degrading to a full `readPure()`.
 *    D8 [LOW]    a re-index that changes ONLY the primary stat (meta
 *                also rewritten) still serves the old cache.
 *
 * 4. Test targets (ranked): D1 (memoization) > D2 (migration-swap) >
 *    D3/D4 (write/clear invalidate) > D5 (no-stat disables) >
 *    D6 (purity) > D7 (corrupt meta) > D8.
 *
 * --------------------------------------------------------------------
 * COMPILE NOTE: this file depends on the AC-12 widening of
 * `CreateIndexStorageDeps.io` with `stat(path): Promise<IndexFileStat |
 * null>` and the exported `IndexFileStat` type. Until the implementer
 * lands these the file fails to COMPILE. The test SOURCE is the
 * authority on the contract (plan L1166-1216).
 * --------------------------------------------------------------------
 */

import { describe, expect, it } from "vitest";

import {
  createIndexStorage,
  type CreateIndexStorageDeps,
  type IndexFileStat,
  type IndexStorage
} from "../../src/indexing/index-storage.js";
import { CURRENT_SCHEMA_VERSION, type IndexFile } from "../../src/indexing/library-crawler.js";

const DATA_DIR = "/var/test-fixture/zotero-data";
const PRIMARY = `${DATA_DIR}/zotero-ai-explain-index.json`;
const META = `${DATA_DIR}/zotero-ai-explain-index.meta.json`;
const TMP = `${PRIMARY}.tmp`;

// --------------------------------------------------------------------
// Instrumented in-memory IO adapter. Records EVERY call so a cache HIT
// (which must skip the primary readString) is observable. The `stat`
// method is the AC-12 addition: it returns size + lastModified for a
// present file, `null` for an absent one.
//
// `lastModified` is bumped on every writeString / rename so two
// distinct on-disk states never share a fingerprint by accident.
// --------------------------------------------------------------------

type FileEntry = { readonly contents: string; readonly lastModified: number };

type SpyFs = {
  readonly io: CreateIndexStorageDeps["io"];
  readonly files: Map<string, FileEntry>;
  /** Per-path call counts, keyed `<method>:<path>`. */
  readonly counts: Map<string, number>;
  /** Ordered op log: `<method>:<path>`. */
  readonly ops: string[];
  readableCount(path: string): number;
};

function makeSpyFs(initial: Record<string, string> = {}): SpyFs {
  const files = new Map<string, FileEntry>();
  let clock = 1000;
  for (const [p, contents] of Object.entries(initial)) {
    clock += 1;
    files.set(p, { contents, lastModified: clock });
  }
  const counts = new Map<string, number>();
  const ops: string[] = [];
  const tick = (method: string, path: string): void => {
    const key = `${method}:${path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    ops.push(key);
  };
  const io: CreateIndexStorageDeps["io"] = {
    async readString(p) {
      await Promise.resolve();
      tick("readString", p);
      const v = files.get(p);
      if (v === undefined) {
        throw new Error(`ENOENT: ${p}`);
      }
      return v.contents;
    },
    async writeString(p, contents) {
      await Promise.resolve();
      tick("writeString", p);
      clock += 1;
      files.set(p, { contents, lastModified: clock });
    },
    async remove(p) {
      await Promise.resolve();
      tick("remove", p);
      if (!files.has(p)) {
        throw new Error(`ENOENT: ${p}`);
      }
      files.delete(p);
    },
    async exists(p) {
      await Promise.resolve();
      tick("exists", p);
      return files.has(p);
    },
    async rename(src, dst) {
      await Promise.resolve();
      tick("rename", `${src}->${dst}`);
      const v = files.get(src);
      if (v === undefined) {
        throw new Error(`ENOENT: ${src}`);
      }
      clock += 1;
      files.set(dst, { contents: v.contents, lastModified: clock });
      files.delete(src);
    },
    async stat(p): Promise<IndexFileStat | null> {
      await Promise.resolve();
      tick("stat", p);
      const v = files.get(p);
      if (v === undefined) {
        return null;
      }
      return { size: v.contents.length, lastModified: v.lastModified };
    }
  };
  return {
    io,
    files,
    counts,
    ops,
    readableCount(path) {
      return counts.get(`readString:${path}`) ?? 0;
    }
  };
}

/**
 * A NO-OP `stat` adapter — `stat` always resolves `null` (the
 * `buildIndexStorageIo` fallback / a host that cannot stat). Every other
 * method behaves like the spy adapter. AC-12 P9: with no stat the cache
 * must degrade to "never cache" — correctness preserved, optimization
 * lost.
 */
function makeNoStatFs(initial: Record<string, string> = {}): SpyFs {
  const base = makeSpyFs(initial);
  const io: CreateIndexStorageDeps["io"] = {
    ...base.io,
    async stat(p): Promise<IndexFileStat | null> {
      await Promise.resolve();
      // Count the call so a test can confirm `read()` still PROBES stat
      // (the cache asks; the adapter just cannot answer).
      base.counts.set(`stat:${p}`, (base.counts.get(`stat:${p}`) ?? 0) + 1);
      base.ops.push(`stat:${p}`);
      return null;
    }
  };
  return { ...base, io };
}

/**
 * A SIZE-ONLY `stat` adapter — `stat` returns `{ size }` with NO
 * `lastModified`. This models a host whose platform / IO layer exposes
 * the byte size but not a reliable last-modified change token (codex S9
 * FINDING-1). A bare `size` is NOT a sound fingerprint: an atomic
 * `commitMigration` swap to a file of the SAME byte length would share
 * the fingerprint and serve a stale cache. The cache must therefore
 * treat a size-only stat exactly like the no-stat path (cache disabled).
 */
function makeSizeOnlyFs(initial: Record<string, string> = {}): SpyFs {
  const base = makeSpyFs(initial);
  const io: CreateIndexStorageDeps["io"] = {
    ...base.io,
    async stat(p): Promise<IndexFileStat | null> {
      const full = await base.io.stat(p);
      if (full === null) {
        return null;
      }
      // Drop `lastModified` — the host cannot supply a change token.
      return { size: full.size };
    }
  };
  return { ...base, io };
}

function makeStorage(fs: SpyFs): IndexStorage {
  const deps: CreateIndexStorageDeps = {
    zotero: { DataDirectory: { dir: DATA_DIR } },
    io: fs.io
  };
  return createIndexStorage(deps);
}

const LEGACY = `${DATA_DIR}/zotero-ai-explain-index.json`;

/** Storage configured for the historical (ollama, embeddinggemma) pairing. */
function makeOllamaStorage(fs: SpyFs): IndexStorage {
  const deps: CreateIndexStorageDeps = {
    zotero: { DataDirectory: { dir: DATA_DIR } },
    io: fs.io,
    embedProvider: { kind: "ollama", model: "embeddinggemma" }
  };
  return createIndexStorage(deps);
}

function indexFile(itemKey = "K1", title = "Paper One"): IndexFile {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    items: {
      [itemKey]: {
        title,
        chunks: [{ text: "chunk", embedding: [0.1, 0.2, 0.3], sourceKind: "metadata" }]
      }
    },
    indexedAt: "2026-05-22T00:00:00.000Z"
  };
}

/** A v2 file that the migration `.tmp` holds before commit. */
function migratedFile(): IndexFile {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    items: {
      MIG1: {
        title: "Migrated Paper",
        chunks: [
          {
            text: "migrated chunk",
            embedding: [0.4, 0.5, 0.6],
            sourceKind: "pdf-page",
            pageIndex: 0,
            attachmentKey: "ATTACH01"
          }
        ]
      }
    },
    indexedAt: "2026-05-22T11:00:00.000Z"
  };
}

function metaFor(file: IndexFile): string {
  return JSON.stringify({
    itemCount: Object.keys(file.items).length,
    indexedAt: file.indexedAt
  });
}

// ====================================================================
// Adv-1 — cache hit: a second read() skips the 71MB re-parse
// ====================================================================

describe("AC-12 Adv-1 — cache hit on an unchanged index", () => {
  it("a second read() with no intervening write/clear does NOT re-read the primary", async () => {
    const file = indexFile();
    const fs = makeSpyFs({
      [PRIMARY]: JSON.stringify(file),
      [META]: metaFor(file)
    });
    const storage = makeStorage(fs);

    const first = await storage.read();
    expect(first).toEqual(file);
    // The cold read parsed the primary exactly once.
    expect(fs.readableCount(PRIMARY)).toBe(1);

    const second = await storage.read();
    expect(second).toEqual(file);
    // D1: the HIT must NOT have re-read the 71MB primary — still 1.
    expect(fs.readableCount(PRIMARY)).toBe(1);
  });

  it("the cache hit still PROBES the fingerprint (meta read + io.stat of the primary)", async () => {
    const file = indexFile();
    const fs = makeSpyFs({
      [PRIMARY]: JSON.stringify(file),
      [META]: metaFor(file)
    });
    const storage = makeStorage(fs);

    await storage.read();
    const statBefore = fs.counts.get(`stat:${PRIMARY}`) ?? 0;
    await storage.read();
    const statAfter = fs.counts.get(`stat:${PRIMARY}`) ?? 0;

    // The second read computed a fresh fingerprint — io.stat fired again
    // (the fingerprint compute is cheap, the primary re-parse is not).
    expect(statAfter).toBeGreaterThan(statBefore);
  });

  it("repeated reads of an unchanged index all return deep-equal IndexFiles", async () => {
    const file = indexFile();
    const fs = makeSpyFs({
      [PRIMARY]: JSON.stringify(file),
      [META]: metaFor(file)
    });
    const storage = makeStorage(fs);

    const a = await storage.read();
    const b = await storage.read();
    const c = await storage.read();
    expect(a).toEqual(file);
    expect(b).toEqual(file);
    expect(c).toEqual(file);
    // Exactly one primary parse across all three reads.
    expect(fs.readableCount(PRIMARY)).toBe(1);
  });
});

// ====================================================================
// Adv-2 — cache invalidation on a normal re-index (meta fingerprint)
// ====================================================================

describe("AC-12 Adv-2 — invalidation when the meta fingerprint changes", () => {
  it("write() of a new file changes the meta sidecar → next read() re-parses the NEW file", async () => {
    const oldFile = indexFile("OLD", "Old Paper");
    const fs = makeSpyFs({
      [PRIMARY]: JSON.stringify(oldFile),
      [META]: metaFor(oldFile)
    });
    const storage = makeStorage(fs);

    const first = await storage.read();
    expect(first?.items.OLD).toBeDefined();
    expect(fs.readableCount(PRIMARY)).toBe(1);

    // A re-index rewrites the primary AND the meta sidecar.
    const newFile: IndexFile = {
      ...indexFile("NEW", "New Paper"),
      indexedAt: "2026-05-22T23:59:59.000Z"
    };
    await storage.write(newFile);

    const second = await storage.read();
    // D3: the second read must return the NEW file, never the stale one.
    expect(second?.items.NEW).toBeDefined();
    expect(second?.items.OLD).toBeUndefined();
  });

  it("an external meta-sidecar rewrite (different indexedAt) invalidates the cache", async () => {
    // The meta fingerprint component is the sidecar CONTENTS — a sidecar
    // whose `indexedAt` changed is a different fingerprint even if the
    // item count is identical.
    const file = indexFile();
    const fs = makeSpyFs({
      [PRIMARY]: JSON.stringify(file),
      [META]: metaFor(file)
    });
    const storage = makeStorage(fs);
    await storage.read();
    expect(fs.readableCount(PRIMARY)).toBe(1);

    // Simulate another process rewriting both files (same item key,
    // different content + a new indexedAt).
    const refreshed: IndexFile = {
      ...indexFile("K1", "Paper One v2"),
      indexedAt: "2099-01-01T00:00:00.000Z"
    };
    await fs.io.writeString(PRIMARY, JSON.stringify(refreshed));
    await fs.io.writeString(META, metaFor(refreshed));

    const second = await storage.read();
    expect(second?.items.K1?.title).toBe("Paper One v2");
    // The fingerprint changed → the primary was re-parsed.
    expect(fs.readableCount(PRIMARY)).toBe(2);
  });
});

// ====================================================================
// Adv-3 — cache invalidation on a migration commit (SP-12.2)
//
// commitMigration renames the .tmp over the primary but does NOT touch
// the meta sidecar. A meta-only fingerprint would MISS this — the
// primary-file `stat` component must catch it.
// ====================================================================

describe("AC-12 Adv-3 — invalidation on a commitMigration swap", () => {
  it("read() after commitMigration returns the v2 file, not the stale cached legacy file", async () => {
    const legacy = indexFile("LEG1", "Legacy Paper");
    const fs = makeSpyFs({
      [PRIMARY]: JSON.stringify(legacy),
      [META]: metaFor(legacy)
    });
    const storage = makeStorage(fs);

    // Prime the cache against the legacy primary.
    const before = await storage.read();
    expect(before?.items.LEG1).toBeDefined();
    expect(fs.readableCount(PRIMARY)).toBe(1);

    // A migration commit: write the v2 file to `.tmp`, then atomically
    // rename it over the primary. The meta sidecar is deliberately
    // LEFT UNTOUCHED — exactly the SP-12.2 scenario.
    await storage.writeTmp(migratedFile());
    await storage.commitMigration();

    const after = await storage.read();
    // D2: a meta-only fingerprint would return the STALE legacy file
    // here. The primary stat changed (rename bumped lastModified + the
    // file size differs) → the cache must invalidate.
    expect(after?.items.MIG1).toBeDefined();
    expect(after?.items.LEG1).toBeUndefined();
    // The primary was re-parsed (cold) after the swap.
    expect(fs.readableCount(PRIMARY)).toBe(2);
  });

  it("the stat component alone distinguishes the pre- and post-migration primary", async () => {
    // Pin the exact contract: a swap that does NOT change the meta
    // sidecar must still be detected. We assert the cache is keyed on
    // the primary stat by checking the post-swap read does NOT serve
    // the cached value even though `io.stat` is the only thing that
    // moved.
    const legacy = indexFile("LEG2", "Legacy");
    const fs = makeSpyFs({
      [PRIMARY]: JSON.stringify(legacy),
      [META]: metaFor(legacy)
    });
    const storage = makeStorage(fs);
    await storage.read();

    // Confirm the meta sidecar is genuinely untouched across the swap.
    const metaBefore = fs.files.get(META)?.contents;
    await storage.writeTmp(migratedFile());
    await storage.commitMigration();
    const metaAfter = fs.files.get(META)?.contents;
    expect(metaAfter).toBe(metaBefore);

    // Despite the identical meta sidecar, the read must reflect the swap.
    const after = await storage.read();
    expect(after?.items.MIG1).toBeDefined();
  });
});

// ====================================================================
// FINDING-1 — size-only stat must NOT serve a stale cache after a
// same-size commitMigration swap.
//
// Codex S9 review: `IndexFileStat.lastModified` is optional. A host
// that supplies `{ size }` only has no reliable change token — and a
// migrated file of the SAME byte length as the cached file would share
// the `(meta, size)` fingerprint. `commitMigration` does NOT refresh
// the meta sidecar, so a meta+size fingerprint cannot catch the swap.
// The fix: (1) a size-only stat disables the cache (treated like
// no-stat); (2) `commitMigration` invalidates the cache directly.
// ====================================================================

describe("AC-12 FINDING-1 — size-only stat never serves a stale post-migration cache", () => {
  it("commitMigration to a SAME-SIZE file is reflected by read() under a size-only stat", async () => {
    // Two distinct IndexFiles whose JSON serializations are the SAME
    // byte length. `meta` is left untouched across the swap (SP-12.2),
    // so `(meta, size)` is identical before and after — only a direct
    // cache invalidation OR a `lastModified` token could catch it.
    const cached: IndexFile = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      items: {
        AAAA: {
          title: "Title-A",
          chunks: [{ text: "chunk-aaa", embedding: [0.1, 0.2, 0.3], sourceKind: "metadata" }]
        }
      },
      indexedAt: "2026-05-22T00:00:00.000Z"
    };
    const migrated: IndexFile = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      items: {
        BBBB: {
          title: "Title-B",
          chunks: [{ text: "chunk-bbb", embedding: [0.4, 0.5, 0.6], sourceKind: "metadata" }]
        }
      },
      indexedAt: "2026-05-22T00:00:00.000Z"
    };
    const cachedJson = JSON.stringify(cached);
    const migratedJson = JSON.stringify(migrated);
    // Precondition the adversarial case depends on: identical byte size.
    expect(migratedJson.length).toBe(cachedJson.length);

    const fs = makeSizeOnlyFs({
      [PRIMARY]: cachedJson,
      [META]: metaFor(cached)
    });
    const storage = makeStorage(fs);

    // Prime the cache against the original primary.
    const before = await storage.read();
    expect(before?.items.AAAA).toBeDefined();

    // Atomic migration swap: write the same-size v2 file to `.tmp`,
    // commit it over the primary. The meta sidecar is NOT refreshed.
    await storage.writeTmp(migrated);
    await storage.commitMigration();

    const after = await storage.read();
    // The read MUST return the NEW file. A size-only fingerprint that
    // cached on `(meta, size)` would return the stale `cached` here.
    expect(after?.items.BBBB).toBeDefined();
    expect(after?.items.AAAA).toBeUndefined();
  });

  it("a size-only stat disables the cache entirely (every read re-parses)", async () => {
    // With no `lastModified` token the cache must degrade to never-hit,
    // exactly like the no-stat path — the primary is re-parsed each call.
    const file = indexFile();
    const fs = makeSizeOnlyFs({
      [PRIMARY]: JSON.stringify(file),
      [META]: metaFor(file)
    });
    const storage = makeStorage(fs);

    await storage.read();
    await storage.read();
    await storage.read();

    // No fingerprint is computable → no HIT → 3 cold parses.
    expect(fs.readableCount(PRIMARY)).toBe(3);
  });
});

// ====================================================================
// Adv-4 — no stat available → never serve stale (cache disabled)
// ====================================================================

describe("AC-12 Adv-4 — no-op stat adapter degrades to never-cache", () => {
  it("with stat() always null, every read() re-parses the primary (cache disabled)", async () => {
    const file = indexFile();
    const fs = makeNoStatFs({
      [PRIMARY]: JSON.stringify(file),
      [META]: metaFor(file)
    });
    const storage = makeStorage(fs);

    await storage.read();
    await storage.read();
    await storage.read();

    // D5: no fingerprint is computable → no HIT is ever served → the
    // primary is parsed on EVERY call. The optimization is lost; the
    // CORRECTNESS (never a stale read) is preserved.
    expect(fs.readableCount(PRIMARY)).toBe(3);
  });

  it("a no-stat read() never serves a stale file after an external rewrite", async () => {
    const oldFile = indexFile("STALE", "Stale Paper");
    const fs = makeNoStatFs({
      [PRIMARY]: JSON.stringify(oldFile),
      [META]: metaFor(oldFile)
    });
    const storage = makeStorage(fs);

    const first = await storage.read();
    expect(first?.items.STALE).toBeDefined();

    // External rewrite — a cache that wrongly hit would miss this.
    const fresh = indexFile("FRESH", "Fresh Paper");
    await fs.io.writeString(PRIMARY, JSON.stringify(fresh));
    await fs.io.writeString(META, metaFor(fresh));

    const second = await storage.read();
    expect(second?.items.FRESH).toBeDefined();
    expect(second?.items.STALE).toBeUndefined();
  });
});

// ====================================================================
// Adv-5 — read() purity: the cache adds only reads, never a mutation
// ====================================================================

describe("AC-12 Adv-5 — read() stays pure (AC-5 FINDING-1 contract)", () => {
  it("a cold read() issues no writeString / remove / rename", async () => {
    const file = indexFile();
    const fs = makeSpyFs({
      [PRIMARY]: JSON.stringify(file),
      [META]: metaFor(file)
    });
    const storage = makeStorage(fs);

    await storage.read();

    // D6: the cache must add ONLY in-memory state plus reads — no
    // mutation of the filesystem.
    expect(fs.ops.some((op) => op.startsWith("writeString:"))).toBe(false);
    expect(fs.ops.some((op) => op.startsWith("remove:"))).toBe(false);
    expect(fs.ops.some((op) => op.startsWith("rename:"))).toBe(false);
  });

  it("a cache-HIT read() issues no writeString / remove / rename", async () => {
    const file = indexFile();
    const fs = makeSpyFs({
      [PRIMARY]: JSON.stringify(file),
      [META]: metaFor(file)
    });
    const storage = makeStorage(fs);

    await storage.read();
    const opsAfterCold = fs.ops.length;
    await storage.read();

    const hitOps = fs.ops.slice(opsAfterCold);
    expect(hitOps.some((op) => op.startsWith("writeString:"))).toBe(false);
    expect(hitOps.some((op) => op.startsWith("remove:"))).toBe(false);
    expect(hitOps.some((op) => op.startsWith("rename:"))).toBe(false);
  });

  it("a read() during an in-flight migration (marker + .tmp present) mutates nothing", async () => {
    // Mirrors AC-5 Adv-6: a production read DURING a migration must be
    // side-effect free even with the cache layered on top.
    const legacy = indexFile("LEG1", "Legacy");
    const fs = makeSpyFs({
      [PRIMARY]: JSON.stringify(legacy),
      [META]: metaFor(legacy),
      [TMP]: JSON.stringify(migratedFile()),
      [`${PRIMARY}.migrating`]: "2026-05-22T00:00:00.000Z"
    });
    const storage = makeStorage(fs);
    const snapshotBefore = JSON.stringify(
      [...fs.files.entries()].map(([k, v]) => [k, v.contents]).sort()
    );

    const file = await storage.read();
    // read() sees the OLD primary, not the .tmp.
    expect(file?.items.LEG1).toBeDefined();
    expect(file?.items.MIG1).toBeUndefined();

    const snapshotAfter = JSON.stringify(
      [...fs.files.entries()].map(([k, v]) => [k, v.contents]).sort()
    );
    expect(snapshotAfter).toBe(snapshotBefore);
  });
});

// ====================================================================
// FINDING-2 — read()/readWithMigration() stay pure on the legacy
// per-provider fallback path.
//
// Codex S9 review: with `embedProvider = {ollama, embeddinggemma}` and
// ONLY the legacy `zotero-ai-explain-index.json` present, `readPure()`
// used to copy the legacy file to the per-provider name — a read-path
// `writeString`, a real AC-5/AC-12 read-purity contract violation. Both
// `read()` and `readWithMigration()` route through `readPure()`, so the
// purity tests above (which use a non-provider path) miss the mutation.
// The fix returns the legacy content WITHOUT copying it.
// ====================================================================

describe("AC-12 FINDING-2 — legacy per-provider fallback read is pure", () => {
  it("read() over the legacy-eligible provider returns the legacy file and writes NOTHING", async () => {
    const legacy = indexFile("LEG1", "Legacy Paper");
    // Only the legacy flat file exists — no per-provider file.
    const fs = makeSpyFs({ [LEGACY]: JSON.stringify(legacy) });
    const storage = makeOllamaStorage(fs);

    const result = await storage.read();
    // The legacy content is returned correctly.
    expect(result?.items.LEG1).toBeDefined();
    // FINDING-2: the read path issued NO filesystem mutation — no copy
    // of the legacy file to the per-provider name.
    expect(fs.ops.some((op) => op.startsWith("writeString:"))).toBe(false);
    expect(fs.ops.some((op) => op.startsWith("remove:"))).toBe(false);
    expect(fs.ops.some((op) => op.startsWith("rename:"))).toBe(false);
  });

  it("readWithMigration() over the legacy-eligible provider is also pure", async () => {
    const legacy = indexFile("LEG1", "Legacy Paper");
    const fs = makeSpyFs({ [LEGACY]: JSON.stringify(legacy) });
    const storage = makeOllamaStorage(fs);

    const { file } = await storage.readWithMigration();
    // The legacy content is returned correctly through the migration probe.
    expect(file?.items.LEG1).toBeDefined();
    // `readWithMigration()` shares `readPure()` — it must NOT copy either.
    expect(fs.ops.some((op) => op.startsWith("writeString:"))).toBe(false);
    expect(fs.ops.some((op) => op.startsWith("remove:"))).toBe(false);
    expect(fs.ops.some((op) => op.startsWith("rename:"))).toBe(false);
  });

  it("repeated legacy-fallback reads all return the legacy data with zero writes", async () => {
    const legacy = indexFile("LEG1", "Legacy Paper");
    const fs = makeSpyFs({ [LEGACY]: JSON.stringify(legacy) });
    const storage = makeOllamaStorage(fs);

    expect((await storage.read())?.items.LEG1).toBeDefined();
    expect((await storage.read())?.items.LEG1).toBeDefined();
    // No one-time copy means every read is a clean, side-effect-free
    // legacy fallback.
    expect(fs.ops.some((op) => op.startsWith("writeString:"))).toBe(false);
  });
});

// ====================================================================
// Adv-6 — clear() invalidates: read() after clear() returns null
// ====================================================================

describe("AC-12 Adv-6 — clear() drops the cached entry", () => {
  it("read() then clear() then read() → the second read returns null, not a stale hit", async () => {
    const file = indexFile();
    const fs = makeSpyFs({
      [PRIMARY]: JSON.stringify(file),
      [META]: metaFor(file)
    });
    const storage = makeStorage(fs);

    const first = await storage.read();
    expect(first).toEqual(file);

    await storage.clear();

    const second = await storage.read();
    // D4: the cache was dropped on clear — the index is gone.
    expect(second).toBeNull();
  });

  it("a same-process re-index after clear() is immediately consistent", async () => {
    const file = indexFile("BEFORE", "Before Clear");
    const fs = makeSpyFs({
      [PRIMARY]: JSON.stringify(file),
      [META]: metaFor(file)
    });
    const storage = makeStorage(fs);

    await storage.read();
    await storage.clear();
    expect(await storage.read()).toBeNull();

    // Re-index in the same process — write() must invalidate too so the
    // freshly-written file is visible immediately.
    const reindexed = indexFile("AFTER", "After Reindex");
    await storage.write(reindexed);
    const back = await storage.read();
    expect(back?.items.AFTER).toBeDefined();
    expect(back?.items.BEFORE).toBeUndefined();
  });
});

// ====================================================================
// Adv-7 — corrupt meta sidecar: fingerprint degrades, never throws
// ====================================================================

describe("AC-12 Adv-7 — corrupt <index>.meta.json", () => {
  it("a malformed meta sidecar does NOT make read() throw — it returns the primary file", async () => {
    const file = indexFile();
    const fs = makeSpyFs({
      [PRIMARY]: JSON.stringify(file),
      [META]: "{ this is not valid json"
    });
    const storage = makeStorage(fs);

    // D7: a corrupt meta sidecar must degrade to the "absent" sentinel,
    // not crash the read path.
    await expect(storage.read()).resolves.toEqual(file);
  });

  it("a malformed meta sidecar never serves a stale read across an external rewrite", async () => {
    const oldFile = indexFile("OLD", "Old");
    const fs = makeSpyFs({
      [PRIMARY]: JSON.stringify(oldFile),
      [META]: "<<<garbage>>>"
    });
    const storage = makeStorage(fs);

    const first = await storage.read();
    expect(first?.items.OLD).toBeDefined();

    // Rewrite the primary — the stat component still changes, so even
    // with an "absent"-sentinel meta the fingerprint differs.
    const newFile = indexFile("NEW", "New");
    await fs.io.writeString(PRIMARY, JSON.stringify(newFile));

    const second = await storage.read();
    expect(second?.items.NEW).toBeDefined();
    expect(second?.items.OLD).toBeUndefined();
  });
});

// ====================================================================
// read() signature + return-value invariants under the cache
// ====================================================================

describe("AC-12 — read() signature/contract preserved by the cache", () => {
  it("read() of an absent index returns null (cold) and stays null on the next read", async () => {
    const fs = makeSpyFs({});
    const storage = makeStorage(fs);
    expect(await storage.read()).toBeNull();
    expect(await storage.read()).toBeNull();
  });

  it("read() of a corrupt primary returns null and never caches a bogus value", async () => {
    const fs = makeSpyFs({ [PRIMARY]: "<<<not json>>>" });
    const storage = makeStorage(fs);
    expect(await storage.read()).toBeNull();
    // A second read still returns null — a corrupt primary is never
    // cached as a "valid" hit.
    expect(await storage.read()).toBeNull();
  });
});
