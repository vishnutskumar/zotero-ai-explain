import { describe, expect, it } from "vitest";

import {
  buildUpdateManifest,
  formatCompatibilitySummary,
  parseReleaseVersion,
  readProjectVersions,
  validateReleaseVersions
} from "../../scripts/release-version.mjs";

describe("parseReleaseVersion", () => {
  it("accepts numbered semantic release tags", () => {
    expect(parseReleaseVersion("v1.2.3")).toBe("1.2.3");
    expect(parseReleaseVersion("1.2.3")).toBe("1.2.3");
  });

  it("rejects partial or prerelease tags", () => {
    expect(() => parseReleaseVersion("v1.2")).toThrow("Release tag must be");
    expect(() => parseReleaseVersion("v1.2.3-beta.1")).toThrow("Release tag must be");
  });

  it("rejects dev-suffixed tags (release artifacts must be clean semver)", () => {
    // The strict regex is the guarantee that release tags + release
    // artifacts never carry a `-dev` suffix. Local-development builds
    // route around this through `package-xpi.mjs`'s local-build branch,
    // never through `parseReleaseVersion`.
    expect(() => parseReleaseVersion("v0.4.0-dev")).toThrow("Release tag must be");
    expect(() => parseReleaseVersion("0.4.0-dev")).toThrow("Release tag must be");
  });
});

describe("readProjectVersions", () => {
  it("returns matching manifest + package versions from disk", () => {
    const versions = readProjectVersions();
    expect(typeof versions.packageVersion).toBe("string");
    expect(typeof versions.manifestVersion).toBe("string");
    expect(versions.packageVersion).toBe(versions.manifestVersion);
    // Either dev-suffixed (feature branch) or clean semver (release prep).
    expect(versions.manifestVersion).toMatch(/^\d+\.\d+\.\d+(?:-dev)?$/u);
  });
});

describe("formatCompatibilitySummary", () => {
  it("reports supported Zotero versions for releases", () => {
    expect(
      formatCompatibilitySummary({
        zoteroMaximumVersion: "9.99.99",
        zoteroMinimumVersion: "8.0"
      })
    ).toBe("Compatible with Zotero 8.0 through 9.99.99.");
  });

  it("requires an explicit maximum Zotero version for releases", () => {
    expect(() => formatCompatibilitySummary({ zoteroMinimumVersion: "8.0" })).toThrow(
      "strict_max_version"
    );
  });
});

describe("buildUpdateManifest", () => {
  it("generates the Zotero release update manifest", () => {
    expect(
      buildUpdateManifest(
        "0.1.0",
        {
          extensionId: "zotero-ai-explain@vishnutskumar.github.io",
          zoteroMaximumVersion: "9.99.99",
          zoteroMinimumVersion: "8.0"
        },
        {
          updateHash: "sha256:abc123",
          updateLink:
            "https://github.com/vishnutskumar/zotero-ai-explain/releases/download/v0.1.0/zotero-ai-explain-v0.1.0.xpi"
        }
      )
    ).toEqual({
      addons: {
        "zotero-ai-explain@vishnutskumar.github.io": {
          updates: [
            {
              version: "0.1.0",
              update_link:
                "https://github.com/vishnutskumar/zotero-ai-explain/releases/download/v0.1.0/zotero-ai-explain-v0.1.0.xpi",
              update_hash: "sha256:abc123",
              applications: {
                zotero: {
                  strict_min_version: "8.0",
                  strict_max_version: "9.99.99"
                }
              }
            }
          ]
        }
      }
    });
  });

  it("requires secure update artifacts", () => {
    expect(() =>
      buildUpdateManifest(
        "0.1.0",
        {
          extensionId: "zotero-ai-explain@vishnutskumar.github.io",
          zoteroMaximumVersion: "9.99.99",
          zoteroMinimumVersion: "8.0"
        },
        { updateHash: "sha256:abc123", updateLink: "http://example.test/plugin.xpi" }
      )
    ).toThrow("HTTPS");
  });
});

describe("validateReleaseVersions", () => {
  it("requires package, manifest, and tag versions to match", () => {
    expect(
      validateReleaseVersions("v0.1.0", {
        packageVersion: "0.1.0",
        manifestVersion: "0.1.0"
      })
    ).toBe("0.1.0");

    expect(() =>
      validateReleaseVersions("v0.1.0", {
        packageVersion: "0.2.0",
        manifestVersion: "0.1.0"
      })
    ).toThrow("package.json version 0.2.0 does not match tag v0.1.0");
  });
});
