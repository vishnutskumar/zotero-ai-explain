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
    const items = view.querySelectorAll("ul li");
    expect(items.length).toBe(2);
    expect(items[0]?.textContent).toBe("one");
    expect(items[1]?.textContent).toBe("two");
  });
});
