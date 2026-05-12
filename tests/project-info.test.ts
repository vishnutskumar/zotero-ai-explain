import { describe, expect, it } from "vitest";

import { projectInfo } from "../src/project-info.js";

describe("projectInfo", () => {
  it("records the Zotero plugin scaffold identity", () => {
    expect(projectInfo).toEqual({
      displayName: "Zotero AI Explain",
      packageName: "zotero-ai-explain",
      zoteroMinimumVersion: "7.0"
    });
  });
});
