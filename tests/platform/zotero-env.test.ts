import { describe, expect, it } from "vitest";

import { assertZotero8Compatible } from "../../src/platform/zotero-env.js";

describe("assertZotero8Compatible", () => {
  it("accepts Zotero 8 versions", () => {
    expect(assertZotero8Compatible("8.0.5")).toEqual({ ok: true });
  });

  it("rejects Zotero 7 versions", () => {
    expect(assertZotero8Compatible("7.0.0")).toEqual({
      ok: false,
      reason: "Zotero AI Explain requires Zotero 8 or newer."
    });
  });
});
