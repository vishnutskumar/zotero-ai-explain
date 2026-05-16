#!/usr/bin/env node
/**
 * Zotero E2E harness CLI.
 *
 * Spawns a real Zotero process with a fresh profile, the plugin XPI installed,
 * captures debug output, and exits 0 only if the plugin's startup line is
 * observed.
 *
 * Usage:
 *   node scripts/zotero-e2e/spawn.mjs [--wait <seconds>] [--keep] [--quiet]
 *
 * Env:
 *   ZOTERO_BINARY    Path to Zotero binary (default: macOS bundle path).
 *   ZOTERO_XPI       Path to the XPI to install (default: ./zotero-ai-explain.xpi).
 *   ZOTERO_E2E_WAIT  Seconds to wait before terminating Zotero (default: 12).
 *   ZOTERO_E2E_KEEP  If set to "1", do not clean up the profile dir.
 *
 * Exit codes:
 *   0 -> Plugin startup line found in log.
 *   1 -> No startup line found (plugin failed to load) or harness error.
 *   2 -> Usage error.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  DEFAULT_BINARY,
  DEFAULT_MARIONETTE_PORT,
  REPO_ROOT,
  STARTUP_LINE,
  cleanupProfile,
  createProfile,
  installPlugin,
  readLogFile,
  spawnZotero
} from "./launch.mjs";

function parseArgs(argv) {
  const args = {
    waitSeconds: Number(process.env.ZOTERO_E2E_WAIT ?? "12"),
    keepProfile: process.env.ZOTERO_E2E_KEEP === "1",
    quiet: false,
    profileDir: null,
    unpack: process.env.ZOTERO_E2E_UNPACK !== "0",
    extra: []
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--wait") {
      args.waitSeconds = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--keep") {
      args.keepProfile = true;
    } else if (arg === "--quiet") {
      args.quiet = true;
    } else if (arg === "--no-unpack") {
      args.unpack = false;
    } else if (arg === "--profile-dir") {
      args.profileDir = argv[i + 1];
      i += 1;
    } else if (arg === "--") {
      args.extra = argv.slice(i + 1);
      break;
    } else {
      args.extra.push(arg);
    }
  }
  return args;
}

function scanLog(logText) {
  const lines = logText.split(/\r?\n/);
  const pluginLines = [];
  const errorLines = [];
  const errorPatterns = [
    /\berror\b/i,
    /\bexception\b/i,
    /\bfailed\b/i,
    /is not defined/i,
    /not a function/i,
    /SyntaxError/i,
    /TypeError/i,
    /ReferenceError/i
  ];
  lines.forEach((line, idx) => {
    if (line.includes("Zotero AI Explain") || line.includes("zotero-ai-explain")) {
      pluginLines.push({ lineNumber: idx + 1, content: line });
    } else if (errorPatterns.some((re) => re.test(line))) {
      errorLines.push({ lineNumber: idx + 1, content: line });
    }
  });
  return { pluginLines, errorLines };
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (Number.isNaN(args.waitSeconds) || args.waitSeconds < 1) {
    process.stderr.write("usage: spawn.mjs [--wait <seconds>] [--keep] [--quiet]\n");
    process.exit(2);
  }

  const binaryPath = process.env.ZOTERO_BINARY ?? DEFAULT_BINARY;
  const xpiPath = resolve(process.env.ZOTERO_XPI ?? join(REPO_ROOT, "zotero-ai-explain.xpi"));

  if (!existsSync(binaryPath)) {
    process.stderr.write(`[harness] Zotero binary not found: ${binaryPath}\n`);
    process.exit(1);
  }
  if (!existsSync(xpiPath)) {
    process.stderr.write(`[harness] XPI not found: ${xpiPath}\n`);
    process.exit(1);
  }

  const profileDir = createProfile({
    marionettePort: DEFAULT_MARIONETTE_PORT,
    profileDir: args.profileDir
  });
  installPlugin(profileDir, xpiPath, { unpack: args.unpack });
  const logPath = join(profileDir, "zotero.log");
  const repoLogDir = join(REPO_ROOT, ".zotero-e2e");
  mkdirSync(repoLogDir, { recursive: true });
  const repoLogPath = join(repoLogDir, "last-run.log");
  const reportPath = join(repoLogDir, "last-report.json");

  if (!args.quiet) {
    process.stderr.write(`[harness] profile=${profileDir}\n`);
    process.stderr.write(`[harness] log=${logPath}\n`);
    process.stderr.write(`[harness] xpi=${xpiPath}\n`);
    process.stderr.write(`[harness] start=${nowIso()}\n`);
  }

  const handle = spawnZotero({
    binaryPath,
    profileDir,
    logPath,
    quiet: args.quiet
  });

  // Race: wait for startup line OR the configured time budget.
  const startupPromise = handle
    .waitForLogLine(STARTUP_LINE, { timeoutMs: args.waitSeconds * 1000 })
    .catch(() => false);
  const startupSeen = await startupPromise;

  await handle.shutdown({ graceMs: 3000 });
  const exitInfo = await handle.exitPromise;

  const logText = await readLogFile(logPath);
  const { pluginLines, errorLines } = scanLog(logText);

  const startupFound = pluginLines.some((entry) => entry.content.includes(STARTUP_LINE));
  const menuRegistered = pluginLines.some((entry) => entry.content.includes("registered menu"));
  const readerRegistered = pluginLines.some((entry) =>
    entry.content.includes("registered reader command")
  );
  const missingToolsPopup = pluginLines.some((entry) =>
    entry.content.includes("could not find the Tools menu popup")
  );

  try {
    copyFileSync(logPath, repoLogPath);
  } catch {
    /* ignore */
  }
  try {
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          startedAt: nowIso(),
          profileDir,
          logPath,
          repoLogPath,
          zoteroExit: exitInfo,
          counts: {
            pluginLines: pluginLines.length,
            errorLines: errorLines.length
          },
          flags: {
            startupSeenViaLogWait: Boolean(startupSeen),
            startupFound,
            menuRegistered,
            readerRegistered,
            missingToolsPopup
          },
          pluginLines,
          errorLines: errorLines.slice(0, 120)
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  } catch {
    /* ignore */
  }

  process.stdout.write("\n========== HARNESS REPORT ==========\n");
  process.stdout.write(`profile: ${profileDir}\n`);
  process.stdout.write(`log: ${logPath}\n`);
  process.stdout.write(
    `zotero exit: code=${exitInfo.code ?? "null"} signal=${exitInfo.signal ?? "null"}\n`
  );
  process.stdout.write(`plugin lines: ${pluginLines.length}\n`);
  pluginLines.forEach((entry) => {
    process.stdout.write(`  L${entry.lineNumber}: ${entry.content}\n`);
  });
  process.stdout.write(`error/exception lines: ${errorLines.length}\n`);
  errorLines.slice(0, 60).forEach((entry) => {
    process.stdout.write(`  L${entry.lineNumber}: ${entry.content}\n`);
  });
  if (errorLines.length > 60) {
    process.stdout.write(`  ... (${errorLines.length - 60} more error lines suppressed)\n`);
  }
  process.stdout.write("========== /HARNESS REPORT =========\n");
  process.stdout.write(`[harness] repo-local log copy: ${repoLogPath}\n`);
  process.stdout.write(`[harness] repo-local report: ${reportPath}\n`);

  if (!args.keepProfile) {
    cleanupProfile(profileDir);
  } else {
    process.stdout.write(`[harness] retained profile at ${profileDir}\n`);
  }

  process.exit(startupFound ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[harness] fatal: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
