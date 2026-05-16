/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import { renderAnchoredPopup } from "../../src/ui/anchored-popup-view.js";

describe("renderAnchoredPopup", () => {
  it("renders provider disclosure and positions from the selection anchor", () => {
    const view = renderAnchoredPopup({
      disclosure: "Selected text will be sent to OpenAI using gpt-test.",
      anchor: { left: 10, top: 20, width: 100, height: 30 },
      text: "Explanation"
    });

    expect(view.style.left).toBe("10px");
    expect(view.style.top).toBe("20px");
    expect(view.textContent).toContain("Selected text will be sent to OpenAI using gpt-test.");
    expect(view.textContent).toContain("Explanation");
    expect(view.querySelector('[data-action="continue-sidebar"]')?.textContent).toBe(
      "Open in sidebar"
    );
    expect(view.querySelector('[data-action="retry"]')?.textContent).toBe("Retry");
  });
});
