/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import { renderAnchoredPopup } from "../../src/ui/anchored-popup-view.js";
import { attachCitationClickHandler } from "../../src/ui/citation-click.js";
import { buildCitationLookup } from "../../src/ui/citation-lookup.js";
import type { CitationClick } from "../../src/ui/library-chat-view.js";
import { renderMarkdownWithCitations } from "../../src/ui/markdown.js";

describe("renderAnchoredPopup", () => {
  it("renders provider disclosure and content; positioning is handled by the wrapper", () => {
    const view = renderAnchoredPopup({
      disclosure: "Selected text will be sent to OpenAI using gpt-test.",
      anchor: { left: 10, top: 20, width: 100, height: 30 },
      text: "Explanation"
    });

    // Regression guard: the section MUST NOT set its own position/left/top.
    // mountPopup wraps this section in a `position: fixed` wrapper that owns
    // placement. Setting `position: absolute; left; top` on the section
    // would cause it to escape the wrapper's max-width constraint and render
    // at chrome (wrapper.left + section.left, wrapper.top + section.top) —
    // observed as a 1100px-wide popup at the top of the page.
    expect(view.style.position).toBe("");
    expect(view.style.left).toBe("");
    expect(view.style.top).toBe("");
    expect(view.textContent).toContain("Selected text will be sent to OpenAI using gpt-test.");
    expect(view.textContent).toContain("Explanation");
    expect(view.querySelector('[data-action="continue-sidebar"]')?.textContent).toBe(
      "Open in sidebar"
    );
    expect(view.querySelector('[data-action="retry"]')?.textContent).toBe("Retry");
  });

  it("shows a loading indicator when text is empty (AC4)", () => {
    const view = renderAnchoredPopup({
      disclosure: "disclosure",
      anchor: null,
      text: ""
    });
    const loading = view.querySelector<HTMLElement>(".zotero-ai-explain-popup__loading");
    expect(loading).not.toBeNull();
    expect(loading?.hidden).toBe(false);
    expect(loading?.getAttribute("role")).toBe("status");
    expect(loading?.dataset.state).toBe("loading");
    expect(loading?.textContent ?? "").toMatch(/loading|working|…|\.\.\./iu);
    // The animated indicator paints three dot spans alongside the
    // label so users see a pulsing animation instead of static text.
    const dots = view.querySelectorAll<HTMLElement>(".zotero-ai-explain-popup__loading-dot");
    expect(dots.length).toBe(3);
  });

  it("renders an error block (hidden by default) so the runtime can surface failures visibly", () => {
    const view = renderAnchoredPopup({ disclosure: "disclosure", anchor: null, text: "" });
    const errorBlock = view.querySelector<HTMLElement>(".zotero-ai-explain-popup__error");
    const errorMsg = view.querySelector<HTMLElement>(".zotero-ai-explain-popup__error-message");
    expect(errorBlock).not.toBeNull();
    expect(errorBlock?.hidden).toBe(true);
    expect(errorBlock?.getAttribute("role")).toBe("alert");
    expect(errorMsg).not.toBeNull();
  });

  it("hides the loading indicator when text is non-empty", () => {
    const view = renderAnchoredPopup({
      disclosure: "disclosure",
      anchor: null,
      text: "Already streamed"
    });
    const loading = view.querySelector<HTMLElement>(".zotero-ai-explain-popup__loading");
    expect(loading?.hidden).toBe(true);
  });

  it("renders an inline follow-up form (AC5)", () => {
    const view = renderAnchoredPopup({
      disclosure: "disclosure",
      anchor: null,
      text: ""
    });
    const form = view.querySelector<HTMLFormElement>(".zotero-ai-explain-popup__form");
    const textarea = view.querySelector<HTMLTextAreaElement>(
      '.zotero-ai-explain-popup__form [name="followUp"]'
    );
    const send = view.querySelector<HTMLButtonElement>('[data-action="send-follow-up"]');
    expect(form).not.toBeNull();
    expect(textarea).not.toBeNull();
    expect(send).not.toBeNull();
    expect(send?.type).toBe("submit");
  });

  it("body element has no overflow:hidden that would clip long content (AC3)", () => {
    const view = renderAnchoredPopup({
      disclosure: "disclosure",
      anchor: null,
      text: ""
    });
    const body = view.querySelector<HTMLElement>(".zotero-ai-explain-popup__body");
    const style = body?.getAttribute("style") ?? "";
    expect(style).not.toMatch(/overflow\s*:\s*hidden/iu);
  });

  it("citation click wiring: a delegated click on a rendered citation anchor fires the handler with the right payload (plumbed-not-wired guard)", () => {
    // Wiring contract pinned at this level: the runtime's
    // `startExplain` path renders citation anchors into the popup body
    // (via `renderMarkdownWithCitations`) and attaches a DELEGATED
    // click handler at the popup root. This test pins the delegation
    // shape — anchor → bubble to root → handler reads dataset →
    // dispatches `onCitationClick` — so a regression that stamps
    // anchors but never wires the listener (the literal
    // "plumbed-not-wired" failure mode) trips here.
    const view = renderAnchoredPopup({
      disclosure: "d",
      anchor: null,
      text: ""
    });
    const body = view.querySelector<HTMLElement>(".zotero-ai-explain-popup__body");
    if (body === null) {
      throw new Error("popup body element is missing");
    }
    const lookup = buildCitationLookup([
      {
        itemKey: "ABCD1234",
        title: "T",
        text: "x",
        score: 1,
        chunkIndex: 3,
        attachmentKey: "ATT00007",
        pageIndex: 16
      }
    ]);
    renderMarkdownWithCitations(body, "Claim [ABCD1234#3] holds.", { lookup });

    // Exercise the SHARED `attachCitationClickHandler` helper that the
    // runtime's popup + sidebar wiring and `library-chat-view.ts` all
    // delegate to. Re-implementing the click-walk in the test would let
    // it pass even if the helper regressed — pinning the production
    // helper directly catches that drift.
    const dispatched: CitationClick[] = [];
    const detach = attachCitationClickHandler(view, (citation) => {
      dispatched.push(citation);
    });

    const anchor = body.querySelector<HTMLAnchorElement>("a[data-item-key]");
    if (anchor === null) {
      throw new Error("citation anchor was not rendered");
    }
    anchor.click();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.itemKey).toBe("ABCD1234");
    expect(dispatched[0]?.attachmentKey).toBe("ATT00007");
    expect(dispatched[0]?.pageIndex).toBe(16);

    // Teardown must remove the listener — subsequent clicks must not
    // re-dispatch. Symmetric with the `cleanupExplain` teardown in
    // `zotero-runtime.ts`.
    detach();
    anchor.click();
    expect(dispatched).toHaveLength(1);
  });
});
