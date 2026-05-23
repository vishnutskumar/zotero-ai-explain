#!/usr/bin/env node
/**
 * Cleanup any stray harness-spawned Zotero or marionette node processes.
 * Useful when a test run was interrupted and you need to free port 2828.
 */

import { execSync, execFileSync } from "node:child_process";

const PATTERNS = [
  "zotero-e2e-harness",
  "marionette-smoke",
  "marionette-raw",
  "spawn.mjs",
  "zotero-e2e-"
];

function listPids() {
  const pids = new Set();
  for (const pattern of PATTERNS) {
    try {
      const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
      out
        .split("\n")
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n !== process.pid)
        .forEach((pid) => pids.add(pid));
    } catch {
      /* pgrep exits 1 when no matches */
    }
  }
  return [...pids];
}

const pids = listPids();
if (pids.length === 0) {
  process.stdout.write("[cleanup] no stray processes\n");
  process.exit(0);
}
process.stdout.write(`[cleanup] sending SIGTERM to: ${pids.join(", ")}\n`);
for (const pid of pids) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    process.stderr.write(`[cleanup] could not signal ${pid}: ${err?.message ?? err}\n`);
  }
}

setTimeout(() => {
  const remaining = listPids();
  for (const pid of remaining) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  if (remaining.length > 0) {
    process.stdout.write(`[cleanup] sent SIGKILL to: ${remaining.join(", ")}\n`);
  }
  try {
    execSync("true");
  } catch {
    /* ignore */
  }
  process.exit(0);
}, 2500);
