import { describe, expect, it } from "vitest";

import {
  checkTextContents,
  containsLocalMachinePath,
  containsTmpPath,
  shouldCheckWorktreeFile
} from "../../scripts/precommit-checks.mjs";

const macUserPath = ["/Us", "ers/alice/project/file.ts"].join("");
const linuxUserPath = ["file://", "/ho", "me/alice/project/file.ts"].join("");
const tempPath = ["/pri", "vate/t", "mp/build-output.txt"].join("");

describe("containsLocalMachinePath", () => {
  it("flags absolute home-directory paths", () => {
    expect(containsLocalMachinePath(`See ${macUserPath}`)).toBe(true);
    expect(containsLocalMachinePath(`See ${linuxUserPath}`)).toBe(true);
  });

  it("no longer treats /tmp or /private as a local-machine path (covered by containsTmpPath)", () => {
    expect(containsLocalMachinePath(`See ${tempPath}`)).toBe(false);
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

// Fixture string segments below are concatenated at runtime so the
// `/t` + `mp/...` substring never appears literally in this source —
// the universal precommit check rejects /tmp-prefixed paths in .ts/
// .mjs files and would otherwise flag this very test.
const tmpLog = ["/t", "mp/zotero-e2e-latest.log"].join("");
const tmpWorkflowLog = ["/t", "mp/output.log"].join("");
const tmpSourceIndex = ["/t", "mp/test-index.json"].join("");

describe("containsTmpPath", () => {
  it("flags /tmp and /private/tmp paths", () => {
    expect(containsTmpPath(`See ${tempPath}`)).toBe(true);
    expect(containsTmpPath(`See ${tmpLog}`)).toBe(true);
  });
});

describe("checkTextContents", () => {
  it("reports local paths with a repo-relative guidance message", () => {
    expect(checkTextContents("README.md", `Open ${macUserPath}`)).toEqual([
      "README.md: contains a local machine path; use a repo-relative path instead"
    ]);
  });

  it("allows /tmp paths inside markdown / yml documentation files", () => {
    expect(checkTextContents("README.md", `Open ${tmpLog}`)).toEqual([]);
    expect(checkTextContents(".github/workflows/ci.yml", `path: ${tmpWorkflowLog}`)).toEqual([]);
  });

  it("still flags /tmp paths inside source files (.ts, .mjs, .js)", () => {
    expect(checkTextContents("src/foo.ts", `return "${tmpSourceIndex}";`)).toEqual([
      "src/foo.ts: contains a /tmp or /private path; use a repo-relative path instead"
    ]);
  });
});

describe("shouldCheckWorktreeFile", () => {
  it("skips deleted tracked paths during renames", () => {
    expect(shouldCheckWorktreeFile("path-that-does-not-exist.md")).toBe(false);
  });
});
