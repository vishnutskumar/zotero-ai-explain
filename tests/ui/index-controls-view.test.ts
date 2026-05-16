/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import { renderIndexControls } from "../../src/ui/index-controls-view.js";

describe("renderIndexControls", () => {
  it("renders status and control buttons", () => {
    const view = renderIndexControls({
      state: "running",
      totalItems: 20,
      indexedItems: 4,
      failedItems: 1
    });

    expect(view.textContent).toContain("4 / 20 indexed");
    expect(view.textContent).toContain("1 failed");
    expect(view.querySelector('[data-action="pause-index"]')).not.toBeNull();
    expect(view.querySelector('[data-action="clear-index"]')).not.toBeNull();
  });
});
