import { describe, expect, it } from "vitest";

import { createReaderIntegration } from "../../src/platform/reader-integration.js";

const emptySource = {
  itemKey: null,
  itemTitle: null,
  attachmentKey: null,
  pageLabel: null,
  location: null
};

describe("createReaderIntegration", () => {
  it("triggers explain only for normalized non-empty selections", () => {
    const calls: string[] = [];
    const integration = createReaderIntegration({
      onExplain: (selection) => calls.push(selection.quote)
    });

    integration.handleSelection({
      quote: "  important text  ",
      source: emptySource,
      anchor: { left: 1, top: 2, width: 3, height: 4 }
    });
    integration.handleSelection({
      quote: " ",
      source: emptySource,
      anchor: null
    });

    expect(calls).toEqual(["important text"]);
  });
});
