import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readProjectVersions } from "../../scripts/release-version.mjs";

// Local-build sanity: invoking the packaging script with no argv and no
// GITHUB_REF_NAME env should succeed, accept the `-dev`-suffixed manifest
// version verbatim, and produce a correspondingly-named XPI.
//
// We rely on `zip` (POSIX) or `7z` (Windows) being on PATH; if neither
// is installed we skip rather than fail — local builds are an opt-in
// developer convenience.

function hasArchiver() {
  const tool = process.platform === "win32" ? "7z" : "zip";
  const which = spawnSync(process.platform === "win32" ? "where" : "which", [tool], {
    stdio: "ignore"
  });
  return which.status === 0;
}

describe("package-xpi local-build path", () => {
  const versions = readProjectVersions();
  const expectedVersion = versions.manifestVersion;
  const artifactPath = join("dist", `zotero-ai-explain-v${expectedVersion}.xpi`);
  const latestAlias = "zotero-ai-explain.xpi";
  const updatesJson = join("dist", "updates.json");

  it.skipIf(!hasArchiver())("produces a dev-versioned XPI when invoked without tag/argv", () => {
    // Snapshot files we may create so cleanup is targeted.
    const preexistingArtifact = existsSync(artifactPath);
    const preexistingLatest = existsSync(latestAlias);
    const preexistingUpdates = existsSync(updatesJson);

    try {
      const env = { ...process.env };
      delete env.GITHUB_REF_NAME;

      const stdout = execFileSync("node", ["scripts/package-xpi.mjs"], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"]
      });

      expect(stdout).toContain(`version=${expectedVersion}`);
      expect(existsSync(artifactPath)).toBe(true);
      expect(existsSync(latestAlias)).toBe(true);

      // unzip the XPI in-memory and confirm the bundled manifest carries
      // the same `-dev` version. This is the load-bearing assertion: a
      // half-stripped suffix in manifest.json would surface here.
      const manifestText = execFileSync("unzip", ["-p", latestAlias, "manifest.json"], {
        encoding: "utf8"
      });
      const manifest = JSON.parse(manifestText);
      expect(manifest.version).toBe(expectedVersion);
    } finally {
      if (!preexistingArtifact) rmSync(artifactPath, { force: true });
      if (!preexistingLatest) rmSync(latestAlias, { force: true });
      if (!preexistingUpdates) rmSync(updatesJson, { force: true });
    }
  });

  it.skipIf(!hasArchiver())(
    "embeds the manifest version verbatim in the updates.json payload",
    () => {
      const preexistingArtifact = existsSync(artifactPath);
      const preexistingLatest = existsSync(latestAlias);
      const preexistingUpdates = existsSync(updatesJson);

      try {
        const env = { ...process.env };
        delete env.GITHUB_REF_NAME;

        execFileSync("node", ["scripts/package-xpi.mjs"], {
          env,
          stdio: ["ignore", "ignore", "inherit"]
        });

        const updates = JSON.parse(readFileSync(updatesJson, "utf8"));
        const entries = updates.addons[versions.extensionId].updates;
        expect(entries).toHaveLength(1);
        expect(entries[0].version).toBe(expectedVersion);
        expect(entries[0].update_link).toContain(`v${expectedVersion}`);
      } finally {
        if (!preexistingArtifact) rmSync(artifactPath, { force: true });
        if (!preexistingLatest) rmSync(latestAlias, { force: true });
        if (!preexistingUpdates) rmSync(updatesJson, { force: true });
      }
    }
  );
});
