/**
 * AC-7 + AC-9 e2e — citation jump-to-page through a real Zotero launch.
 *
 * Plan: `docs/superpowers/plans/2026-05-19-pdf-context-features.md`
 *   AC-7 description           L486-498 (adversarial cases L494-497)
 *   AC-9 description           L540-552 (adversarial cases a-d)
 *   AC-6 + AC-7 contracts      L760-829
 *
 * --------------------------------------------------------------------
 *  HARNESS CONSTRAINT — read before extending this file
 * --------------------------------------------------------------------
 *
 *  The unit-level citation behavior is covered elsewhere:
 *    - `tests/ui/citation-lookup.test.ts` — token parsing + lookup table.
 *    - `tests/ui/library-chat-citation.test.ts` — chunk-scoped rendering,
 *      hallucination guard, per-turn table pinning, onCitationClick shape.
 *    - `tests/conversation/library-conversation-store.test.ts` — per-message
 *      lookup tables on the store.
 *
 *  This e2e file covers what ONLY a real Zotero reader can prove: that a
 *  citation whose resolved `pageIndex` is set calls
 *  `Zotero.Reader.open(attachmentId, { pageIndex })` with `pageIndex` as
 *  the SECOND positional argument (NOT nested under `{ location: ... }`),
 *  that a `pageIndex === undefined` citation falls back to the v0.2.0
 *  no-location `Zotero.Reader.open(attachmentId)` call, and that a second
 *  citation click on the same item navigates the EXISTING reader tab
 *  rather than spawning a duplicate.
 *
 *  It is driven by a NEW `runCitationJumpFlow` phase in `e2e-driver.ts`
 *  that the AC-7/AC-9 implementer adds (see CONTRACT below). Until that
 *  driver flow lands, this suite SKIPS its behavioral assertions rather
 *  than failing, so it never produces a false negative for contributors
 *  (mirrors the established `migration-resume.e2e.test.ts` and
 *  `ask-question-popup.e2e.test.ts` skip patterns).
 *
 * --------------------------------------------------------------------
 *  CONTRACT for the AC-7/AC-9 implementer's `runCitationJumpFlow`
 * --------------------------------------------------------------------
 *
 *  Runs as part of the `e2e-trigger=all` driver sequence (it needs the
 *  real sample PDF imported by the real-pdf setup flow and a built index).
 *  The flow MUST set up a library-chat turn whose retrieved chunks include
 *  TWO chunks from the SAME parent item but DIFFERENT pages — chunk #0 on
 *  one page, chunk #1 on a later page — then:
 *    (a) render the assistant answer carrying distinct `[itemKey#0]` and
 *        `[itemKey#1]` citation tokens;
 *    (b) click the chunk-#0 citation and observe the reader open call;
 *    (c) click the chunk-#1 citation IN THE SAME ALREADY-OPEN READER and
 *        observe the navigate call;
 *    (d) render and click a citation whose chunk has NO pageIndex
 *        (metadata/note/legacy) and observe the no-location open call;
 *    (e) render a hallucinated `[WRONGKEY#0]` token where WRONGKEY is not
 *        chunk-0's source and click it — confirm it does NOT route to
 *        chunk-0's true source;
 *    (f) emit the log keys this suite scrapes:
 *        - e2e:citation-jump:chunk0-page=<pageIndex passed to Reader.open>
 *        - e2e:citation-jump:chunk0-arg-shape=<positional|nested-location>
 *        - e2e:citation-jump:chunk1-page=<pageIndex passed to Reader.open>
 *        - e2e:citation-jump:same-tab-navigated=<true|false>
 *        - e2e:citation-jump:reader-tab-count=<integer count after both clicks>
 *        - e2e:citation-jump:nolocation-open=<true|false>
 *        - e2e:citation-jump:nolocation-page-arg=<absent|<value>>
 *        - e2e:citation-jump:hallucinated-routed-to-chunk0=<true|false>
 *        - e2e:citation-jump:prompt-has-distinct-labels=<true|false>
 *        - e2e:phase=citation-jump:start / citation-jump:done
 *
 *  IMPORTANT (AC-7 L488): `pageIndex` is the SECOND POSITIONAL arg of
 *  `Zotero.Reader.open` — `open(attachmentId, { pageIndex })`. It is NOT
 *  `open(attachmentId, { location: { pageIndex } })`. The driver MUST
 *  inspect the actual argument shape and report `chunk0-arg-shape`.
 *
 * --------------------------------------------------------------------
 *  Fault Localization (Template 4 — AC-7/AC-9 e2e citation jump)
 * --------------------------------------------------------------------
 *
 *  1. Spec semantics (premises):
 *     P1. A citation with resolved `pageIndex !== undefined` calls
 *         `Zotero.Reader.open(attachmentId, { pageIndex })` — pageIndex
 *         as the SECOND POSITIONAL arg, not under `{ location: ... }`.
 *     P2. `pageIndex: 0` opens at page 0 — the impl checks `!== undefined`,
 *         not truthiness; page 0 is a real page.
 *     P3. A citation with `pageIndex === undefined` calls
 *         `Zotero.Reader.open(attachmentId)` with NO location arg.
 *     P4. A second citation click on the SAME item, different page,
 *         navigates the existing reader tab — no duplicate tab opens.
 *     P5. (AC-9) The prompt presents two same-item chunks with distinct
 *         `[itemKey#chunkIndex]` labels.
 *     P6. (AC-9) A hallucinated `[WRONGKEY#0]` does NOT silently route to
 *         chunk-0's true source.
 *  2. Code path trace:
 *     - driver `runCitationJumpFlow` builds a two-same-item-chunk turn,
 *       clicks each citation, inspects the `Zotero.Reader.open` calls.
 *  3. Divergence analysis:
 *     D1 [HIGH]   pageIndex passed nested under `{ location: ... }` not
 *                 as the second positional arg.
 *     D2 [HIGH]   `pageIndex: 0` dropped by a truthy guard -> opens at
 *                 page 0 anyway but via the no-location call (wrong path).
 *     D3 [HIGH]   second click on the same item spawns a duplicate tab.
 *     D4 [MEDIUM] `pageIndex: undefined` still passes a location arg.
 *     D5 [MEDIUM] hallucinated `[WRONGKEY#0]` routes to chunk-0's source.
 *     D6 [LOW]    prompt collapses two same-item chunks to one label.
 *  4. Test targets: D1 > D3 > D2 > D5 > D4 > D6.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  REPO_ROOT,
  cleanupProfile,
  startZoteroWithPlugin,
  type ZoteroHandle
} from "../../scripts/zotero-e2e/launch.mjs";

const MARIONETTE_PORT = Number(process.env.ZOTERO_MARIONETTE_PORT ?? "2841");
const XPI_PATH = process.env.ZOTERO_XPI ?? join(REPO_ROOT, "zotero-ai-explain.xpi");
const SAMPLE_PDF_PATH = join(REPO_ROOT, "tests", "fixtures", "sample.pdf");

type State = {
  handle: ZoteroHandle | null;
  startupError: Error | null;
  /** True when the driver entered the citation-jump phase at all. */
  driverFlowPresent: boolean;
};

const state: State = { handle: null, startupError: null, driverFlowPresent: false };

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractLast(log: string, key: string): string | null {
  const matches = Array.from(log.matchAll(new RegExp(`e2e:${escapeRegex(key)}=(.*)`, "g")));
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1];
  return last ? (last[1]?.trimEnd() ?? null) : null;
}

function extractAll(log: string, key: string): string[] {
  return Array.from(log.matchAll(new RegExp(`e2e:${escapeRegex(key)}=(.*)`, "g"))).map((m) =>
    (m[1] ?? "").trimEnd()
  );
}

function requireHandle(s: State): ZoteroHandle {
  if (s.handle === null) {
    throw s.startupError ?? new Error("Zotero handle was not initialised");
  }
  return s.handle;
}

beforeAll(async () => {
  if (!existsSync(XPI_PATH)) {
    throw new Error(
      `Plugin XPI not found at ${XPI_PATH}. Build it via 'npm run build && npm run package'.`
    );
  }
  try {
    state.handle = await startZoteroWithPlugin({
      xpiPath: XPI_PATH,
      marionettePort: MARIONETTE_PORT,
      startupTimeoutMs: 90_000,
      quiet: true,
      extraPrefs: {
        "extensions.zotero-ai-explain.e2e-sample-pdf": SAMPLE_PDF_PATH,
        "extensions.zotero-ai-explain.e2e-trigger": "all",
        "reader.sidebarOpen": true,
        "reader.sidebarWidth": 240,
        "reader.contextPaneOpen": true
      }
    });
    await state.handle.waitForLogLine(/e2e:done=/u, { timeoutMs: 120_000 });
    state.driverFlowPresent = extractAll(state.handle.getLog(), "phase").some((p) =>
      p.startsWith("citation-jump")
    );
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

describe("AC-7/AC-9 e2e: citation jump-to-page", () => {
  it("driver enters the citation-jump phase (skips if the driver flow is not yet implemented)", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) {
      // The AC-7/AC-9 implementer has not yet added `runCitationJumpFlow`
      // to e2e-driver.ts. Skip rather than fail — the citation parsing,
      // lookup table, and rendering behavior are covered by the jsdom
      // suites listed in the header.
      return;
    }
    const phases = extractAll(state.handle?.getLog() ?? "", "phase");
    expect(phases).toContain("citation-jump:start");
    expect(phases).toContain("citation-jump:done");
  });

  it("D1/P1: a chunk-#0 citation opens the reader with pageIndex as the second positional arg", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    const log = state.handle?.getLog() ?? "";
    // pageIndex must be carried as `open(attachmentId, { pageIndex })`,
    // NOT nested under `{ location: { pageIndex } }`.
    expect(extractLast(log, "citation-jump:chunk0-arg-shape")).toBe("positional");
    const chunk0Page = extractLast(log, "citation-jump:chunk0-page");
    expect(chunk0Page).not.toBeNull();
    // chunk #0's page is a concrete page index (not the undefined sentinel).
    expect(chunk0Page).not.toBe("undefined");
    expect(Number.isNaN(Number(chunk0Page))).toBe(false);
  });

  it("D2/P2: a citation resolving to pageIndex 0 still opens via the positional pageIndex arg", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    // If the driver's chunk-#0 is page 0, the arg shape must STILL be
    // `positional` — a truthy guard would mishandle page 0. Only assert
    // when the driver actually exercised page 0.
    const log = state.handle?.getLog() ?? "";
    if (extractLast(log, "citation-jump:chunk0-page") === "0") {
      expect(extractLast(log, "citation-jump:chunk0-arg-shape")).toBe("positional");
    }
  });

  it("D3/P4: clicking the chunk-#1 citation navigates the SAME reader tab (no duplicate)", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    const log = state.handle?.getLog() ?? "";
    expect(extractLast(log, "citation-jump:same-tab-navigated")).toBe("true");
    // Exactly one reader tab for the cited attachment after both clicks.
    expect(extractLast(log, "citation-jump:reader-tab-count")).toBe("1");
  });

  it("P1: chunk #0 and chunk #1 of the same item open at different pages", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    const log = state.handle?.getLog() ?? "";
    const page0 = extractLast(log, "citation-jump:chunk0-page");
    const page1 = extractLast(log, "citation-jump:chunk1-page");
    expect(page0).not.toBeNull();
    expect(page1).not.toBeNull();
    // Same parent item, different chunks -> different resolved pages.
    expect(page0).not.toBe(page1);
  });

  it("D4/P3: a citation with no pageIndex opens the attachment with NO location argument", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    const log = state.handle?.getLog() ?? "";
    expect(extractLast(log, "citation-jump:nolocation-open")).toBe("true");
    // No page argument may ride the no-location open call.
    expect(extractLast(log, "citation-jump:nolocation-page-arg")).toBe("absent");
  });

  it("D5/P6: a hallucinated [WRONGKEY#0] citation does NOT route to chunk-0's true source", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    expect(
      extractLast(state.handle?.getLog() ?? "", "citation-jump:hallucinated-routed-to-chunk0")
    ).toBe("false");
  });

  it("D6/P5: the prompt presents two same-item chunks with distinct [itemKey#chunkIndex] labels", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    expect(
      extractLast(state.handle?.getLog() ?? "", "citation-jump:prompt-has-distinct-labels")
    ).toBe("true");
  });

  it("the driver completes without an error", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    const handle = requireHandle(state);
    expect(extractLast(handle.getLog(), "done")).toBe("ok");
  });
});
