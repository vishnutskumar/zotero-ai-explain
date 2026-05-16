import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("README assets", () => {
  it("references the animated Zotero extension preview and language badges", () => {
    const readme = readFileSync("README.md", "utf8");

    expect(readme).toContain("docs/assets/readme-zotero-ai-preview.svg");
    expect(readme).toContain("docs/assets/readme-sidebar-screenshot.svg");
    expect(readme).toContain("TypeScript");
    expect(readme).toContain("JavaScript");
    expect(readme).toContain("CSS");
  });
});
