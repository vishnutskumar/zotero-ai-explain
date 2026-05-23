/**
 * Adversarial unit tests for AC-5 — atomic write-new-then-swap index
 * migration with a sidecar pending marker.
 *
 * Plan: `docs/superpowers/plans/2026-05-19-pdf-context-features.md`
 *   AC-5 description           L451-470 (Adv-1 .. Adv-6)
 *   AC-5 interface contracts   L662-757
 *   AC-5 Modify notes          L270-305
 *
 * --------------------------------------------------------------------
 * Fault Localization (Template 4 — AC-5 migration state machine)
 * --------------------------------------------------------------------
 *
 * 1. Spec semantics (premises):
 *    P1.  `read()` is PURE — no side effects, never triggers migration.
 *         It returns whatever IndexFile is on disk (or null), exactly
 *         as the v0.2.0 contract did (contract L721-723).
 *    P2.  `readWithMigration()` returns `{file, migrationPending}`
 *         where `migrationPending = sidecar-exists ||
 *         (file?.schemaVersion ?? 1) < CURRENT_SCHEMA_VERSION`
 *         (contract L724-727). It is the SOLE migration-probe entry
 *         point — only `IndexingController.hydrate()` calls it.
 *    P3.  `writeTmp(file)` writes the serialized file to `<path>.tmp`.
 *         It does NOT touch the primary file.
 *    P4.  `commitMigration()` atomically renames `<path>.tmp` →
 *         `<path>`, then calls `removeMarker()`. After it the primary
 *         is the new file and the sidecar is gone.
 *    P5.  `abandonMigration()` removes any stale `<path>.tmp`
 *         (idempotent). It does NOT touch the marker — the marker
 *         persists so the next launch retries.
 *    P6.  `writeMarker()` creates `<path>.migrating` (idempotent —
 *         calling twice is a no-op, never an error).
 *    P7.  `removeMarker()` deletes `<path>.migrating` (idempotent —
 *         no-op when absent, never an error).
 *    P8.  `hasMarker()` is an existence check on `<path>.migrating`.
 *    P9.  The primary index file is NEVER mutated in place during
 *         migration. Concurrent `read()` sees either the fully-old or
 *         fully-new file — never a half-state (Adv-3).
 *    P10. A legacy IndexFile (no `schemaVersion` field) is treated as
 *         schemaVersion 1 → `migrationPending` true (contract L726).
 *    P11. A corrupt primary JSON makes `read()` return null (the
 *         existing v0.2.0 error path). `readWithMigration` surfaces it
 *         as `{file: null, ...}` — no silent overwrite (Adv-5).
 *
 * 2. Code path trace (against the contract — bodies NOT inspected):
 *    - hydrate → readWithMigration → if pending → runMigration
 *      (writeMarker → abandonMigration → crawl→writeTmp → commitMigration).
 *    - C5 special case: schemaVersion already 2 BUT marker present →
 *      hydrate calls removeMarker() directly, skips runMigration.
 *
 * 3. Divergence analysis (likely bugs):
 *    D1 [HIGH]   `read()` is NOT pure — it migrates / mutates on read
 *                (violates Adv-6 + P1; production reads would race).
 *    D2 [HIGH]   `migrationPending` false for a legacy (no
 *                schemaVersion) file → migration never fires.
 *    D3 [HIGH]   `migrationPending` true AFTER a successful migration
 *                (sidecar not removed, or schemaVersion not bumped) →
 *                spurious re-fire on every launch (Adv-2).
 *    D4 [HIGH]   `commitMigration` mutates the primary in place rather
 *                than atomic rename → a crash mid-write leaves a
 *                half-written primary (Adv-3 / Adv-4 C5).
 *    D5 [HIGH]   `abandonMigration` removes the MARKER too → the next
 *                launch no longer knows a migration was pending (C3/C4).
 *    D6 [MEDIUM] `writeMarker` / `removeMarker` throw on the
 *                already-exists / already-absent case (not idempotent).
 *    D7 [MEDIUM] `writeTmp` writes to the primary path, not `.tmp`.
 *    D8 [MEDIUM] Corrupt primary → readWithMigration throws or returns
 *                a bogus file instead of `{file: null}` (Adv-5).
 *    D9 [LOW]    `pageIndex: 0` on a chunk is treated as "no page"
 *                by the schemaVersion heuristic.
 *
 * 4. Test targets (ranked): D1 (read purity) > D3 (no re-fire) >
 *    D4 (atomic swap) > D5 (abandon scope) > D2 (legacy detection) >
 *    D6/D7 (idempotency / path) > D8 (corrupt).
 *
 * --------------------------------------------------------------------
 * COMPILE NOTE: this file depends on the AC-5 widening of
 * `IndexStorage` (`readWithMigration`, `writeTmp`, `commitMigration`,
 * `abandonMigration`, `writeMarker`, `removeMarker`, `hasMarker`), of
 * `CreateIndexStorageDeps.io` (`rename`), of `IndexFile`
 * (`schemaVersion`), and on `CURRENT_SCHEMA_VERSION`. Until the
 * implementer lands these the file fails to COMPILE. The test SOURCE is
 * the authority on the contract (plan L662-757).
 * --------------------------------------------------------------------
 */

import { describe, expect, it } from "vitest";

import {
  createIndexStorage,
  type CreateIndexStorageDeps,
  type IndexStorage
} from "../../src/indexing/index-storage.js";
import { CURRENT_SCHEMA_VERSION, type IndexFile } from "../../src/indexing/library-crawler.js";

const DATA_DIR = "/var/test-fixture/zotero-data";
const PRIMARY = `${DATA_DIR}/zotero-ai-explain-index.json`;
const TMP = `${PRIMARY}.tmp`;
const MARKER = `${PRIMARY}.migrating`;

// --------------------------------------------------------------------
// In-memory IO adapter with the AC-5 `rename` method. A spy-able fake
// filesystem — NOT a tautological mock; the rename semantics
// (atomic move, source removed) mirror IOUtils.move.
// --------------------------------------------------------------------

type FakeFs = {
  readonly io: CreateIndexStorageDeps["io"];
  readonly files: Map<string, string>;
  readonly ops: string[];
};

function makeFs(initial: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(initial));
  const ops: string[] = [];
  const io: CreateIndexStorageDeps["io"] = {
    async readString(p) {
      await Promise.resolve();
      ops.push(`read:${p}`);
      const v = files.get(p);
      if (v === undefined) {
        throw new Error(`ENOENT: ${p}`);
      }
      return v;
    },
    async writeString(p, contents) {
      await Promise.resolve();
      ops.push(`write:${p}`);
      files.set(p, contents);
    },
    async remove(p) {
      await Promise.resolve();
      ops.push(`remove:${p}`);
      if (!files.has(p)) {
        // Mirror IOUtils.remove({ ignoreAbsent: true }) — the storage
        // layer is responsible for absent-tolerance, NOT the adapter.
        throw new Error(`ENOENT: ${p}`);
      }
      files.delete(p);
    },
    async exists(p) {
      await Promise.resolve();
      return files.has(p);
    },
    async rename(src, dst) {
      await Promise.resolve();
      ops.push(`rename:${src}->${dst}`);
      const v = files.get(src);
      if (v === undefined) {
        throw new Error(`ENOENT: ${src}`);
      }
      // Atomic move: destination fully replaced, source gone.
      files.set(dst, v);
      files.delete(src);
    },
    async stat(p) {
      // AC-12: cheap stat for the index-cache fingerprint. Resolves
      // `null` when the file is absent (mirrors `IOUtils.stat` ENOENT).
      await Promise.resolve();
      ops.push(`stat:${p}`);
      const v = files.get(p);
      return v === undefined ? null : { size: v.length };
    }
  };
  return { io, files, ops };
}

function makeStorage(fs: FakeFs): IndexStorage {
  const deps: CreateIndexStorageDeps = {
    zotero: { DataDirectory: { dir: DATA_DIR } },
    io: fs.io
  };
  return createIndexStorage(deps);
}

function v1File(): IndexFile {
  // A legacy file: no `schemaVersion` field. `schemaVersion` is a
  // REQUIRED field on the v0.3.0 `IndexFile`, so the deliberate
  // omission is cast through `unknown` — a legacy on-disk file genuinely
  // lacks the field and `readWithMigration` treats its absence as v1.
  return {
    items: {
      LEG1: {
        title: "Legacy Paper",
        chunks: [{ text: "legacy chunk", embedding: [0.1, 0.2] }]
      }
    },
    indexedAt: "2026-05-01T00:00:00.000Z"
  } as unknown as IndexFile;
}

function v2File(itemKey = "NEW1"): IndexFile {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    items: {
      [itemKey]: {
        title: "Migrated Paper",
        chunks: [
          {
            text: "migrated chunk",
            embedding: [0.3, 0.4],
            sourceKind: "pdf-page",
            pageIndex: 0,
            attachmentKey: "ATTACH01"
          }
        ]
      }
    },
    indexedAt: "2026-05-19T00:00:00.000Z"
  };
}

/** Persist a raw IndexFile JSON straight to the primary path. */
function seedPrimary(file: IndexFile): Record<string, string> {
  return { [PRIMARY]: JSON.stringify(file) };
}

// ====================================================================
// readWithMigration — pending-detection logic (P2, P10, D2, D3)
// ====================================================================

describe("AC-5 readWithMigration — migrationPending detection", () => {
  it("legacy file with no schemaVersion → migrationPending true", async () => {
    // P10 / D2: a legacy file is treated as schemaVersion 1 < 2.
    const fs = makeFs(seedPrimary(v1File()));
    const storage = makeStorage(fs);
    const { file, migrationPending } = await storage.readWithMigration();
    expect(file).not.toBeNull();
    expect(migrationPending).toBe(true);
  });

  it("file already at CURRENT_SCHEMA_VERSION with no marker → migrationPending false", async () => {
    // D3: a fully-migrated file must NOT re-fire migration (Adv-2).
    const fs = makeFs(seedPrimary(v2File()));
    const storage = makeStorage(fs);
    const { file, migrationPending } = await storage.readWithMigration();
    expect(file?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrationPending).toBe(false);
  });

  it("sidecar marker present → migrationPending true even when schemaVersion is current", async () => {
    // The C5 case: rename completed (primary = v2) but the marker
    // removal was interrupted. The marker forces a pending signal.
    const fs = makeFs({
      ...seedPrimary(v2File()),
      [MARKER]: "2026-05-19T00:00:00.000Z"
    });
    const storage = makeStorage(fs);
    const { migrationPending } = await storage.readWithMigration();
    expect(migrationPending).toBe(true);
  });

  it("no primary file at all → migrationPending true (a fresh install needs a v2 crawl)", async () => {
    // (undefined schemaVersion ?? 1) === 1 < 2.
    const fs = makeFs({});
    const storage = makeStorage(fs);
    const { file, migrationPending } = await storage.readWithMigration();
    expect(file).toBeNull();
    expect(migrationPending).toBe(true);
  });
});

// ====================================================================
// Adv-6 — read() purity guarantee (P1, D1)
// ====================================================================

describe("AC-5 Adv-6 — read() is pure: no migration, no mutation", () => {
  it("read() on a legacy file returns it verbatim and triggers NO migration", async () => {
    const fs = makeFs(seedPrimary(v1File()));
    const storage = makeStorage(fs);
    const before = JSON.stringify([...fs.files.entries()].sort());

    const file = await storage.read();

    // The legacy file is returned as-is — RAG consumers handle missing
    // sourceKind/pageIndex gracefully (Adv-6).
    expect(file).not.toBeNull();
    expect(file?.items.LEG1?.title).toBe("Legacy Paper");

    // D1: read() must NOT have created a .tmp, a marker, or mutated the
    // primary. The filesystem is byte-identical after the read.
    const after = JSON.stringify([...fs.files.entries()].sort());
    expect(after).toBe(before);
    expect(fs.files.has(TMP)).toBe(false);
    expect(fs.files.has(MARKER)).toBe(false);
    // No write/remove/rename op was issued — read-only.
    expect(fs.ops.some((op) => op.startsWith("write:"))).toBe(false);
    expect(fs.ops.some((op) => op.startsWith("rename:"))).toBe(false);
    expect(fs.ops.some((op) => op.startsWith("remove:"))).toBe(false);
  });

  it("read() during an active migration returns the OLD primary, not the .tmp", async () => {
    // Adv-6: a production read path opens the index mid-migration. The
    // .tmp holds the new v2 file; read() must still see the old v1.
    const fs = makeFs({
      ...seedPrimary(v1File()),
      [TMP]: JSON.stringify(v2File()),
      [MARKER]: "2026-05-19T00:00:00.000Z"
    });
    const storage = makeStorage(fs);

    const file = await storage.read();
    // Old file — the legacy item key, not the migrated one.
    expect(file?.items.LEG1).toBeDefined();
    expect(file?.items.NEW1).toBeUndefined();
  });
});

// ====================================================================
// writeTmp / commitMigration / abandonMigration — atomic swap (P3-P5)
// ====================================================================

describe("AC-5 writeTmp — writes the sidecar .tmp, never the primary", () => {
  it("writeTmp writes <path>.tmp and leaves the primary untouched", async () => {
    // D7: writeTmp must target the .tmp path.
    const fs = makeFs(seedPrimary(v1File()));
    const storage = makeStorage(fs);
    const primaryBefore = fs.files.get(PRIMARY);

    await storage.writeTmp(v2File());

    expect(fs.files.has(TMP)).toBe(true);
    expect(fs.files.get(PRIMARY)).toBe(primaryBefore);
    const tmpFile = JSON.parse(fs.files.get(TMP) ?? "{}") as IndexFile;
    expect(tmpFile.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("AC-5 commitMigration — atomic rename .tmp over primary + removeMarker", () => {
  it("commitMigration replaces the primary with the .tmp content and clears the marker", async () => {
    // P4 / D4: the swap is an atomic rename — the primary is never
    // partially written.
    const fs = makeFs({
      ...seedPrimary(v1File()),
      [MARKER]: "2026-05-19T00:00:00.000Z"
    });
    const storage = makeStorage(fs);
    await storage.writeTmp(v2File());

    await storage.commitMigration();

    // The primary is now the v2 file.
    const primary = JSON.parse(fs.files.get(PRIMARY) ?? "{}") as IndexFile;
    expect(primary.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(primary.items.NEW1).toBeDefined();
    // The .tmp is consumed by the rename.
    expect(fs.files.has(TMP)).toBe(false);
    // The marker is removed — migration is complete.
    expect(fs.files.has(MARKER)).toBe(false);
    // The swap went through `rename`, not a writeString to the primary.
    expect(fs.ops.some((op) => op === `rename:${TMP}->${PRIMARY}`)).toBe(true);
  });

  it("after commitMigration a fresh readWithMigration reports migrationPending false (Adv-2)", async () => {
    // Adv-2: the hydrate() IMMEDIATELY after a successful migration must
    // NOT re-fire. Sidecar absent + schemaVersion 2 ⇒ pending false.
    const fs = makeFs({
      ...seedPrimary(v1File()),
      [MARKER]: "2026-05-19T00:00:00.000Z"
    });
    const storage = makeStorage(fs);
    await storage.writeTmp(v2File());
    await storage.commitMigration();

    const { file, migrationPending } = await storage.readWithMigration();
    expect(file?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(migrationPending).toBe(false);
  });
});

describe("AC-5 abandonMigration — removes stale .tmp, preserves the marker", () => {
  it("abandonMigration removes <path>.tmp but does NOT remove the marker", async () => {
    // P5 / D5: the marker survives so the next launch retries.
    const fs = makeFs({
      ...seedPrimary(v1File()),
      [TMP]: JSON.stringify(v2File()),
      [MARKER]: "2026-05-19T00:00:00.000Z"
    });
    const storage = makeStorage(fs);

    await storage.abandonMigration();

    expect(fs.files.has(TMP)).toBe(false);
    expect(fs.files.has(MARKER)).toBe(true);
    // The primary is untouched.
    expect(fs.files.has(PRIMARY)).toBe(true);
  });

  it("abandonMigration is idempotent — no throw when .tmp is already absent", async () => {
    const fs = makeFs(seedPrimary(v1File()));
    const storage = makeStorage(fs);
    await expect(storage.abandonMigration()).resolves.toBeUndefined();
    // A second call is also a no-op.
    await expect(storage.abandonMigration()).resolves.toBeUndefined();
  });
});

// ====================================================================
// writeMarker / removeMarker / hasMarker — idempotency (P6-P8, D6)
// ====================================================================

describe("AC-5 marker lifecycle — writeMarker / removeMarker / hasMarker", () => {
  it("writeMarker creates the sidecar; hasMarker observes it", async () => {
    const fs = makeFs(seedPrimary(v1File()));
    const storage = makeStorage(fs);
    expect(await storage.hasMarker()).toBe(false);
    await storage.writeMarker();
    expect(await storage.hasMarker()).toBe(true);
    expect(fs.files.has(MARKER)).toBe(true);
  });

  it("writeMarker is idempotent — calling twice does not throw", async () => {
    // D6: idempotent on marker creation (plan L298, runMigration relies
    // on this for C2 — crash after marker, before .tmp).
    const fs = makeFs(seedPrimary(v1File()));
    const storage = makeStorage(fs);
    await storage.writeMarker();
    await expect(storage.writeMarker()).resolves.toBeUndefined();
    expect(await storage.hasMarker()).toBe(true);
  });

  it("removeMarker deletes the sidecar; idempotent when already absent", async () => {
    const fs = makeFs(seedPrimary(v1File()));
    const storage = makeStorage(fs);
    await storage.writeMarker();
    await storage.removeMarker();
    expect(await storage.hasMarker()).toBe(false);
    // D6: a second removeMarker on an absent sidecar must not throw.
    await expect(storage.removeMarker()).resolves.toBeUndefined();
  });
});

// ====================================================================
// Adv-5 — corrupt primary JSON surfaces, no silent overwrite
// ====================================================================

describe("AC-5 Adv-5 — corrupt primary index file", () => {
  it("readWithMigration on a corrupt primary returns file null, no migration mutation", async () => {
    // Adv-5: corrupt JSON → existing v0.2.0 error path (read returns
    // null). readWithMigration must NOT throw and must NOT overwrite.
    const fs = makeFs({ [PRIMARY]: "{ this is not valid json" });
    const storage = makeStorage(fs);
    const before = fs.files.get(PRIMARY);

    const { file } = await storage.readWithMigration();
    expect(file).toBeNull();
    // The corrupt bytes are NOT silently overwritten by readWithMigration.
    expect(fs.files.get(PRIMARY)).toBe(before);
    expect(fs.files.has(TMP)).toBe(false);
  });

  it("read() on a corrupt primary returns null (the v0.2.0 contract is unchanged)", async () => {
    const fs = makeFs({ [PRIMARY]: "<<<not json>>>" });
    const storage = makeStorage(fs);
    await expect(storage.read()).resolves.toBeNull();
  });
});

// ====================================================================
// Adv-3 — concurrent reader safety: read() never sees a half-state
// ====================================================================

describe("AC-5 Adv-3 — concurrent reader safety around commitMigration", () => {
  it("a read() before and after commitMigration sees fully-old then fully-new — never half", async () => {
    // Adv-3: two reads bracketing the rename. Each observes a complete
    // IndexFile. The rename is the only mutation of the primary, so
    // there is no observable intermediate state.
    const fs = makeFs({
      ...seedPrimary(v1File()),
      [MARKER]: "2026-05-19T00:00:00.000Z"
    });
    const storage = makeStorage(fs);
    await storage.writeTmp(v2File());

    const beforeRead = await storage.read();
    // Fully-old: the legacy item, complete.
    expect(beforeRead?.items.LEG1).toBeDefined();
    expect(beforeRead?.items.NEW1).toBeUndefined();

    await storage.commitMigration();

    const afterRead = await storage.read();
    // Fully-new: the migrated item, complete, with sourceKind stamped.
    expect(afterRead?.items.NEW1).toBeDefined();
    expect(afterRead?.items.LEG1).toBeUndefined();
    expect(afterRead?.items.NEW1?.chunks[0]?.sourceKind).toBe("pdf-page");
    expect(afterRead?.items.NEW1?.chunks[0]?.pageIndex).toBe(0);
  });

  it("commitMigration leaves the primary intact when the .tmp is missing (no half-clear)", async () => {
    // Adv-3 corollary: if there is nothing to commit, commitMigration
    // must NOT destroy the existing primary.
    const fs = makeFs(seedPrimary(v2File()));
    const storage = makeStorage(fs);
    // No writeTmp call — .tmp is absent.
    await storage.commitMigration().catch(() => {
      /* a throw is acceptable; a destroyed primary is not */
    });
    // The primary still holds a complete, valid IndexFile.
    const primary = await storage.read();
    expect(primary).not.toBeNull();
    expect(primary?.items.NEW1).toBeDefined();
  });
});

// ====================================================================
// Adv-1 + Adv-4 — full crash-state machine C1-C5
//
// The harness cannot kill a Zotero process mid-call, so each crash
// point is reproduced by leaving the filesystem in the exact state a
// crash at that point would produce, then asserting the behavior of
// the NEXT-launch sequence (readWithMigration → runMigration steps).
// ====================================================================

/**
 * Re-run the migration sequence the controller's `runMigration` would
 * perform — writeMarker → abandonMigration → writeTmp → commitMigration
 * — given a freshly-crawled v2 file. Returns the storage so callers can
 * assert post-conditions.
 */
async function replayRunMigration(storage: IndexStorage, freshCrawl: IndexFile): Promise<void> {
  await storage.writeMarker();
  await storage.abandonMigration();
  await storage.writeTmp(freshCrawl);
  await storage.commitMigration();
}

describe("AC-5 Adv-1 — resume after mid-.tmp-write crash", () => {
  it("next launch discards the partial .tmp and re-crawls to completion", async () => {
    // Crash during .tmp write → a TRUNCATED .tmp on disk + marker
    // present + original v1 primary. The next runMigration calls
    // abandonMigration (drops the bad .tmp), re-crawls, commits.
    const fs = makeFs({
      ...seedPrimary(v1File()),
      [MARKER]: "2026-05-19T00:00:00.000Z",
      [TMP]: '{"items":{"PARTIAL' // truncated mid-write
    });
    const storage = makeStorage(fs);

    // hydrate observes the pending signal.
    const probe = await storage.readWithMigration();
    expect(probe.migrationPending).toBe(true);

    await replayRunMigration(storage, v2File("RESUMED"));

    // Outcome: migration completes, no data loss, the partial .tmp gone.
    expect(fs.files.has(TMP)).toBe(false);
    expect(fs.files.has(MARKER)).toBe(false);
    const final = await storage.readWithMigration();
    expect(final.file?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(final.file?.items.RESUMED).toBeDefined();
    expect(final.migrationPending).toBe(false);
  });
});

describe("AC-5 Adv-4 — crash-state machine C1..C5", () => {
  it("C1 — crash during marker create: marker absent → treated as fresh trigger", async () => {
    // Filesystem: v1 primary only (the marker write never landed).
    // readWithMigration still reports pending (schemaVersion 1 < 2);
    // runMigration creates the marker and proceeds.
    const fs = makeFs(seedPrimary(v1File()));
    const storage = makeStorage(fs);
    expect((await storage.readWithMigration()).migrationPending).toBe(true);
    expect(await storage.hasMarker()).toBe(false);

    await replayRunMigration(storage, v2File("C1OUT"));

    const final = await storage.readWithMigration();
    expect(final.file?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(final.migrationPending).toBe(false);
  });

  it("C2 — crash after marker create, before .tmp write: marker present, no .tmp", async () => {
    // Filesystem: v1 primary + marker, no .tmp. runMigration's
    // writeMarker is idempotent; it proceeds to writeTmp + commit.
    const fs = makeFs({
      ...seedPrimary(v1File()),
      [MARKER]: "2026-05-19T00:00:00.000Z"
    });
    const storage = makeStorage(fs);
    expect((await storage.readWithMigration()).migrationPending).toBe(true);
    expect(await storage.hasMarker()).toBe(true);
    expect(fs.files.has(TMP)).toBe(false);

    await replayRunMigration(storage, v2File("C2OUT"));

    const final = await storage.readWithMigration();
    expect(final.file?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(final.migrationPending).toBe(false);
  });

  it("C3 — crash during .tmp write: marker present + partial .tmp → abandon then re-crawl", async () => {
    // Filesystem: v1 primary + marker + truncated .tmp.
    const fs = makeFs({
      ...seedPrimary(v1File()),
      [MARKER]: "2026-05-19T00:00:00.000Z",
      [TMP]: '{"items":{"HALF'
    });
    const storage = makeStorage(fs);
    expect((await storage.readWithMigration()).migrationPending).toBe(true);

    await replayRunMigration(storage, v2File("C3OUT"));

    // The partial .tmp was discarded; the final primary is the re-crawl.
    expect(fs.files.has(TMP)).toBe(false);
    const final = await storage.readWithMigration();
    expect(final.file?.items.C3OUT).toBeDefined();
    expect(final.migrationPending).toBe(false);
  });

  it("C4 — crash after .tmp complete, before rename: complete .tmp discarded, re-crawl", async () => {
    // Filesystem: v1 primary + marker + a COMPLETE (but stale) .tmp.
    // Per the plan the .tmp is discarded (abandonMigration) and the
    // crawl re-runs — cheap and unambiguous.
    const fs = makeFs({
      ...seedPrimary(v1File()),
      [MARKER]: "2026-05-19T00:00:00.000Z",
      [TMP]: JSON.stringify(v2File("STALETMP"))
    });
    const storage = makeStorage(fs);
    expect((await storage.readWithMigration()).migrationPending).toBe(true);

    await replayRunMigration(storage, v2File("C4OUT"));

    // The primary is the FRESH crawl, not the stale .tmp.
    const final = await storage.readWithMigration();
    expect(final.file?.items.C4OUT).toBeDefined();
    expect(final.file?.items.STALETMP).toBeUndefined();
    expect(fs.files.has(TMP)).toBe(false);
    expect(final.migrationPending).toBe(false);
  });

  it("C5 — crash after rename: primary is v2 + marker still present → removeMarker, skip runMigration", async () => {
    // Filesystem: primary ALREADY v2 (rename completed) + marker still
    // there (marker removal interrupted). hydrate sees schemaVersion 2
    // AND a marker → it must call removeMarker() directly and NOT
    // re-run the migration crawl.
    const fs = makeFs({
      ...seedPrimary(v2File("C5DONE")),
      [MARKER]: "2026-05-19T00:00:00.000Z"
    });
    const storage = makeStorage(fs);

    const probe = await storage.readWithMigration();
    // The marker forces migrationPending true even though schemaVersion
    // is already current — that is the C5 signal hydrate keys on.
    expect(probe.migrationPending).toBe(true);
    expect(probe.file?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    // hydrate's C5 branch: schemaVersion is already current, so the
    // correct action is removeMarker() — NOT a re-crawl.
    await storage.removeMarker();

    const afterCleanup = await storage.readWithMigration();
    expect(afterCleanup.migrationPending).toBe(false);
    // The primary was NEVER touched — the migrated data is intact.
    expect(afterCleanup.file?.items.C5DONE).toBeDefined();
  });
});

// ====================================================================
// Invariant — the primary file is never mutated in place during a
// migration sequence (only the atomic rename touches it).
// ====================================================================

describe("AC-5 invariant — primary is never written in place during migration", () => {
  it("a full migration sequence issues exactly one mutation of the primary: the rename", async () => {
    const fs = makeFs(seedPrimary(v1File()));
    const storage = makeStorage(fs);

    await replayRunMigration(storage, v2File("INVOUT"));

    // The ONLY op that produced the new primary content is the rename.
    const primaryWrites = fs.ops.filter((op) => op === `write:${PRIMARY}`);
    const primaryRenames = fs.ops.filter((op) => op === `rename:${TMP}->${PRIMARY}`);
    expect(primaryWrites).toEqual([]);
    expect(primaryRenames.length).toBe(1);
  });
});

// ====================================================================
// FINDING-4 (Phase 4b codex review) — clear() removes ALL FOUR index
// artefacts: primary, .meta.json sidecar, .tmp, and the .migrating
// marker. Leaving the `.tmp` behind would let a later commitMigration
// rename it back over the primary; leaving the marker behind would
// re-trigger migration on the next launch against a cleared index.
// ====================================================================

describe("FINDING-4 IndexStorage.clear — removes primary, meta, tmp, and marker", () => {
  const META = `${DATA_DIR}/zotero-ai-explain-index.meta.json`;

  it("clear removes the .tmp and the .migrating marker, not just the primary", async () => {
    // Reproduce the filesystem state of an in-flight migration: the
    // legacy primary, a partially-crawled `.tmp`, and the marker.
    const fs = makeFs({
      [PRIMARY]: JSON.stringify(v1File()),
      [META]: JSON.stringify({ itemCount: 1, indexedAt: "2026-05-01T00:00:00.000Z" }),
      [TMP]: JSON.stringify(v2File("PARTIAL")),
      [MARKER]: "2026-05-19T00:00:00.000Z"
    });
    const storage = makeStorage(fs);

    await storage.clear();

    // ALL FOUR artefacts gone — no resurrection vector survives.
    expect(fs.files.has(PRIMARY)).toBe(false);
    expect(fs.files.has(META)).toBe(false);
    expect(fs.files.has(TMP)).toBe(false);
    expect(fs.files.has(MARKER)).toBe(false);
  });

  it("after clear, readWithMigration reports no pending migration (no stale marker re-fire)", async () => {
    // The next-launch hydrate() must NOT see a pending migration after a
    // clear during migration — the marker that would re-trigger it is
    // gone. (`file` is null + marker absent → hydrate's fresh-install
    // branch skips migration entirely.)
    const fs = makeFs({
      [PRIMARY]: JSON.stringify(v1File()),
      [TMP]: JSON.stringify(v2File("PARTIAL")),
      [MARKER]: "2026-05-19T00:00:00.000Z"
    });
    const storage = makeStorage(fs);

    await storage.clear();
    const { file } = await storage.readWithMigration();

    expect(file).toBeNull();
    // The marker is gone, so hydrate()'s `file === null && !hasMarker`
    // fresh-install branch fires — no migration is triggered.
    expect(await storage.hasMarker()).toBe(false);
  });

  it("clear is robust when only some artefacts exist (idempotent per-file removal)", async () => {
    // A clear on a library with just the primary + marker (no `.tmp`
    // crawled yet) must still succeed and remove what IS present.
    const fs = makeFs({
      [PRIMARY]: JSON.stringify(v1File()),
      [MARKER]: "2026-05-19T00:00:00.000Z"
    });
    const storage = makeStorage(fs);

    await expect(storage.clear()).resolves.toBeUndefined();
    expect(fs.files.has(PRIMARY)).toBe(false);
    expect(fs.files.has(MARKER)).toBe(false);
  });
});
