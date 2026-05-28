/* @vitest-environment jsdom */

/**
 * Tests for `renderMarkdownWithCitations` — the popup/sidebar's
 * citation-linkifying markdown renderer (Bug B). Pinned cases:
 *
 *   B1: markdown with an inline `[ABCD1234#3]` chunk-scoped token
 *       renders an `<a>` inside the appropriate `<p>` AND the anchor
 *       carries `data-chunk-index`, `data-attachment-key`,
 *       `data-page-index` from the matched entry.
 *   B2: markdown with a bare `[ABCD1234]` token (legacy / chunk-index-
 *       absent) resolves via `resolveCitation`'s fallback to an anchor
 *       that carries ONLY `data-item-key` — the README contract is that
 *       a bare key opens the attachment at page 1 (no `data-page-index`).
 *   B3: markdown with a hallucinated `[ZZZZZZZZ#99]` renders the token
 *       as LITERAL text — no anchor. A hallucination must never produce
 *       a clickable but misdirected link.
 *   B4: when `lookup === undefined` (caller has no retrieval yet)
 *       citation handling is suppressed; tokens render as literal text
 *       just like `renderMarkdown` would have rendered them.
 *
 * Black-box: only the public exports of `renderMarkdownWithCitations`
 * and `buildCitationLookup` are exercised — no internal helpers are
 * imported or inspected.
 */

import { describe, expect, it } from "vitest";

import { buildCitationLookup } from "../../src/ui/citation-lookup.js";
import { renderMarkdownWithCitations } from "../../src/ui/markdown.js";
import type { RetrievedChunk } from "../../src/indexing/index-search.js";

function fresh(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  return target;
}

function chunk(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    itemKey: "ABCD1234",
    title: "Title",
    text: "excerpt body",
    score: 0.9,
    chunkIndex: 0,
    ...over
  };
}

describe("renderMarkdownWithCitations", () => {
  it("B1: inline [ABCD1234#3] renders an <a> inside the surrounding <p> with chunk-scoped data attributes", () => {
    const target = fresh();
    const lookup = buildCitationLookup([
      chunk({
        itemKey: "ABCD1234",
        chunkIndex: 3,
        attachmentKey: "ATT00007",
        pageIndex: 16
      })
    ]);
    renderMarkdownWithCitations(target, "Claim [ABCD1234#3] is supported.", { lookup });
    const paragraph = target.querySelector("p");
    expect(paragraph).not.toBeNull();
    const anchor = paragraph?.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.dataset.itemKey).toBe("ABCD1234");
    expect(anchor?.dataset.chunkIndex).toBe("3");
    expect(anchor?.dataset.attachmentKey).toBe("ATT00007");
    expect(anchor?.dataset.pageIndex).toBe("16");
    expect(anchor?.textContent).toBe("[ABCD1234#3]");
    // The paragraph's text content stitches the surrounding text + the
    // anchor's label — adversarial check that we did not lose any text.
    expect(paragraph?.textContent).toBe("Claim [ABCD1234#3] is supported.");
  });

  it("B2: bare [ABCD1234] resolves via the fallback — anchor carries data-item-key only", () => {
    const target = fresh();
    const lookup = buildCitationLookup([
      chunk({
        itemKey: "ABCD1234",
        chunkIndex: 0,
        attachmentKey: "ATT00001",
        pageIndex: 4
      })
    ]);
    renderMarkdownWithCitations(target, "Cite [ABCD1234] here.", { lookup });
    const anchor = target.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.dataset.itemKey).toBe("ABCD1234");
    // README contract: a bare-key fallback opens the document at page 1,
    // not at any specific chunk's page. The renderer must NOT stamp
    // page-index / attachment-key / chunk-index on the fallback anchor.
    expect(anchor?.dataset.pageIndex).toBeUndefined();
    expect(anchor?.dataset.attachmentKey).toBeUndefined();
    expect(anchor?.dataset.chunkIndex).toBeUndefined();
    expect(anchor?.textContent).toBe("[ABCD1234]");
  });

  it("B3: hallucinated [ZZZZZZZZ#99] renders as literal text with no anchor", () => {
    const target = fresh();
    const lookup = buildCitationLookup([chunk({ itemKey: "ABCD1234", chunkIndex: 0 })]);
    renderMarkdownWithCitations(target, "Bogus [ZZZZZZZZ#99] cite.", { lookup });
    // No anchor anywhere in the rendered tree — the token degrades to
    // text rather than a misdirected link.
    expect(target.querySelector("a")).toBeNull();
    // The original token text survives — `[ZZZZZZZZ#99]` appears in the
    // paragraph's text content untouched.
    expect(target.textContent).toContain("[ZZZZZZZZ#99]");
  });

  it("B3 (variant): hallucinated chunk-index on a valid itemKey also renders as text", () => {
    const target = fresh();
    const lookup = buildCitationLookup([chunk({ itemKey: "ABCD1234", chunkIndex: 0 })]);
    renderMarkdownWithCitations(target, "Bad chunk [ABCD1234#99].", { lookup });
    expect(target.querySelector("a")).toBeNull();
    expect(target.textContent).toContain("[ABCD1234#99]");
  });

  it("B4: lookup === undefined suppresses citation handling; tokens are literal text", () => {
    const target = fresh();
    renderMarkdownWithCitations(target, "Cite [ABCD1234#3] here.");
    // Without a lookup we never emit anchors — citation tokens are
    // preserved verbatim. This matches what `renderMarkdown` would do.
    expect(target.querySelector("a")).toBeNull();
    expect(target.textContent).toContain("[ABCD1234#3]");
  });

  it("renders markdown structure (headings, lists) alongside citation anchors", () => {
    // Adversarial: a single render call must produce a complete
    // markdown tree (h2, ul, p) AND linkify citations inside list items
    // and paragraphs. A regression that swapped the block-renderer for a
    // text-only path would lose the headings.
    const target = fresh();
    const lookup = buildCitationLookup([
      chunk({ itemKey: "ABCD1234", chunkIndex: 0, pageIndex: 1 })
    ]);
    renderMarkdownWithCitations(target, "## Heading\n\n- item [ABCD1234#0]\n\nFinal paragraph.", {
      lookup
    });
    expect(target.querySelector("h2")?.textContent).toBe("Heading");
    const li = target.querySelector("li");
    expect(li).not.toBeNull();
    expect(li?.querySelector("a")?.dataset.itemKey).toBe("ABCD1234");
    expect(target.querySelectorAll("p").length).toBe(1);
  });

  it("citation tokens inside fenced code blocks render literally (no anchor)", () => {
    // Hardening: code blocks intentionally preserve their text verbatim
    // (markdown convention). A `[ABCD1234#0]` inside ``` … ``` is quoted
    // source code, not a link.
    const target = fresh();
    const lookup = buildCitationLookup([chunk({ chunkIndex: 0 })]);
    renderMarkdownWithCitations(target, "```\n[ABCD1234#0]\n```", { lookup });
    expect(target.querySelector("a")).toBeNull();
    expect(target.querySelector("code")?.textContent).toBe("[ABCD1234#0]");
  });

  it("re-rendering replaces the previous tree (streaming-friendly)", () => {
    const target = fresh();
    const lookup = buildCitationLookup([chunk({ chunkIndex: 0 })]);
    renderMarkdownWithCitations(target, "First [ABCD1234#0].", { lookup });
    renderMarkdownWithCitations(target, "Second [ABCD1234#0].", { lookup });
    // Only ONE paragraph + ONE anchor — the stale first render is gone.
    expect(target.querySelectorAll("p").length).toBe(1);
    expect(target.querySelectorAll("a").length).toBe(1);
    expect(target.textContent).toContain("Second");
    expect(target.textContent).not.toContain("First");
  });
});
