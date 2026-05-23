/* @vitest-environment jsdom */

/**
 * Fault Localization: AC-6 — chunk-scoped citation rendering with hallucination
 * guard (`appendWithCitations`, `renderLibraryChatView`, `wireLibraryChatView`,
 * `buildLibraryPrompt` from `src/ui/library-chat-view.ts`).
 *
 * ### PHASE 1 — SPEC SEMANTICS
 * - PREMISE S1: `appendWithCitations(target, source, lookup?)` parses both halves
 *   of a citation via `/\[([A-Z0-9]{8})(?:#(\d+))?\]/g`. The renderer composes
 *   the full lookup key `${itemKey}#${chunkIndex}` and resolves it against the
 *   per-turn `lookup` table.
 * - PREMISE S2: ON A HIT the `<a>` element carries `data-item-key`,
 *   `data-chunk-index`, `data-attachment-key`, `data-page-index` populated from
 *   the matched `CitationLookupEntry`.
 * - PREMISE S3: ON A MISS — a legacy `[ITEMKEY]` token (no chunk-index), a
 *   hallucinated itemKey, OR a hallucinated in-range-looking chunk-index such as
 *   `[ABCD1234#99]` when only chunks 0-7 are in the table — the renderer falls
 *   back to legacy `[itemKey]` behavior: a link carrying `data-item-key` only
 *   (no `data-page-index`), which downstream opens the attachment at page 0.
 * - PREMISE S4: `[WRONGKEY#0]` where WRONGKEY ≠ chunk-0's true itemKey ⇒ the
 *   composed key `WRONGKEY#0` is absent from the table ⇒ miss ⇒ fallback to
 *   legacy `[WRONGKEY]`. It must NOT silently route to chunk-0's true source.
 * - PREMISE S5: the lookup table is PER-TURN, pinned to the assistant message
 *   index in the store (`citationLookups: ReadonlyMap<number, CitationLookup>`).
 *   Re-rendering an OLDER assistant turn must use THAT turn's table.
 * - PREMISE S6: `wireLibraryChatView`'s `onCitationClick` receives a citation
 *   object `{itemKey, attachmentKey?, pageIndex?}` (widened from a bare string).
 * - PREMISE S7: `buildLibraryPrompt` prefixes each excerpt with
 *   `[${itemKey}#${chunkIndex}]` and instructs the model to cite in that shape.
 * - PREMISE S8: rendering stays XSS-safe — no `innerHTML`; markup payloads land
 *   as literal text.
 *
 * ### PHASE 2 — CODE PATH TRACE (current code)
 * - METHOD: `CITATION_PATTERN` | LOCATION: src/ui/library-chat-view.ts:46 |
 *   BEHAVIOR (current): `/\[([A-Za-z0-9_]{3,32})\]/gu`, NO chunk-index half.
 *   RELEVANCE: must widen to capture `#(\d+)`.
 * - METHOD: `appendWithCitations(target, source)` | LOCATION: lines 252-267 |
 *   BEHAVIOR (current): 2-arg, every match becomes a link with `data-item-key`
 *   only. RELEVANCE: must accept the `lookup?` 3rd arg and stamp the page/
 *   attachment data attributes on hits.
 * - METHOD: `wireLibraryChatView` click delegate | LOCATION: lines 315-325 |
 *   BEHAVIOR (current): emits a bare string `itemKey`. RELEVANCE: must emit the
 *   citation object.
 * - METHOD: `buildLibraryPrompt` | LOCATION: lines 355-370 | BEHAVIOR (current):
 *   excerpt prefix `[${c.itemKey}]`. RELEVANCE: must become `[${itemKey}#${chunkIndex}]`.
 *
 * ### PHASE 3 — DIVERGENCE ANALYSIS
 * - CLAIM D1: a hit may stamp only `data-item-key` and forget the new
 *   `data-chunk-index/-attachment-key/-page-index` attributes.
 * - CLAIM D2: a hallucinated `[ABCD1234#99]` may still resolve if the renderer
 *   keys the table by bare itemKey, or if it falls back to chunk 0 of that item.
 * - CLAIM D3: a `[WRONGKEY#0]` token may route to chunk 0's true source if the
 *   renderer ignores the itemKey half of the composed key.
 * - CLAIM D4: a re-render may use the CURRENT lookup table (singleton) rather
 *   than the table pinned to the message's index — wrong page on stale turns.
 * - CLAIM D5: `pageIndex: 0` may be dropped on the data attribute by a truthy
 *   guard, producing a missing `data-page-index` on a real page-0 citation.
 * - CLAIM D6: `onCitationClick` may still emit a bare string after the widen.
 *
 * ### PHASE 4 — TEST TARGETS
 * 1. D2/D3 — hallucination guard: out-of-range and wrong-key tokens fall back.
 * 2. D1/D5 — hit stamps all four data attributes incl. page 0.
 * 3. D4 — per-turn table pinning across an older-turn re-render.
 * 4. D6 — onCitationClick emits the resolved citation object.
 * 5. legacy `[ITEMKEY]` (no chunk-index) fallback; buildLibraryPrompt shape.
 *
 * Black-box: imports only public exports of `library-chat-view.ts` +
 * `citation-lookup.ts` + the `RetrievedChunk` type.
 */

import { describe, expect, it, vi } from "vitest";

import {
  appendWithCitations,
  buildLibraryPrompt,
  renderLibraryChatView,
  wireLibraryChatView
} from "../../src/ui/library-chat-view.js";
import { buildCitationLookup } from "../../src/ui/citation-lookup.js";
import type { CitationLookup } from "../../src/ui/citation-lookup.js";
import type { RetrievedChunk } from "../../src/indexing/index-search.js";

function chunk(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    itemKey: "ABCD1234",
    title: "Title",
    text: "excerpt",
    score: 0.9,
    chunkIndex: 0,
    ...over
  };
}

/** Eight-chunk lookup table for item ABCD1234, chunk indices 0..7. */
function eightChunkLookup(): CitationLookup {
  const chunks: RetrievedChunk[] = [];
  for (let i = 0; i < 8; i += 1) {
    chunks.push(
      chunk({
        itemKey: "ABCD1234",
        chunkIndex: i,
        attachmentKey: "ATT00001",
        pageIndex: i,
        text: `page ${String(i)} body`
      })
    );
  }
  return buildCitationLookup(chunks);
}

describe("appendWithCitations — hit path stamps chunk-scoped data attributes", () => {
  it("stamps data-item-key, data-chunk-index, data-attachment-key, data-page-index on a hit", () => {
    // Adversarial D1.
    const target = document.createElement("div");
    const lookup = eightChunkLookup();
    appendWithCitations(target, "Claim [ABCD1234#3].", lookup);
    const link = target.querySelector<HTMLAnchorElement>("a[data-item-key]");
    expect(link).not.toBeNull();
    expect(link?.dataset.itemKey).toBe("ABCD1234");
    expect(link?.dataset.chunkIndex).toBe("3");
    expect(link?.dataset.attachmentKey).toBe("ATT00001");
    expect(link?.dataset.pageIndex).toBe("3");
  });

  it("stamps data-page-index='0' for a chunk whose pageIndex is 0", () => {
    // Adversarial D5: page 0 is a real page; a truthy guard would drop it.
    const target = document.createElement("div");
    appendWithCitations(target, "First page [ABCD1234#0].", eightChunkLookup());
    const link = target.querySelector<HTMLAnchorElement>("a[data-item-key]");
    expect(link?.dataset.pageIndex).toBe("0");
  });
});

describe("appendWithCitations — miss path falls back to legacy [itemKey] behavior", () => {
  it("treats a legacy [ITEMKEY] token (no chunk-index) as a fallback link", () => {
    // PREMISE S3: no chunk-index half -> legacy behavior, no data-page-index.
    const target = document.createElement("div");
    appendWithCitations(target, "Legacy cite [ABCD1234].", eightChunkLookup());
    const link = target.querySelector<HTMLAnchorElement>("a[data-item-key]");
    expect(link).not.toBeNull();
    expect(link?.dataset.itemKey).toBe("ABCD1234");
    expect(link?.dataset.pageIndex).toBeUndefined();
  });

  it("falls back when the chunk-index is out of range ([ABCD1234#99], table holds 0-7)", () => {
    // Adversarial D2.
    const target = document.createElement("div");
    appendWithCitations(target, "Hallucinated [ABCD1234#99].", eightChunkLookup());
    const link = target.querySelector<HTMLAnchorElement>("a[data-item-key]");
    expect(link).not.toBeNull();
    expect(link?.dataset.itemKey).toBe("ABCD1234");
    // Miss -> legacy fallback: no resolved page/attachment.
    expect(link?.dataset.pageIndex).toBeUndefined();
  });

  it("falls back for [WRONGKEY#0] and does NOT route to chunk-0's true source", () => {
    // Adversarial D3 / PREMISE S4. The table's chunk 0 is itemKey ABCD1234 on
    // page 0. A wrong itemKey with chunkIndex 0 must NOT inherit that page.
    const target = document.createElement("div");
    appendWithCitations(target, "Wrong key [WRONGKEY#0].", eightChunkLookup());
    const link = target.querySelector<HTMLAnchorElement>("a[data-item-key]");
    expect(link).not.toBeNull();
    expect(link?.dataset.itemKey).toBe("WRONGKEY");
    // Must NOT have silently adopted chunk-0's pageIndex 0 / attachment.
    expect(link?.dataset.pageIndex).toBeUndefined();
    expect(link?.dataset.attachmentKey).toBeUndefined();
  });

  it("falls back when no lookup table is supplied at all (legacy 2-arg caller)", () => {
    const target = document.createElement("div");
    appendWithCitations(target, "Cite [ABCD1234#3].");
    const link = target.querySelector<HTMLAnchorElement>("a[data-item-key]");
    expect(link).not.toBeNull();
    expect(link?.dataset.itemKey).toBe("ABCD1234");
    expect(link?.dataset.pageIndex).toBeUndefined();
  });

  it("inserts non-citation text as literal text nodes and never as markup (XSS-safe)", () => {
    // PREMISE S8.
    const target = document.createElement("div");
    appendWithCitations(target, "before <img src=x onerror=alert(1)> after", eightChunkLookup());
    expect(target.querySelector("img")).toBeNull();
    expect(target.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("renders [<img ...>] as text, not a link or element (key alphabet rejects it)", () => {
    const target = document.createElement("div");
    appendWithCitations(target, "x [<img src=x>] y", eightChunkLookup());
    expect(target.querySelector("img")).toBeNull();
    expect(target.querySelector("a[data-item-key]")).toBeNull();
  });
});

describe("renderLibraryChatView — per-turn lookup table pinning", () => {
  it("uses each turn's own lookup table so an older turn keeps its own pages", () => {
    // Adversarial D4 / PREMISE S5. Turn 1 (assistant msg index 1) cites chunk 0
    // -> page 2. Turn 2 (index 3) cites chunk 0 -> page 40. Both turns rendered
    // together: the index-1 link must keep page 2, NOT inherit page 40.
    const turn1Lookup = buildCitationLookup([
      chunk({ itemKey: "ABCD1234", chunkIndex: 0, attachmentKey: "ATT00001", pageIndex: 2 })
    ]);
    const turn2Lookup = buildCitationLookup([
      chunk({ itemKey: "ABCD1234", chunkIndex: 0, attachmentKey: "ATT00001", pageIndex: 40 })
    ]);
    const citationLookups = new Map<number, CitationLookup>([
      [1, turn1Lookup],
      [3, turn2Lookup]
    ]);

    const view = renderLibraryChatView({
      messages: [
        { role: "user", content: "Q1" },
        { role: "assistant", content: "Answer one [ABCD1234#0]." },
        { role: "user", content: "Q2" },
        { role: "assistant", content: "Answer two [ABCD1234#0]." }
      ],
      status: "completed",
      errorMessage: null,
      hasIndex: true,
      citationLookups
    });

    const links = view.querySelectorAll<HTMLAnchorElement>("a[data-item-key]");
    expect(links.length).toBe(2);
    // The order of assistant messages is preserved in the DOM.
    expect(links[0]?.dataset.pageIndex).toBe("2");
    expect(links[1]?.dataset.pageIndex).toBe("40");
  });

  it("renders a citation as a legacy fallback when its turn has no lookup entry", () => {
    // An assistant turn with no entry in citationLookups -> miss -> fallback.
    const view = renderLibraryChatView({
      messages: [{ role: "assistant", content: "Orphan [ABCD1234#0]." }],
      status: "completed",
      errorMessage: null,
      hasIndex: true,
      citationLookups: new Map<number, CitationLookup>()
    });
    const link = view.querySelector<HTMLAnchorElement>("a[data-item-key]");
    expect(link).not.toBeNull();
    expect(link?.dataset.pageIndex).toBeUndefined();
  });
});

describe("wireLibraryChatView — onCitationClick emits the resolved citation object", () => {
  it("emits {itemKey, attachmentKey, pageIndex} when a resolved citation is clicked", () => {
    // Adversarial D6. The handler must hand the wire the resolved fields, not a
    // bare itemKey string.
    const view = renderLibraryChatView({
      messages: [{ role: "assistant", content: "Claim [ABCD1234#3]." }],
      status: "completed",
      errorMessage: null,
      hasIndex: true,
      citationLookups: new Map<number, CitationLookup>([[0, eightChunkLookup()]])
    });
    document.body.append(view);
    const onCitationClick = vi.fn();
    const detach = wireLibraryChatView({
      view,
      onSubmit: vi.fn(() => Promise.resolve()),
      onReset: vi.fn(),
      onCitationClick
    });
    const link = view.querySelector<HTMLAnchorElement>("a[data-item-key]");
    link?.click();
    expect(onCitationClick).toHaveBeenCalledTimes(1);
    expect(onCitationClick).toHaveBeenCalledWith(
      expect.objectContaining({ itemKey: "ABCD1234", attachmentKey: "ATT00001", pageIndex: 3 })
    );
    detach();
  });

  it("emits a citation with pageIndex undefined for a legacy/fallback citation", () => {
    const view = renderLibraryChatView({
      messages: [{ role: "assistant", content: "Legacy [ABCD1234]." }],
      status: "completed",
      errorMessage: null,
      hasIndex: true,
      citationLookups: new Map<number, CitationLookup>([[0, eightChunkLookup()]])
    });
    document.body.append(view);
    const onCitationClick = vi.fn();
    const detach = wireLibraryChatView({
      view,
      onSubmit: vi.fn(() => Promise.resolve()),
      onReset: vi.fn(),
      onCitationClick
    });
    view.querySelector<HTMLAnchorElement>("a[data-item-key]")?.click();
    expect(onCitationClick).toHaveBeenCalledTimes(1);
    const arg = onCitationClick.mock.calls[0]?.[0] as { itemKey: string; pageIndex?: number };
    expect(arg.itemKey).toBe("ABCD1234");
    expect(arg.pageIndex).toBeUndefined();
    detach();
  });

  it("does not double-emit when the same item is cited twice on different pages", () => {
    // Adversarial: two clicks, two distinct citations -> two distinct emits.
    const view = renderLibraryChatView({
      messages: [{ role: "assistant", content: "A [ABCD1234#2] then B [ABCD1234#5]." }],
      status: "completed",
      errorMessage: null,
      hasIndex: true,
      citationLookups: new Map<number, CitationLookup>([[0, eightChunkLookup()]])
    });
    document.body.append(view);
    const onCitationClick = vi.fn();
    const detach = wireLibraryChatView({
      view,
      onSubmit: vi.fn(() => Promise.resolve()),
      onReset: vi.fn(),
      onCitationClick
    });
    const links = view.querySelectorAll<HTMLAnchorElement>("a[data-item-key]");
    links[0]?.click();
    links[1]?.click();
    expect(onCitationClick).toHaveBeenCalledTimes(2);
    expect(onCitationClick.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ pageIndex: 2 }));
    expect(onCitationClick.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ pageIndex: 5 }));
    detach();
  });
});

describe("buildLibraryPrompt — chunk-scoped excerpt labels", () => {
  it("prefixes every excerpt with [itemKey#chunkIndex]", () => {
    // PREMISE S7.
    const prompt = buildLibraryPrompt({
      question: "What does X mean?",
      chunks: [
        chunk({ itemKey: "ABCD1234", chunkIndex: 0, text: "X is alpha." }),
        chunk({ itemKey: "ABCD1234", chunkIndex: 1, text: "X is beta." })
      ]
    });
    expect(prompt).toContain("[ABCD1234#0] X is alpha.");
    expect(prompt).toContain("[ABCD1234#1] X is beta.");
    expect(prompt).toContain("Question: What does X mean?");
  });

  it("instructs the model to cite in the [itemKey#chunkIndex] shape", () => {
    const prompt = buildLibraryPrompt({
      question: "Q",
      chunks: [chunk({ itemKey: "ABCD1234", chunkIndex: 0 })]
    });
    // The instruction must reference the chunk-scoped token shape, not just
    // the bare [itemKey] form.
    expect(prompt).toMatch(/#/);
    expect(prompt.toLowerCase()).toContain("cite");
  });

  it("labels two chunks of the SAME item with distinct tokens (collision case)", () => {
    // Adversarial AC-9(a) at the prompt-builder level.
    const prompt = buildLibraryPrompt({
      question: "Q",
      chunks: [
        chunk({ itemKey: "ABCD1234", chunkIndex: 0, pageIndex: 2, text: "page two." }),
        chunk({ itemKey: "ABCD1234", chunkIndex: 1, pageIndex: 17, text: "page seventeen." })
      ]
    });
    expect(prompt).toContain("[ABCD1234#0]");
    expect(prompt).toContain("[ABCD1234#1]");
    // Distinct labels — not a single collapsed [ABCD1234].
    expect(prompt.indexOf("[ABCD1234#0]")).not.toBe(prompt.indexOf("[ABCD1234#1]"));
  });

  it("renders the empty excerpts section when chunks is empty", () => {
    const prompt = buildLibraryPrompt({ question: "Q", chunks: [] });
    expect(prompt).toContain("Question: Q");
  });
});
