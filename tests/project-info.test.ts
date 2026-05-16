import { describe, expect, it } from "vitest";

import { projectInfo } from "../src/project-info.js";

describe("projectInfo", () => {
  it("records the Zotero plugin scaffold identity", () => {
    expect(projectInfo).toEqual({
      displayName: "Zotero AI Explain",
      packageName: "zotero-ai-explain",
      zoteroMinimumVersion: "8.0",
      supportedZoteroMajor: 8
    });
  });

  it("records the minimum supported Zotero version", () => {
    expect(projectInfo.zoteroMinimumVersion).toBe("8.0");
    expect(projectInfo.supportedZoteroMajor).toBe(8);
  });
});
