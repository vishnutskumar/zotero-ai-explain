/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";

import {
  buildLibraryPrompt,
  renderLibraryChatView,
  wireLibraryChatView
} from "../../src/ui/library-chat-view.js";

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

  it("renders [itemKey] in assistant output as a clickable link with data-item-key", () => {
    // AC-6: the citation token alphabet is exactly `[A-Z0-9]{8}` — Zotero's
    // item-key shape. Both keys below are 8-char so they linkify.
    const view = renderLibraryChatView({
      messages: [{ role: "assistant", content: "Claim one [ABCD1234] and claim two [XYZW5678]." }],
      status: "completed",
      errorMessage: null,
      hasIndex: true
    });
    const links = view.querySelectorAll<HTMLAnchorElement>("a[data-item-key]");
    expect(links.length).toBe(2);
    expect(links[0]?.dataset.itemKey).toBe("ABCD1234");
    expect(links[0]?.textContent).toBe("ABCD1234");
    expect(links[1]?.dataset.itemKey).toBe("XYZW5678");
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
    // AC-6: `onCitationClick` receives a `{ itemKey, ... }` citation object
    // (widened from a bare string). A legacy `[itemKey]` token with no
    // lookup table emits just the itemKey — no page / attachment.
    const view = renderLibraryChatView({
      messages: [{ role: "assistant", content: "Claim [KEYABC42]." }],
      status: "completed",
      errorMessage: null,
      hasIndex: true
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
