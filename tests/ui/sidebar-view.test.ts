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
  });
});
