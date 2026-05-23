#!/usr/bin/env node
/**
 * Coverage gate enforced before push (hooked into the `test` pre-push
 * entry of `.pre-commit-config.yaml`). Reads
 * `coverage/coverage-summary.json` produced by `npm run test:coverage`
 * and fails the run if any aggregate metric drops below the configured
 * threshold.
 *
 * Why a separate gate instead of vitest's built-in `thresholds`:
 *
 *   - Clearer failure output: a single block listing every metric and
 *     its current value, rather than vitest's bare assertion.
 *   - Easier to refine into per-directory thresholds later — the JSON
 *     summary already breaks down by file, so we just extend the
 *     checks here.
 *   - Decoupled from test failures: vitest's `thresholds` make a test
 *     run fail *and* the coverage gate fail with the same exit code,
 *     making CI logs harder to triage.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const REPO_ROOT = process.cwd();
const SUMMARY_PATH = join(REPO_ROOT, "coverage", "coverage-summary.json");

/**
 * Minimum acceptable coverage percentage for each metric. Tracked at
 * the aggregate level only — per-file gates are easy to add later by
 * iterating the summary's per-file keys and applying a stricter or
 * looser bar per directory.
 *
 * 80% is the project-wide bar set by the AC. The branch threshold is
 * a few points lower than lines/statements because branch coverage is
 * sensitive to defensive guards (`?? null` returns, `try/catch` arms)
 * that are easy to write but hard to exercise from a test without
 * contortions.
 */
const THRESHOLDS = {
  lines: 80,
  statements: 80,
  functions: 80,
  branches: 75
};

if (!existsSync(SUMMARY_PATH)) {
  console.error(
    `[coverage-gate] missing ${SUMMARY_PATH}. Run \`npm run test:coverage\` first ` +
      `or use \`npm run test:coverage:check\` to chain them.`
  );
  process.exit(1);
}

let summary;
try {
  summary = JSON.parse(readFileSync(SUMMARY_PATH, "utf8"));
} catch (err) {
  console.error(
    `[coverage-gate] failed to parse ${SUMMARY_PATH}: ${err instanceof Error ? err.message : String(err)}.\n` +
      `  Regenerate via \`npm run test:coverage\`.`
  );
  process.exit(1);
}

// Codex review #6: validate the summary shape before indexing into it.
// A malformed or empty `coverage-summary.json` (e.g. produced by a
// canceled run, a vitest version mismatch, or a manually-edited file)
// would otherwise throw a TypeError on `summary.total[metric]` and
// produce a confusing stack trace instead of the structured gate
// failure the operator expects. `typeof null === "object"` in JS, so
// the null guard is explicit (codex review follow-up: a `{"total":null}`
// summary slipped past the first version of this check).
if (
  summary === null ||
  typeof summary !== "object" ||
  summary.total === null ||
  typeof summary.total !== "object"
) {
  console.error(
    `[coverage-gate] ${SUMMARY_PATH} is missing the 'total' coverage block.\n` +
      `  Regenerate via \`npm run test:coverage\`.`
  );
  process.exit(1);
}

const failures = [];
for (const [metric, threshold] of Object.entries(THRESHOLDS)) {
  const bucket = summary.total[metric];
  const actual = bucket !== null && typeof bucket === "object" ? bucket.pct : undefined;
  // Codex review follow-up: reject NaN / Infinity / out-of-range values
  // before threshold comparison. `Infinity < 80` is false, so a hand-
  // crafted `{"pct": 1e999}` would otherwise slip past the gate and the
  // formatter would print "Infinity%". Same for negatives and >100.
  if (typeof actual !== "number" || !Number.isFinite(actual) || actual < 0 || actual > 100) {
    failures.push(
      typeof actual === "number"
        ? `  - ${metric}: malformed value ${String(actual)} (expected 0..100)`
        : `  - ${metric}: missing from summary`
    );
    continue;
  }
  if (actual < threshold) {
    failures.push(`  - ${metric}: ${actual.toFixed(2)}% < ${String(threshold)}%`);
  }
}

if (failures.length > 0) {
  console.error("[coverage-gate] coverage below threshold:");
  console.error(failures.join("\n"));
  console.error(
    "\n  Open coverage/index.html to see which files dragged the totals down.\n" +
      "  Run `npm run test:coverage` to refresh the summary after adding tests."
  );
  process.exit(1);
}

const fmt = (m) => `${m}=${summary.total[m].pct.toFixed(2)}%`;
console.log(
  `[coverage-gate] OK (${fmt("lines")} ${fmt("statements")} ${fmt("functions")} ${fmt("branches")})`
);
