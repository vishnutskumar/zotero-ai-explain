/**
 * Adversarial unit tests for AC-3 — in-PDF RAG auto-scope via the
 * request-scoped `topKChunks(..., { scopedItemKey })` 4th argument.
 *
 * Plan: `docs/superpowers/plans/2026-05-19-pdf-context-features.md`
 *   AC-3 description           L422-433 (adversarial cases L430-433)
 *   AC-3 interface contracts   L629-660
 *   AC-3 Modify notes          L290-294
 *
 * --------------------------------------------------------------------
 * Fault Localization (Template 4 — AC-3 scoped retrieval)
 * --------------------------------------------------------------------
 *
 * 1. Spec semantics (premises):
 *    P1.  `topKChunks(indexFile, queryEmbedding, k, options?)` — the
 *         4th `options` parameter is OPTIONAL. Calls with three args
 *         (the library-chat call site at zotero-runtime.ts:1048) must
 *         keep working unchanged: library-wide retrieval (contract
 *         L636-641, SP7 L105).
 *    P2.  When `options.scopedItemKey` is a string, retrieval is
 *         filtered: only chunks whose source itemKey EQUALS
 *         `scopedItemKey` are eligible to be ranked/returned. Chunks
 *         from every other item are excluded (AC-3 L424).
 *    P3.  When `options` is `undefined` OR `options.scopedItemKey` is
 *         `undefined`, retrieval is unscoped (library-wide) — identical
 *         to the 3-arg behavior (Adv-2, L432).
 *    P4.  `scopedItemKey` set to a key with NO chunks in the index ⇒
 *         retrieval returns `[]` (Adv-1, L431). Empty, not an error.
 *    P5.  The returned `RetrievedChunk` carries `itemKey`, `title`,
 *         `text`, `score`, and the v0.3.0 optional provenance fields
 *         `chunkIndex?`, `pageIndex?`, `attachmentKey?`, `sourceKind?`
 *         (contract L644-659). `pageIndex: 0` is preserved as a valid
 *         value, never conflated with `undefined` (SP1 L99).
 *    P6.  `topKChunks` is PURE — calling it with a scoped options bag
 *         must not mutate `indexFile` or the `options` object, so two
 *         in-flight requests with different scopes never interfere
 *         (Adv-3, L433 — no shared mutable state).
 *    P7.  `k <= 0` returns `[]` even when a scope is set.
 *    P8.  A dimension mismatch still throws `EmbeddingDimensionMismatchError`
 *         — but ONLY for chunks that survive the scope filter. (A
 *         scoped query must not blow up on an out-of-scope item whose
 *         embeddings have a different dimension.)
 *
 * 2. Code path trace (against the contract — body NOT inspected):
 *    - `topKChunks` iterates `indexFile.items`; with `scopedItemKey`
 *      set it skips items whose key !== scopedItemKey, scores the rest
 *      by cosine, sorts desc, slices top-K.
 *
 * 3. Divergence analysis (where the impl could fail the spec):
 *    D1 [HIGH]   scope filter applied to the WRONG key field (e.g.
 *                attachmentKey instead of itemKey) → wrong chunks.
 *    D2 [HIGH]   scoped key with zero matching chunks throws or returns
 *                library-wide results instead of `[]`.
 *    D3 [HIGH]   3-arg call site regressed by the new optional param.
 *    D4 [MEDIUM] dimension mismatch on an OUT-OF-SCOPE item bubbles up
 *                even though that item should have been filtered first.
 *    D5 [MEDIUM] `topKChunks` mutates the options bag / index → cross
 *                -request contamination.
 *    D6 [LOW]    provenance fields (pageIndex:0) dropped from the
 *                returned chunk.
 *
 * 4. Test targets, ranked: D1 > D2 > D3 > D4 > D5 > D6.
 */

import { describe, expect, it } from "vitest";

import { EmbeddingDimensionMismatchError, topKChunks } from "../../src/indexing/index-search.js";
import type { IndexFile, IndexedItemChunk } from "../../src/indexing/library-crawler.js";

type ChunkSpec = {
  readonly text: string;
  readonly embedding: number[];
  readonly sourceKind?: IndexedItemChunk["sourceKind"];
  readonly pageIndex?: number;
  readonly attachmentKey?: string;
};

/**
 * Build a realistic v0.3.0 IndexFile. Each item's chunks default to
 * `sourceKind: "metadata"` unless the spec overrides it — these tests
 * exercise the scope filter, not chunk provenance, so a uniform kind
 * keeps the fixtures terse while staying schema-valid.
 */
function makeIndex(items: Record<string, { title: string; chunks: ChunkSpec[] }>): IndexFile {
  const stamped: IndexFile["items"] = {};
  for (const [key, item] of Object.entries(items)) {
    stamped[key] = {
      title: item.title,
      chunks: item.chunks.map((chunk) => {
        const base: IndexedItemChunk = {
          text: chunk.text,
          embedding: chunk.embedding,
          sourceKind: chunk.sourceKind ?? "metadata"
        };
        // Only attach the optional provenance fields when supplied so
        // the fixture mirrors how a real crawl stamps them (absent =
        // `undefined`, never `null`).
        return {
          ...base,
          ...(chunk.pageIndex !== undefined ? { pageIndex: chunk.pageIndex } : {}),
          ...(chunk.attachmentKey !== undefined ? { attachmentKey: chunk.attachmentKey } : {})
        };
      })
    };
  }
  return { schemaVersion: 2, items: stamped, indexedAt: new Date(0).toISOString() };
}

describe("topKChunks — AC-3 scoped retrieval", () => {
  it("D1: with scopedItemKey set, returns ONLY chunks from that item", () => {
    const index = makeIndex({
      PAPER001: {
        title: "Scoped paper",
        chunks: [
          { text: "in-scope best", embedding: [1, 0, 0] },
          { text: "in-scope close", embedding: [0.95, 0.05, 0] }
        ]
      },
      OTHER999: {
        title: "Different paper",
        chunks: [
          // This chunk is an even BETTER cosine match than the scoped
          // ones — if the filter is missing it would rank first.
          { text: "out-of-scope perfect match", embedding: [1, 0, 0] }
        ]
      }
    });

    const result = topKChunks(index, [1, 0, 0], 10, { scopedItemKey: "PAPER001" });

    expect(result).toHaveLength(2);
    expect(result.every((c) => c.itemKey === "PAPER001")).toBe(true);
    expect(result.map((c) => c.text)).not.toContain("out-of-scope perfect match");
  });

  it("D1: the scope filter keys off itemKey, not attachmentKey or title", () => {
    // Two items share an attachmentKey value on their chunks; the scope
    // must still resolve by the item's key (the Object.entries key),
    // not the chunk's attachmentKey field.
    const index = makeIndex({
      ITEMAAAA: {
        title: "shared-attachment-name",
        chunks: [{ text: "from item A", embedding: [1, 0], attachmentKey: "ATT" }]
      },
      ITEMBBBB: {
        title: "shared-attachment-name",
        chunks: [{ text: "from item B", embedding: [1, 0], attachmentKey: "ATT" }]
      }
    });

    const result = topKChunks(index, [1, 0], 10, { scopedItemKey: "ITEMBBBB" });

    expect(result).toHaveLength(1);
    expect(result[0]?.itemKey).toBe("ITEMBBBB");
    expect(result[0]?.text).toBe("from item B");
  });

  it("D2: scopedItemKey with NO matching chunks returns [] (not library-wide, not throw)", () => {
    const index = makeIndex({
      PAPER001: { title: "A", chunks: [{ text: "a", embedding: [1, 0] }] },
      PAPER002: { title: "B", chunks: [{ text: "b", embedding: [0, 1] }] }
    });

    let result: readonly unknown[] | undefined;
    expect(() => {
      result = topKChunks(index, [1, 0], 5, { scopedItemKey: "NOSUCHITEM" });
    }).not.toThrow();
    expect(result).toEqual([]);
  });

  it("D2: scopedItemKey pointing at an item with an empty chunks array returns []", () => {
    const index = makeIndex({
      EMPTY001: { title: "Empty", chunks: [] },
      FULL0002: { title: "Full", chunks: [{ text: "x", embedding: [1, 0] }] }
    });

    expect(topKChunks(index, [1, 0], 5, { scopedItemKey: "EMPTY001" })).toEqual([]);
  });

  it("D3 (regression): the 3-arg call site stays library-wide and unchanged", () => {
    // This is the exact zotero-runtime.ts:1048 library-chat shape — no
    // options bag. It must keep returning chunks from every item.
    const index = makeIndex({
      PAPER001: { title: "A", chunks: [{ text: "from A", embedding: [1, 0, 0] }] },
      PAPER002: { title: "B", chunks: [{ text: "from B", embedding: [0.9, 0.1, 0] }] },
      PAPER003: { title: "C", chunks: [{ text: "from C", embedding: [0, 1, 0] }] }
    });

    const result = topKChunks(index, [1, 0, 0], 8);

    expect(result.map((c) => c.itemKey).sort()).toEqual(["PAPER001", "PAPER002", "PAPER003"]);
  });

  it("D3 (regression): an explicit undefined options bag is equivalent to omitting it", () => {
    const index = makeIndex({
      PAPER001: { title: "A", chunks: [{ text: "from A", embedding: [1, 0] }] },
      PAPER002: { title: "B", chunks: [{ text: "from B", embedding: [0, 1] }] }
    });

    const omitted = topKChunks(index, [1, 0], 8);
    const explicitUndefined = topKChunks(index, [1, 0], 8, undefined);
    expect(explicitUndefined.map((c) => c.itemKey).sort()).toEqual(
      omitted.map((c) => c.itemKey).sort()
    );
  });

  it("D3 (regression): an options bag with scopedItemKey undefined is library-wide", () => {
    const index = makeIndex({
      PAPER001: { title: "A", chunks: [{ text: "from A", embedding: [1, 0] }] },
      PAPER002: { title: "B", chunks: [{ text: "from B", embedding: [0, 1] }] }
    });

    const result = topKChunks(index, [1, 0], 8, { scopedItemKey: undefined });
    expect(result.map((c) => c.itemKey).sort()).toEqual(["PAPER001", "PAPER002"]);
  });

  it("D4: a dimension mismatch on an OUT-OF-SCOPE item must not surface when scoped away", () => {
    // The scoped item's embeddings match the query dimension; an
    // unrelated item carries 2-D embeddings. A scoped query for the
    // 3-D item must filter the 2-D item BEFORE cosineSimilarity ever
    // sees it — otherwise the dimension-mismatch error leaks.
    const index = makeIndex({
      GOOD0001: {
        title: "Right dimension",
        chunks: [{ text: "scoped hit", embedding: [1, 0, 0] }]
      },
      BAD00002: {
        title: "Wrong dimension",
        chunks: [{ text: "ignored", embedding: [1, 0] }]
      }
    });

    let result: readonly { itemKey: string }[] | undefined;
    expect(() => {
      result = topKChunks(index, [1, 0, 0], 5, { scopedItemKey: "GOOD0001" });
    }).not.toThrow();
    expect(result).toHaveLength(1);
    expect(result?.[0]?.itemKey).toBe("GOOD0001");
  });

  it("D4: a dimension mismatch INSIDE the scoped item still throws", () => {
    // The scope filter is not an excuse to swallow a real mismatch on
    // a chunk the caller asked for.
    const index = makeIndex({
      GOOD0001: { title: "Mismatched", chunks: [{ text: "x", embedding: [1, 0] }] }
    });

    expect(() => topKChunks(index, [1, 0, 0], 5, { scopedItemKey: "GOOD0001" })).toThrow(
      EmbeddingDimensionMismatchError
    );
  });

  it("D5 (no shared mutable state): two scoped calls with different keys are independent", () => {
    const index = makeIndex({
      PAPER001: { title: "A", chunks: [{ text: "from A", embedding: [1, 0] }] },
      PAPER002: { title: "B", chunks: [{ text: "from B", embedding: [1, 0] }] }
    });

    const first = topKChunks(index, [1, 0], 5, { scopedItemKey: "PAPER001" });
    const second = topKChunks(index, [1, 0], 5, { scopedItemKey: "PAPER002" });
    // The first call must not have polluted the index/options so the
    // second sees its own scope (Adv-3 — multi-window concurrent reads).
    expect(first.map((c) => c.itemKey)).toEqual(["PAPER001"]);
    expect(second.map((c) => c.itemKey)).toEqual(["PAPER002"]);
    // And the first result is still PAPER001 after the second call ran.
    expect(first.map((c) => c.itemKey)).toEqual(["PAPER001"]);
  });

  it("D5: topKChunks does not mutate the passed options object", () => {
    const index = makeIndex({
      PAPER001: { title: "A", chunks: [{ text: "a", embedding: [1, 0] }] }
    });
    const options = { scopedItemKey: "PAPER001" };
    const snapshot = JSON.stringify(options);
    topKChunks(index, [1, 0], 5, options);
    expect(JSON.stringify(options)).toBe(snapshot);
  });

  it("k <= 0 returns [] even with a scope set", () => {
    const index = makeIndex({
      PAPER001: { title: "A", chunks: [{ text: "a", embedding: [1, 0] }] }
    });
    expect(topKChunks(index, [1, 0], 0, { scopedItemKey: "PAPER001" })).toEqual([]);
  });

  it("D6: pageIndex 0 on a scoped pdf-page chunk is preserved as 0 in the result", () => {
    const index = makeIndex({
      PDFITEM1: {
        title: "PDF paper",
        chunks: [
          {
            text: "first page text",
            embedding: [1, 0, 0],
            sourceKind: "pdf-page",
            pageIndex: 0,
            attachmentKey: "ATT12345"
          },
          {
            text: "third page text",
            embedding: [0.9, 0.1, 0],
            sourceKind: "pdf-page",
            pageIndex: 2,
            attachmentKey: "ATT12345"
          }
        ]
      }
    });

    const result = topKChunks(index, [1, 0, 0], 5, { scopedItemKey: "PDFITEM1" });
    const page0 = result.find((c) => c.text === "first page text");
    expect(page0).toBeDefined();
    // Explicit `=== 0` and `!== undefined` — pageIndex 0 must NOT be
    // conflated with "no page" (SP1).
    expect(page0?.pageIndex).toBe(0);
    expect(page0?.pageIndex).not.toBeUndefined();
    expect(typeof page0?.pageIndex).toBe("number");
    expect(page0?.attachmentKey).toBe("ATT12345");
    expect(page0?.sourceKind).toBe("pdf-page");
  });

  it("scoped retrieval still ranks by descending cosine similarity within the scope", () => {
    const index = makeIndex({
      PAPER001: {
        title: "Ranked",
        chunks: [
          { text: "weak", embedding: [0.2, 0.98, 0] },
          { text: "strong", embedding: [1, 0, 0] },
          { text: "medium", embedding: [0.7, 0.71, 0] }
        ]
      }
    });

    const result = topKChunks(index, [1, 0, 0], 3, { scopedItemKey: "PAPER001" });
    expect(result.map((c) => c.text)).toEqual(["strong", "medium", "weak"]);
  });

  it("scoped retrieval respects k when the scoped item has more chunks", () => {
    const index = makeIndex({
      PAPER001: {
        title: "Many chunks",
        chunks: [
          { text: "c1", embedding: [1, 0] },
          { text: "c2", embedding: [0.9, 0.1] },
          { text: "c3", embedding: [0.8, 0.2] },
          { text: "c4", embedding: [0, 1] }
        ]
      }
    });

    const result = topKChunks(index, [1, 0], 2, { scopedItemKey: "PAPER001" });
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.text)).toEqual(["c1", "c2"]);
  });
});
