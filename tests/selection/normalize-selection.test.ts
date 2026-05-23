import { describe, expect, it } from "vitest";

import { normalizeSelection } from "../../src/selection/normalize-selection.js";

describe("normalizeSelection", () => {
  it("trims selected text and preserves source metadata", () => {
    expect(
      normalizeSelection({
        quote: "  Photosynthesis converts light into chemical energy.  ",
        source: {
          itemKey: "ITEM1",
          itemTitle: "Biology Paper",
          attachmentKey: "ATT1",
          pageLabel: "12"
        },
        anchor: { left: 10, top: 20, width: 100, height: 15 }
      })
    ).toEqual({
      ok: true,
      selection: {
        quote: "Photosynthesis converts light into chemical energy.",
        source: {
          itemKey: "ITEM1",
          itemTitle: "Biology Paper",
          attachmentKey: "ATT1",
          pageLabel: "12"
        },
        anchor: { left: 10, top: 20, width: 100, height: 15 }
      }
    });
  });

  it("rejects empty selections", () => {
    expect(
      normalizeSelection({
        quote: "   ",
        source: {
          itemKey: null,
          itemTitle: null,
          attachmentKey: null,
          pageLabel: null
        },
        anchor: null
      })
    ).toEqual({ ok: false, reason: "Select text before asking for an explanation." });
  });
});
