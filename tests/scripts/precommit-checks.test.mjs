import { describe, expect, it } from "vitest";

import { checkTextContents, containsLocalMachinePath } from "../../scripts/precommit-checks.mjs";

const macUserPath = ["/Us", "ers/alice/project/file.ts"].join("");
const linuxUserPath = ["file://", "/ho", "me/alice/project/file.ts"].join("");
const tempPath = ["/pri", "vate/t", "mp/build-output.txt"].join("");

describe("containsLocalMachinePath", () => {
  it("flags absolute local machine paths", () => {
    expect(containsLocalMachinePath(`See ${macUserPath}`)).toBe(true);
    expect(containsLocalMachinePath(`See ${linuxUserPath}`)).toBe(true);
    expect(containsLocalMachinePath(`See ${tempPath}`)).toBe(true);
  });

  it("allows repo-relative paths and package-like absolute paths", () => {
    expect(containsLocalMachinePath("See src/platform/reader-integration.ts")).toBe(false);
    expect(containsLocalMachinePath("Import from /zotero-ai-explain/content/module.js")).toBe(
      false
    );
    expect(
      containsLocalMachinePath("Visit https://github.com/vishnutskumar/zotero-ai-explain")
    ).toBe(false);
  });
});

describe("checkTextContents", () => {
  it("reports local paths with a repo-relative guidance message", () => {
    expect(checkTextContents("README.md", `Open ${macUserPath}`)).toEqual([
      "README.md: contains a local machine path; use a repo-relative path instead"
    ]);
  });
});
