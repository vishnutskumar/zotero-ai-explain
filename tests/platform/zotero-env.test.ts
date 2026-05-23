import { describe, expect, it } from "vitest";

import { assertZoteroCompatible } from "../../src/platform/zotero-env.js";

describe("assertZoteroCompatible", () => {
  it("accepts supported Zotero versions", () => {
    expect(assertZoteroCompatible("8.0.5")).toEqual({ ok: true });
    expect(assertZoteroCompatible("9.0.3")).toEqual({ ok: true });
  });

  it("rejects unsupported Zotero versions", () => {
    expect(assertZoteroCompatible("7.0.0")).toEqual({
      ok: false,
      reason: "Zotero AI Explain requires Zotero 8 or newer."
    });
  });
});
