import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildUpdateManifest,
  formatCompatibilitySummary,
  releaseDownloadBaseUrl,
  readProjectVersions,
  validateReleaseVersions
} from "./release-version.mjs";

// argv[2] is explicit and wins. CI workflows that aren't on a tag (e.g.
// the cross-platform matrix on a feature branch or workflow_dispatch)
// pass the manifest version as argv[2]; GITHUB_REF_NAME would otherwise
// be the branch name like "forge/foo" and fail the semver guard.
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
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

// Bundle the llm-proxy server + backends into the XPI so end users do
// not have to keep the dev checkout on disk. We stage a `llm-proxy/`
// subtree under `addon/` (mirroring the runtime path the bootstrap
// resolves via `data.rootURI`) and clean it up after zipping.
const stagedProxyDir = "addon/llm-proxy";
rmSync(stagedProxyDir, { recursive: true, force: true });
mkdirSync(stagedProxyDir, { recursive: true });
// `cpSync` with `recursive: true` is portable across macOS / Linux and
// avoids shelling out to `cp -R`. The filter strips local-only files
// (test fixtures, README) so the XPI stays lean.
cpSync("scripts/llm-proxy", stagedProxyDir, {
  recursive: true,
  filter(src) {
    if (src.endsWith("README.md")) return false;
    return true;
  }
});

try {
  execFileSync(
    "zip",
    ["-X", "-r", `../${artifactPath}`, "manifest.json", "bootstrap.js", "content", "llm-proxy"],
    {
      cwd: "addon",
      stdio: "inherit"
    }
  );
} finally {
  // Always remove the staged copy; leaving it would confuse subsequent
  // `npm run build` invocations (they expect a clean addon/ tree).
  rmSync(stagedProxyDir, { recursive: true, force: true });
}
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
