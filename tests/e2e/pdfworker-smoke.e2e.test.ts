/**
 * AC-0 — PDF.js entry-point smoke test (planner gate before AC-4).
 *
 * Spawns a real Zotero with the plugin XPI installed and triggers the
 * in-plugin diagnostic driver with `e2e-trigger=pdfworker-smoke`. That
 * trigger runs the real-PDF setup prelude (imports `tests/fixtures/sample.pdf`
 * and resolves its attachment id), then runs `runPdfWorkerSmokeFlow`, which
 * calls `Zotero.PDFWorker.getFullText(attachmentID)` and emits `e2e:pdfworker:*`
 * log lines this suite scrapes.
 *
 * Why this gate exists: AC-4 (`per-page PDF text extraction`) is built
 * entirely on `Zotero.PDFWorker.getFullText` returning `{text, extractedPages,
 * totalPages}` with page boundaries delimited by `\f`. If that API is absent,
 * differently shaped, or does not delimit pages with `\f`, AC-4's design is
 * invalid. This test fails RED in that case so the AC-4 implementer never
 * starts against a wrong premise.
 *
 * --------------------------------------------------------------------------
 *  Fault Localization (Template 4 — AC-0 PDF.js entry point)
 * --------------------------------------------------------------------------
 *
 *  1. Spec semantics (AC-0, plan L383-394 + interface L582-588):
 *     P1. `Zotero.PDFWorker.getFullText(attachmentID)` resolves to
 *         `{text, extractedPages, totalPages}`.
 *     P2. `totalPages >= 1` for a valid PDF.
 *     P3. `text.split('\f').length === totalPages` — an N-page PDF has
 *         exactly N-1 form-feeds (single page → 0 → split length 1).
 *     P4. The first page's first 20 chars are non-empty and ASCII-printable.
 *     P5. Adversarial: a corrupt/non-PDF fixture makes `getFullText` REJECT;
 *         the rejection is surfaced (`e2e:pdfworker:corrupt:rejected=true`),
 *         not silently swallowed.
 *     P6. Adversarial: a multi-page fixture exercises the `\f` split with
 *         `totalPages > 1` (`split('\f').length === totalPages`).
 *
 *  2. Code path trace:
 *     - driver `runRealPdfSetupFlow` → `Zotero.Attachments.importFromFile`
 *       (single-page sample.pdf) → `currentReaderAttachmentItemID`.
 *     - driver `runPdfWorkerSmokeFlow` → `Zotero.PDFWorker.getFullText`
 *       (single-page), then imports + extracts the multi-page fixture, then
 *       imports + extracts the corrupt fixture.
 *
 *  3. Divergence analysis (most likely failure modes):
 *     D1 [HIGHEST] `Zotero.PDFWorker` / `getFullText` is missing on the
 *                  chrome `Zotero` global → driver emits
 *                  `e2e:pdfworker:error=no-pdfworker-getfulltext-api`.
 *                  AC-4's premise is invalid → NEEDS_CONTEXT.
 *     D2 [HIGH]    `getFullText` does not delimit pages with `\f` →
 *                  `formFeedCount !== totalPages - 1` → P3 / P6 fail.
 *     D3 [HIGH]    `getFullText` rejects on a freshly-imported attachment
 *                  (the planner counter-hypothesis: worker startup delay) →
 *                  `e2e:pdfworker:error=<message>` on the PRIMARY fixture.
 *     D4 [MEDIUM]  A corrupt PDF does NOT reject (the worker returns empty
 *                  text instead) → `corrupt:rejected=false` → P5 fails.
 *     D5 [LOW]     First-page text is empty (extraction heuristic miss) →
 *                  P4 fails.
 *
 *  4. Test targets — ranked: D1 (api reachable) > D3 (primary rejects) >
 *     D2 (form-feed split) > D4 (corrupt rejects) > D5 (first-page text).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  REPO_ROOT,
  cleanupProfile,
  startZoteroWithPlugin,
  type ZoteroHandle
} from "../../scripts/zotero-e2e/launch.mjs";

const MARIONETTE_PORT = Number(process.env.ZOTERO_MARIONETTE_PORT ?? "2833");
const XPI_PATH = process.env.ZOTERO_XPI ?? join(REPO_ROOT, "zotero-ai-explain.xpi");
const SAMPLE_PDF_PATH = resolve(REPO_ROOT, "tests", "fixtures", "sample.pdf");
const MULTIPAGE_PDF_PATH = resolve(REPO_ROOT, "tests", "fixtures", "sample-multipage.pdf");
const CORRUPT_PDF_PATH = resolve(REPO_ROOT, "tests", "fixtures", "corrupt.pdf");

type State = {
  handle: ZoteroHandle | null;
  startupError: Error | null;
};

const state: State = { handle: null, startupError: null };

function requireHandle(s: State): ZoteroHandle {
  if (s.handle === null) {
    throw s.startupError ?? new Error("Zotero handle was not initialised");
  }
  return s.handle;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractLast(log: string, key: string): string | null {
  const matches = Array.from(log.matchAll(new RegExp(`e2e:${escapeRegex(key)}=(.*)`, "g")));
  if (matches.length === 0) {
    return null;
  }
  const last = matches[matches.length - 1];
  return last ? (last[1]?.trimEnd() ?? null) : null;
}

function extractAll(log: string, key: string): string[] {
  return Array.from(log.matchAll(new RegExp(`e2e:${escapeRegex(key)}=(.*)`, "g"))).map((m) =>
    (m[1] ?? "").trimEnd()
  );
}

beforeAll(async () => {
  if (!existsSync(XPI_PATH)) {
    throw new Error(
      `Plugin XPI not found at ${XPI_PATH}. Build it via 'npm run build && npm run package'.`
    );
  }
  for (const [label, path] of [
    ["sample.pdf", SAMPLE_PDF_PATH],
    ["sample-multipage.pdf", MULTIPAGE_PDF_PATH],
    ["corrupt.pdf", CORRUPT_PDF_PATH]
  ] as const) {
    if (!existsSync(path)) {
      throw new Error(
        `Fixture ${label} not found at ${path}. AC-0 requires it; see tests/fixtures/README.md.`
      );
    }
  }

  try {
    state.handle = await startZoteroWithPlugin({
      xpiPath: XPI_PATH,
      marionettePort: MARIONETTE_PORT,
      startupTimeoutMs: 90_000,
      quiet: true,
      extraPrefs: {
        "extensions.zotero-ai-explain.e2e-sample-pdf": SAMPLE_PDF_PATH,
        "extensions.zotero-ai-explain.e2e-multipage-pdf": MULTIPAGE_PDF_PATH,
        "extensions.zotero-ai-explain.e2e-corrupt-pdf": CORRUPT_PDF_PATH,
        "extensions.zotero-ai-explain.e2e-trigger": "pdfworker-smoke"
      }
    });
    // The smoke flow opens the reader (prelude, ~5-10 s) then runs three
    // getFullText calls (<1 s each). 60 s is generous headroom.
    await state.handle.waitForLogLine(/e2e:done=/u, { timeoutMs: 60_000 });
  } catch (err) {
    state.startupError = err instanceof Error ? err : new Error(String(err));
  }
}, 240_000);

afterAll(async () => {
  if (state.handle) {
    await state.handle.shutdown({ graceMs: 5_000 });
    cleanupProfile(state.handle.profileDir);
    state.handle = null;
  }
}, 60_000);

describe("AC-0: Zotero.PDFWorker.getFullText smoke test", () => {
  it("driver runs the pdfworker-smoke phase and completes", () => {
    if (state.startupError) {
      throw state.startupError;
    }
    const handle = requireHandle(state);
    const log = handle.getLog();
    const phases = extractAll(log, "phase");
    expect(
      phases.includes("pdfworker-smoke:start"),
      "driver never entered the pdfworker-smoke phase"
    ).toBe(true);
    expect(
      phases.includes("pdfworker-smoke:done"),
      "pdfworker-smoke phase did not reach :done"
    ).toBe(true);
    expect(extractLast(log, "done")).toBe("ok");
  });

  it("Zotero.PDFWorker.getFullText is reachable (no api-missing error)", () => {
    // D1: if the chrome `Zotero` global has no `PDFWorker.getFullText`, the
    // driver emits this exact error. AC-4's entire design assumes the API
    // exists — surface that as a hard failure of the planner gate.
    const handle = requireHandle(state);
    const errors = extractAll(handle.getLog(), "pdfworker:error");
    expect(
      errors,
      "driver emitted `e2e:pdfworker:error=no-pdfworker-getfulltext-api` — " +
        "Zotero.PDFWorker.getFullText is not reachable; AC-4's premise is invalid."
    ).not.toContain("no-pdfworker-getfulltext-api");
  });

  it("getFullText resolved on the single-page sample.pdf (no rejection surfaced)", () => {
    // D3: the planner counter-hypothesis is that the worker rejects on a
    // freshly-imported attachment. If `e2e:pdfworker:error` fired, the
    // primary getFullText call rejected and the smoke test must fail loud.
    const handle = requireHandle(state);
    const log = handle.getLog();
    const error = extractLast(log, "pdfworker:error");
    expect(
      error,
      `getFullText rejected on the primary single-page fixture: ${error ?? "<none>"}. ` +
        "Either the attachment was not registered as a PDF or the worker failed to parse it."
    ).toBeNull();
    // The flow emits totalPages only when getFullText resolved.
    expect(extractLast(log, "pdfworker:totalPages")).not.toBeNull();
  });

  it("(a) totalPages >= 1", () => {
    const handle = requireHandle(state);
    const totalPages = Number(extractLast(handle.getLog(), "pdfworker:totalPages"));
    expect(Number.isNaN(totalPages)).toBe(false);
    expect(totalPages).toBeGreaterThanOrEqual(1);
  });

  it("(b) text.split('\\f').length === totalPages (single-page → 1)", () => {
    // sample.pdf is single-page → 0 form-feeds → split length 1 = totalPages.
    const handle = requireHandle(state);
    const log = handle.getLog();
    const totalPages = Number(extractLast(log, "pdfworker:totalPages"));
    const splitLength = Number(extractLast(log, "pdfworker:splitLength"));
    const formFeedCount = Number(extractLast(log, "pdfworker:formFeedCount"));
    expect(Number.isNaN(splitLength)).toBe(false);
    expect(splitLength).toBe(totalPages);
    // An N-page PDF has exactly N-1 form-feeds (omni.ja worker.js: `\f` is
    // pushed between pages, never after the last).
    expect(formFeedCount).toBe(totalPages - 1);
  });

  it("(c) first page's first 20 chars are non-empty and ASCII-printable", () => {
    const handle = requireHandle(state);
    const prefix = extractLast(handle.getLog(), "pdfworker:firstPagePrefix");
    expect(prefix, "driver did not emit `e2e:pdfworker:firstPagePrefix`").not.toBeNull();
    const text = prefix ?? "";
    expect(text.length, "first page prefix is empty — no text extracted").toBeGreaterThan(0);
    // ASCII printable range 0x20-0x7E. The driver replaces \n/\r/\f with a
    // space before logging, so a space is acceptable; control chars are not.
    expect(
      /^[\x20-\x7e]+$/u.test(text),
      `first page prefix "${text}" contains non-ASCII-printable characters`
    ).toBe(true);
  });

  it("extractedPages equals totalPages for the fully-extracted single-page PDF", () => {
    const handle = requireHandle(state);
    const log = handle.getLog();
    const totalPages = Number(extractLast(log, "pdfworker:totalPages"));
    const extractedPages = Number(extractLast(log, "pdfworker:extractedPages"));
    expect(Number.isNaN(extractedPages)).toBe(false);
    expect(extractedPages).toBe(totalPages);
  });

  // -----------------------------------------------------------------
  // Adversarial: multi-page PDF exercises the `\f` page-boundary split.
  // -----------------------------------------------------------------

  describe("adversarial — multi-page PDF (sample-multipage.pdf, 3 pages)", () => {
    it("getFullText resolved on the multi-page fixture", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      const error = extractLast(log, "pdfworker:multipage:error");
      expect(
        error,
        `getFullText rejected on the multi-page fixture: ${error ?? "<none>"}`
      ).toBeNull();
      expect(extractLast(log, "pdfworker:multipage:totalPages")).not.toBeNull();
    });

    it("multi-page totalPages > 1", () => {
      const handle = requireHandle(state);
      const totalPages = Number(extractLast(handle.getLog(), "pdfworker:multipage:totalPages"));
      expect(Number.isNaN(totalPages)).toBe(false);
      expect(totalPages).toBeGreaterThan(1);
    });

    it("multi-page text.split('\\f').length === totalPages (N-1 form-feeds)", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      const totalPages = Number(extractLast(log, "pdfworker:multipage:totalPages"));
      const splitLength = Number(extractLast(log, "pdfworker:multipage:splitLength"));
      const formFeedCount = Number(extractLast(log, "pdfworker:multipage:formFeedCount"));
      expect(splitLength).toBe(totalPages);
      expect(formFeedCount).toBe(totalPages - 1);
    });

    it("multi-page first and last page prefixes are non-empty (distinct page text)", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      const first = extractLast(log, "pdfworker:multipage:firstPagePrefix");
      const last = extractLast(log, "pdfworker:multipage:lastPagePrefix");
      expect((first ?? "").length).toBeGreaterThan(0);
      expect((last ?? "").length).toBeGreaterThan(0);
      // The fixture renders a distinct ASCII string per page, so the first
      // and last page text must differ — proving the split is per-page.
      expect(first).not.toBe(last);
    });
  });

  // -----------------------------------------------------------------
  // Adversarial: corrupt PDF — getFullText must REJECT (not swallow).
  // -----------------------------------------------------------------

  describe("adversarial — corrupt PDF (corrupt.pdf)", () => {
    it("getFullText rejects on the corrupt fixture and the rejection is surfaced", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      const rejected = extractLast(log, "pdfworker:corrupt:rejected");
      expect(
        rejected,
        "driver did not emit `e2e:pdfworker:corrupt:rejected`; the corrupt-PDF " +
          "adversarial case did not run"
      ).not.toBeNull();
      expect(
        rejected,
        "corrupt PDF did not make getFullText reject — the failure was swallowed " +
          "instead of surfaced (AC-0 adversarial case)"
      ).toBe("true");
    });

    it("the corrupt-PDF rejection carries a non-empty error message", () => {
      const handle = requireHandle(state);
      const message = extractLast(handle.getLog(), "pdfworker:corrupt:error");
      expect(message).not.toBeNull();
      expect((message ?? "").length).toBeGreaterThan(0);
    });
  });
});
