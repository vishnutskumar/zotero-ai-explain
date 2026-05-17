#!/usr/bin/env node
/**
 * One-shot: launch Zotero with the `extensions.zotero-ai-explain.dump-tokens`
 * pref set to true, wait for the plugin's `Zotero AI Explain token dump:`
 * log line, parse the JSON tail, and write it to
 * `.forge/phases/zotero-e2e-harness/zotero9-tokens.json`.
 *
 * Usage:
 *   node scripts/zotero-e2e/dump-tokens.mjs [--xpi <path>] [--timeout <seconds>]
 *
 * Exit codes:
 *   0 -> dump captured and written
 *   1 -> dump not seen / harness failure
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_BINARY,
  DEFAULT_MARIONETTE_PORT,
  REPO_ROOT,
  cleanupProfile,
  createProfile,
  installPlugin,
  spawnZotero
} from "./launch.mjs";

const DUMP_LINE_PREFIX = "Zotero AI Explain token dump:";
const OUTPUT_PATH = join(REPO_ROOT, ".forge/phases/zotero-e2e-harness/zotero9-tokens.json");

function parseArgs(argv) {
  const args = {
    xpiPath: process.env.ZOTERO_XPI ?? join(REPO_ROOT, "zotero-ai-explain.xpi"),
    binaryPath: process.env.ZOTERO_BINARY ?? DEFAULT_BINARY,
    timeoutSeconds: Number(process.env.ZOTERO_TOKEN_TIMEOUT ?? "45")
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--xpi") {
      args.xpiPath = argv[i + 1];
      i += 1;
    } else if (arg === "--binary") {
      args.binaryPath = argv[i + 1];
      i += 1;
    } else if (arg === "--timeout") {
      args.timeoutSeconds = Number(argv[i + 1]);
      i += 1;
    }
  }
  return args;
}

function extractDumpJson(logBuffer) {
  const lines = logBuffer.split(/\r?\n/);
  for (const line of lines) {
    const idx = line.indexOf(DUMP_LINE_PREFIX);
    if (idx === -1) {
      continue;
    }
    const tail = line.slice(idx + DUMP_LINE_PREFIX.length).trim();
    try {
      return JSON.parse(tail);
    } catch {
      // Fallback: the tail might have a trailing log suffix; find the
      // balanced JSON object.
      const start = tail.indexOf("{");
      const end = tail.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(tail.slice(start, end + 1));
        } catch {
          /* try next line */
        }
      }
    }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const xpiPath = resolve(args.xpiPath);
  if (!existsSync(xpiPath)) {
    process.stderr.write(`[dump-tokens] XPI not found: ${xpiPath}\n`);
    process.exit(1);
  }
  if (!existsSync(args.binaryPath)) {
    process.stderr.write(`[dump-tokens] Zotero binary not found: ${args.binaryPath}\n`);
    process.exit(1);
  }

  const profileDir = createProfile({
    marionettePort: DEFAULT_MARIONETTE_PORT,
    extraPrefs: { "extensions.zotero-ai-explain.dump-tokens": true }
  });
  installPlugin(profileDir, xpiPath, { unpack: true });

  const logPath = join(profileDir, "zotero.log");
  const handle = spawnZotero({
    binaryPath: args.binaryPath,
    profileDir,
    logPath,
    quiet: false
  });

  let dump = null;
  try {
    await handle.waitForLogLine(/Zotero AI Explain token dump:/u, {
      timeoutMs: args.timeoutSeconds * 1000
    });
    dump = extractDumpJson(handle.getLog());
  } catch (err) {
    process.stderr.write(`[dump-tokens] ${String(err)}\n`);
  } finally {
    await handle.shutdown({ graceMs: 3000 });
  }

  if (dump === null) {
    process.stderr.write("[dump-tokens] failed to capture token dump\n");
    cleanupProfile(profileDir);
    process.exit(1);
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(dump, null, 2)}\n`, "utf8");
  process.stdout.write(`[dump-tokens] wrote ${OUTPUT_PATH}\n`);
  cleanupProfile(profileDir);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[dump-tokens] fatal: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
