import { describe, expect, it } from "vitest";

import {
  cosineSimilarity,
  EmbeddingDimensionMismatchError,
  loadIndex,
  topKChunks
} from "../../src/indexing/index-search.js";
import type { IndexFile } from "../../src/indexing/library-crawler.js";
import type { IndexStorage } from "../../src/indexing/index-storage.js";

function fakeStorage(file: IndexFile | null): IndexStorage {
  return {
    read() {
      return Promise.resolve(file);
    },
    readWithMigration() {
      return Promise.resolve({ file, migrationPending: false });
    },
    readItemCount() {
      return Promise.resolve(file === null ? 0 : Object.keys(file.items).length);
    },
    write() {
      return Promise.resolve();
    },
    writeItem() {
      return Promise.resolve();
    },
    writeTmp() {
      return Promise.resolve();
    },
    commitMigration() {
      return Promise.resolve();
    },
    abandonMigration() {
      return Promise.resolve();
    },
    writeMarker() {
      return Promise.resolve();
    },
    removeMarker() {
      return Promise.resolve();
    },
    hasMarker() {
      return Promise.resolve(false);
    },
    clear() {
      return Promise.resolve();
    },
    path() {
      return "/var/test-fixture/index.json";
    }
  };
}

function makeIndex(
  items: Record<string, { title: string; chunks: { text: string; embedding: number[] }[] }>
): IndexFile {
  // Stamp the v0.3.0 required `sourceKind` (and `schemaVersion`) so the
  // black-box test fixtures stay terse — these tests exercise cosine
  // retrieval, not chunk provenance, so a uniform "metadata" kind is
  // a faithful stand-in.
  const stamped: IndexFile["items"] = {};
  for (const [key, item] of Object.entries(items)) {
    stamped[key] = {
      title: item.title,
      chunks: item.chunks.map((chunk) => ({ ...chunk, sourceKind: "metadata" as const }))
    };
  }
  return { schemaVersion: 2, items: stamped, indexedAt: new Date(0).toISOString() };
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical unit-vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 10);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1, 10);
  });

  it("ignores magnitude (cosine is scale-invariant)", () => {
    // [3,4] vs [6,8] are parallel; cosine must be exactly 1.
    expect(cosineSimilarity([3, 4], [6, 8])).toBeCloseTo(1, 10);
  });

  it("returns 0 when one vector is all zeros (degenerate, avoids NaN)", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it("throws EmbeddingDimensionMismatchError on length mismatch", () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow(EmbeddingDimensionMismatchError);
  });
});

describe("topKChunks", () => {
  it("returns chunks sorted by descending similarity to the query", () => {
    const index = makeIndex({
      A: {
        title: "Alpha",
        chunks: [
          { text: "best match", embedding: [1, 0, 0] },
          { text: "orthogonal", embedding: [0, 1, 0] }
        ]
      },
      B: {
        title: "Beta",
        chunks: [{ text: "close", embedding: [0.9, 0.1, 0] }]
      }
    });
    const result = topKChunks(index, [1, 0, 0], 3);
    expect(result).toHaveLength(3);
    expect(result[0]?.text).toBe("best match");
    expect(result[0]?.itemKey).toBe("A");
    expect(result[0]?.title).toBe("Alpha");
    expect(result[1]?.text).toBe("close");
    expect(result[1]?.itemKey).toBe("B");
    expect(result[2]?.text).toBe("orthogonal");
    expect(result[0]?.score).toBeGreaterThan(result[1]?.score ?? Infinity);
    expect(result[1]?.score).toBeGreaterThan(result[2]?.score ?? Infinity);
  });

  it("respects K when the index has more candidate chunks", () => {
    const index = makeIndex({
      A: {
        title: "A",
        chunks: [
          { text: "c1", embedding: [1, 0] },
          { text: "c2", embedding: [0.9, 0.1] },
          { text: "c3", embedding: [0, 1] }
        ]
      }
    });
    const result = topKChunks(index, [1, 0], 2);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.text)).toEqual(["c1", "c2"]);
  });

  it("returns [] for an empty index", () => {
    const index = makeIndex({});
    expect(topKChunks(index, [1, 0, 0], 5)).toEqual([]);
  });

  it("returns [] when K is zero", () => {
    const index = makeIndex({
      A: { title: "A", chunks: [{ text: "c", embedding: [1, 0] }] }
    });
    expect(topKChunks(index, [1, 0], 0)).toEqual([]);
  });

  it("throws EmbeddingDimensionMismatchError when query/chunk dims differ", () => {
    const index = makeIndex({
      A: { title: "A", chunks: [{ text: "c", embedding: [1, 0, 0] }] }
    });
    expect(() => topKChunks(index, [1, 0], 1)).toThrow(EmbeddingDimensionMismatchError);
  });

  it("skips items that contain zero chunks without failing", () => {
    const index = makeIndex({
      A: { title: "A", chunks: [] },
      B: { title: "B", chunks: [{ text: "b1", embedding: [1, 0] }] }
    });
    const result = topKChunks(index, [1, 0], 5);
    expect(result).toHaveLength(1);
    expect(result[0]?.itemKey).toBe("B");
  });
});

describe("loadIndex", () => {
  it("returns the persisted file when the storage holds one", async () => {
    const file = makeIndex({
      A: { title: "A", chunks: [{ text: "c", embedding: [1] }] }
    });
    const storage = fakeStorage(file);
    await expect(loadIndex(storage)).resolves.toBe(file);
  });

  it("returns null when storage has no file", async () => {
    await expect(loadIndex(fakeStorage(null))).resolves.toBeNull();
  });
});
