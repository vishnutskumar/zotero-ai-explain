import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("addon/manifest.json", "utf8"));

describe("addon manifest", () => {
  it("uses a Zotero-compatible email-style extension id", () => {
    expect(manifest.applications.zotero.id).toBe("zotero-ai-explain@vishnutskumar.github.io");
    expect(manifest.applications.zotero.id).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/u);
  });

  it("declares the Zotero-required update manifest URL", () => {
    expect(manifest.applications.zotero.update_url).toBe(
      "https://github.com/vishnutskumar/zotero-ai-explain/releases/latest/download/updates.json"
    );
  });

  it("does not declare a Gecko fallback that can override Zotero compatibility", () => {
    expect(manifest).not.toHaveProperty("browser_specific_settings");
  });

  it("declares the tested Zotero compatibility range", () => {
    expect(manifest.applications.zotero).toMatchObject({
      strict_min_version: "8.0",
      strict_max_version: "9.99.99"
    });
  });
});
