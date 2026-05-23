/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import { createReaderDomAdapter } from "../../src/platform/reader-dom-adapter.js";

describe("createReaderDomAdapter", () => {
  it("converts reader mouseup selections into selection contexts", () => {
    const quotes: string[] = [];
    const adapter = createReaderDomAdapter({
      document,
      getSelectionText: () => " selected text ",
      getAnchor: () => ({ left: 10, top: 20, width: 30, height: 40 }),
      getSource: () => ({
        itemKey: "ITEM",
        itemTitle: "Paper",
        attachmentKey: "ATT",
        pageLabel: "5"
      }),
      onSelection: (selection) => quotes.push(selection.quote)
    });

    adapter.attach();
    document.dispatchEvent(new MouseEvent("mouseup"));
    adapter.detach();
    document.dispatchEvent(new MouseEvent("mouseup"));

    expect(quotes).toEqual([" selected text "]);
  });
});
