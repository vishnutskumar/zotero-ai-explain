import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Cross-file version guard.
//
// `addon/manifest.json` and `package.json` MUST advance together — a
// release tag's strict validation requires the pair to agree, and
// Zotero's auto-updater treats the manifest version as the install's
// identity. This guard exists to catch a maintainer who half-strips
// the `-dev` suffix when prepping a release (or half-adds it when
// returning to dev), which `validateReleaseVersions` would only flag
// on the next tag-build attempt.
//
// Accepted shape: clean semver (release-prep state) OR clean semver
// followed by `-dev` (feature-branch state). No other prerelease
// suffixes — those would silently bypass the strictly-newer-than-
// release ordering Zotero auto-update relies on.

const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-dev)?$/u;

type JsonWithVersion = {
  version?: unknown;
};

const manifest = JSON.parse(readFileSync("addon/manifest.json", "utf8")) as JsonWithVersion;
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as JsonWithVersion;

describe("addon + package version guards", () => {
  it("manifest.json declares a string version of the accepted shape", () => {
    expect(typeof manifest.version).toBe("string");
    expect(manifest.version as string).toMatch(VERSION_SHAPE);
  });

  it("package.json declares a string version of the accepted shape", () => {
    expect(typeof packageJson.version).toBe("string");
    expect(packageJson.version as string).toMatch(VERSION_SHAPE);
  });

  it("manifest.json and package.json versions agree", () => {
    expect(manifest.version).toBe(packageJson.version);
  });

  it("the dev-suffix state is either fully present or fully absent across both files", () => {
    const manifestIsDev = (manifest.version as string).endsWith("-dev");
    const packageIsDev = (packageJson.version as string).endsWith("-dev");
    expect(manifestIsDev).toBe(packageIsDev);
  });
});
