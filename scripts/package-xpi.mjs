import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildUpdateManifest,
  formatCompatibilitySummary,
  releaseDownloadBaseUrl,
  readProjectVersions,
  validateReleaseVersions
} from "./release-version.mjs";

const tag = process.env.GITHUB_REF_NAME ?? process.argv[2] ?? "";
const versions = readProjectVersions();
const version = validateReleaseVersions(tag, versions);
const distDirectory = "dist";
const artifactName = `zotero-ai-explain-v${version}.xpi`;
const artifactPath = join(distDirectory, artifactName);
const updateManifestPath = join(distDirectory, "updates.json");
const latestArtifactPath = "zotero-ai-explain.xpi";

mkdirSync(distDirectory, { recursive: true });
rmSync(artifactPath, { force: true });
rmSync(latestArtifactPath, { force: true });
// Clean up legacy ESM bundle if present from previous builds; the active
// distribution is the IIFE bundle at content/zotero-ai-explain.js.
rmSync("addon/content/zotero-ai-explain.sys.mjs", { force: true });
execFileSync(
  "zip",
  ["-X", "-r", `../${artifactPath}`, "manifest.json", "bootstrap.js", "content"],
  {
    cwd: "addon",
    stdio: "inherit"
  }
);
copyFileSync(artifactPath, latestArtifactPath);

const updateHash = `sha256:${createHash("sha256").update(readFileSync(artifactPath)).digest("hex")}`;
const updateLink = `${releaseDownloadBaseUrl}/v${version}/${artifactName}`;
writeFileSync(
  updateManifestPath,
  `${JSON.stringify(buildUpdateManifest(version, versions, { updateHash, updateLink }), null, 2)}\n`
);

console.log(artifactPath);
console.log(updateManifestPath);
console.log(latestArtifactPath);
console.log(formatCompatibilitySummary(versions));
