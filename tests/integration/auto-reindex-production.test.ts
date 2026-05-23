/**
 * AC-8a — production auto-reindex behaviour (Adv-4).
 *
 * The e2e-hermeticity gate in `attachAutoReindex` (covered by
 * `auto-reindex-e2e-gate.test.ts`) disables auto-reindex when the
 * `e2e-trigger` pref is set. That gate ONLY makes the e2e suite
 * deterministic — it does not, by itself, prove the production
 * auto-reindex path works. If the gate silently masked a real
 * auto-reindex bug, no e2e test would catch it.
 *
 * This test pins production behaviour INDEPENDENTLY: with the
 * `e2e-trigger` pref UNSET, a synthesized `Zotero.Notifier` `add`
 * event must, after the debounce window, drive the real indexing
 * controller to actually run an index.
 *
 * It asserts OBSERVABLE behaviour — the controller status sequence
 * recorded by a subscriber — never the internal debounce/notify
 * wiring. It fails RED if production auto-reindex is broken regardless
 * of the e2e harness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachAutoReindex } from "../../src/bootstrap.js";
import { createIndexingController } from "../../src/indexing/indexing-controller.js";
import type { IndexingState } from "../../src/indexing/indexing-status.js";
import { controllerStubDeps } from "../indexing/controller-test-helpers.js";

type NotifierObserver = {
  notify: (event: string, type: string, ids: readonly (number | string)[]) => void;
};

/**
 * Build a fake Zotero global whose `Notifier.registerObserver` captures
 * the observer so the test can synthesize a real `add` event against
 * it — exactly what Zotero would do when the user imports an item.
 */
function makeZoteroCapturingObserver(): {
  zotero: Parameters<typeof attachAutoReindex>[0]["zotero"];
  fireNotify: (event: string, ids: readonly number[]) => void;
  observerCount: () => number;
} {
  const observers: NotifierObserver[] = [];
  const zotero = {
    debug: vi.fn(),
    Notifier: {
      registerObserver: (observer: NotifierObserver, _types: readonly string[], id: string) => {
        observers.push(observer);
        return id;
      },
      unregisterObserver: vi.fn()
    }
  } as unknown as Parameters<typeof attachAutoReindex>[0]["zotero"];
  return {
    zotero,
    fireNotify: (event, ids) => {
      for (const observer of observers) {
        observer.notify(event, "item", ids);
      }
    },
    observerCount: () => observers.length
  };
}

/** Drain pending microtasks so async controller transitions settle. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

describe("attachAutoReindex — production behaviour (AC-8a Adv-4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("a Notifier `add` event drives the controller to run after the debounce window", async () => {
    // A real indexing controller over an empty stub library: `start()`
    // transitions idle → running synchronously, then the crawl of an
    // empty library settles to `complete`. We record the full status
    // sequence so we can prove the controller actually ran.
    const controller = createIndexingController({
      logger: { debug: vi.fn() },
      ...controllerStubDeps()
    });
    const seen: IndexingState[] = [];
    controller.subscribe((s) => seen.push(s.state));

    const { zotero, fireNotify } = makeZoteroCapturingObserver();
    const detach = attachAutoReindex({
      zotero,
      indexingController: controller,
      debounceMs: 5_000,
      // Production: pref UNSET → auto-reindex fully enabled.
      e2eTriggerPref: undefined
    });

    expect(controller.getStatus().state).toBe("idle");

    // The user imports an item — Zotero fires an `add` notify.
    fireNotify("add", [42]);

    // BEFORE the debounce window elapses the controller must NOT have
    // started — the debounce is what coalesces a batch import.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(controller.getStatus().state).toBe("idle");

    // AFTER the debounce window the controller must run.
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    await vi.runAllTimersAsync();
    await flushMicrotasks();

    // Observable outcome: the controller went through `running`. With an
    // empty library the crawl then settles to `complete` — either way
    // the controller LEFT `idle`, which is the production guarantee.
    expect(seen).toContain("running");
    expect(controller.getStatus().state).not.toBe("idle");

    detach();
  });

  it("a `modify` event also triggers an auto-reindex run", async () => {
    // A re-titled / re-abstracted paper needs a re-embed; `modify` is
    // on the trigger set alongside `add`.
    const controller = createIndexingController({
      logger: { debug: vi.fn() },
      ...controllerStubDeps()
    });
    const seen: IndexingState[] = [];
    controller.subscribe((s) => seen.push(s.state));

    const { zotero, fireNotify } = makeZoteroCapturingObserver();
    const detach = attachAutoReindex({
      zotero,
      indexingController: controller,
      debounceMs: 5_000,
      e2eTriggerPref: undefined
    });

    fireNotify("modify", [7]);
    await vi.advanceTimersByTimeAsync(6_000);
    await flushMicrotasks();
    await vi.runAllTimersAsync();
    await flushMicrotasks();

    expect(seen).toContain("running");

    detach();
  });

  it("an empty-id event does NOT trigger a run (no spurious crawl)", async () => {
    // Notifier fires events with empty id lists in some cases; those
    // must not schedule a crawl.
    const controller = createIndexingController({
      logger: { debug: vi.fn() },
      ...controllerStubDeps()
    });
    const startSpy = vi.spyOn(controller, "start");

    const { zotero, fireNotify } = makeZoteroCapturingObserver();
    const detach = attachAutoReindex({
      zotero,
      indexingController: controller,
      debounceMs: 5_000,
      e2eTriggerPref: undefined
    });

    fireNotify("add", []);
    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(startSpy).not.toHaveBeenCalled();
    expect(controller.getStatus().state).toBe("idle");

    detach();
  });

  it("detach() before the debounce fires cancels the pending run", async () => {
    // Unsubscribing (plugin shutdown) must cancel an in-flight debounce
    // so the controller is not started after teardown.
    const controller = createIndexingController({
      logger: { debug: vi.fn() },
      ...controllerStubDeps()
    });
    const startSpy = vi.spyOn(controller, "start");

    const { zotero, fireNotify } = makeZoteroCapturingObserver();
    const detach = attachAutoReindex({
      zotero,
      indexingController: controller,
      debounceMs: 5_000,
      e2eTriggerPref: undefined
    });

    fireNotify("add", [99]);
    // Detach BEFORE the 5 s debounce elapses.
    await vi.advanceTimersByTimeAsync(2_000);
    detach();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    expect(startSpy).not.toHaveBeenCalled();
    expect(controller.getStatus().state).toBe("idle");
  });
});
