/**
 * Adversarial unit tests for `createIndexStorage` (AC3, real-product-pipeline).
 *
 * Plan section: AC3 Interfaces L1016-1033 + AC4 storage.read shape
 * validation L770-786 of
 * `docs/superpowers/plans/2026-05-17-real-product-pipeline.md`.
 *
 * --------------------------------------------------------------------
 * Fault Localization (Template 4)
 * --------------------------------------------------------------------
 *
 * 1. Spec semantics (premises):
 *    P1. `createIndexStorage({zotero, io})` returns `IndexStorage` with
 *        `read`, `write`, `clear`, `path`.
 *    P2. `path()` returns
 *        `${zotero.DataDirectory.dir}/zotero-ai-explain-index.json`.
 *    P3. `read()` returns `null` when:
 *        - file does not exist (io.exists → false), OR
 *        - JSON.parse throws, OR
 *        - parsed shape does not match `IndexFile` (validate
 *          `typeof items === 'object' && typeof indexedAt === 'string'`).
 *    P4. `read()` returns the parsed `IndexFile` on success.
 *    P5. `write(file)` writes a JSON serialization of `file` to the path.
 *    P6. `clear()` removes the file (no-op if missing — no throw).
 *
 * 2. Code path trace (against the contract):
 *    - All disk I/O goes through the injected `io` adapter — tests use
 *      an in-memory fake.
 *
 * 3. Divergence analysis (likely bugs):
 *    D1 [HIGH]   `read()` rethrows on malformed JSON instead of null.
 *    D2 [HIGH]   `read()` returns the parsed value even when its shape
 *                is wrong (e.g., `{items: "oops", indexedAt: 1234}`).
 *    D3 [HIGH]   `clear()` throws when the file is missing.
 *    D4 [MEDIUM] `write()` does not stringify (passes object → adapter).
 *    D5 [MEDIUM] `path()` uses `/` join when `dir` already ends with `/`
 *                (results in `//`).
 *    D6 [LOW]    `read()` after `write()` does not round-trip the same
 *                JSON (e.g., a key gets dropped, embedding numbers
 *                lose precision).
 *
 * 4. Test targets (ranked):
 *    T1 — D3: read() on missing file → null.
 *    T2 — D1: read() on malformed JSON → null.
 *    T3 — D2: read() on shape-mismatched JSON → null (several variants).
 *    T4 — D6: write() then read() round-trip preserves shape.
 *    T5 — D3: clear() on existing file removes it.
 *    T6 — D3: clear() on missing file does NOT throw.
 *    T7 — D5: path() composes the expected absolute path.
 *    T8 — D4: write() serializes to JSON (not "[object Object]").
 */

import { describe, expect, it } from "vitest";

import type { CreateIndexStorageDeps, IndexFile, IndexStorageIoLike } from "./contracts.js";
import { createIndexStorage } from "../../src/indexing/index-storage.js";

function makeIo(initial: Record<string, string> = {}): {
  io: IndexStorageIoLike;
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initial));
  const io: IndexStorageIoLike = {
    async readString(p) {
      await Promise.resolve();
      const v = files.get(p);
      if (v === undefined) {
        throw new Error(`ENOENT: ${p}`);
      }
      return v;
    },
    async writeString(p, contents) {
      await Promise.resolve();
      files.set(p, contents);
    },
    async remove(p) {
      await Promise.resolve();
      if (!files.has(p)) {
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
      const v = files.get(src);
      if (v === undefined) {
        throw new Error(`ENOENT: ${src}`);
      }
      files.set(dst, v);
      files.delete(src);
    },
    async stat(p) {
      // AC-12: cheap stat for the index-cache fingerprint. Resolves
      // `null` when the file is absent (matches `IOUtils.stat` ENOENT).
      await Promise.resolve();
      const v = files.get(p);
      return v === undefined ? null : { size: v.length };
    }
  };
  return { io, files };
}

function makeStorage(
  ioOverride?: IndexStorageIoLike,
  dataDir = "/var/test-fixture/zotero-data"
): ReturnType<typeof createIndexStorage> {
  const { io } = ioOverride ? { io: ioOverride } : makeIo();
  const deps: CreateIndexStorageDeps = {
    zotero: { DataDirectory: { dir: dataDir } },
    io
  };
  return createIndexStorage(deps);
}

const validFile: IndexFile = {
  schemaVersion: 2,
  items: {
    K1: {
      title: "Paper One",
      chunks: [{ text: "chunk", embedding: [0.1, 0.2, 0.3], sourceKind: "metadata" }]
    }
  },
  indexedAt: "2026-05-17T00:00:00.000Z"
};

describe("createIndexStorage", () => {
  describe("path()", () => {
    it("T7: returns <dataDir>/zotero-ai-explain-index.json", () => {
      const storage = makeStorage(undefined, "/var/test-fixture/zotero-data");
      expect(storage.path()).toBe("/var/test-fixture/zotero-data/zotero-ai-explain-index.json");
    });

    it("T7b: does not double-up the separator when dataDir ends with /", () => {
      const storage = makeStorage(undefined, "/var/test-fixture/zotero-data/");
      // Either of these is acceptable — what is NOT acceptable is a "//".
      expect(storage.path()).not.toContain("//zotero-ai-explain-index.json");
      expect(storage.path()).toMatch(/zotero-ai-explain-index\.json$/u);
    });
  });

  describe("read()", () => {
    it("T1: returns null when the file does not exist", async () => {
      const { io } = makeIo({});
      const storage = makeStorage(io);
      await expect(storage.read()).resolves.toBeNull();
    });

    it("T2: returns null when the file contents are malformed JSON", async () => {
      const { io } = makeIo({
        "/var/test-fixture/zotero-data/zotero-ai-explain-index.json": "not json{"
      });
      const storage = makeStorage(io);
      await expect(storage.read()).resolves.toBeNull();
    });

    it("T3a: returns null when parsed JSON has no `items` field", async () => {
      const { io } = makeIo({
        "/var/test-fixture/zotero-data/zotero-ai-explain-index.json": JSON.stringify({
          indexedAt: "2026-05-17T00:00:00Z"
        })
      });
      const storage = makeStorage(io);
      await expect(storage.read()).resolves.toBeNull();
    });

    it("T3b: returns null when parsed JSON has no `indexedAt` field", async () => {
      const { io } = makeIo({
        "/var/test-fixture/zotero-data/zotero-ai-explain-index.json": JSON.stringify({
          items: {}
        })
      });
      const storage = makeStorage(io);
      await expect(storage.read()).resolves.toBeNull();
    });

    it("T3c: returns null when `items` is the wrong type (string)", async () => {
      const { io } = makeIo({
        "/var/test-fixture/zotero-data/zotero-ai-explain-index.json": JSON.stringify({
          items: "oops",
          indexedAt: "2026-05-17T00:00:00Z"
        })
      });
      const storage = makeStorage(io);
      await expect(storage.read()).resolves.toBeNull();
    });

    it("T3d: returns null when `indexedAt` is the wrong type (number)", async () => {
      const { io } = makeIo({
        "/var/test-fixture/zotero-data/zotero-ai-explain-index.json": JSON.stringify({
          items: {},
          indexedAt: 1234
        })
      });
      const storage = makeStorage(io);
      await expect(storage.read()).resolves.toBeNull();
    });

    it("T3e: returns null when parsed JSON is null (the literal null)", async () => {
      const { io } = makeIo({
        "/var/test-fixture/zotero-data/zotero-ai-explain-index.json": "null"
      });
      const storage = makeStorage(io);
      await expect(storage.read()).resolves.toBeNull();
    });

    it("T3f: returns null when parsed JSON is an array (top-level wrong shape)", async () => {
      const { io } = makeIo({
        "/var/test-fixture/zotero-data/zotero-ai-explain-index.json": "[1,2,3]"
      });
      const storage = makeStorage(io);
      await expect(storage.read()).resolves.toBeNull();
    });

    it("legacy <base>.json on disk is IGNORED — read() returns null when no per-provider data exists", async () => {
      // Post-simplification: the historical (ollama, embeddinggemma)
      // legacy fallback is GONE. A user upgrading from a monolithic
      // `zotero-ai-explain-index.json` install sees an empty index
      // until they clear+re-index; the legacy file is left on disk
      // untouched. Test under the ollama+embeddinggemma pairing — the
      // ONLY configuration that previously consulted the legacy flat
      // file.
      const legacyPath = "/var/test-fixture/zotero-data/zotero-ai-explain-index.json";
      const { io, files } = makeIo({ [legacyPath]: JSON.stringify(validFile) });
      const storage = createIndexStorage({
        zotero: { DataDirectory: { dir: "/var/test-fixture/zotero-data" } },
        io,
        embedProvider: { kind: "ollama", model: "embeddinggemma" }
      });
      await expect(storage.read()).resolves.toBeNull();
      // The legacy file is NOT consumed — it stays exactly as we seeded
      // it so the user can either delete it manually or roll back.
      expect(files.get(legacyPath)).toBe(JSON.stringify(validFile));
    });
  });

  describe("write()", () => {
    it("T8: serializes the IndexFile to JSON and stores it at path()", async () => {
      const { io, files } = makeIo();
      const storage = makeStorage(io);
      await storage.write(validFile);
      const stored = files.get(storage.path());
      expect(stored).toBeDefined();
      // The stored string MUST be valid JSON and parse back to the
      // shape we wrote.
      const parsed = JSON.parse(stored ?? "") as unknown;
      expect(parsed).toEqual(validFile);
    });
  });

  describe("per-provider filenames (Phase 4)", () => {
    it("uses the legacy single filename when embedProvider is not supplied", () => {
      const storage = makeStorage(undefined, "/var/test-fixture/zotero-data");
      expect(storage.path()).toBe("/var/test-fixture/zotero-data/zotero-ai-explain-index.json");
    });

    it("uses a per-provider+model filename when embedProvider is supplied", () => {
      const { io } = makeIo();
      const storage = createIndexStorage({
        zotero: { DataDirectory: { dir: "/var/test-fixture/zotero-data" } },
        io,
        embedProvider: { kind: "openai", model: "text-embedding-3-large" }
      });
      expect(storage.path()).toBe(
        "/var/test-fixture/zotero-data/zotero-ai-explain-index-openai-3-large.json"
      );
    });

    it("Ollama embeddinggemma maps to the per-provider name (not the legacy one)", () => {
      const { io } = makeIo();
      const storage = createIndexStorage({
        zotero: { DataDirectory: { dir: "/var/test-fixture/zotero-data" } },
        io,
        embedProvider: { kind: "ollama", model: "embeddinggemma" }
      });
      expect(storage.path()).toBe(
        "/var/test-fixture/zotero-data/zotero-ai-explain-index-ollama-embeddinggemma.json"
      );
    });

    it("Gemini text-embedding-004 maps to ...-gemini-004.json", () => {
      const { io } = makeIo();
      const storage = createIndexStorage({
        zotero: { DataDirectory: { dir: "/var/test-fixture/zotero-data" } },
        io,
        embedProvider: { kind: "gemini", model: "text-embedding-004" }
      });
      expect(storage.path()).toBe(
        "/var/test-fixture/zotero-data/zotero-ai-explain-index-gemini-004.json"
      );
    });
  });

  describe("clear()", () => {
    it("T5: removes an existing file", async () => {
      const { io, files } = makeIo({
        "/var/test-fixture/zotero-data/zotero-ai-explain-index.json": JSON.stringify(validFile)
      });
      const storage = makeStorage(io);
      await storage.clear();
      expect(files.has(storage.path())).toBe(false);
      // And a subsequent read() returns null (the file is gone).
      await expect(storage.read()).resolves.toBeNull();
    });

    it("T6: is a no-op when the file does not exist (does NOT throw)", async () => {
      const { io } = makeIo({});
      const storage = makeStorage(io);
      await expect(storage.clear()).resolves.toBeUndefined();
    });
  });

  // ====================================================================
  // AC-23 — per-item directory layout (OOM long-term fix)
  // ====================================================================
  //
  // The hot persist path used to JSON.stringify the whole IndexFile per
  // item, blowing past the chrome memory cap at ~200 items in a 5738-
  // item library. The long-term fix splits the IndexFile into one file
  // per item under a sibling directory. Each `writeItem` call is O(1)
  // (one per-item file + a tiny `_meta.json` update) regardless of
  // library size.
  //
  // These tests use a directory-aware in-memory IO adapter to model the
  // new layout. The legacy `makeIo` adapter (no `listChildren`) lives on
  // for the back-compat tests above so a host without filesystem
  // primitives still works.

  describe("AC-23 — per-item directory layout", () => {
    type DirFs = {
      readonly io: IndexStorageIoLike & {
        readonly makeDirectory: (path: string) => Promise<void>;
        readonly listChildren: (path: string) => Promise<readonly string[] | null>;
        readonly removeDirectory: (path: string) => Promise<void>;
      };
      readonly files: Map<string, string>;
      readonly dirs: Set<string>;
    };

    function makeDirFs(initial: Record<string, string> = {}): DirFs {
      const files = new Map<string, string>(Object.entries(initial));
      const dirs = new Set<string>();
      const io: DirFs["io"] = {
        async readString(p) {
          await Promise.resolve();
          const v = files.get(p);
          if (v === undefined) throw new Error(`ENOENT: ${p}`);
          return v;
        },
        async writeString(p, contents) {
          await Promise.resolve();
          files.set(p, contents);
        },
        async remove(p) {
          await Promise.resolve();
          if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
          files.delete(p);
        },
        async exists(p) {
          await Promise.resolve();
          return files.has(p) || dirs.has(p);
        },
        async rename(src, dst) {
          await Promise.resolve();
          const v = files.get(src);
          if (v === undefined) throw new Error(`ENOENT: ${src}`);
          files.set(dst, v);
          files.delete(src);
        },
        async stat(p) {
          await Promise.resolve();
          const v = files.get(p);
          return v === undefined ? null : { size: v.length };
        },
        async makeDirectory(p) {
          await Promise.resolve();
          dirs.add(p);
        },
        async listChildren(p) {
          await Promise.resolve();
          if (!dirs.has(p)) return null;
          const prefix = p.endsWith("/") ? p : `${p}/`;
          const names: string[] = [];
          for (const key of files.keys()) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.substring(prefix.length);
            if (rest.includes("/")) continue;
            names.push(rest);
          }
          return names;
        },
        async removeDirectory(p) {
          await Promise.resolve();
          const prefix = p.endsWith("/") ? p : `${p}/`;
          for (const key of [...files.keys()]) {
            if (key.startsWith(prefix)) {
              files.delete(key);
            }
          }
          dirs.delete(p);
        }
      };
      return { io, files, dirs };
    }

    const DIR = "/var/test-fixture/zotero-data/zotero-ai-explain-index";
    const LEGACY = "/var/test-fixture/zotero-data/zotero-ai-explain-index.json";

    it("writeItem writes a single per-item file and an incremental _meta.json", async () => {
      const fs = makeDirFs();
      const storage = makeStorage(fs.io);

      await storage.writeItem("ITEM_A", {
        title: "Paper A",
        chunks: [{ text: "a", embedding: [0.1], sourceKind: "metadata" }]
      });

      expect(fs.files.has(`${DIR}/ITEM_A.json`)).toBe(true);
      expect(fs.files.has(`${DIR}/_meta.json`)).toBe(true);
      const meta = JSON.parse(fs.files.get(`${DIR}/_meta.json`) ?? "{}") as {
        itemCount: number;
        indexedAt: string;
        schemaVersion: number;
      };
      expect(meta.itemCount).toBe(1);
      expect(meta.schemaVersion).toBe(2);
    });

    it("writeItem on item B does NOT touch the existing file for item A", async () => {
      const fs = makeDirFs();
      const storage = makeStorage(fs.io);

      await storage.writeItem("ITEM_A", {
        title: "Paper A",
        chunks: [{ text: "a", embedding: [0.1], sourceKind: "metadata" }]
      });
      const aSnapshot = fs.files.get(`${DIR}/ITEM_A.json`);

      await storage.writeItem("ITEM_B", {
        title: "Paper B",
        chunks: [{ text: "b", embedding: [0.2], sourceKind: "metadata" }]
      });

      // ITEM_A's file is byte-identical — writeItem is sibling-isolated.
      expect(fs.files.get(`${DIR}/ITEM_A.json`)).toBe(aSnapshot);
      // ITEM_B got its own file, meta count bumped to 2.
      expect(fs.files.has(`${DIR}/ITEM_B.json`)).toBe(true);
      const meta = JSON.parse(fs.files.get(`${DIR}/_meta.json`) ?? "{}") as { itemCount: number };
      expect(meta.itemCount).toBe(2);
    });

    it("read() assembles the IndexFile from per-item files in the directory", async () => {
      const fs = makeDirFs();
      const storage = makeStorage(fs.io);

      await storage.writeItem("ALPHA", {
        title: "Alpha",
        chunks: [{ text: "alpha", embedding: [0.1, 0.2], sourceKind: "metadata" }]
      });
      await storage.writeItem("BETA", {
        title: "Beta",
        chunks: [{ text: "beta", embedding: [0.3, 0.4], sourceKind: "pdf-page", pageIndex: 0 }]
      });

      const file = await storage.read();
      expect(file).not.toBeNull();
      expect(Object.keys(file?.items ?? {}).sort()).toEqual(["ALPHA", "BETA"]);
      expect(file?.items.ALPHA?.title).toBe("Alpha");
      expect(file?.items.BETA?.chunks[0]?.pageIndex).toBe(0);
    });

    it("clear() removes the per-item directory entirely", async () => {
      const fs = makeDirFs();
      const storage = makeStorage(fs.io);

      await storage.writeItem("K1", {
        title: "K1",
        chunks: [{ text: "k1", embedding: [0.1], sourceKind: "metadata" }]
      });
      await storage.writeItem("K2", {
        title: "K2",
        chunks: [{ text: "k2", embedding: [0.2], sourceKind: "metadata" }]
      });
      expect(fs.files.has(`${DIR}/K1.json`)).toBe(true);

      await storage.clear();

      expect(fs.files.has(`${DIR}/K1.json`)).toBe(false);
      expect(fs.files.has(`${DIR}/K2.json`)).toBe(false);
      expect(fs.files.has(`${DIR}/_meta.json`)).toBe(false);
      expect(fs.dirs.has(DIR)).toBe(false);
      await expect(storage.read()).resolves.toBeNull();
    });

    it("readItemCount() reads dir _meta.json fast path", async () => {
      const fs = makeDirFs();
      const storage = makeStorage(fs.io);

      await storage.writeItem("K1", {
        title: "K1",
        chunks: [{ text: "k1", embedding: [0.1], sourceKind: "metadata" }]
      });
      await storage.writeItem("K2", {
        title: "K2",
        chunks: [{ text: "k2", embedding: [0.2], sourceKind: "metadata" }]
      });

      const count = await storage.readItemCount();
      expect(count).toBe(2);
    });

    it("writeItem twice for the same key does NOT double-count in _meta.json", async () => {
      // Re-indexing an existing item (e.g., the user updated its title)
      // overwrites the per-item file in place. The meta itemCount must
      // stay at 1, not climb monotonically with every overwrite.
      const fs = makeDirFs();
      const storage = makeStorage(fs.io);

      await storage.writeItem("K1", {
        title: "K1 v1",
        chunks: [{ text: "v1", embedding: [0.1], sourceKind: "metadata" }]
      });
      await storage.writeItem("K1", {
        title: "K1 v2",
        chunks: [{ text: "v2", embedding: [0.2], sourceKind: "metadata" }]
      });

      const meta = JSON.parse(fs.files.get(`${DIR}/_meta.json`) ?? "{}") as { itemCount: number };
      expect(meta.itemCount).toBe(1);

      // The per-item file holds the latest content.
      const itemBytes = fs.files.get(`${DIR}/K1.json`) ?? "";
      const parsed = JSON.parse(itemBytes) as { title: string };
      expect(parsed.title).toBe("K1 v2");
    });

    // ================================================================
    // P0 / P1 / P2 regression tests for the per-item storage refactor.
    // ================================================================

    it("P1-2: write({A,B}) removes the stale per-item file for C", async () => {
      const fs = makeDirFs();
      const storage = makeStorage(fs.io);

      await storage.writeItem("A", {
        title: "A",
        chunks: [{ text: "a", embedding: [0.1], sourceKind: "metadata" }]
      });
      await storage.writeItem("B", {
        title: "B",
        chunks: [{ text: "b", embedding: [0.2], sourceKind: "metadata" }]
      });
      await storage.writeItem("C", {
        title: "C",
        chunks: [{ text: "c", embedding: [0.3], sourceKind: "metadata" }]
      });
      expect(fs.files.has(`${DIR}/C.json`)).toBe(true);

      await storage.write({
        schemaVersion: 2,
        items: {
          A: { title: "A", chunks: [{ text: "a", embedding: [0.1], sourceKind: "metadata" }] },
          B: { title: "B", chunks: [{ text: "b", embedding: [0.2], sourceKind: "metadata" }] }
        },
        indexedAt: "2026-05-22T00:00:00.000Z"
      });

      expect(fs.files.has(`${DIR}/A.json`)).toBe(true);
      expect(fs.files.has(`${DIR}/B.json`)).toBe(true);
      expect(fs.files.has(`${DIR}/C.json`)).toBe(false);
      const after = await storage.read();
      expect(Object.keys(after?.items ?? {}).sort()).toEqual(["A", "B"]);
    });

    it("P1-4: stale-but-parseable _meta.json (itemCount lies) → readItemCount returns the true dir count + heals the meta", async () => {
      const fs = makeDirFs();
      fs.dirs.add(DIR);
      // Pretend three per-item files exist but the meta lies (claims 1).
      fs.files.set(`${DIR}/A.json`, JSON.stringify({ title: "A", chunks: [] }));
      fs.files.set(`${DIR}/B.json`, JSON.stringify({ title: "B", chunks: [] }));
      fs.files.set(`${DIR}/C.json`, JSON.stringify({ title: "C", chunks: [] }));
      fs.files.set(
        `${DIR}/_meta.json`,
        JSON.stringify({ schemaVersion: 2, indexedAt: "2026-01-01T00:00:00.000Z", itemCount: 1 })
      );
      const storage = makeStorage(fs.io);

      const count = await storage.readItemCount();
      expect(count).toBe(3);

      // The meta is rewritten in passing.
      const healed = JSON.parse(fs.files.get(`${DIR}/_meta.json`) ?? "{}") as { itemCount: number };
      expect(healed.itemCount).toBe(3);
    });

    it("P1-5: concurrent different-key writeItem calls — both items persisted and meta count is correct", async () => {
      const fs = makeDirFs();
      const storage = makeStorage(fs.io);

      // Fire two writeItem calls without await between them.
      await Promise.all([
        storage.writeItem("A", {
          title: "A",
          chunks: [{ text: "a", embedding: [0.1], sourceKind: "metadata" }]
        }),
        storage.writeItem("B", {
          title: "B",
          chunks: [{ text: "b", embedding: [0.2], sourceKind: "metadata" }]
        })
      ]);

      expect(fs.files.has(`${DIR}/A.json`)).toBe(true);
      expect(fs.files.has(`${DIR}/B.json`)).toBe(true);
      const meta = JSON.parse(fs.files.get(`${DIR}/_meta.json`) ?? "{}") as { itemCount: number };
      expect(meta.itemCount).toBe(2);
    });

    it("P1-6: corrupt single <itemKey>.json → read() skips it and returns the rest", async () => {
      const fs = makeDirFs();
      const storage = makeStorage(fs.io);

      await storage.writeItem("A", {
        title: "A",
        chunks: [{ text: "a", embedding: [0.1], sourceKind: "metadata" }]
      });
      await storage.writeItem("B", {
        title: "B",
        chunks: [{ text: "b", embedding: [0.2], sourceKind: "metadata" }]
      });

      // Corrupt B.json
      fs.files.set(`${DIR}/B.json`, "{not valid json");

      const result = await storage.read();
      expect(result).not.toBeNull();
      expect(Object.keys(result?.items ?? {})).toEqual(["A"]);
    });

    it("P2-7: invalid itemKey filename ('..', containing '/', Windows-reserved CON) is sanitized — writeItem rejects, read() skips", async () => {
      const fs = makeDirFs();
      const storage = makeStorage(fs.io);

      // writeItem rejects unsafe keys.
      await expect(
        storage.writeItem("..", {
          title: "bad",
          chunks: [{ text: "x", embedding: [0.1], sourceKind: "metadata" }]
        })
      ).rejects.toThrow(/unsafe itemKey/u);
      await expect(
        storage.writeItem("a/b", {
          title: "bad",
          chunks: [{ text: "x", embedding: [0.1], sourceKind: "metadata" }]
        })
      ).rejects.toThrow(/unsafe itemKey/u);
      await expect(
        storage.writeItem("CON", {
          title: "bad",
          chunks: [{ text: "x", embedding: [0.1], sourceKind: "metadata" }]
        })
      ).rejects.toThrow(/unsafe itemKey/u);

      // On read(), a maliciously-named on-disk file is skipped.
      fs.dirs.add(DIR);
      fs.files.set(`${DIR}/..json`, JSON.stringify({ title: "evil", chunks: [] }));
      fs.files.set(`${DIR}/CON.json`, JSON.stringify({ title: "windows", chunks: [] }));
      // Add one legitimate item so read() returns a non-null result.
      await storage.writeItem("GOOD", {
        title: "good",
        chunks: [{ text: "g", embedding: [0.1], sourceKind: "metadata" }]
      });

      const result = await storage.read();
      const keys = Object.keys(result?.items ?? {});
      expect(keys).toEqual(["GOOD"]);
    });

    it("P0-8: empty directory with only _meta.json → read() returns an empty IndexFile (NOT null and NOT legacy fallback)", async () => {
      // After the AC-15 empty-completion invariant the crawler writes an
      // empty IndexFile when zero items index. We need a non-null read
      // result so callers that distinguish "indexed but empty" from
      // "never indexed" behave correctly.
      const fs = makeDirFs();
      fs.dirs.add(DIR);
      fs.files.set(
        `${DIR}/_meta.json`,
        JSON.stringify({ schemaVersion: 2, indexedAt: "2026-05-22T00:00:00.000Z", itemCount: 0 })
      );
      const storage = makeStorage(fs.io);

      const result = await storage.read();
      expect(result).not.toBeNull();
      expect(result?.items).toEqual({});
    });

    // ================================================================
    // Round-3 concurrency-simplification regression tests.
    //
    // The storage layer now serializes EVERY public op (reads + writes)
    // through one queue. These tests pin the invariants the
    // simplification protects.
    // ================================================================

    it("round-3: concurrent read + write never observes partial state — read sees either pre- or post-write", async () => {
      // The dangerous race the queue fixes: a read fired while a write
      // is rebuilding the directory used to be able to observe the
      // partially-rewritten directory (some new keys present, some old
      // keys still on disk). With every op serialized the read either
      // completes before the write starts OR fully after it commits.
      const fs = makeDirFs();
      const storage = makeStorage(fs.io);

      // Seed with three items.
      await storage.writeItem("A", {
        title: "A",
        chunks: [{ text: "a", embedding: [0.1], sourceKind: "metadata" }]
      });
      await storage.writeItem("B", {
        title: "B",
        chunks: [{ text: "b", embedding: [0.2], sourceKind: "metadata" }]
      });
      await storage.writeItem("C", {
        title: "C",
        chunks: [{ text: "c", embedding: [0.3], sourceKind: "metadata" }]
      });

      // Fire a write (replaces {A,B,C} with {X,Y}) and many concurrent
      // reads. Every read must return either the original {A,B,C} OR
      // the post-write {X,Y} — never a mixed set.
      const writePromise = storage.write({
        schemaVersion: 2,
        items: {
          X: { title: "X", chunks: [{ text: "x", embedding: [0.4], sourceKind: "metadata" }] },
          Y: { title: "Y", chunks: [{ text: "y", embedding: [0.5], sourceKind: "metadata" }] }
        },
        indexedAt: "2026-05-22T00:00:00.000Z"
      });
      const reads = await Promise.all([
        storage.read(),
        storage.read(),
        storage.read(),
        storage.read(),
        storage.read()
      ]);
      await writePromise;

      const allowed = [
        ["A", "B", "C"],
        ["X", "Y"]
      ];
      for (const r of reads) {
        const keys = Object.keys(r?.items ?? {}).sort();
        const match = allowed.some(
          (snap) => snap.length === keys.length && snap.every((k, i) => k === keys[i])
        );
        expect(match, `unexpected partial-state read: ${JSON.stringify(keys)}`).toBe(true);
      }

      // After everything settles the final read must be the post-write.
      const final = await storage.read();
      expect(Object.keys(final?.items ?? {}).sort()).toEqual(["X", "Y"]);
    });

    it("round-3: write() REJECTS when an orphan per-item file cannot be removed (legacy state unchanged)", async () => {
      // The orphan-delete used to be silent (try/catch{}) — a write of
      // {A,B} over {A,B,C} would "succeed" while leaving C's file on
      // disk, so the next read() resurrected C. The conservative fix:
      // reject the write so the caller knows the layout is inconsistent.
      const fs = makeDirFs();
      const storage = makeStorage(fs.io);

      await storage.writeItem("A", {
        title: "A",
        chunks: [{ text: "a", embedding: [0.1], sourceKind: "metadata" }]
      });
      await storage.writeItem("B", {
        title: "B",
        chunks: [{ text: "b", embedding: [0.2], sourceKind: "metadata" }]
      });
      await storage.writeItem("ORPHAN", {
        title: "ORPHAN",
        chunks: [{ text: "o", embedding: [0.3], sourceKind: "metadata" }]
      });

      // Patch the IO adapter to refuse removing the orphan's file
      // specifically (a permissions / locked-file scenario in production).
      const realRemove = fs.io.remove.bind(fs.io);
      (fs.io as { remove: typeof fs.io.remove }).remove = async (p: string): Promise<void> => {
        if (p === `${DIR}/ORPHAN.json`) {
          throw new Error("EACCES: permission denied");
        }
        return realRemove(p);
      };

      await expect(
        storage.write({
          schemaVersion: 2,
          items: {
            A: { title: "A", chunks: [{ text: "a", embedding: [0.1], sourceKind: "metadata" }] },
            B: { title: "B", chunks: [{ text: "b", embedding: [0.2], sourceKind: "metadata" }] }
          },
          indexedAt: "2026-05-22T00:00:00.000Z"
        })
      ).rejects.toThrow(/orphan/u);

      // The orphan file is still on disk — the write rejected before
      // committing, so the pre-write set is still observable.
      expect(fs.files.has(`${DIR}/ORPHAN.json`)).toBe(true);
      expect(fs.files.has(`${DIR}/A.json`)).toBe(true);
      expect(fs.files.has(`${DIR}/B.json`)).toBe(true);
      // Restore the real remove so subsequent reads work normally.
      (fs.io as { remove: typeof fs.io.remove }).remove = realRemove;
    });

    it("round-3: writeItem followed immediately by readItemCount returns the post-write count (no stale meta)", async () => {
      // readItemCount used to bypass the mutation queue — a fast caller
      // could observe an in-flight writeItem mid-flight (meta updated
      // before the per-item file landed, or vice versa). With both ops
      // queued, readItemCount always sees the fully-committed state.
      const fs = makeDirFs();
      const storage = makeStorage(fs.io);

      // Fire writeItem + readItemCount without await between them.
      const writePromise = storage.writeItem("K1", {
        title: "K1",
        chunks: [{ text: "k1", embedding: [0.1], sourceKind: "metadata" }]
      });
      const countPromise = storage.readItemCount();
      await writePromise;
      const count = await countPromise;
      // The readItemCount was queued behind the writeItem → it sees 1.
      expect(count).toBe(1);

      // Repeat with a second writeItem for the same key (overwrite — meta
      // count must not double-bump).
      const writePromise2 = storage.writeItem("K1", {
        title: "K1 v2",
        chunks: [{ text: "k1v2", embedding: [0.2], sourceKind: "metadata" }]
      });
      const countPromise2 = storage.readItemCount();
      await writePromise2;
      const count2 = await countPromise2;
      expect(count2).toBe(1);

      // And a new key bumps the count to 2.
      const writePromise3 = storage.writeItem("K2", {
        title: "K2",
        chunks: [{ text: "k2", embedding: [0.3], sourceKind: "metadata" }]
      });
      const countPromise3 = storage.readItemCount();
      await writePromise3;
      const count3 = await countPromise3;
      expect(count3).toBe(2);
    });

    it("P1 cache: out-of-band dir mutation invalidates the cache fingerprint", async () => {
      // Seed the legacy single-file too so the cache fingerprint has a
      // primary `filePath` stat to key on; then exercise an out-of-band
      // mutation that only changes the directory state. The next
      // read() must detect the change via the dirChildCount component
      // of the fingerprint, not the primary-file stat.
      const fs = makeDirFs({
        // A stub legacy file at the primary path so stat returns
        // non-null. Its content is irrelevant because the dir wins.
        [LEGACY]: JSON.stringify({
          schemaVersion: 2,
          items: {},
          indexedAt: "2026-05-22T00:00:00.000Z"
        })
      });
      // Patch stat to return a stable lastModified token so the
      // fingerprint is computable. Crucially: lastModified does NOT
      // change across the test — we want the cache to engage and we
      // want to prove the dir-state component is what triggers the
      // miss. Use the file's bytes hash as a poor-man's mtime so the
      // primary file's lastModified only changes when its bytes change.
      const stableStat: typeof fs.io.stat = (p) => {
        const v = fs.files.get(p);
        if (v === undefined) return Promise.resolve(null);
        let h = 0;
        for (let i = 0; i < v.length; i += 1) h = (h * 31 + v.charCodeAt(i)) | 0;
        return Promise.resolve({ size: v.length, lastModified: h });
      };
      (fs.io as { stat: typeof fs.io.stat }).stat = stableStat;
      const storage = makeStorage(fs.io);

      await storage.writeItem("A", {
        title: "A",
        chunks: [{ text: "a", embedding: [0.1], sourceKind: "metadata" }]
      });
      await storage.writeItem("B", {
        title: "B",
        chunks: [{ text: "b", embedding: [0.2], sourceKind: "metadata" }]
      });

      const before = await storage.read();
      expect(Object.keys(before?.items ?? {}).sort()).toEqual(["A", "B"]);

      // Out-of-band: delete A.json directly through the fake. The
      // primary-file stat does not change; the cache must catch this
      // via the dir-state component of the fingerprint.
      fs.files.delete(`${DIR}/A.json`);

      const after = await storage.read();
      expect(Object.keys(after?.items ?? {})).toEqual(["B"]);
    });
  });
});
