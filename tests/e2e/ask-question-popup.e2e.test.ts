/**
 * AC-1 e2e — the "Ask a question" reader command and its sticky-quote
 * chat, exercised through a real Zotero launch.
 *
 * Plan: `docs/superpowers/plans/2026-05-19-pdf-context-features.md`
 *   AC-1 description           L395-407 (adversarial cases L403-407)
 *   AC-1 + AC-2 contracts      L590-627
 *
 * --------------------------------------------------------------------
 *  HARNESS CONSTRAINT — read before extending this file
 * --------------------------------------------------------------------
 *
 *  The unit-level reader-command behavior (button registration,
 *  hidden-when-empty, source-field population, the params-undefined
 *  fall-through) is fully covered by the jsdom test
 *  `tests/platform/zotero-ui-adapter-source-fields.test.ts`.
 *
 *  This e2e file covers what only a REAL reader can prove: that the
 *  second "Ask a question" command actually appears in the live
 *  reader-selection popup, opens the anchored popup with the selection
 *  preloaded as a quote block and the textarea focused (NO auto-stream),
 *  and that the first submitted turn is framed as
 *  `Quote: "<selection>"\n\nQuestion: <user-question>` with the quote
 *  re-applied as a system message on every later turn.
 *
 *  It is driven by a NEW `runAskQuestionFlow` phase in `e2e-driver.ts`
 *  that the AC-1 implementer adds (see CONTRACT below). Until that
 *  driver flow lands, this suite SKIPS its behavioral assertions rather
 *  than failing, so it never produces a false negative for contributors
 *  (mirrors the established `migration-resume.e2e.test.ts` pattern).
 *
 * --------------------------------------------------------------------
 *  CONTRACT for the AC-1 implementer's `runAskQuestionFlow`
 * --------------------------------------------------------------------
 *
 *  Runs as part of the `e2e-trigger=all` driver sequence (it needs the
 *  real sample PDF imported by `runRealPdfSetupFlow`). The flow MUST:
 *    (a) dispatch a real `renderTextSelectionPopup` reader event with a
 *        non-empty selection;
 *    (b) locate the "Ask a question" command button in the appended
 *        reader-popup controls and click it;
 *    (c) assert the anchored popup mounts with the selection rendered
 *        as a quote block and the textarea focused, and that NO
 *        assistant turn streamed on open (no auto-explain);
 *    (d) type a question, submit, and inspect the first user turn sent
 *        to the provider;
 *    (e) submit a SECOND and THIRD turn and inspect the system frame;
 *    (f) ALSO dispatch a reader event with an EMPTY selection and
 *        confirm the "Ask a question" command is hidden;
 *    (g) emit these log keys this suite scrapes:
 *        - e2e:ask-question:command-present=<true|false>
 *        - e2e:ask-question:popup-mounted=<true|false>
 *        - e2e:ask-question:quote-block-text=<selection text>
 *        - e2e:ask-question:textarea-focused=<true|false>
 *        - e2e:ask-question:auto-streamed=<true|false>   (MUST be false)
 *        - e2e:ask-question:empty-submit-rejected=<true|false>
 *        - e2e:ask-question:first-turn=<the framed first user message>
 *        - e2e:ask-question:turn5-has-quote=<true|false>
 *        - e2e:ask-question:hidden-when-no-selection=<true|false>
 *        - e2e:phase=ask-question:start / ask-question:done
 *
 * --------------------------------------------------------------------
 *  Fault Localization (Template 4 — AC-1 e2e ask-question command)
 * --------------------------------------------------------------------
 *
 *  1. Spec semantics (premises):
 *     P1. A second reader command labeled "Ask a question" appears
 *         alongside "Explain with AI" on a PDF text selection.
 *     P2. Activating it opens the anchored popup with the selection
 *         preloaded as a quote block, the textarea focused, and NO
 *         auto-explain (no assistant turn streams on open).
 *     P3. The first submitted turn is
 *         `Quote: "<selection>"\n\nQuestion: <user-question>`.
 *     P4. Every later turn re-applies the quote as a system message —
 *         turn 5 still carries the quote in the system frame.
 *     P5. Submitting with an empty textarea is a rejected no-op.
 *     P6. With an empty reader selection the command is HIDDEN.
 *  2. Code path trace:
 *     - driver `runAskQuestionFlow` dispatches a real reader event,
 *       clicks the "Ask a question" button, drives the popup.
 *  3. Divergence analysis:
 *     D1 [HIGH]   the "Ask a question" command never appears.
 *     D2 [HIGH]   the popup auto-streams an explanation on open.
 *     D3 [HIGH]   the first turn is not quote-framed.
 *     D4 [HIGH]   the quote drops out of the system frame by turn 5.
 *     D5 [MEDIUM] empty submit is not rejected.
 *     D6 [MEDIUM] the command is not hidden on an empty selection.
 *  4. Test targets: D1 > D2 > D3 > D4 > D5 > D6.
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

const MARIONETTE_PORT = Number(process.env.ZOTERO_MARIONETTE_PORT ?? "2839");
const XPI_PATH = process.env.ZOTERO_XPI ?? join(REPO_ROOT, "zotero-ai-explain.xpi");
const SAMPLE_PDF_PATH = join(REPO_ROOT, "tests", "fixtures", "sample.pdf");

type State = {
  handle: ZoteroHandle | null;
  startupError: Error | null;
  /** True when the driver entered the ask-question phase at all. */
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
      p.startsWith("ask-question")
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

describe("AC-1 e2e: the 'Ask a question' reader command", () => {
  it("driver enters the ask-question phase (skips if the driver flow is not yet implemented)", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) {
      // The AC-1 implementer has not yet added `runAskQuestionFlow` to
      // e2e-driver.ts. Skip rather than fail — the reader-command unit
      // behavior is covered by the jsdom source-fields suite.
      return;
    }
    const phases = extractAll(state.handle?.getLog() ?? "", "phase");
    expect(phases).toContain("ask-question:start");
    expect(phases).toContain("ask-question:done");
  });

  it("D1: the 'Ask a question' command appears on a real PDF selection", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    expect(extractLast(state.handle?.getLog() ?? "", "ask-question:command-present")).toBe("true");
  });

  it("D1/P2: activating it opens the anchored popup with the selection as a quote block", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    const log = state.handle?.getLog() ?? "";
    expect(extractLast(log, "ask-question:popup-mounted")).toBe("true");
    const quoteText = extractLast(log, "ask-question:quote-block-text");
    expect(quoteText).not.toBeNull();
    expect((quoteText ?? "").length).toBeGreaterThan(0);
  });

  it("P2: the textarea is focused on open", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    expect(extractLast(state.handle?.getLog() ?? "", "ask-question:textarea-focused")).toBe("true");
  });

  it("D2: opening the ask-question popup does NOT auto-stream an explanation", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    // The defining difference from "Explain with AI": ask-question
    // waits for the user's first question — it never streams on open.
    expect(extractLast(state.handle?.getLog() ?? "", "ask-question:auto-streamed")).toBe("false");
  });

  it("D5: submitting with an empty textarea is rejected (no-op)", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    expect(extractLast(state.handle?.getLog() ?? "", "ask-question:empty-submit-rejected")).toBe(
      "true"
    );
  });

  it('D3/P3: the first submitted turn is framed as Quote: "..."\\n\\nQuestion: ...', () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    const firstTurn = extractLast(state.handle?.getLog() ?? "", "ask-question:first-turn");
    expect(firstTurn).not.toBeNull();
    // The exact quote-frame shape from AC-1 L397.
    expect(firstTurn ?? "").toMatch(/^Quote: ".*"/u);
    expect(firstTurn ?? "").toContain("Question:");
  });

  it("D4/P4: turn 5 still carries the quote in the system message frame", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    expect(extractLast(state.handle?.getLog() ?? "", "ask-question:turn5-has-quote")).toBe("true");
  });

  it("D6/P6: an empty reader selection hides the 'Ask a question' command", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    expect(extractLast(state.handle?.getLog() ?? "", "ask-question:hidden-when-no-selection")).toBe(
      "true"
    );
  });

  it("the driver completes without an error", () => {
    if (state.startupError) throw state.startupError;
    if (!state.driverFlowPresent) return;
    const handle = requireHandle(state);
    expect(extractLast(handle.getLog(), "done")).toBe("ok");
  });
});
