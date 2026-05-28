/* @vitest-environment jsdom */

/**
 * Fault Localization: AC-6 — chunk-scoped citation rendering with hallucination
 * guard (`appendWithCitations`, `renderLibraryChatView`, `wireLibraryChatView`,
 * `buildLibraryPrompt` from `src/ui/library-chat-view.ts`).
 *
 * REV (HIGH-3): `appendWithCitations` now delegates to the shared
 * `emitTextWithCitations` in `citation-lookup.ts`, the same tokenizer the
 * popup/sidebar markdown renderer uses. The library-chat surface and the
 * popup/sidebar surface therefore tokenize citations IDENTICALLY — a
 * hallucinated chunk-scoped token renders as inert text on every surface,
 * a bare-key token routes through `resolveCitation`'s legacy fallback on
 * every surface, and the anchor's visible text is the bracketed token on
 * every surface (e.g. `[ABCD1234#3]`, not bare `ABCD1234`).
 *
 * ### PHASE 1 — SPEC SEMANTICS
 * - PREMISE S1: `appendWithCitations(target, source, lookup?)` parses both halves
 *   of a citation via `/\[([A-Z0-9]{8})(?:#(\d+))?\]/g`. The renderer composes
 *   the full lookup key `${itemKey}#${chunkIndex}` and resolves it against the
 *   per-turn `lookup` table.
 * - PREMISE S2: ON A HIT the `<a>` element carries `data-item-key`,
 *   `data-chunk-index`, `data-attachment-key`, `data-page-index` populated from
 *   the matched `CitationLookupEntry`. The anchor's `textContent` is the
 *   bracketed token (e.g. `[ABCD1234#3]`), matching the popup/sidebar.
 * - PREMISE S3 (HIGH-3): ON A CHUNK-SCOPED MISS — a hallucinated itemKey,
 *   an out-of-range chunk-index such as `[ABCD1234#99]` when only chunks 0-7
 *   are in the table, or `[WRONGKEY#0]` where WRONGKEY shares no chunk in the
 *   table — the renderer emits INERT TEXT (no anchor). This matches the README
 *   "inert text on hallucination" contract that the popup/sidebar already
 *   enforced; the library-chat surface used to emit a fallback `<a>` instead.
 * - PREMISE S4 (HIGH-3): a BARE-KEY `[ITEMKEY]` token (no `#`) routes through
 *   `resolveCitation`'s legacy fallback: if ANY chunk in the lookup shares
 *   this itemKey, the helper synthesises a fallback entry `{ itemKey, text }`
 *   (no `pageIndex` / `attachmentKey`) and the renderer emits a clickable
 *   anchor carrying `data-item-key` only. When the lookup has no chunk for
 *   this itemKey (or no lookup at all — the legacy 2-arg caller passes an
 *   empty `Map`), `resolveCitation` returns `undefined` and the token renders
 *   as INERT TEXT. The anchor's `textContent` on the bare-key hit is the
 *   bracketed `[ITEMKEY]`, NOT bare `ITEMKEY`.
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
 * ### PHASE 3 — DIVERGENCE ANALYSIS
 * - CLAIM D1: a hit may stamp only `data-item-key` and forget the new
 *   `data-chunk-index/-attachment-key/-page-index` attributes.
 * - CLAIM D2 (HIGH-3 flipped): a hallucinated `[ABCD1234#99]` may still render
 *   a clickable fallback anchor (the legacy library-chat behavior). After
 *   unification the token must render as INERT TEXT.
 * - CLAIM D3 (HIGH-3 flipped): `[WRONGKEY#0]` may emit a fallback `<a>` even
 *   when no chunk in the table shares WRONGKEY. After unification the token
 *   must render as INERT TEXT.
 * - CLAIM D4: a re-render may use the CURRENT lookup table (singleton) rather
 *   than the table pinned to the message's index — wrong page on stale turns.
 * - CLAIM D5: `pageIndex: 0` may be dropped on the data attribute by a truthy
 *   guard, producing a missing `data-page-index` on a real page-0 citation.
 * - CLAIM D6: `onCitationClick` may still emit a bare string after the widen.
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
  it("treats a legacy [ITEMKEY] token (no chunk-index) as a fallback link with bracketed text", () => {
    // PREMISE S4 (HIGH-3): a bare-key token still resolves via
    // `resolveCitation`'s legacy fallback when ANY chunk in the lookup
    // shares this itemKey. The fallback entry has no pageIndex /
    // attachmentKey, so the anchor carries data-item-key ONLY. The
    // anchor's textContent is the BRACKETED token (`[ABCD1234]`), not
    // bare `ABCD1234` — matches the popup/sidebar markdown renderer.
    const target = document.createElement("div");
    appendWithCitations(target, "Legacy cite [ABCD1234].", eightChunkLookup());
    const link = target.querySelector<HTMLAnchorElement>("a[data-item-key]");
    expect(link).not.toBeNull();
    expect(link?.dataset.itemKey).toBe("ABCD1234");
    expect(link?.dataset.pageIndex).toBeUndefined();
    expect(link?.dataset.attachmentKey).toBeUndefined();
    expect(link?.dataset.chunkIndex).toBeUndefined();
    // HIGH-3 visible-text shape: bracketed, not bare.
    expect(link?.textContent).toBe("[ABCD1234]");
  });

  it("renders out-of-range [ABCD1234#99] as INERT TEXT (no anchor)", () => {
    // Adversarial D2 (HIGH-3 flipped). The table holds chunks 0-7; chunk
    // 99 is a hallucination. Library-chat used to emit a fallback `<a>`;
    // after unification with the popup/sidebar renderer the token now
    // renders as inert text — matches the README contract.
    const target = document.createElement("div");
    appendWithCitations(target, "Hallucinated [ABCD1234#99].", eightChunkLookup());
    expect(target.querySelector("a")).toBeNull();
    // The original token survives verbatim in the rendered text.
    expect(target.textContent).toContain("[ABCD1234#99]");
  });

  it("renders [WRONGKEY#0] as INERT TEXT — never routes to chunk-0's true source", () => {
    // Adversarial D3 (HIGH-3 flipped). The table's chunk 0 is itemKey
    // ABCD1234 on page 0. A wrong itemKey with chunkIndex 0 composes
    // `WRONGKEY#0`, absent from the lookup -> miss -> INERT TEXT. No
    // chunk in the table shares WRONGKEY either, so the bare-key
    // fallback also misses. The token must NOT inherit chunk-0's page.
    const target = document.createElement("div");
    appendWithCitations(target, "Wrong key [WRONGKEY#0].", eightChunkLookup());
    expect(target.querySelector("a")).toBeNull();
    expect(target.textContent).toContain("[WRONGKEY#0]");
  });

  it("renders chunk-scoped [ABCD1234#3] as INERT TEXT when no lookup is supplied (legacy 2-arg caller)", () => {
    // PREMISE S4 (HIGH-3): the legacy 2-arg call passes an empty lookup.
    // A chunk-scoped token has nothing to resolve against -> inert text.
    // (A bare-key token would still also be inert because no chunk
    // shares its itemKey — covered in the next test.)
    const target = document.createElement("div");
    appendWithCitations(target, "Cite [ABCD1234#3].");
    expect(target.querySelector("a")).toBeNull();
    expect(target.textContent).toContain("[ABCD1234#3]");
  });

  it("renders bare-key [ABCD1234] as INERT TEXT when no lookup is supplied (legacy 2-arg caller)", () => {
    // HIGH-3 visible-text contract: with no lookup, `resolveCitation`'s
    // legacy fallback returns undefined for a bare-key token (no chunk
    // shares this itemKey because there are no chunks), so the token
    // renders as inert text — matching the popup/sidebar.
    const target = document.createElement("div");
    appendWithCitations(target, "Cite [ABCD1234].");
    expect(target.querySelector("a")).toBeNull();
    expect(target.textContent).toContain("[ABCD1234]");
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

  it("renders a chunk-scoped citation as INERT TEXT when its turn has no lookup entry", () => {
    // HIGH-3 flipped: an assistant turn with no entry in citationLookups
    // exposes a chunk-scoped token to an empty lookup -> miss -> inert
    // text. Library-chat used to emit a fallback `<a>`; after unification
    // with the popup/sidebar renderer the contract is "inert text on
    // hallucination" everywhere.
    const view = renderLibraryChatView({
      messages: [{ role: "assistant", content: "Orphan [ABCD1234#0]." }],
      status: "completed",
      errorMessage: null,
      hasIndex: true,
      citationLookups: new Map<number, CitationLookup>()
    });
    expect(view.querySelector("a")).toBeNull();
    expect(view.textContent).toContain("[ABCD1234#0]");
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
