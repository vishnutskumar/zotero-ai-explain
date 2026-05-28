import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname } from "node:path";

const MAX_FILE_SIZE_BYTES = 500 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);
const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);
const JSON_EXTENSIONS = new Set([".json"]);
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/;
const MERGE_CONFLICT_PATTERN = /^(<{7}|={7}|>{7})/m;
// Match user-home paths (Users/, home/) — those are the high-signal
// cases of "a developer left their checkout path in a committed file".
// The matching tmp + private patterns are also fair game in source
// files, but legitimate documentation + CI workflows reference log
// paths there; gating those patterns to non-doc files keeps the check
// meaningful without false-positiving on prose.
const LOCAL_PATH_PATTERNS = [
  /(?:file:\/\/)?\/Users\/[^\s)'"}>]+/u,
  // Allow the canonical Linuxbrew system install location under
  // `/home/linuxbrew/.linuxbrew` — it's the same path on every
  // Linuxbrew install, not per-user. Other home-prefixed paths still
  // get flagged since they leak the developer's username.
  /(?:file:\/\/)?\/home\/(?!linuxbrew\/)[^\s)'"}>]+/u
];
const TMP_PATH_PATTERNS = [
  /(?:file:\/\/)?\/private\/(?:tmp|var)\/[^\s)'"}>]+/u,
  /(?:file:\/\/)?\/tmp\/[^\s)'"}>]+/u
];
const DOC_EXTENSIONS = new Set([".md", ".yml", ".yaml"]);

export function runUniversalChecks() {
  const gitOutput = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  const files = gitOutput.split("\0").filter(Boolean);
  const errors = [];
  let changed = false;

  const seenLowercasePaths = new Map();

  for (const file of files) {
    if (!shouldCheckWorktreeFile(file)) {
      continue;
    }

    const stats = statSync(file);
    if (!stats.isFile()) {
      continue;
    }

    if (stats.size > MAX_FILE_SIZE_BYTES) {
      errors.push(`${file}: file exceeds 500 KB`);
    }

    const lowercasePath = file.toLocaleLowerCase("en-US");
    const previousPath = seenLowercasePaths.get(lowercasePath);
    if (previousPath !== undefined && previousPath !== file) {
      errors.push(`${file}: case conflict with ${previousPath}`);
    }
    seenLowercasePaths.set(lowercasePath, file);

    const extension = extname(file);
    if (!TEXT_EXTENSIONS.has(extension)) {
      continue;
    }

    let contents = readFileSync(file, "utf8");
    const originalContents = contents;

    contents = contents.replace(/\r\n?/g, "\n");
    contents = contents
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/u, ""))
      .join("\n");
    contents = `${contents.replace(/\n*$/u, "")}\n`;

    if (contents !== originalContents) {
      writeFileSync(file, contents);
      changed = true;
    }

    errors.push(...checkTextContents(file, contents));

    if (JSON_EXTENSIONS.has(extension)) {
      try {
        JSON.parse(contents);
      } catch (error) {
        errors.push(`${file}: invalid JSON (${formatError(error)})`);
      }
    }

    if (YAML_EXTENSIONS.has(extension)) {
      validateYaml(file, errors);
    }
  }

  if (changed) {
    errors.push("one or more files were normalized; review the changes and rerun pre-commit");
  }

  return errors;
}

export function checkTextContents(file, contents) {
  const errors = [];

  if (MERGE_CONFLICT_PATTERN.test(contents)) {
    errors.push(`${file}: contains merge conflict markers`);
  }

  if (PRIVATE_KEY_PATTERN.test(contents)) {
    errors.push(`${file}: contains a private key marker`);
  }

  if (containsLocalMachinePath(contents)) {
    errors.push(`${file}: contains a local machine path; use a repo-relative path instead`);
  }
  if (!DOC_EXTENSIONS.has(extname(file)) && containsTmpPath(contents)) {
    errors.push(`${file}: contains a /tmp or /private path; use a repo-relative path instead`);
  }

  return errors;
}

export function containsLocalMachinePath(contents) {
  return LOCAL_PATH_PATTERNS.some((pattern) => pattern.test(contents));
}

export function containsTmpPath(contents) {
  return TMP_PATH_PATTERNS.some((pattern) => pattern.test(contents));
}

export function shouldCheckWorktreeFile(file) {
  return existsSync(file);
}

function validateYaml(file, errors) {
  try {
    execFileSync("ruby", ["-e", "require 'yaml'; YAML.load_file(ARGV.fetch(0))", file], {
      stdio: "pipe"
    });
  } catch (error) {
    errors.push(`${file}: invalid YAML (${formatError(error)})`);
  }
}

function formatError(error) {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}
