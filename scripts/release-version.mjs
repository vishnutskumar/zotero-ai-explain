import { readFileSync } from "node:fs";

export const releaseDownloadBaseUrl =
  "https://github.com/vishnutskumar/zotero-ai-explain/releases/download";
// Strict by design: release artifacts must be clean semver. Prerelease
// suffixes like `-dev` (used on feature branches so Zotero's auto-updater
// treats the locally-installed XPI as strictly newer than the latest
// GitHub release) MUST NOT flow through here. The local-build path in
// `scripts/package-xpi.mjs` reads the manifest version verbatim when no
// tag is supplied, so dev workflows never touch this regex. Release tags
// also go through `.github/workflows/release.yml`'s
// `v[0-9]+.[0-9]+.[0-9]+` filter, which already rejects `-dev`.
export const semverPattern = /^(?:v)?(?<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;

export function parseReleaseVersion(tag) {
  const match = semverPattern.exec(tag);

  if (match?.groups?.version === undefined) {
    throw new Error(`Release tag must be vMAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH: ${tag}`);
  }

  return match.groups.version;
}

export function readProjectVersions(options = {}) {
  const packageJsonPath = options.packageJsonPath ?? "package.json";
  const manifestJsonPath = options.manifestJsonPath ?? "addon/manifest.json";
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const manifestJson = JSON.parse(readFileSync(manifestJsonPath, "utf8"));

  if (typeof packageJson.version !== "string") {
    throw new Error(`${packageJsonPath} is missing a string version`);
  }

  if (typeof manifestJson.version !== "string") {
    throw new Error(`${manifestJsonPath} is missing a string version`);
  }

  return {
    extensionId: manifestJson.applications?.zotero?.id,
    packageVersion: packageJson.version,
    manifestVersion: manifestJson.version,
    zoteroMaximumVersion: manifestJson.applications?.zotero?.strict_max_version,
    zoteroMinimumVersion: manifestJson.applications?.zotero?.strict_min_version,
    zoteroUpdateUrl: manifestJson.applications?.zotero?.update_url
  };
}

export function validateReleaseVersions(tag, versions) {
  const tagVersion = parseReleaseVersion(tag);

  if (versions.packageVersion !== tagVersion) {
    throw new Error(`package.json version ${versions.packageVersion} does not match tag ${tag}`);
  }

  if (versions.manifestVersion !== tagVersion) {
    throw new Error(
      `addon/manifest.json version ${versions.manifestVersion} does not match tag ${tag}`
    );
  }

  return tagVersion;
}

export function formatCompatibilitySummary(versions) {
  if (typeof versions.zoteroMinimumVersion !== "string") {
    throw new Error("addon/manifest.json is missing applications.zotero.strict_min_version");
  }

  if (typeof versions.zoteroMaximumVersion !== "string") {
    throw new Error("addon/manifest.json is missing applications.zotero.strict_max_version");
  }

  return `Compatible with Zotero ${versions.zoteroMinimumVersion} through ${versions.zoteroMaximumVersion}.`;
}

export function buildUpdateManifest(version, versions, artifact) {
  if (typeof versions.extensionId !== "string") {
    throw new Error("addon/manifest.json is missing applications.zotero.id");
  }

  if (typeof artifact.updateLink !== "string" || !artifact.updateLink.startsWith("https://")) {
    throw new Error("Release update_link must be an HTTPS URL");
  }

  if (typeof artifact.updateHash !== "string" || !artifact.updateHash.startsWith("sha256:")) {
    throw new Error("Release update_hash must be a sha256 hash");
  }

  formatCompatibilitySummary(versions);

  return {
    addons: {
      [versions.extensionId]: {
        updates: [
          {
            version,
            update_link: artifact.updateLink,
            update_hash: artifact.updateHash,
            applications: {
              zotero: {
                strict_min_version: versions.zoteroMinimumVersion,
                strict_max_version: versions.zoteroMaximumVersion
              }
            }
          }
        ]
      }
    }
  };
}
