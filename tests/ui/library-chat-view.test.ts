/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";

import {
  buildLibraryPrompt,
  renderLibraryChatView,
  wireLibraryChatView
} from "../../src/ui/library-chat-view.js";
import { buildCitationLookup } from "../../src/ui/citation-lookup.js";
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

describe("renderLibraryChatView", () => {
  it("renders the empty state when no messages have been exchanged", () => {
    const view = renderLibraryChatView({
      messages: [],
      status: "idle",
      errorMessage: null,
      hasIndex: true
    });
    const empty = view.querySelector(".zotero-ai-library-chat__empty");
    expect(empty).not.toBeNull();
    expect(view.querySelector<HTMLTextAreaElement>('[name="question"]')).not.toBeNull();
    expect(view.querySelector('[data-action="submit-question"]')?.textContent).toBe("Ask");
    expect(view.querySelector('[data-action="new-conversation"]')).not.toBeNull();
  });

  it("renders the 'index your library first' empty state when no index exists", () => {
    const view = renderLibraryChatView({
      messages: [],
      status: "idle",
      errorMessage: null,
      hasIndex: false
    });
    const empty = view.querySelector(".zotero-ai-library-chat__empty");
    const text = empty?.textContent ?? "";
    expect(text.toLowerCase()).toContain("index your library");
  });

  it("renders user and assistant messages with role attribution", () => {
    const view = renderLibraryChatView({
      messages: [
        { role: "user", content: "What is X?" },
        { role: "assistant", content: "X is Y [ABCD1234]." }
      ],
      status: "completed",
      errorMessage: null,
      hasIndex: true
    });
    expect(view.textContent).toContain("What is X?");
    expect(view.textContent).toContain("X is Y");
  });

  it("renders [itemKey] in assistant output as a clickable link with data-item-key when the lookup contains a matching chunk", () => {
    // AC-6 / HIGH-3: the citation token alphabet is exactly `[A-Z0-9]{8}`
    // — Zotero's item-key shape. A bare-key token now routes through
    // `resolveCitation`'s legacy fallback, so it only linkifies when ANY
    // chunk in the lookup shares this itemKey. Without a lookup the
    // token renders as inert text (a separate test below).
    const lookup = buildCitationLookup([
      chunk({ itemKey: "ABCD1234", chunkIndex: 0 }),
      chunk({ itemKey: "XYZW5678", chunkIndex: 0 })
    ]);
    const view = renderLibraryChatView({
      messages: [{ role: "assistant", content: "Claim one [ABCD1234] and claim two [XYZW5678]." }],
      status: "completed",
      errorMessage: null,
      hasIndex: true,
      citationLookups: new Map([[0, lookup]])
    });
    const links = view.querySelectorAll<HTMLAnchorElement>("a[data-item-key]");
    expect(links.length).toBe(2);
    expect(links[0]?.dataset.itemKey).toBe("ABCD1234");
    // HIGH-3 visible text: bracketed, not bare.
    expect(links[0]?.textContent).toBe("[ABCD1234]");
    expect(links[1]?.dataset.itemKey).toBe("XYZW5678");
    expect(links[1]?.textContent).toBe("[XYZW5678]");
  });

  it("renders [itemKey] as inert text when no lookup is supplied (HIGH-3 contract)", () => {
    // HIGH-3: without a lookup, `resolveCitation`'s legacy fallback
    // returns undefined and the token degrades to inert text — matches
    // the popup/sidebar.
    const view = renderLibraryChatView({
      messages: [{ role: "assistant", content: "Claim one [ABCD1234]." }],
      status: "completed",
      errorMessage: null,
      hasIndex: true
    });
    expect(view.querySelector("a")).toBeNull();
    expect(view.textContent).toContain("[ABCD1234]");
  });

  it("escapes citation keys safely (no innerHTML / no markup injection)", () => {
    // If the renderer used innerHTML the angle-bracket payload below would
    // produce a real <img> element inside the link. With createElement +
    // textContent (the contract), the text is literal.
    const malicious = `[<img src=x onerror=alert(1)>]`;
    const view = renderLibraryChatView({
      messages: [{ role: "assistant", content: `Hi ${malicious}` }],
      status: "completed",
      errorMessage: null,
      hasIndex: true
    });
    // No injected <img> should reach the DOM.
    expect(view.querySelector("img")).toBeNull();
  });

  it("renders the streaming indicator when status is streaming", () => {
    const view = renderLibraryChatView({
      messages: [
        { role: "user", content: "Q" },
        { role: "assistant", content: "" }
      ],
      status: "streaming",
      errorMessage: null,
      hasIndex: true
    });
    expect(view.querySelector(".zotero-ai-library-chat__streaming")).not.toBeNull();
  });

  it("renders an error message when status is failed", () => {
    const view = renderLibraryChatView({
      messages: [{ role: "user", content: "Q" }],
      status: "failed",
      errorMessage: "Embedding dimension mismatch.",
      hasIndex: true
    });
    expect(view.textContent).toContain("Embedding dimension mismatch.");
  });

  it("citation anchors render with a visible underline + accent color affordance (HIGH-2)", () => {
    // HIGH-2 follow-up: the shared `renderCitationAnchor` does NOT stamp
    // an inline style; popup/sidebar inherit styling via MARKDOWN_CSS.
    // Library-chat has no MARKDOWN_CSS owner, so the embedded `<style>`
    // tag must carry an `a {}` rule scoped to the assistant body that
    // ships an underline + accent color so anchors look clickable.
    const lookup = buildCitationLookup([chunk({ itemKey: "ABCD1234", chunkIndex: 0 })]);
    const view = renderLibraryChatView({
      messages: [{ role: "assistant", content: "Claim [ABCD1234]." }],
      status: "completed",
      errorMessage: null,
      hasIndex: true,
      citationLookups: new Map([[0, lookup]])
    });
    // jsdom doesn't evaluate the live cascaded computed style for
    // CSS-from-`<style>`-tag rules consistently across all selectors,
    // so we assert against the rule's source text in the embedded
    // <style> tag. The selector must scope to `.zotero-ai-library-chat__body a`
    // and the declaration block must include both `text-decoration: underline`
    // and a color affordance.
    const styleTag = view.querySelector("style");
    const styleText = styleTag?.textContent ?? "";
    expect(styleText).toMatch(/\.zotero-ai-library-chat__body a/u);
    expect(styleText).toMatch(/text-decoration:\s*underline/u);
    // Color affordance: either the literal ACCENT token or a generic
    // color rule. The current implementation interpolates the ACCENT
    // var; the regex tolerates whitespace differences.
    expect(styleText).toMatch(/color:\s*var\(--accent-blue/u);
    // And the anchor itself rendered so the rule has a target.
    const anchor = view.querySelector<HTMLAnchorElement>("a[data-item-key]");
    expect(anchor).not.toBeNull();
  });
});

describe("wireLibraryChatView", () => {
  function setup(opts: { hasIndex: boolean } = { hasIndex: true }) {
    const view = renderLibraryChatView({
      messages: [],
      status: "idle",
      errorMessage: null,
      hasIndex: opts.hasIndex
    });
    document.body.append(view);
    const onSubmit = vi.fn(() => Promise.resolve());
    const onReset = vi.fn();
    const onCitationClick = vi.fn();
    const detach = wireLibraryChatView({
      view,
      onSubmit,
      onReset,
      onCitationClick
    });
    return { view, detach, onSubmit, onReset, onCitationClick };
  }

  it("invokes onSubmit with the trimmed question text when the form submits", () => {
    const { view, detach, onSubmit } = setup();
    const textarea = view.querySelector<HTMLTextAreaElement>('[name="question"]');
    const form = view.querySelector<HTMLFormElement>(".zotero-ai-library-chat__form");
    if (textarea) {
      textarea.value = "  what is X?  ";
    }
    form?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    expect(onSubmit).toHaveBeenCalledWith("what is X?");
    expect(textarea?.value).toBe("");
    detach();
  });

  it("does not invoke onSubmit when the input is empty / whitespace only", () => {
    const { view, detach, onSubmit } = setup();
    const textarea = view.querySelector<HTMLTextAreaElement>('[name="question"]');
    const form = view.querySelector<HTMLFormElement>(".zotero-ai-library-chat__form");
    if (textarea) {
      textarea.value = "   ";
    }
    form?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    detach();
  });

  it("invokes onReset when 'New conversation' is clicked", () => {
    const { view, detach, onReset } = setup();
    const reset = view.querySelector<HTMLButtonElement>('[data-action="new-conversation"]');
    reset?.click();
    expect(onReset).toHaveBeenCalledTimes(1);
    detach();
  });

  it("invokes onCitationClick with the resolved citation when a citation link is clicked", () => {
    // AC-6 / HIGH-3: `onCitationClick` receives a `{ itemKey, ... }`
    // citation object (widened from a bare string). A bare-key token
    // linkifies only when the lookup contains a matching chunk —
    // `resolveCitation`'s legacy fallback synthesises an entry with
    // just the itemKey, no page / attachment.
    const lookup = buildCitationLookup([chunk({ itemKey: "KEYABC42", chunkIndex: 0 })]);
    const view = renderLibraryChatView({
      messages: [{ role: "assistant", content: "Claim [KEYABC42]." }],
      status: "completed",
      errorMessage: null,
      hasIndex: true,
      citationLookups: new Map([[0, lookup]])
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
    expect(link).not.toBeNull();
    link?.click();
    expect(onCitationClick).toHaveBeenCalledWith(expect.objectContaining({ itemKey: "KEYABC42" }));
    detach();
  });

  it("detach removes listeners so subsequent submits no longer fire onSubmit", () => {
    const { view, detach, onSubmit } = setup();
    detach();
    const textarea = view.querySelector<HTMLTextAreaElement>('[name="question"]');
    const form = view.querySelector<HTMLFormElement>(".zotero-ai-library-chat__form");
    if (textarea) {
      textarea.value = "Q";
    }
    form?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("buildLibraryPrompt", () => {
  it("includes the prompt header, every excerpt with its item key, and the question", () => {
    const prompt = buildLibraryPrompt({
      question: "What does X mean?",
      chunks: [
        { itemKey: "KEY1", title: "Title1", text: "X means alpha.", score: 0.9 },
        { itemKey: "KEY2", title: "Title2", text: "X means beta.", score: 0.7 }
      ]
    });
    expect(prompt).toContain("[KEY1] X means alpha.");
    expect(prompt).toContain("[KEY2] X means beta.");
    expect(prompt).toContain("Question: What does X mean?");
    expect(prompt.toLowerCase()).toContain("cite");
  });

  it("renders an empty excerpts section when chunks is empty", () => {
    const prompt = buildLibraryPrompt({ question: "Q", chunks: [] });
    expect(prompt).toContain("Question: Q");
  });
});
