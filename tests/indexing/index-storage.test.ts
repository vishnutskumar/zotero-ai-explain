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

    it("T4: returns the parsed IndexFile when JSON shape is valid", async () => {
      const { io } = makeIo({
        "/var/test-fixture/zotero-data/zotero-ai-explain-index.json": JSON.stringify(validFile)
      });
      const storage = makeStorage(io);
      const result = await storage.read();
      expect(result).toEqual(validFile);
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

    it("T4-roundtrip: write() then read() preserves the IndexFile", async () => {
      const { io } = makeIo();
      const storage = makeStorage(io);
      await storage.write(validFile);
      const result = await storage.read();
      expect(result).toEqual(validFile);
    });

    it("T8b: write() overwrites an existing file", async () => {
      const { io } = makeIo({
        "/var/test-fixture/zotero-data/zotero-ai-explain-index.json": JSON.stringify({
          items: {},
          indexedAt: "1970-01-01T00:00:00Z"
        })
      });
      const storage = makeStorage(io);
      await storage.write(validFile);
      const result = await storage.read();
      expect(result).toEqual(validFile);
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

  describe("legacy filename fallback (Bug A)", () => {
    /**
     * Premises (P_legacy):
     *   P1. When `embedProvider = {kind: "ollama", model: "embeddinggemma"}`
     *       and the per-provider file is missing, `read()` MUST fall back
     *       to the legacy `zotero-ai-explain-index.json` filename.
     *   P2. `read()` is PURE (AC-12 SP-12.4 / AC-5 FINDING-1) — a legacy
     *       fallback returns the parsed legacy data and issues NO
     *       `writeString`/`remove`/`rename`. The legacy file is NOT
     *       copied to the per-provider name by `read()`; the per-provider
     *       file is (re)created by the next real `write()` instead.
     *       (Codex S9 FINDING-2: the prior copy was a read-path mutation.)
     *   P3. If the per-provider file exists, the legacy filename is
     *       IGNORED (new wins; legacy is stale).
     *   P4. If the embed provider is NOT ollama/embeddinggemma, the
     *       legacy file is NOT considered (legacy only ever held
     *       ollama/embeddinggemma vectors).
     *   P5. A malformed legacy file MUST yield null, NOT throw.
     *   P6. Every legacy fallback read returns the same parsed legacy
     *       data — there is no copy to fail, so a read-only disk never
     *       blocks the read.
     */

    const legacyPath = "/var/test-fixture/zotero-data/zotero-ai-explain-index.json";
    const newPath =
      "/var/test-fixture/zotero-data/zotero-ai-explain-index-ollama-embeddinggemma.json";

    function makeOllamaEmbedStorage(
      io: IndexStorageIoLike,
      dataDir = "/var/test-fixture/zotero-data"
    ) {
      const deps: CreateIndexStorageDeps = {
        zotero: { DataDirectory: { dir: dataDir } },
        io,
        embedProvider: { kind: "ollama", model: "embeddinggemma" }
      };
      return createIndexStorage(deps);
    }

    it("falls back to the legacy filename when the new per-provider file is missing", async () => {
      const { io } = makeIo({ [legacyPath]: JSON.stringify(validFile) });
      const storage = makeOllamaEmbedStorage(io);
      const result = await storage.read();
      expect(result).toEqual(validFile);
    });

    it("read() does NOT copy the legacy file to the per-provider path (read stays pure)", async () => {
      // AC-12 SP-12.4 / codex S9 FINDING-2: a legacy fallback `read()`
      // returns the parsed data WITHOUT writing the per-provider file —
      // the read path issues no `writeString`. The per-provider file is
      // created by the next real `write()`, not as a read side effect.
      const { io, files } = makeIo({ [legacyPath]: JSON.stringify(validFile) });
      const storage = makeOllamaEmbedStorage(io);
      const result = await storage.read();
      expect(result).toEqual(validFile);
      // No copy: the per-provider file is NOT created by the read.
      expect(files.has(newPath)).toBe(false);
      // The legacy file is left alone — we don't destroy user data.
      expect(files.has(legacyPath)).toBe(true);
    });

    it("repeated legacy-fallback reads all return the legacy data (pure, no copy)", async () => {
      const { io } = makeIo({ [legacyPath]: JSON.stringify(validFile) });
      const storage = makeOllamaEmbedStorage(io);
      // Every read falls back to the legacy file directly — there is no
      // one-time copy, so the second read behaves identically to the
      // first. (The per-provider fast path is restored by `write()`.)
      expect(await storage.read()).toEqual(validFile);
      expect(await storage.read()).toEqual(validFile);
    });

    it("a write() after a legacy read creates the per-provider file (fast path restored)", async () => {
      // The per-provider file is (re)created by the next real `write()`,
      // not by `read()`. After a write, reads hit the per-provider path.
      const { io, files } = makeIo({ [legacyPath]: JSON.stringify(validFile) });
      const storage = makeOllamaEmbedStorage(io);
      await storage.read();
      expect(files.has(newPath)).toBe(false);

      await storage.write(validFile);
      expect(files.has(newPath)).toBe(true);

      // With the per-provider file present, a read no longer needs the
      // legacy fallback.
      files.delete(legacyPath);
      expect(await storage.read()).toEqual(validFile);
    });

    it("prefers the new per-provider file when BOTH legacy and new exist (legacy is stale)", async () => {
      const stale: IndexFile = {
        schemaVersion: 2,
        items: { OLD: { title: "Old", chunks: [] } },
        indexedAt: "1970-01-01T00:00:00Z"
      };
      const { io } = makeIo({
        [legacyPath]: JSON.stringify(stale),
        [newPath]: JSON.stringify(validFile)
      });
      const storage = makeOllamaEmbedStorage(io);
      const result = await storage.read();
      expect(result).toEqual(validFile);
    });

    it("does NOT fall back to legacy when the embed provider is openai", async () => {
      // Legacy only ever held ollama/embeddinggemma vectors. OpenAI has
      // different dimensions; mixing them would corrupt cosine scores.
      const { io } = makeIo({ [legacyPath]: JSON.stringify(validFile) });
      const storage = createIndexStorage({
        zotero: { DataDirectory: { dir: "/var/test-fixture/zotero-data" } },
        io,
        embedProvider: { kind: "openai", model: "text-embedding-3-large" }
      });
      await expect(storage.read()).resolves.toBeNull();
    });

    it("does NOT fall back to legacy when the embed provider is ollama with a DIFFERENT model", async () => {
      const { io } = makeIo({ [legacyPath]: JSON.stringify(validFile) });
      const storage = createIndexStorage({
        zotero: { DataDirectory: { dir: "/var/test-fixture/zotero-data" } },
        io,
        embedProvider: { kind: "ollama", model: "nomic-embed-text" }
      });
      await expect(storage.read()).resolves.toBeNull();
    });

    it("returns null when the legacy file exists but is malformed JSON", async () => {
      const { io } = makeIo({ [legacyPath]: "not json{" });
      const storage = makeOllamaEmbedStorage(io);
      await expect(storage.read()).resolves.toBeNull();
    });

    it("returns null when the legacy file is shape-mismatched (missing `items`)", async () => {
      const { io } = makeIo({
        [legacyPath]: JSON.stringify({ indexedAt: "2026-05-17T00:00:00Z" })
      });
      const storage = makeOllamaEmbedStorage(io);
      await expect(storage.read()).resolves.toBeNull();
    });

    it("a legacy-fallback read() issues NO writeString — it is pure (FINDING-2)", async () => {
      // AC-12 SP-12.4: `read()` is pure. A legacy fallback must NOT copy
      // the file to the per-provider name. A spy IO whose `writeString`
      // throws on any call proves the read path never writes: if `read()`
      // still attempted the (removed) copy this would surface the error
      // OR populate `newPath`. Neither must happen.
      const files = new Map<string, string>([[legacyPath, JSON.stringify(validFile)]]);
      let writeStringCalls = 0;
      const io: IndexStorageIoLike = {
        async readString(p) {
          await Promise.resolve();
          const v = files.get(p);
          if (v === undefined) throw new Error(`ENOENT: ${p}`);
          return v;
        },
        async writeString() {
          await Promise.resolve();
          writeStringCalls += 1;
          throw new Error("EROFS: read-only filesystem");
        },
        async remove(p) {
          await Promise.resolve();
          files.delete(p);
        },
        async exists(p) {
          await Promise.resolve();
          return files.has(p);
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
        }
      };
      const storage = makeOllamaEmbedStorage(io);
      const result = await storage.read();
      expect(result).toEqual(validFile);
      // The read path issued zero writes — it is genuinely pure.
      expect(writeStringCalls).toBe(0);
      // No copy: the per-provider path stays empty.
      expect(files.has(newPath)).toBe(false);
    });

    it("does NOT fall back to legacy when no embedProvider is supplied (legacy path IS the active path)", async () => {
      // Without embedProvider, `path()` already resolves to the legacy
      // filename. The fallback would be a self-read, which read() should
      // simply do once. Verify the behaviour is "read legacy directly".
      const { io } = makeIo({ [legacyPath]: JSON.stringify(validFile) });
      const storage = makeStorage(io);
      const result = await storage.read();
      expect(result).toEqual(validFile);
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
});
