/* @vitest-environment jsdom */

/*
 * Adversarial regression tests for AC5 of the real-product-pipeline plan
 * (`docs/superpowers/plans/2026-05-17-real-product-pipeline.md`, lines
 * 793-824).
 *
 * Fault localization (semi-formal):
 *
 * 1. Spec semantics (premises from the plan):
 *    P1. `src/ui/index-controls-view.ts` MUST NOT contain the literal
 *        "Coming soon". The `IndexControlsOptions` type and the
 *        `previewEnabled` parameter MUST be deleted. The
 *        `renderIndexControls(status)` function MUST render the summary
 *        and the four buttons (start/pause/resume/clear) unconditionally.
 *    P2. `src/ui/settings-view.ts` MUST NOT pass `previewEnabled` to
 *        `renderIndexControls`. The `indexingPreviewEnabled` input field
 *        MUST be deleted.
 *    P3. `src/preferences/ollama-profile.ts` MUST NOT export
 *        `readIndexingPreviewPref`.
 *    P4. `src/bootstrap.ts` MUST NOT import `readIndexingPreviewPref` or
 *        pass `options: { indexingPreviewEnabled }`.
 *    P5. A repo-wide grep for `indexing-preview` against `src/` and the
 *        `addon/` assets (excluding the regenerated bundle) MUST return
 *        zero matches.
 *    P6. `describeIndexingStatus` MUST NOT return "Phase 2" or
 *        "not yet implemented" copy in any reducer state.
 *
 * 2. Code path trace (the failure modes the user has been burned by):
 *    T1. The current `renderIndexControls(status, options?)` defaults
 *        `options.previewEnabled` to `false` and short-circuits to a
 *        "Coming soon -- planned for v0.2" placeholder, hiding the four
 *        action buttons. Settings view forwards `indexingPreviewEnabled`
 *        into that option. The preview pref defaults to off, so users
 *        ship a "broken-feeling" UI in every release.
 *    T2. The `readIndexingPreviewPref` reader at
 *        `src/preferences/ollama-profile.ts` plus its bootstrap import
 *        is the supply chain for the placeholder gating. Deleting the
 *        function but leaving the import would break `npm run build`;
 *        deleting the import but leaving the function would silently
 *        permit re-introduction.
 *    T3. The `describeIndexingStatus` reducer produces the status text
 *        the controls show. A near-miss revert could resurrect "Phase 2"
 *        copy inside the running-state phrase or inside a comment that
 *        a future refactor templates into a string.
 *
 * 3. Divergence analysis -- where the impl could fail the spec:
 *    D1. Implementer drops the placeholder branch in
 *        `index-controls-view.ts` but leaves the `previewEnabled` option
 *        signature in place (so callers can still gate the buttons by
 *        passing `previewEnabled: false`). Tests below call
 *        `renderIndexControls(status)` with no options and assert that
 *        ALL four buttons render.
 *    D2. Implementer removes the literal "Coming soon" but leaves a
 *        near-miss string like "planned for v0.2" or
 *        "indexing-coming-soon" or simply renames to
 *        `indexing-preview-v2`. Tests below grep `src/` + `addon/` for
 *        every variant.
 *    D3. Implementer deletes `readIndexingPreviewPref` from the named
 *        exports but leaves the function definition (so a dynamic
 *        import or re-export could pull it back). Test below verifies
 *        the runtime module shape via dynamic import -- the function
 *        MUST be `undefined`.
 *    D4. Implementer relocates the gating logic into a helper module
 *        (e.g. `feature-flags.ts`) and re-imports it from bootstrap.
 *        The grep smoke-check below catches re-introductions of the
 *        pref string under ANY filename in `src/` and `addon/`.
 *    D5. Implementer drops "Phase 2" from the running-state phrase but
 *        a comment containing "Phase 2" is later interpolated into a
 *        log line. The per-state loop below covers all five reducer
 *        states.
 *    D6. Implementer adjusts `renderSettingsView` to require an
 *        `indexingPreviewEnabled` arg (defeating the AC5 contract). The
 *        test below calls `renderSettingsView` with only the two
 *        documented fields and asserts no placeholder copy renders.
 *
 * 4. Test targets (ranked by failure likelihood):
 *    R1. `describeIndexingStatus` re-introduces "Phase 2" copy in a
 *        single state -- guarded by the all-states loop in test #1.
 *    R2. The settings view re-introduces "Coming soon" placeholder copy
 *        -- guarded by test #2.
 *    R3. Index controls revert to gated buttons -- guarded by test #3.
 *    R4. A future revert re-exports `readIndexingPreviewPref` -- guarded
 *        by the dynamic-import test #4.
 *    R5. A future revert re-introduces the `indexing-preview` pref
 *        string under any name -- guarded by the codebase grep test #5.
 *    R6. A near-miss rename (`indexing-preview-v2`, `indexing-coming-soon`,
 *        `indexing-comingsoon`) -- guarded by the extended grep set in
 *        test #5.
 */

import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { describeIndexingStatus } from "../../src/indexing/indexing-controller.js";
import type { IndexingState, IndexingStatus } from "../../src/indexing/indexing-status.js";
import { createDefaultOllamaSettings } from "../../src/preferences/ollama-profile.js";
import { renderIndexControls } from "../../src/ui/index-controls-view.js";
import { renderSettingsView } from "../../src/ui/settings-view.js";

const ALL_STATES: readonly IndexingState[] = ["idle", "running", "paused", "complete", "failed"];

const SAMPLE_STATUS: IndexingStatus = {
  state: "running",
  totalItems: 12,
  indexedItems: 5,
  failedItems: 1
};

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function statusFor(state: IndexingState): IndexingStatus {
  return { state, totalItems: 8, indexedItems: 3, failedItems: 1 };
}

describe("AC5 -- describeIndexingStatus never emits placeholder copy", () => {
  it("returns no 'Phase 2' / 'not yet implemented' / 'Coming soon' copy in any reducer state", () => {
    for (const state of ALL_STATES) {
      const text = describeIndexingStatus(statusFor(state));
      // Forgiving regex: "Phase 2", "phase 2", "Phase2", "phase  2" all
      // fail. Same shape for the other forbidden phrases.
      expect(text, `state=${state}`).not.toMatch(/phase\s*2/iu);
      expect(text, `state=${state}`).not.toMatch(/not\s*yet\s*implemented/iu);
      expect(text, `state=${state}`).not.toMatch(/coming\s*soon/iu);
      expect(text, `state=${state}`).not.toMatch(/planned\s*for/iu);
    }
  });
});

describe("AC5 -- settings view never renders placeholder copy", () => {
  it("renders no 'Coming soon' / 'planned for' / 'v0.2' copy with the default settings-view inputs", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: SAMPLE_STATUS
    });
    const text = view.textContent;

    expect(text).not.toMatch(/coming\s*soon/iu);
    expect(text).not.toMatch(/planned\s*for/iu);
    // v0.2 / v 0.2 / v.0.2 -- adversarial near-misses.
    expect(text).not.toMatch(/v\s*\.?\s*0\.\s*2/iu);
    expect(text).not.toMatch(/phase\s*2/iu);
    expect(text).not.toMatch(/not\s*yet\s*implemented/iu);
  });

  it("renders the four indexing action buttons via the settings view (no preview flag passed)", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 }
    });

    expect(view.querySelector('[data-action="start-index"]')).not.toBeNull();
    expect(view.querySelector('[data-action="pause-index"]')).not.toBeNull();
    expect(view.querySelector('[data-action="resume-index"]')).not.toBeNull();
    expect(view.querySelector('[data-action="clear-index"]')).not.toBeNull();
  });
});

describe("AC5 -- renderIndexControls renders buttons unconditionally", () => {
  it("renders all four action buttons in every reducer state with no options arg", () => {
    for (const state of ALL_STATES) {
      const view = renderIndexControls(statusFor(state));
      const message = `state=${state}`;
      expect(view.querySelector('[data-action="start-index"]'), message).not.toBeNull();
      expect(view.querySelector('[data-action="pause-index"]'), message).not.toBeNull();
      expect(view.querySelector('[data-action="resume-index"]'), message).not.toBeNull();
      expect(view.querySelector('[data-action="clear-index"]'), message).not.toBeNull();

      const text = view.textContent;
      expect(text, message).not.toMatch(/coming\s*soon/iu);
      expect(text, message).not.toMatch(/planned\s*for/iu);
      expect(text, message).not.toMatch(/phase\s*2/iu);
      expect(text, message).not.toMatch(/not\s*yet\s*implemented/iu);
    }
  });
});

describe("AC5 -- readIndexingPreviewPref is not part of the module surface", () => {
  it("dynamic import of src/preferences/ollama-profile.js has no readIndexingPreviewPref export", async () => {
    const moduleSpec = "../../src/preferences/ollama-profile.js";
    // Dynamic import so removing the static export does not turn this
    // into a typecheck failure -- we want a runtime assertion that
    // catches a future revert that re-introduces the export.
    const mod = (await import(moduleSpec)) as Record<string, unknown>;

    expect(mod.readIndexingPreviewPref).toBeUndefined();
    expect(Object.keys(mod)).not.toContain("readIndexingPreviewPref");
  });
});

describe("AC5 -- codebase smoke checks for re-introduction of the flag", () => {
  /**
   * Run ripgrep (or grep -rIn as a fallback) for a literal needle under
   * the given paths, returning the matching lines. Files known to be
   * regenerated by `npm run build` and this test file itself are
   * excluded so neither a stale bundle nor the assertion text pollutes
   * the result.
   */
  function grepLiteral(needle: string, paths: readonly string[]): string[] {
    const quotedNeedle = JSON.stringify(needle);
    const quotedPaths = paths.map((p) => JSON.stringify(p)).join(" ");
    const rgGlobs =
      "--glob '!addon/content/zotero-ai-explain.js' --glob '!**/no-coming-soon-copy.test.ts'";
    let raw = "";
    try {
      raw = execSync(
        `rg --no-config --no-heading --line-number --color=never --fixed-strings ${quotedNeedle} ${quotedPaths} ${rgGlobs}`,
        { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 1) {
        // rg exits 1 on zero matches -- treat as success.
        return [];
      }
      // rg not installed / different failure -- fall back to grep -rIn.
      try {
        raw = execSync(
          `grep -rIn --exclude='zotero-ai-explain.js' --exclude='no-coming-soon-copy.test.ts' --fixed-strings -- ${quotedNeedle} ${quotedPaths}`,
          { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
        );
      } catch (fallbackError) {
        const fallbackStatus = (fallbackError as { status?: number }).status;
        if (fallbackStatus === 1) {
          return [];
        }
        throw fallbackError;
      }
    }
    return raw.split("\n").filter((line) => line.length > 0);
  }

  it("src/ and addon/ contain no reference to 'extensions.zotero-ai-explain.indexing-preview'", () => {
    const matches = grepLiteral("extensions.zotero-ai-explain.indexing-preview", ["src", "addon"]);
    expect(matches, `unexpected pref references: ${matches.join(" | ")}`).toEqual([]);
  });

  it("src/ and addon/ contain no reference to the bare 'indexing-preview' substring", () => {
    // Catches near-miss renames like `indexing-preview-v2`,
    // `extensions.zotero-ai-explain.indexing-preview-enabled`, etc.
    const matches = grepLiteral("indexing-preview", ["src", "addon"]);
    expect(matches, `unexpected indexing-preview references: ${matches.join(" | ")}`).toEqual([]);
  });

  it("src/ contains no 'previewEnabled' symbol (flag check could be relocated)", () => {
    const matches = grepLiteral("previewEnabled", ["src"]);
    expect(matches, `unexpected previewEnabled references: ${matches.join(" | ")}`).toEqual([]);
  });

  it("src/ contains no 'indexingPreviewEnabled' symbol (flag check could be relocated)", () => {
    const matches = grepLiteral("indexingPreviewEnabled", ["src"]);
    expect(matches, `unexpected indexingPreviewEnabled references: ${matches.join(" | ")}`).toEqual(
      []
    );
  });

  it("src/ contains no 'readIndexingPreviewPref' symbol (the function MUST be deleted)", () => {
    const matches = grepLiteral("readIndexingPreviewPref", ["src"]);
    expect(
      matches,
      `unexpected readIndexingPreviewPref references: ${matches.join(" | ")}`
    ).toEqual([]);
  });

  it("src/ and addon/ contain no 'Coming soon' literal in any common casing", () => {
    for (const variant of ["Coming soon", "coming soon", "COMING SOON", "Coming Soon"]) {
      const matches = grepLiteral(variant, ["src", "addon"]);
      expect(matches, `unexpected '${variant}' references: ${matches.join(" | ")}`).toEqual([]);
    }
  });

  it("src/ and addon/ contain no near-miss flag renames", () => {
    const nearMisses = [
      "indexing-coming-soon",
      "indexing-comingsoon",
      "indexing-preview-v2",
      "indexing-preview-enabled",
      "indexingComingSoon",
      "indexingPreviewV2"
    ];
    for (const needle of nearMisses) {
      const matches = grepLiteral(needle, ["src", "addon"]);
      expect(matches, `unexpected '${needle}' references: ${matches.join(" | ")}`).toEqual([]);
    }
  });
});
