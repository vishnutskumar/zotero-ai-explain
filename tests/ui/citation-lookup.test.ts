/**
 * Fault Localization: AC-6 — citation-token parsing + per-turn lookup table
 * (`parseCitationToken`, `buildCitationLookup` from `src/ui/citation-lookup.ts`)
 *
 * ### PHASE 1 — SPEC SEMANTICS
 * - PREMISE S1: `parseCitationToken` parses `[ITEMKEY]` and `[ITEMKEY#3]` bracket
 *   tokens. ITEMKEY is exactly 8 uppercase-alphanumeric chars (`/[A-Z0-9]{8}/`).
 *   `[ITEMKEY]` (no `#`) ⇒ `{itemKey, chunkIndex: undefined}`. `[ITEMKEY#3]` ⇒
 *   `{itemKey, chunkIndex: 3}`. `[ITEMKEY#0]` ⇒ `{itemKey, chunkIndex: 0}`
 *   (0 is a valid chunk index, not a "missing" sentinel).
 * - PREMISE S2: malformed tokens return `null` — lowercase keys, wrong length,
 *   empty bracket, dangling `#`, non-numeric chunk-index, no brackets at all.
 * - PREMISE S3: `buildCitationLookup` builds a `ReadonlyMap` keyed by the FULL
 *   token `${itemKey}#${chunkIndex}` — NOT by bare `itemKey`. Keying by the full
 *   token is the hallucination guard: a hallucinated chunk-index produces a key
 *   that simply isn't in the map.
 * - PREMISE S4: each lookup entry carries `{itemKey, attachmentKey?, pageIndex?,
 *   text}` derived from the source `RetrievedChunk`.
 *
 * ### PHASE 2 — CODE PATH TRACE (adjacent code)
 * - METHOD: `topKChunks` | LOCATION: src/indexing/index-search.ts | BEHAVIOR:
 *   returns `RetrievedChunk[]` now widened with `chunkIndex/pageIndex/
 *   attachmentKey/sourceKind` (S2/S3 landed). RELEVANCE: `buildCitationLookup`
 *   consumes exactly that shape; `chunkIndex` MUST be set by `topKChunks` for
 *   the key to be well-formed.
 * - METHOD: `CITATION_PATTERN` | LOCATION: src/ui/library-chat-view.ts:46 |
 *   BEHAVIOR (current): `/\[([A-Za-z0-9_]{3,32})\]/gu` — accepts 3-32 word
 *   chars, NO `#chunkIndex` half. RELEVANCE: the new parser must accept the
 *   `#` half and tighten the key shape to exactly 8 upper-alphanumeric.
 *
 * ### PHASE 3 — DIVERGENCE ANALYSIS
 * - CLAIM D1: parser may treat `[ITEMKEY#0]` as chunkIndex-absent if it uses a
 *   truthy check on the captured group instead of `!== undefined`.
 * - CLAIM D2: parser may accept lowercase / wrong-length keys (the legacy regex
 *   was `[A-Za-z0-9_]{3,32}`); spec demands exactly `[A-Z0-9]{8}`.
 * - CLAIM D3: `buildCitationLookup` may key by bare `itemKey` (defeating the
 *   hallucinated-chunk-index guard) or skip chunks with `chunkIndex === undefined`.
 * - CLAIM D4: a chunk with `chunkIndex: 0` may be dropped if the builder filters
 *   on truthiness of `chunkIndex`.
 *
 * ### PHASE 4 — TEST TARGETS
 * 1. D2 — malformed-token rejection (lowercase, length, empty, dangling #).
 * 2. D1/D4 — chunkIndex 0 round-trips as 0, not undefined / not dropped.
 * 3. D3 — lookup keyed by full token; bare itemKey misses.
 * 4. happy-path parse + build.
 *
 * Black-box: imports only the public exports of `src/ui/citation-lookup.ts`
 * and the `RetrievedChunk` type. No implementation bodies inspected.
 */

import { describe, expect, it } from "vitest";

import {
  buildCitationLookup,
  parseCitationToken,
  resolveCitation
} from "../../src/ui/citation-lookup.js";
import type { RetrievedChunk } from "../../src/indexing/index-search.js";

function chunk(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    itemKey: "ABCD1234",
    title: "Title",
    text: "excerpt text",
    score: 0.9,
    chunkIndex: 0,
    ...over
  };
}

describe("parseCitationToken", () => {
  it("parses a bare [ITEMKEY] token with chunkIndex undefined", () => {
    const parsed = parseCitationToken("[ABCD1234]");
    expect(parsed).not.toBeNull();
    expect(parsed?.itemKey).toBe("ABCD1234");
    expect(parsed?.chunkIndex).toBeUndefined();
  });

  it("parses a [ITEMKEY#3] token capturing both halves", () => {
    const parsed = parseCitationToken("[ABCD1234#3]");
    expect(parsed).not.toBeNull();
    expect(parsed?.itemKey).toBe("ABCD1234");
    expect(parsed?.chunkIndex).toBe(3);
  });

  it("parses [ITEMKEY#0] with chunkIndex strictly equal to 0 (not undefined)", () => {
    // Adversarial: 0 is a real chunk index. A truthy check would lose it.
    const parsed = parseCitationToken("[ABCD1234#0]");
    expect(parsed).not.toBeNull();
    expect(parsed?.chunkIndex).toBe(0);
    expect(parsed?.chunkIndex).not.toBeUndefined();
  });

  it("parses a multi-digit chunk index", () => {
    const parsed = parseCitationToken("[ABCD1234#127]");
    expect(parsed?.chunkIndex).toBe(127);
  });

  it("returns null for a lowercase item key [abcd1234]", () => {
    // Adversarial D2: spec key alphabet is [A-Z0-9], not [A-Za-z0-9_].
    expect(parseCitationToken("[abcd1234]")).toBeNull();
  });

  it("returns null for the short malformed token [abc]", () => {
    expect(parseCitationToken("[abc]")).toBeNull();
  });

  it("returns null for a key shorter than 8 chars [ABCD123]", () => {
    expect(parseCitationToken("[ABCD123]")).toBeNull();
  });

  it("returns null for a key longer than 8 chars [ABCD12345]", () => {
    expect(parseCitationToken("[ABCD12345]")).toBeNull();
  });

  it("returns null for a dangling-hash token [ABCD1234#]", () => {
    // Adversarial: `#` present but no digits after it.
    expect(parseCitationToken("[ABCD1234#]")).toBeNull();
  });

  it("returns null for a non-numeric chunk index [ABCD1234#x]", () => {
    expect(parseCitationToken("[ABCD1234#x]")).toBeNull();
  });

  it("returns null for an empty bracket []", () => {
    expect(parseCitationToken("[]")).toBeNull();
  });

  it("returns null for a token with no brackets at all (ABCD1234)", () => {
    expect(parseCitationToken("ABCD1234")).toBeNull();
  });

  it("returns null for a key containing a non-alphanumeric char", () => {
    expect(parseCitationToken("[ABCD_234]")).toBeNull();
    expect(parseCitationToken("[ABCD-234]")).toBeNull();
  });
});

describe("buildCitationLookup", () => {
  it("keys entries by the full `${itemKey}#${chunkIndex}` token", () => {
    const lookup = buildCitationLookup([
      chunk({ itemKey: "ABCD1234", chunkIndex: 0 }),
      chunk({ itemKey: "ABCD1234", chunkIndex: 1 })
    ]);
    expect(lookup.has("ABCD1234#0")).toBe(true);
    expect(lookup.has("ABCD1234#1")).toBe(true);
  });

  it("does NOT key entries by the bare itemKey (hallucination guard)", () => {
    // Adversarial D3: keying by bare itemKey would let `[ABCD1234#99]` match
    // chunk 0's source. The full-token key makes that miss.
    const lookup = buildCitationLookup([chunk({ itemKey: "ABCD1234", chunkIndex: 0 })]);
    expect(lookup.has("ABCD1234")).toBe(false);
    expect(lookup.get("ABCD1234")).toBeUndefined();
  });

  it("includes a chunk whose chunkIndex is 0 (not dropped by a truthy filter)", () => {
    // Adversarial D4.
    const lookup = buildCitationLookup([chunk({ itemKey: "WXYZ5678", chunkIndex: 0 })]);
    expect(lookup.get("WXYZ5678#0")).toBeDefined();
  });

  it("carries attachmentKey, pageIndex, and text onto the entry", () => {
    const lookup = buildCitationLookup([
      chunk({
        itemKey: "ABCD1234",
        chunkIndex: 2,
        attachmentKey: "ATT00001",
        pageIndex: 16,
        text: "page seventeen body"
      })
    ]);
    const entry = lookup.get("ABCD1234#2");
    expect(entry).toBeDefined();
    expect(entry?.itemKey).toBe("ABCD1234");
    expect(entry?.attachmentKey).toBe("ATT00001");
    expect(entry?.pageIndex).toBe(16);
    expect(entry?.text).toBe("page seventeen body");
  });

  it("preserves pageIndex 0 on the entry (not coerced to undefined)", () => {
    // Adversarial: page 0 is a valid first page.
    const lookup = buildCitationLookup([chunk({ chunkIndex: 1, pageIndex: 0 })]);
    expect(lookup.get("ABCD1234#1")?.pageIndex).toBe(0);
  });

  it("leaves pageIndex/attachmentKey undefined for a metadata/note chunk", () => {
    const lookup = buildCitationLookup([
      chunk({ itemKey: "META0001", chunkIndex: 0, sourceKind: "metadata" })
    ]);
    const entry = lookup.get("META0001#0");
    expect(entry).toBeDefined();
    expect(entry?.pageIndex).toBeUndefined();
    expect(entry?.attachmentKey).toBeUndefined();
  });

  it("builds two distinct entries for two chunks of the SAME item, different pages", () => {
    // Adversarial chunk-collision: AC-9's scenario at the lookup-table level.
    const lookup = buildCitationLookup([
      chunk({ itemKey: "ABCD1234", chunkIndex: 0, pageIndex: 2 }),
      chunk({ itemKey: "ABCD1234", chunkIndex: 1, pageIndex: 17 })
    ]);
    expect(lookup.get("ABCD1234#0")?.pageIndex).toBe(2);
    expect(lookup.get("ABCD1234#1")?.pageIndex).toBe(17);
  });

  it("returns an empty map for an empty chunk list", () => {
    const lookup = buildCitationLookup([]);
    expect(lookup.size).toBe(0);
  });
});

describe("resolveCitation", () => {
  it("full-key hit: returns the entry verbatim with attachmentKey + pageIndex", () => {
    // Spec branch 1 — `[ABCD1234#3]` with a matching chunk in the
    // lookup MUST surface the chunk-scoped fields so the click handler
    // can jump to the cited page.
    const lookup = buildCitationLookup([
      chunk({
        itemKey: "ABCD1234",
        chunkIndex: 3,
        attachmentKey: "ATT00007",
        pageIndex: 16,
        text: "page seventeen text"
      })
    ]);
    const entry = resolveCitation({ itemKey: "ABCD1234", chunkIndex: 3 }, lookup);
    expect(entry).toBeDefined();
    expect(entry?.itemKey).toBe("ABCD1234");
    expect(entry?.attachmentKey).toBe("ATT00007");
    expect(entry?.pageIndex).toBe(16);
    expect(entry?.text).toBe("page seventeen text");
  });

  it("bare-key fallback: returns a minimal entry when any chunk shares the itemKey", () => {
    // Spec branch 2 — legacy `[ABCD1234]` shape with no chunk index.
    // Multiple chunks may share the itemKey at different pages; the
    // fallback intentionally drops attachmentKey/pageIndex so
    // citation-open.ts opens the document at page 1 (the README
    // contract). Borrowing one chunk's `text` is fine — it's used only
    // for the tooltip and the click target is the document, not a page.
    const lookup = buildCitationLookup([
      chunk({ itemKey: "ABCD1234", chunkIndex: 0, pageIndex: 4, attachmentKey: "ATT0001" }),
      chunk({ itemKey: "ABCD1234", chunkIndex: 1, pageIndex: 9, attachmentKey: "ATT0001" })
    ]);
    const entry = resolveCitation({ itemKey: "ABCD1234" }, lookup);
    expect(entry).toBeDefined();
    expect(entry?.itemKey).toBe("ABCD1234");
    // The README-documented fallback drops chunk-scoped fields.
    expect(entry?.pageIndex).toBeUndefined();
    expect(entry?.attachmentKey).toBeUndefined();
  });

  it("hallucinated key: returns undefined for a full-key miss", () => {
    // Spec branch 3a — model emitted a chunk index that wasn't in the
    // retrieval. Returning a fallback would route the click to an
    // arbitrary chunk; returning undefined lets the renderer emit inert
    // text instead.
    const lookup = buildCitationLookup([chunk({ itemKey: "ABCD1234", chunkIndex: 0 })]);
    const entry = resolveCitation({ itemKey: "ABCD1234", chunkIndex: 99 }, lookup);
    expect(entry).toBeUndefined();
  });

  it("hallucinated key: returns undefined for a bare token whose itemKey is absent", () => {
    // Spec branch 3b — bare `[ZZZZZZZZ]` matches no chunk in the lookup.
    const lookup = buildCitationLookup([chunk({ itemKey: "ABCD1234", chunkIndex: 0 })]);
    const entry = resolveCitation({ itemKey: "ZZZZZZZZ" }, lookup);
    expect(entry).toBeUndefined();
  });
});
