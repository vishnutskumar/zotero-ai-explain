/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import { createIndexingController } from "../../src/indexing/indexing-controller.js";
import { controllerStubDeps } from "../indexing/controller-test-helpers.js";
import { attachIndexControls, renderIndexControls } from "../../src/ui/index-controls-view.js";

describe("renderIndexControls", () => {
  it("renders status text and all four action buttons unconditionally", () => {
    const view = renderIndexControls({
      state: "running",
      totalItems: 20,
      indexedItems: 4,
      failedItems: 1
    });

    expect(view.textContent).toContain("4 / 20 indexed");
    expect(view.textContent).toContain("1 failed");
    expect(view.querySelector('[data-action="start-index"]')).not.toBeNull();
    expect(view.querySelector('[data-action="pause-index"]')).not.toBeNull();
    expect(view.querySelector('[data-action="resume-index"]')).not.toBeNull();
    expect(view.querySelector('[data-action="clear-index"]')).not.toBeNull();
  });

  it("renders all four action buttons in every reducer state", () => {
    for (const state of ["idle", "running", "paused", "complete", "failed"] as const) {
      const view = renderIndexControls({
        state,
        totalItems: 5,
        indexedItems: 2,
        failedItems: 1
      });
      expect(view.querySelector('[data-action="start-index"]'), `state=${state}`).not.toBeNull();
      expect(view.querySelector('[data-action="pause-index"]'), `state=${state}`).not.toBeNull();
      expect(view.querySelector('[data-action="resume-index"]'), `state=${state}`).not.toBeNull();
      expect(view.querySelector('[data-action="clear-index"]'), `state=${state}`).not.toBeNull();
    }
  });

  it("never includes 'Phase 2' or 'not yet implemented' wording in any state", () => {
    for (const state of ["idle", "running", "paused", "complete", "failed"] as const) {
      const view = renderIndexControls({
        state,
        totalItems: 5,
        indexedItems: 2,
        failedItems: 1
      });
      const text = view.textContent;
      expect(text).not.toMatch(/phase\s*2/iu);
      expect(text).not.toMatch(/not yet implemented/iu);
    }
  });
});

describe("attachIndexControls", () => {
  function setup() {
    const controller = createIndexingController({
      logger: { debug: () => undefined },
      ...controllerStubDeps()
    });
    const view = renderIndexControls(controller.getStatus());
    document.body.append(view);
    const detach = attachIndexControls(view, controller);
    const summary = view.querySelector<HTMLElement>(".zotero-ai-index-controls__summary");
    return { controller, view, detach, summary };
  }

  it("clicking start changes the summary text to a running-state phrase", () => {
    const { view, summary, detach } = setup();
    expect(summary?.textContent ?? "").toContain("0 / 0 indexed");
    const start = view.querySelector<HTMLButtonElement>('[data-action="start-index"]');
    start?.click();
    // AC-14 Fix 3: an immediately-started run (`totalItems === 0`, before
    // the first crawler `onProgress`) shows "Starting… scanning your
    // library." rather than "Indexing 0 of 0." — the regex accepts both.
    expect(summary?.textContent ?? "").toMatch(/Indexing|Starting/u);
    detach();
    view.remove();
  });

  it("supports pause -> resume -> clear flow with visible status changes", async () => {
    const { view, summary, detach } = setup();
    view.querySelector<HTMLButtonElement>('[data-action="start-index"]')?.click();
    expect(summary?.textContent ?? "").toMatch(/Indexing|Starting/u);
    view.querySelector<HTMLButtonElement>('[data-action="pause-index"]')?.click();
    expect(summary?.textContent ?? "").toContain("Paused");
    view.querySelector<HTMLButtonElement>('[data-action="resume-index"]')?.click();
    expect(summary?.textContent ?? "").toMatch(/Indexing|Starting/u);
    // AC-14 Fix 2: the Clear button is now a two-stage in-view confirm.
    // The flow test's `clear` step is updated in lockstep with the
    // two-stage confirm (the e2e-driver co-change pattern applies to the
    // unit flow test too — plan "Regression guard").
    const clearBtn = view.querySelector<HTMLButtonElement>('[data-action="clear-index"]');
    clearBtn?.click(); // arm the confirm
    clearBtn?.click(); // confirm → drives the real clear
    // `controller.clear()` is async (it awaits the in-flight run); drain
    // microtasks so the `cleared` reducer action lands before asserting
    // the cleared-state summary. (Pre-AC-14 this assertion passed only
    // because the running-state text itself contained "0 / 0 indexed";
    // AC-14 Fix 3 changed that text to "Starting…", so the test must
    // genuinely await the clear to observe the idle/cleared state.)
    for (let i = 0; i < 16; i += 1) {
      await Promise.resolve();
    }
    expect(summary?.textContent ?? "").toContain("0 / 0 indexed");
    detach();
    view.remove();
  });

  it("detach stops updating the summary on further controller actions", () => {
    const { controller, view, summary, detach } = setup();
    const baseline = summary?.textContent ?? "";
    detach();
    controller.start();
    // After detach the summary text should not have changed.
    expect(summary?.textContent ?? "").toBe(baseline);
    view.remove();
  });
});
