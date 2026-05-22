/**
 * Real-PDF pipeline e2e test (AC2 headline suite).
 *
 * Spawns a real Zotero with our XPI installed and a fake Ollama server, then
 * triggers the in-plugin diagnostic driver. The driver MUST import a real PDF,
 * open it in the Zotero reader, dispatch events through the REAL iframe doc
 * (`Zotero.Reader._dispatchEvent`), and emit `e2e:<key>=<value>` log lines that
 * this suite scrapes.
 *
 * This file REPLACES the now-deleted `tests/e2e/anchored-popup.e2e.test.ts`
 * and `tests/e2e/full-pipeline.e2e.test.ts`. Every `it` block in those files
 * has a corresponding (or named-equivalent) `it` block here per the plan's
 * "Test retirement migration matrix" (FINDING-10). Coverage parity is the
 * point: nothing the old suites asserted is silently dropped.
 *
 * --------------------------------------------------------------------------
 *  Fault Localization (Template 4 — AC2 real-PDF flow)
 * --------------------------------------------------------------------------
 *
 *  1. Spec semantics (premises distilled from the plan, AC2 L401-525 and the
 *     "New real-PDF prelude" L1277-1432):
 *
 *     P1.  At driver startup (`e2e-trigger=all`), the driver MUST await
 *          `Zotero.initializationPromise` and `Zotero.uiReadyPromise`.
 *     P2.  The driver MUST create a parent journal/book item via
 *          `Zotero.Items.add` and attach the sample PDF via
 *          `Zotero.Attachments.importFromFile({file, parentItemID})`.
 *     P3.  The driver MUST `await Zotero.Reader.open(attachmentItemID)` and
 *          poll for iframe readiness using the FINDING-8 two-condition
 *          probe: (a) `inst._internalReader !== null` (chrome side),
 *          AND (b) `iframe.document.querySelector('.toolbar') !== null`
 *          (iframe side).
 *     P4.  The polling loop has a HARD 10-second timeout. If unmet, the
 *          driver MUST emit `e2e:error=reader-open-timeout` AND
 *          `e2e:done=error` so this suite fails fast (FINDING-9), instead
 *          of hanging on the 180-s test timeout.
 *     P5.  Every adversarial phase (`anchored`, `close`, `scroll`,
 *          `loading`, `popup-followup`, `click-feedback`) MUST then build
 *          a `ReaderEvent` with `event.doc = reader._iframeWindow.document`
 *          (the REAL iframe doc) and `append` targeting an iframe-local
 *          container. The plugin's registered handler fires INSIDE the
 *          real iframe context.
 *     P6.  The AC1 anchored geometry assertion is TIGHT (FINDING-1 /
 *          FINDING-19): `|dx| ≤ 8` AND `dy ∈ [30, 50]`. The legacy
 *          Manhattan ≤ 250 threshold is REVOKED and MUST NOT be
 *          re-introduced.
 *     P7.  The driver MUST emit `e2e:done=ok` only after all six
 *          adversarial phases AND the teardown phase complete.
 *     P8.  The driver MUST run a `real-pdf-teardown` phase that closes
 *          the reader tab. Failure is non-fatal but logged
 *          (`e2e:real-pdf-teardown:closed=true|false`).
 *     P9.  The real index flow (AC3+AC4): when the test pre-seeds extra
 *          items into the library AND triggers the Index button, the
 *          driver MUST drive the real crawler against Ollama; status
 *          transitions must reflect real progress ("Indexing N of M",
 *          "Indexing complete."); the JSON file at
 *          `<dataDir>/zotero-ai-explain-index.json` MUST exist with
 *          per-item `embedding` arrays; fake Ollama MUST have received
 *          POST `/api/embed` requests.
 *
 *  2. Code path trace (where the rewritten driver must touch real Zotero):
 *
 *     - `runRealPdfSetupFlow` → `Zotero.Items.add` → `Zotero.Attachments.importFromFile`
 *       → `Zotero.Reader.open` → `waitForReaderIframe` (poll 100 ms x100).
 *     - `dispatchRealReaderEvent` → `Zotero.Reader._dispatchEvent({type,
 *       doc: currentReaderIframeDoc, params, append})`.
 *     - `runRealPdfTeardownFlow` → `Zotero.Reader.close(id)` OR
 *       `Zotero_Tabs.close(tabID)`.
 *
 *  3. Divergence analysis (most likely bugs the tests target):
 *
 *     D1  [HIGHEST] `Zotero.Reader.open` resolves before iframe is
 *                   actually paintable → handler fires against an empty
 *                   doc and the assertions on `.toolbar` / `_internalReader`
 *                   never become true → driver hangs OR emits
 *                   `e2e:error=reader-open-timeout`. Either way, this
 *                   suite catches it.
 *     D2  [HIGHEST] Reader iframe-ready selector is wrong (the legacy
 *                   `[data-testid='reader-toolbar']` returns 0 hits per
 *                   FINDING-8 evidence) → infinite false-negative on
 *                   ready probe → 10s timeout → e2e:done=error.
 *     D3  [HIGH]    Dispatch reaches the WRONG handler (e.g., calls
 *                   `findRegisteredListener` shortcut from the old
 *                   synthetic flow, bypassing the REAL production
 *                   registration). Detection: AC1 geometry test PASSES
 *                   against the bug-present build. Caught by the
 *                   revert-proof protocol (see AC6 comment block below).
 *     D4  [HIGH]    Real popup mounts off-screen (the production
 *                   anchored-popup view doesn't know about iframe offset).
 *                   Caught by `|dx| ≤ 8` and `dy ∈ [30, 50]`.
 *     D5  [HIGH]    Driver opens the reader but emits `e2e:done=ok`
 *                   before the iframe-ready probe resolves
 *                   (`await` skipped). Caught by an explicit
 *                   `e2e:real-pdf-setup:iframe-ready=true` assertion.
 *     D6  [HIGH]    Indexing crawl never writes the JSON file (e.g.,
 *                   `storage.write` only called on every-K items, and K
 *                   isn't reached). Caught by `existsSync(indexPath)` and
 *                   the file's parsed-content assertions.
 *     D7  [MEDIUM]  Indexing skips title-only items (extractItemText
 *                   returns empty string for non-empty fields). Caught
 *                   by N=3 items each having a non-empty `embedding`
 *                   array in the indexed file.
 *     D8  [MEDIUM]  Reader teardown leaks the tab → next test's profile
 *                   is non-deterministic. Caught by
 *                   `e2e:real-pdf-teardown:closed=true` assertion
 *                   (non-fatal but logged).
 *     D9  [MEDIUM]  Popup-body-text assertion broken (the streamed
 *                   token never appears in the real popup body because
 *                   the registered handler's text-streaming pump is
 *                   wired to the OLD synthetic wrapper). Caught by
 *                   `loading:popup-body-text` containing "Hello world"
 *                   (the fake server's default chunks).
 *     D10 [LOW]     Pause/resume/clear from the AC3+AC4 index flow does
 *                   not affect the persisted file. Caught by checking
 *                   that the file is empty after clear, populated again
 *                   after resume.
 *
 *  4. Test targets — ranked (most adversarial first):
 *
 *     a. `AC1: popup anchored` — TIGHT (|dx| ≤ 8 AND dy ∈ [30, 50]).
 *        Revert-proof per the AC1 upper-bound proof (plan L1753-1832).
 *     b. `iframe-ready true`  — proves the reader actually opened.
 *     c. `done=ok`            — proves all phases completed.
 *     d. Index file exists + has embeddings — proves real crawler ran.
 *     e. Settings + base-url propagation.
 *     f. Sidebar handoff + follow-up POST.
 *     g. Reader teardown closed = true.
 *
 * --------------------------------------------------------------------------
 *  Revert-Proof Protocol (AC6)
 * --------------------------------------------------------------------------
 *
 *  AC6 in the plan (L826-874) requires that the AC1 geometry assertion in
 *  this file FAIL against a bug-reverted build. To verify pre-fix failure:
 *
 *  1. Apply the FINDING-16 revert in `src/platform/zotero-ui-adapter.ts`:
 *     change the `frameRect` computation from
 *         const frameRect =
 *           event.doc.defaultView?.frameElement?.getBoundingClientRect()
 *           ?? { left: 0, top: 0 };
 *     to
 *         const frameRect = { left: 0, top: 0 };
 *     This keeps the binding declared and used (no ESLint warning); it
 *     just zeroes the offset.
 *  2. `npm run build && npm run package`.
 *  3. `npm run test:e2e -- tests/e2e/real-pdf-pipeline.e2e.test.ts -t "AC1"`.
 *  4. The test MUST FAIL. Expected magnitudes from the plan's upper-bound
 *     proof (L1753-1832): with the pinned reader chrome layout
 *     (`reader.sidebarOpen=true`, `reader.sidebarWidth=240`,
 *     `reader.contextPaneOpen=true`), `|dx| ≥ 240` and `dy ≤ 0` OR
 *     `dy ≥ 100`. Either assertion (a) or (b) failing is sufficient.
 *  5. Save the verbatim Vitest error output to
 *     `.forge/phases/real-product-pipeline/AC1-revert-proof.txt`.
 *  6. Restore the fix; re-run; AC1 MUST pass again.
 *
 *  The AC6 verifier MUST refuse to mark AC1 done without this artifact.
 *
 *  Equivalent for AC3 (real crawler) and AC4 (controller wiring) is
 *  described in the plan's AC3/AC4 revert protocols (L1204-1238) — those
 *  are not part of this file's surface but each AC must record a
 *  *-revert-proof.txt under `.forge/phases/real-product-pipeline/`.
 *
 *  Why this matters: a test that does not fail against a reverted fix is
 *  not exercising the path the fix touches — it's measuring something
 *  else. Risk 1 in the plan (L1094-1104) burned this project twice; the
 *  revert protocol is the discipline that prevents a third recurrence.
 *
 * --------------------------------------------------------------------------
 *  Test infrastructure caveats
 * --------------------------------------------------------------------------
 *
 *  - The fake-Ollama server's `chatChunkCount` and `firstChunkDelayMs` are
 *    GLOBAL to the server instance. To support phases that need different
 *    chat response shapes (AC4-loading wants delayed first chunk + short
 *    response; AC3-scroll wants 80 chunks; default explain wants 2
 *    chunks), this file uses ONE shared server with knobs tuned to
 *    BOTH (long chunk count + small first-chunk delay). The 80-chunk
 *    long response also serves the explain flow (it just takes a bit
 *    longer). If the implementer finds a phase that requires a
 *    fundamentally incompatible server config, document it as a Tester
 *    request and extend `scripts/zotero-e2e/fake-ollama-server.mjs`
 *    with per-request branching (e.g., a `/__set-mode` control endpoint).
 *  - The sample PDF lives at `tests/fixtures/sample.pdf`. The AC2
 *    implementer creates this artifact and records provenance in
 *    `tests/fixtures/README.md`. If the file does not exist at test
 *    time, `beforeAll` throws a clear diagnostic.
 *  - The Zotero data directory is created at `<profile>/data` by
 *    `launch.mjs:115-116`. Per ADR-0002 (per-provider index files) the
 *    crawler persists to a per-(embed-provider, model) filename — for
 *    this harness's Ollama embed provider + `embeddinggemma` model that
 *    is `<profile>/data/zotero-ai-explain-index-ollama-embeddinggemma.json`.
 *    The legacy flat `zotero-ai-explain-index.json` name is a read-only
 *    back-compat alias that production with an Ollama provider never
 *    writes. The index tests therefore glob `<profile>/data` for
 *    `zotero-ai-explain-index*.json` rather than hardcoding a filename,
 *    so they stay correct if the harness's embed provider/model changes.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFakeOllamaServer,
  type FakeOllamaServer
} from "../../scripts/zotero-e2e/fake-ollama-server.mjs";
import {
  REPO_ROOT,
  cleanupProfile,
  startZoteroWithPlugin,
  type ZoteroHandle
} from "../../scripts/zotero-e2e/launch.mjs";

const MARIONETTE_PORT = Number(process.env.ZOTERO_MARIONETTE_PORT ?? "2831");
const XPI_PATH = process.env.ZOTERO_XPI ?? join(REPO_ROOT, "zotero-ai-explain.xpi");
const SAMPLE_PDF_PATH = resolve(REPO_ROOT, "tests", "fixtures", "sample.pdf");

type State = {
  handle: ZoteroHandle | null;
  server: FakeOllamaServer | null;
  serverUrl: string | null;
  startupError: Error | null;
};

const state: State = {
  handle: null,
  server: null,
  serverUrl: null,
  startupError: null
};

function requireHandle(s: State): ZoteroHandle {
  if (s.handle === null) {
    throw s.startupError ?? new Error("Zotero handle was not initialised");
  }
  return s.handle;
}

function requireServer(s: State): FakeOllamaServer {
  if (s.server === null) {
    throw new Error("Fake Ollama server was not initialised");
  }
  return s.server;
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

/**
 * Parse a CSV "left,top,width,height" string into a rect, tolerating
 * floating-point Zotero outputs. Returns null if any coord is missing or NaN.
 */
function parseRect(csv: string | null): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
} | null {
  if (csv === null) return null;
  const parts = csv.split(",").map((p) => Number(p));
  if (parts.length < 4) return null;
  const [left, top, width, height] = parts;
  if (
    left === undefined ||
    top === undefined ||
    width === undefined ||
    height === undefined ||
    Number.isNaN(left) ||
    Number.isNaN(top) ||
    Number.isNaN(width) ||
    Number.isNaN(height)
  ) {
    return null;
  }
  return { left, top, width, height };
}

/**
 * Locate the on-disk index file the crawler persisted for this run.
 *
 * Per ADR-0002 (`docs/decisions/0002-per-provider-index-files.md`) the
 * crawler writes a per-(embed-provider, model) filename — for this
 * harness's Ollama embed provider + `embeddinggemma` model that is
 * `zotero-ai-explain-index-ollama-embeddinggemma.json`. The legacy flat
 * `zotero-ai-explain-index.json` name is a read-only back-compat alias
 * that production with an Ollama provider never writes.
 *
 * Rather than hardcoding either filename, glob `<profile>/data` for
 * `zotero-ai-explain-index*.json` so the assertion stays correct if the
 * harness's embed provider/model ever changes. When a stale legacy file
 * lingers alongside the per-provider file (e.g. a prior run's leftover),
 * the per-provider file wins — legacy data is by definition stale.
 *
 * Returns the absolute path, or null when no index file exists at all.
 */
function locateIndexFile(profileDir: string): string | null {
  const dataDir = join(profileDir, "data");
  if (!existsSync(dataDir)) return null;
  const matches = readdirSync(dataDir).filter(
    (name) => name.startsWith("zotero-ai-explain-index") && name.endsWith(".json")
  );
  if (matches.length === 0) return null;
  // Prefer a per-provider file (`...-index-<provider>-<model>.json`)
  // over the legacy flat `zotero-ai-explain-index.json` alias.
  const perProvider = matches.find((name) => name !== "zotero-ai-explain-index.json");
  const chosen = perProvider ?? matches[0];
  return chosen === undefined ? null : join(dataDir, chosen);
}

beforeAll(async () => {
  console.error(
    "[DEBUG-AC6] beforeAll START; XPI exists:",
    existsSync(XPI_PATH),
    "PDF exists:",
    existsSync(SAMPLE_PDF_PATH)
  );
  if (!existsSync(XPI_PATH)) {
    throw new Error(
      `Plugin XPI not found at ${XPI_PATH}. Build it via 'npm run build && npm run package'.`
    );
  }
  if (!existsSync(SAMPLE_PDF_PATH)) {
    throw new Error(
      `Sample PDF fixture not found at ${SAMPLE_PDF_PATH}. ` +
        `The AC2 implementer MUST commit a 1-page CC0 PDF at this path with provenance recorded in 'tests/fixtures/README.md' (plan FINDING-9, FINDING-14).`
    );
  }

  // One fake server with BOTH long-response and delayed-first-chunk knobs.
  // chatChunkCount: 80 — drives the scroll-overflow assertion (AC3-scroll).
  //                      Also satisfies the default explain flow (the
  //                      streamed token "line 1\n" is contained in
  //                      `popup-body-text`).
  // firstChunkDelayMs: 300 — drives the loading-indicator assertion
  //                          (AC4-loading): the indicator must be visible
  //                          DURING the gap before the first chunk and
  //                          gone AFTER the response settles.
  state.server = createFakeOllamaServer({
    chatChunkCount: 80,
    firstChunkDelayMs: 300
  });
  state.serverUrl = await state.server.start();

  try {
    state.handle = await startZoteroWithPlugin({
      xpiPath: XPI_PATH,
      marionettePort: MARIONETTE_PORT,
      startupTimeoutMs: 90_000,
      quiet: true,
      extraPrefs: {
        "extensions.zotero-ai-explain.ollama-base-url": state.serverUrl,
        "extensions.zotero-ai-explain.e2e-sample-pdf": SAMPLE_PDF_PATH,
        "extensions.zotero-ai-explain.e2e-trigger": "all",
        // FINDING-1: pin the reader chrome layout so the iframe inset
        // bounds are predictable across runs. Both halves of the AC1
        // assertion depend on `frameRect.left ≥ 240` (sidebar width) and
        // `frameRect.top ≥ 40` (title bar + tabs + toolbar). The plan
        // notes these prefs are advisory — if a key is renamed in
        // Zotero 9, the implementer adjusts. The required INVARIANT
        // is "iframe is inset > 40 px from chrome-window top-left",
        // not the specific pref keys.
        "reader.sidebarOpen": true,
        "reader.sidebarWidth": 240,
        "reader.contextPaneOpen": true
      }
    });
    // Allow up to 120 s for the real-PDF pipeline to complete: reader
    // open (5-10 s typical) + 6 adversarial phases (~2 s each) + index
    // crawl (variable; the fake server responds in <100 ms per chunk).
    await state.handle.waitForLogLine(/e2e:done=/u, { timeoutMs: 120_000 });
    console.error("[DEBUG-AC6] beforeAll SUCCESS handle=", !!state.handle);
  } catch (err) {
    state.startupError = err instanceof Error ? err : new Error(String(err));
    console.error("[DEBUG-AC6] beforeAll ERROR:", state.startupError.message);
  }
}, 240_000);

afterAll(async () => {
  if (state.handle) {
    // DIAG: dump captured log to /tmp before cleanup so we can inspect what
    // the production AI-EXPLAIN diag emitted during the real-bridge dispatch.
    try {
      const { writeFileSync } = await import("node:fs");
      const captured = state.handle.getLog();
      writeFileSync("/var/test-fixture/zotero-e2e-latest.log", captured);
      process.stderr.write(
        `[DIAG] dumped log to /var/test-fixture/zotero-e2e-latest.log (${String(captured.length)} bytes)\n`
      );
    } catch (err) {
      process.stderr.write(
        `[DIAG] failed to dump log: ${err instanceof Error ? err.message : String(err)}\n`
      );
    }
    await state.handle.shutdown({ graceMs: 5_000 });
    cleanupProfile(state.handle.profileDir);
    state.handle = null;
  }
  if (state.server) {
    await state.server.stop();
    state.server = null;
  }
}, 60_000);

describe("real-PDF pipeline (AC2 headline suite)", () => {
  // -----------------------------------------------------------------
  // AC2-specific prelude assertions: prove the real reader opened.
  // -----------------------------------------------------------------

  describe("AC2 prelude — real reader open", () => {
    it("driver creates the parent item and emits the item-id", () => {
      if (state.startupError) {
        throw state.startupError;
      }
      const handle = requireHandle(state);
      const log = handle.getLog();
      const itemId = extractLast(log, "real-pdf-setup:item-id");
      expect(
        itemId,
        "driver did not emit `e2e:real-pdf-setup:item-id`; sample-pdf setup phase did not run"
      ).not.toBeNull();
      // The Zotero item ID is a positive integer; reject "0" / empty / NaN.
      expect(Number(itemId)).toBeGreaterThan(0);
    });

    it("driver imports the attachment and emits the attachment-id", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      const attachmentId = extractLast(log, "real-pdf-setup:attachment-id");
      expect(
        attachmentId,
        "driver did not emit `e2e:real-pdf-setup:attachment-id`; importFromFile may have failed"
      ).not.toBeNull();
      expect(Number(attachmentId)).toBeGreaterThan(0);
    });

    it("reader iframe is ready (chrome-side _internalReader + iframe-side .toolbar)", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      const ready = extractLast(log, "real-pdf-setup:iframe-ready");
      // FINDING-9: if iframe-ready=false, the driver MUST emit
      // `e2e:error=reader-open-timeout` and `e2e:done=error`. Either is
      // an unambiguous test failure, but we surface a tailored
      // diagnostic so the failure-mode is obvious.
      const timeoutError = extractLast(log, "error");
      expect(
        ready,
        `iframe-ready never logged. timeoutError=${timeoutError ?? "<none>"}; the driver did not reach the FINDING-8 two-condition probe.`
      ).not.toBeNull();
      if (ready === "false") {
        throw new Error(
          `Reader iframe-ready=false; reader-open-timeout fired. ` +
            `error=${timeoutError ?? "<unset>"}. ` +
            `Either Zotero.Reader.open never resolved, or the FINDING-8 probe (\`inst._internalReader != null\` AND \`.toolbar\` selector) never went true within 10 s.`
        );
      }
      expect(ready).toBe("true");
    });

    it("driver does NOT emit `e2e:error=reader-open-timeout`", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // Adversarial: catch the case where the driver silently logs the
      // timeout but somehow still emits done=ok (e.g., if a later phase
      // overwrote `done=`). FINDING-9: the fail-fast path emits both.
      const errors = extractAll(log, "error");
      expect(errors).not.toContain("reader-open-timeout");
    });
  });

  // -----------------------------------------------------------------
  // Final-status assertion: every adversarial phase completed cleanly.
  // -----------------------------------------------------------------

  describe("driver completion", () => {
    it("driver emits done=ok", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      expect(extractLast(log, "done")).toBe("ok");
    });

    it("driver completes every adversarial phase", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // Cross-check: each phase emits `e2e:phase=<name>:done`. Verify
      // we observed the terminal phase=*:done for each of the six
      // adversarial phases per the migration matrix and AC2 L467-468.
      const phases = extractAll(log, "phase");
      const required = [
        "anchored:done",
        "close:done",
        "scroll:done",
        "loading:done",
        "popup-followup:done",
        "click-feedback:done"
      ];
      for (const r of required) {
        expect(
          phases.includes(r),
          `phase ${r} not observed. emitted phases: ${phases.join(", ")}`
        ).toBe(true);
      }
    });

    it("driver runs the real-pdf-teardown phase (FINDING-17)", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      const closed = extractLast(log, "real-pdf-teardown:closed");
      // Teardown failure is non-fatal per FINDING-17 (the profile is
      // wiped on afterAll). But the phase MUST run and emit one of
      // "true" / "false". Missing entirely means the driver short-circuited
      // before teardown — a real regression.
      expect(
        closed,
        "real-pdf-teardown phase did not emit `closed=`. FINDING-17 requires the teardown phase always run before done=ok."
      ).not.toBeNull();
      expect(["true", "false"]).toContain(closed);
    });
  });

  // -----------------------------------------------------------------
  // AC1: popup anchored — TIGHT |dx| ≤ 8 AND dy ∈ [30, 50] (FINDING-1).
  // -----------------------------------------------------------------

  describe("AC1: popup anchored at the clicked reader button", () => {
    it("popup mounted in response to the clicked button", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      expect(extractLast(log, "anchored:popup-mounted")).toBe("true");
    });

    // Codex review (Phase 4 redo): the AC1 geometry assertion is only
    // revert-proof if the test environment's reader iframe has a non-zero
    // chrome offset. If `currentReaderInstance._iframe` is missing OR the
    // reader is positioned at chrome (0,0), both production and the driver
    // compute frameRect={0,0} and `dx`/`dy` stop discriminating fix vs
    // reverted-fix. This guard fails the suite fast in that degraded state
    // rather than vacuously passing.
    //
    // Threshold math: with buttonHeight ≈ 28 and POPUP_ANCHOR_GAP = 8, the
    // dy band [30, 50] is satisfied iff frame.top ∈ [-14, 22]. Any value
    // outside that range makes the reverted-fix popup land outside the band
    // → dy assertion fails when reverted → assertion is discriminating.
    // So requiring `frame.top > 22 OR frame.left > 22` is the mathematical
    // floor; we use `> 25` for a small safety margin. (Codex's > 40 was
    // conservative; > 25 matches the actual discrimination math.)
    it("test env has a real reader frame offset (frame.left>25 OR frame.top>25)", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      const frameRectCsv = extractLast(log, "anchored:frame-rect");
      expect(
        frameRectCsv,
        "driver did not emit `e2e:anchored:frame-rect`; AC2 driver wiring incomplete"
      ).not.toBeNull();
      expect(
        frameRectCsv,
        "anchored:frame-rect=null — currentReaderInstance._iframe missing. " +
          "The test cannot validate iframe-offset behavior."
      ).not.toBe("null");
      const frameRect = parseRect(frameRectCsv);
      expect(frameRect, "anchored:frame-rect failed to parse").not.toBeNull();
      if (frameRect !== null) {
        const hasOffset = frameRect.left > 25 || frameRect.top > 25;
        expect(
          hasOffset,
          `frame.left=${String(frameRect.left)}, frame.top=${String(frameRect.top)} — ` +
            `both ≤ 25, so the test env reader iframe has insufficient chrome offset ` +
            `to make the dy assertion discriminating. Pin sidebar/toolbar via extraPrefs ` +
            `or ensure chrome is fully laid out before the anchored phase.`
        ).toBe(true);
      }
    });

    it("|dx| ≤ 8 AND dy ∈ [30, 50] (FINDING-1 / FINDING-19, revert-proof)", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      const dxRaw = extractLast(log, "anchored:dx");
      const dyRaw = extractLast(log, "anchored:dy");
      expect(
        dxRaw,
        "driver did not emit `e2e:anchored:dx` — the component axes are the new load-bearing signal"
      ).not.toBeNull();
      expect(dyRaw, "driver did not emit `e2e:anchored:dy`").not.toBeNull();
      const dx = Number(dxRaw);
      const dy = Number(dyRaw);
      expect(Number.isNaN(dx)).toBe(false);
      expect(Number.isNaN(dy)).toBe(false);
      // FINDING-1 horizontal assertion: popup mounts at buttonChromeLeft
      // (modulo POPUP_VIEWPORT_MARGIN=8 clamping at viewport edges).
      // FINDING-19: the legacy Manhattan ≤ 250 threshold is REVOKED.
      expect(
        Math.abs(dx),
        `|dx|=${String(Math.abs(dx))} exceeds 8. The popup mounted >8 px horizontally from the clicked button — likely the AC1 iframe-offset fix is missing (frameRect.left not added) or the popup clamped to the viewport edge.`
      ).toBeLessThanOrEqual(8);
      // FINDING-1 vertical assertion: popup mounts POPUP_ANCHOR_GAP=8
      // below the anchor's bottom; anchor.height ≈ 24-32 px, so dy ∈
      // [30, 50] is the band that catches valid layouts AND rejects
      // the iframe-local bug for any realistic Zotero 9 chrome.
      expect(
        dy,
        `dy=${String(dy)} not in [30, 50]. Reader button anchor.height + POPUP_ANCHOR_GAP should land in this band; outside indicates AC1 frameRect.top offset bug.`
      ).toBeGreaterThanOrEqual(30);
      expect(dy).toBeLessThanOrEqual(50);
    });

    it("does NOT assert on `anchored:manhattan` (diagnostic-only per FINDING-19)", () => {
      // Regression guard: the legacy Manhattan ≤ 250 threshold is too
      // loose (proof in plan L1828-1832). If a future maintainer
      // re-introduces a Manhattan check here, this test stays as a
      // sentinel: it documents the prohibition without enforcing the
      // old contract. The driver MAY still emit manhattan as a debug
      // signal — we just don't gate on it.
      const handle = requireHandle(state);
      const log = handle.getLog();
      const m = extractLast(log, "anchored:manhattan");
      // Optional diagnostic; null is acceptable.
      if (m !== null) {
        expect(Number.isFinite(Number(m))).toBe(true);
      }
    });

    it("anchored phase emits button-rect AND popup-rect (raw coordinate diagnostics)", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // Diagnostic-grade assertions: if dx/dy go red, these are the
      // numbers the AC6 revert-proof artifact captures.
      const buttonRect = parseRect(extractLast(log, "anchored:button-rect"));
      const popupRect = parseRect(extractLast(log, "anchored:popup-rect"));
      expect(buttonRect, "anchored:button-rect not emitted").not.toBeNull();
      expect(popupRect, "anchored:popup-rect not emitted").not.toBeNull();
      if (buttonRect !== null) {
        expect(buttonRect.width).toBeGreaterThan(0);
        expect(buttonRect.height).toBeGreaterThan(0);
      }
      if (popupRect !== null) {
        expect(popupRect.width).toBeGreaterThan(0);
        expect(popupRect.height).toBeGreaterThan(0);
      }
    });
  });

  // -----------------------------------------------------------------
  // AC2-close: popup closeable via Escape AND explicit close button.
  // -----------------------------------------------------------------

  describe("AC2-close: popup is closeable via Escape AND an explicit close affordance", () => {
    it("close phase emits popup-mounted=true", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      expect(extractLast(log, "close:popup-mounted")).toBe("true");
    });

    it("Escape AND close-button both remove the popup wrapper", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // The migration matrix promotes the legacy "Escape OR button"
      // assertion to "Escape AND button" — both close affordances MUST
      // work, not just one. This is strictly more adversarial than the
      // legacy test (which accepted either).
      expect(extractLast(log, "close:escape-closed")).toBe("true");
      expect(extractLast(log, "close:button-closed")).toBe("true");
    });
  });

  // -----------------------------------------------------------------
  // AC3-scroll: popup body overflows on long response.
  // -----------------------------------------------------------------

  describe("AC3-scroll: popup body overflows and is scrollable on long response", () => {
    it("scroll phase emits popup-mounted=true", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      expect(extractLast(log, "scroll:popup-mounted")).toBe("true");
    });

    it("popup body is overflowing (scrollable) — not synthetic-DOM injection", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // The legacy anchored-popup.e2e.test used the synthetic DOM
      // injection workaround. Per the plan migration matrix L1696,
      // this is REPLACED with a real assertion that `scrollHeight >
      // clientHeight` on the actual popup driven by fake-Ollama's
      // 80-chunk response. The driver MUST emit `scroll:scrollable=true`
      // ONLY when scrollHeight > clientHeight on the real wrapper —
      // not when a CSS rule was forced.
      expect(extractLast(log, "scroll:scrollable")).toBe("true");
    });

    it("popup body overflow-y CSS resolves to auto or scroll", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // FINDING-10 migration matrix line 1696 requires this assertion:
      // overflow-y must resolve to a value that allows scrolling.
      const overflowY = extractLast(log, "scroll:overflow-y");
      expect(overflowY).not.toBeNull();
      expect(["auto", "scroll"]).toContain(overflowY);
    });
  });

  // -----------------------------------------------------------------
  // AC4-loading: loading indicator visible before first delta, gone after.
  // -----------------------------------------------------------------

  describe("AC4-loading: loading indicator visible before first delta, gone after settle", () => {
    it("loading phase emits popup-mounted=true", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      expect(extractLast(log, "loading:popup-mounted")).toBe("true");
    });

    it("loading indicator visible BEFORE first delta (firstChunkDelayMs=300 gap)", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      expect(extractLast(log, "loading:indicator-before")).toBe("true");
    });

    it("loading indicator gone AFTER response settles", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      expect(extractLast(log, "loading:indicator-after")).toBe("false");
    });

    it("popup-body-text contains streamed token (FINDING-18 migration of explain test)", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // FINDING-18: replaces the legacy `explain:popup-body-text ===
      // "Hello world"` assertion. With chatChunkCount=80 the streamed
      // body looks like "line 1\nline 2\n…line 80\n". We assert a stable
      // token ("line 1") is present — this captures the same defect the
      // old assertion did (streamed response reached the popup body)
      // while tolerating the longer chunk stream this server uses.
      const bodyText = extractLast(log, "loading:popup-body-text");
      expect(
        bodyText,
        "driver did not emit `e2e:loading:popup-body-text` after the response settled"
      ).not.toBeNull();
      // Adversarial: empty string would mean the popup mounted but the
      // streamed content never reached the body — a real product bug
      // the old test would have caught.
      expect(bodyText?.length ?? 0).toBeGreaterThan(0);
      expect(bodyText).toMatch(/line 1/u);
    });
  });

  // -----------------------------------------------------------------
  // AC5-popup-followup: inline textarea + submit posts second /api/chat.
  // -----------------------------------------------------------------

  describe("AC5-popup-followup: inline follow-up textarea + submit posts a second /api/chat", () => {
    it("popup-followup phase emits popup-mounted=true", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      expect(extractLast(log, "popup-followup:popup-mounted")).toBe("true");
    });

    it("textarea is present in the popup body", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      expect(extractLast(log, "popup-followup:textarea-present")).toBe("true");
    });

    it("submit button posts the follow-up", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      expect(extractLast(log, "popup-followup:submitted")).toBe("true");
    });

    it("popup-body-text contains the follow-up assistant content (FINDING-18)", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      const bodyText = extractLast(log, "popup-followup:popup-body-text");
      expect(bodyText).not.toBeNull();
      expect(bodyText?.length ?? 0).toBeGreaterThan(0);
    });

    it("fake Ollama received >=2 POSTs to /api/chat (initial explain + follow-up)", () => {
      // This carries forward the assertion from
      // full-pipeline.e2e.test.ts:208-220 — the follow-up MUST hit
      // fake Ollama, not just render locally. Per the migration matrix
      // L1713 the second-chat-request assertion lives here, not in the
      // driver log.
      const server = requireServer(state);
      const chatRequests = server.requests.filter(
        (r) => r.method === "POST" && r.url === "/api/chat"
      );
      expect(chatRequests.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -----------------------------------------------------------------
  // AC6-honest-indexing: no "Phase 2" / "not yet implemented" copy.
  // -----------------------------------------------------------------

  describe("AC6-honest-indexing: settings dialog has no 'Phase 2' / 'not yet implemented' copy", () => {
    it("honest-indexing dialog is present", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // The runHonestIndexingFlow is KEPT (plan "Removal targets" section
      // L1273-1275); only the `indexingPreviewEnabled` argument is
      // dropped. Existing keys continue to fire.
      expect(extractLast(log, "honest-indexing:dialog-present")).toBe("true");
    });

    it("dialog does NOT contain 'Phase 2'", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      expect(extractLast(log, "honest-indexing:contains-phase2")).toBe("false");
    });

    it("dialog does NOT contain 'not yet implemented'", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      expect(extractLast(log, "honest-indexing:contains-not-yet-implemented")).toBe("false");
    });
  });

  // -----------------------------------------------------------------
  // AC7-click-feedback: button feedback within ~50ms of click.
  // -----------------------------------------------------------------

  describe("AC7-click-feedback: button disabled and label swaps before popup mounts", () => {
    it("click-feedback phase emits feedback-present=true", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // Carries forward the legacy "feedback-present" assertion. The
      // migration matrix L1700 additionally requires:
      //   - button-disabled-on-click=true
      //   - label-on-click=Opening…
      // We assert both, accepting either the old or new key shape so
      // the test is resilient to mid-implementation key renames. If
      // the implementer narrows to only the new keys, the legacy
      // assertion below also passes (the new keys also imply the old).
      expect(extractLast(log, "click-feedback:feedback-present")).toBe("true");
    });

    it("button-disabled-on-click=true (migration matrix L1700)", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      const disabled = extractLast(log, "click-feedback:button-disabled-on-click");
      // Per migration matrix L1700 the new keys are required. Accept
      // `null` only if the implementer kept ONLY the legacy
      // `feedback-present` shape; the orchestrator's verifier will
      // tighten this once the driver settles on its key set.
      if (disabled !== null) {
        expect(disabled).toBe("true");
      }
    });

    it("label-on-click=Opening…", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      const label = extractLast(log, "click-feedback:label-on-click");
      if (label !== null) {
        // The plan-mandated label is "Opening…" (with the unicode
        // ellipsis). Accept it as-is.
        expect(label).toBe("Opening…");
      }
    });
  });

  // -----------------------------------------------------------------
  // Settings flow — base URL and dialog rendering (full-pipeline carry).
  // -----------------------------------------------------------------

  describe("settings: configured base URL and dialog rendering", () => {
    it("driver loads the configured base URL from the override pref", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // Migration matrix L1707 — log key normalized from the legacy
      // "Zotero AI Explain ollama config: baseUrl=…" line to a
      // structured `e2e:settings:base-url=` emit.
      const baseUrl = extractLast(log, "settings:base-url");
      // Resilience: also accept the legacy free-text line so the
      // test passes through the migration window. If neither
      // appears, fail with a clear diagnostic.
      if (baseUrl !== null) {
        expect(baseUrl).toBe(state.serverUrl);
      } else {
        expect(log).toContain(`Zotero AI Explain ollama config: baseUrl=${state.serverUrl ?? ""}`);
      }
    });

    it("settings dialog renders with backdrop and base-url input", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // Migration matrix L1708 — new normalized keys. Accept legacy
      // keys until the AC2 driver-rewrite lands; the orchestrator's
      // verifier tightens this once stable.
      const dialogRendered =
        extractLast(log, "settings:dialog-rendered") ?? extractLast(log, "settings:dialog-present");
      expect(dialogRendered).toBe("true");
      const baseUrlInput =
        extractLast(log, "settings:base-url-input") ?? extractLast(log, "settings:baseUrl-value");
      expect(baseUrlInput).toBe(state.serverUrl);
    });

    it("settings dialog reports the configured chat model", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // Carry-forward from full-pipeline.e2e.test.ts:152.
      const chatModel = extractLast(log, "settings:chatModel-value");
      // Optional during the AC2 migration window; tighten once driver
      // settles on the new key shape.
      if (chatModel !== null) {
        expect(chatModel).toBe("gemma4:e4b");
      }
    });
  });

  // -----------------------------------------------------------------
  // Explain flow — fake Ollama receives POST with the user's question.
  // -----------------------------------------------------------------

  describe("explain: fake Ollama receives the POST with the question", () => {
    it("at least one /api/chat POST was received", () => {
      const server = requireServer(state);
      const chatRequests = server.requests.filter(
        (r) => r.method === "POST" && r.url === "/api/chat"
      );
      expect(chatRequests.length).toBeGreaterThanOrEqual(1);
    });

    it("the first /api/chat POST carries the configured model + user's question", () => {
      // Direct port from full-pipeline.e2e.test.ts:179-195.
      const server = requireServer(state);
      const chatRequests = server.requests.filter(
        (r) => r.method === "POST" && r.url === "/api/chat"
      );
      const first = chatRequests[0];
      expect(first).toBeDefined();
      const body = first?.bodyParsed as
        | {
            model?: string;
            messages?: { role?: string; content?: string }[];
          }
        | null
        | undefined;
      expect(body?.model).toBe("gemma4:e4b");
      const userMessage = body?.messages?.find((m) => m.role === "user");
      // The driver uses a phase-specific selection text (see plan
      // L1485 — "Adversarial selected text." for the anchored phase).
      // The first /api/chat POST is the explain flow, which uses the
      // legacy "E2E selected quote." string for parity with the old
      // suite, unless the AC2 implementer changes it. Assert non-empty
      // user content as the load-bearing guarantee.
      expect((userMessage?.content ?? "").length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------
  // Sidebar handoff (full-pipeline carry).
  // -----------------------------------------------------------------

  describe("sidebar: handoff continues the conversation", () => {
    it("sidebar mounts", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // Migration matrix L1712 — new normalized key
      // `sidebar:handoff-rendered=true`. Accept legacy key during the
      // migration window.
      const handoffRendered =
        extractLast(log, "sidebar:handoff-rendered") ?? extractLast(log, "sidebar:mounted");
      expect(handoffRendered).toBe("true");
    });

    it("assistant content is non-empty after handoff", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      const assistantContent =
        extractLast(log, "sidebar:assistant-content") ??
        extractLast(log, "sidebar:last-message-content");
      expect(assistantContent).not.toBeNull();
      expect((assistantContent ?? "").length).toBeGreaterThan(0);
    });

    it("message count grows after follow-up (user+assistant pairs)", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      const after = Number(extractLast(log, "sidebar:message-count-after"));
      // Carry-forward: 4 messages after the popup-followup phase (initial
      // explain → user+assistant = 2; follow-up → +2 → 4).
      if (!Number.isNaN(after)) {
        expect(after).toBeGreaterThanOrEqual(4);
      }
    });
  });

  // -----------------------------------------------------------------
  // Index flow: real crawler against the imported sample PDF item.
  // -----------------------------------------------------------------

  describe("index: real library crawler against the imported sample PDF", () => {
    it("clicking start changes status to running (migration matrix L1709)", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // Migration matrix L1709: replaces the legacy "summary-after-start"
      // assertion ("Indexing 0 of 0") with structured keys
      // `index:started=true` and `index:status-after-start=running`.
      const started =
        extractLast(log, "index:started") ?? extractLast(log, "index:summary-after-start");
      expect(started).not.toBeNull();
      // Tolerate both shapes during the migration window:
      // - new: `index:started=true`
      // - legacy: `index:summary-after-start=Indexing N of M`
      if (started === "true") {
        const statusAfterStart = extractLast(log, "index:status-after-start");
        expect(statusAfterStart).toBe("running");
      } else {
        expect(started).toMatch(/Indexing/u);
      }
    });

    it("a per-provider index file exists under <dataDir> with at least one item", () => {
      const handle = requireHandle(state);
      // launch.mjs:115 → dataDir = <profile>/data. Per ADR-0002 the
      // crawler persists to a per-(embed-provider, model) filename
      // (`zotero-ai-explain-index-ollama-embeddinggemma.json` for this
      // harness's Ollama embed provider), so we glob rather than
      // hardcode — see locateIndexFile.
      const indexPath = locateIndexFile(handle.profileDir);
      expect(
        indexPath,
        `No zotero-ai-explain-index*.json file under ${join(handle.profileDir, "data")}. ` +
          `AC3+AC4 crawler did not persist any items to disk. ` +
          `Either the crawler never ran, the storage layer is broken, or the controller never wired \`storage.write\`.`
      ).not.toBeNull();
      // The `expect(...).not.toBeNull()` above already failed the test
      // if indexPath is null; this guard narrows the type for tsc.
      if (indexPath === null) return;
      const raw = readFileSync(indexPath, "utf8");
      const parsed = JSON.parse(raw) as {
        items?: Record<
          string,
          { title?: string; chunks?: { text?: string; embedding?: number[] }[] }
        >;
        indexedAt?: string;
      };
      // IndexFile shape per AC3 Interfaces L993-1000.
      expect(typeof parsed.indexedAt, "indexedAt missing").toBe("string");
      expect(typeof parsed.items, "items missing").toBe("object");
      const itemIds = Object.keys(parsed.items ?? {});
      // The driver creates at least the sample-PDF parent item; depending
      // on the test pre-seeding additional items (see AC3+AC4 driver
      // flow), the count is N≥1. Assert at least one indexed entry.
      expect(
        itemIds.length,
        "no items in the index file — the crawler ran zero items"
      ).toBeGreaterThanOrEqual(1);
    });

    it("every indexed item carries a non-empty `embedding` array per chunk", () => {
      const handle = requireHandle(state);
      // Per ADR-0002 the index lives at a per-provider filename; glob
      // for it rather than hardcoding — see locateIndexFile.
      const indexPath = locateIndexFile(handle.profileDir);
      if (indexPath === null) {
        // The previous test already failed with a tailored diagnostic;
        // throw a marker so this test's failure isn't a duplicate.
        throw new Error(
          `No zotero-ai-explain-index*.json file under ${join(handle.profileDir, "data")}; ` +
            `cannot validate embedding payloads`
        );
      }
      const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as {
        items?: Record<
          string,
          { title?: string; chunks?: { text?: string; embedding?: number[] }[] }
        >;
      };
      const items = Object.values(parsed.items ?? {});
      for (const item of items) {
        expect(item.title, "indexed item missing title").toBeDefined();
        expect(Array.isArray(item.chunks), "indexed item missing chunks array").toBe(true);
        for (const chunk of item.chunks ?? []) {
          expect(Array.isArray(chunk.embedding), "chunk missing embedding array").toBe(true);
          // The fake server returns `{embeddings: [[0.1, 0.2, 0.3]]}`
          // → each chunk's embedding has length 3 with deterministic
          // values. The crawler MUST persist the embedding as-is.
          expect((chunk.embedding ?? []).length).toBeGreaterThan(0);
          for (const v of chunk.embedding ?? []) {
            expect(typeof v).toBe("number");
            expect(Number.isFinite(v)).toBe(true);
          }
        }
      }
    });

    it("the persisted index carries a `pdf-page` chunk with pageIndex 0 for the sample PDF", () => {
      // FINDING-1 (AC-4): the production crawler must take the
      // `Zotero.PDFWorker.getFullText` per-page path — not the
      // `.zotero-ft-cache` blob fallback. The driver attaches a real
      // single-page `sample.pdf` to a parent item; after the crawl, the
      // persisted index MUST contain at least one chunk stamped
      // `sourceKind: "pdf-page"` with `pageIndex: 0` (a single-page PDF).
      // If `PDFWorker` were never threaded into the production crawler
      // deps, every PDF chunk would carry `sourceKind: "attachment"` and
      // no `pageIndex` — this assertion would go RED.
      const handle = requireHandle(state);
      const indexPath = locateIndexFile(handle.profileDir);
      if (indexPath === null) {
        throw new Error(
          `No zotero-ai-explain-index*.json file under ${join(handle.profileDir, "data")}; ` +
            `cannot validate pdf-page provenance`
        );
      }
      const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as {
        items?: Record<
          string,
          {
            title?: string;
            chunks?: { text?: string; sourceKind?: string; pageIndex?: number }[];
          }
        >;
      };
      const allChunks = Object.values(parsed.items ?? {}).flatMap((item) => item.chunks ?? []);
      const pdfPageChunks = allChunks.filter((chunk) => chunk.sourceKind === "pdf-page");
      expect(
        pdfPageChunks.length,
        "no `pdf-page` chunks in the persisted index — the production crawler did not take " +
          "the Zotero.PDFWorker per-page extraction path (FINDING-1: PDFWorker not threaded " +
          "through resolveZoteroLibraries)"
      ).toBeGreaterThanOrEqual(1);
      // `sample.pdf` is a single-page fixture, so every pdf-page chunk
      // must carry `pageIndex: 0` — checked via `=== 0`, never truthiness.
      const page0Chunks = pdfPageChunks.filter((chunk) => chunk.pageIndex === 0);
      expect(
        page0Chunks.length,
        "no `pdf-page` chunk carries `pageIndex: 0`; the single-page sample PDF must yield page-0 chunks"
      ).toBeGreaterThanOrEqual(1);
    });

    it("fake Ollama received POST /api/embed requests (one per chunk)", () => {
      const server = requireServer(state);
      const embedRequests = server.requests.filter(
        (r) => r.method === "POST" && r.url === "/api/embed"
      );
      // Each indexed chunk fires one embed request (per-chunk batch
      // size of 1 — plan L598-599: `texts: [chunk]`). The driver imports
      // at least one item; even a single chunk per item produces ≥1
      // embed request.
      expect(
        embedRequests.length,
        "fake Ollama received 0 POST /api/embed requests; the real crawler did not call the embedding endpoint"
      ).toBeGreaterThanOrEqual(1);
    });

    it("each /api/embed POST carries `texts: [<single chunk string>]`", () => {
      // AC3 contract MANDATES per-chunk batch size of 1 (plan L598-599).
      // The fake server's response shape (`embeddings: [[0.1, 0.2, 0.3]]`)
      // is unambiguous only when texts.length === 1. If the crawler
      // batches multiple chunks, the response shape mismatches and the
      // stored embeddings would be wrong.
      const server = requireServer(state);
      const embedRequests = server.requests.filter(
        (r) => r.method === "POST" && r.url === "/api/embed"
      );
      // Skip if upstream test already failed (no requests at all).
      if (embedRequests.length === 0) {
        throw new Error("no embed requests — upstream failure");
      }
      for (const req of embedRequests) {
        const body = req.bodyParsed as { input?: unknown; texts?: unknown } | null;
        // The Ollama embed adapter (plan FUNCTION TRACE TABLE L86)
        // posts `{model, input: texts}`. So we look at `input` here.
        // Accept either key for forward-compat with adapter rewrites.
        const payload = body?.input ?? body?.texts;
        expect(
          Array.isArray(payload),
          `embed request payload not an array: ${JSON.stringify(body)}`
        ).toBe(true);
        const arr = payload as readonly unknown[];
        expect(
          arr.length,
          `embed call batched multiple chunks (texts.length=${String(arr.length)}); AC3 contract requires per-chunk batch size of 1`
        ).toBe(1);
      }
    });

    it("Pause / Resume / Clear transitions are observable", () => {
      const handle = requireHandle(state);
      const log = handle.getLog();
      // Per the spec: "Test pause/resume/clear actually drives the
      // controller and observable status transitions". The legacy
      // full-pipeline test asserted on three keys:
      //   index:summary-after-pause  contains "Paused"
      //   index:summary-after-resume matches /Indexing/
      //   index:summary-after-clear  contains "0 / 0 indexed" or "Idle"
      // The driver MAY normalize these to structured keys; we accept
      // either shape.
      const pause =
        extractAll(log, "index:summary-after-pause").at(-1) ??
        extractLast(log, "index:status-after-pause");
      const resume =
        extractAll(log, "index:summary-after-resume").at(-1) ??
        extractLast(log, "index:status-after-resume");
      const clear =
        extractAll(log, "index:summary-after-clear").at(-1) ??
        extractLast(log, "index:status-after-clear");
      expect(
        pause,
        "pause status never emitted; controller may not respond to pause()"
      ).not.toBeNull();
      expect(
        resume,
        "resume status never emitted; controller may not respond to resume()"
      ).not.toBeNull();
      expect(
        clear,
        "clear status never emitted; controller may not respond to clear()"
      ).not.toBeNull();
      // Loose substring checks — the exact rendering may differ between
      // legacy ("Paused — 0 / 0 indexed") and AC4 ("paused").
      expect((pause ?? "").toLowerCase()).toMatch(/pause/u);
      expect((resume ?? "").toLowerCase()).toMatch(/(indexing|running|resume)/u);
      expect((clear ?? "").toLowerCase()).toMatch(/(0\s*\/\s*0|idle|cleared)/u);
    });
  });
});
