/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import { renderSidebarConversation } from "../../src/ui/sidebar-view.js";

describe("renderSidebarConversation", () => {
  it("renders pinned quote, source, and messages", () => {
    const view = renderSidebarConversation({
      quote: "Dense text.",
      sourceLabel: "Paper, p. 4",
      messages: [
        { role: "user", content: "Explain this." },
        { role: "assistant", content: "It means something specific." }
      ]
    });

    expect(view.textContent).toContain("Dense text.");
    expect(view.textContent).toContain("Paper, p. 4");
    expect(view.textContent).toContain("Explain this.");
    expect(view.textContent).toContain("It means something specific.");
    expect(view.querySelector<HTMLTextAreaElement>('[name="followUp"]')).not.toBeNull();
    expect(view.querySelector('[data-action="send-follow-up"]')?.textContent).toBe("Send");
  });

  it("renders a close button (×) in the header with an aria-label", () => {
    const view = renderSidebarConversation({
      quote: "Q",
      sourceLabel: "S",
      messages: []
    });
    const close = view.querySelector<HTMLButtonElement>('[data-action="close-sidebar"]');
    expect(close).not.toBeNull();
    expect(close?.getAttribute("aria-label")).toBe("Close");
    expect(close?.textContent).toBe("×");
    // The close affordance MUST live in the header, not in the footer or
    // message list, so it is always visible regardless of scroll position.
    const header = view.querySelector(".zotero-ai-explain-sidebar__header");
    expect(header?.contains(close as Node)).toBe(true);
  });

  it("renders assistant markdown into the message body (lists become real <li>s)", () => {
    const view = renderSidebarConversation({
      quote: "Q",
      sourceLabel: "S",
      messages: [{ role: "assistant", content: "Steps:\n- one\n- two" }]
    });
    // The runtime contract: markdown rendering produces real DOM, so a
    // bulleted list in the model output yields actual <ul><li> nodes.
    const items = view.querySelectorAll(".zotero-ai-explain-sidebar__messages ul li");
    expect(items.length).toBe(2);
    expect(items[0]?.textContent).toBe("one");
    expect(items[1]?.textContent).toBe("two");
  });

  it("AC-18: each rendered message is a chat-bubble turn with a role data attribute", () => {
    const view = renderSidebarConversation({
      quote: "Q",
      sourceLabel: "S",
      messages: [
        { role: "user", content: "Q?" },
        { role: "assistant", content: "A." }
      ]
    });
    const turns = view.querySelectorAll<HTMLLIElement>(".zotero-ai-explain-sidebar__turn");
    expect(turns.length).toBe(2);
    expect(turns[0]?.dataset.role).toBe("user");
    expect(turns[1]?.dataset.role).toBe("assistant");
  });

  it("AC-18: mounts a <style> block that defines the bubble layout", () => {
    const view = renderSidebarConversation({ quote: "Q", sourceLabel: "S", messages: [] });
    const style = view.querySelector("style");
    expect(style).not.toBeNull();
    const css = style?.textContent ?? "";
    // Bubble side+colour rules — the user-visible AC-18 invariant.
    expect(css).toContain('.zotero-ai-explain-sidebar__turn[data-role="assistant"]');
    expect(css).toContain('.zotero-ai-explain-sidebar__turn[data-role="user"]');
    expect(css).toContain("align-self: flex-start");
    expect(css).toContain("align-self: flex-end");
    // Role text is communicated visually by the bubble; assistive tech
    // still sees the span via the DOM.
    expect(css).toContain(".zotero-ai-explain-sidebar__role");
    // AC-18 + codex polish: visually hide the role span via the
    // standard sr-only pattern so screen readers still announce it.
    // Plain `display: none` would remove it from the a11y tree.
    expect(css).toContain("clip: rect(0, 0, 0, 0)");
  });

  it("AC-18: filters system messages out of the rendered turns", () => {
    const view = renderSidebarConversation({
      quote: "Q",
      sourceLabel: "S",
      messages: [
        { role: "system", content: "Document: Real-Time Systems Page: 1" },
        { role: "user", content: "Explain this." },
        { role: "assistant", content: "It means X." }
      ]
    });
    const turns = view.querySelectorAll<HTMLLIElement>(".zotero-ai-explain-sidebar__turn");
    expect(turns.length).toBe(2);
    expect(Array.from(turns).map((t) => t.dataset.role)).toEqual(["user", "assistant"]);
    // The system frame must not leak into the rendered tree at all —
    // assertion guards against a future refactor that hides it via CSS
    // (which assistive tech would still announce).
    const messagesContainer = view.querySelector(".zotero-ai-explain-sidebar__messages");
    expect(messagesContainer?.textContent).not.toContain("Real-Time Systems");
  });
});
