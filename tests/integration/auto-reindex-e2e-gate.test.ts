/**
 * AC-8a — e2e-hermeticity gate for `attachAutoReindex`.
 *
 * The v0.2.0 auto-reindex observer (`attachAutoReindex` in
 * `src/bootstrap.ts`) registers a `Zotero.Notifier` observer that fires
 * a debounced `indexingController.start()` whenever items are added or
 * modified. The in-process e2e diagnostic driver, by contrast, drives
 * the indexing controller deterministically (start → pause → resume →
 * clear → re-index) and scrapes the controller status at precise
 * points. An auto-reindex `start()` firing on its own debounce timer
 * would mutate the controller out from under those scrapes — a real
 * source of e2e non-determinism.
 *
 * The gate: when the `extensions.zotero-ai-explain.e2e-trigger` pref is
 * non-empty (the e2e driver is active), `attachAutoReindex` must
 * register NO observer and return a no-op unsubscribe.
 *
 * These tests assert OBSERVABLE behaviour (was a Notifier observer
 * registered? did the returned unsubscribe touch the notifier?), never
 * the internal debounce mechanism.
 *
 * Adversarial coverage:
 *  - Adv-1: e2e-trigger empty / undefined / whitespace → observer attaches.
 *  - Adv-2: e2e-trigger non-empty → no observer; unsubscribe is inert.
 */

import { describe, expect, it, vi } from "vitest";

import { attachAutoReindex } from "../../src/bootstrap.js";

type NotifierObserver = {
  notify: (event: string, type: string, ids: readonly (number | string)[]) => void;
};

/**
 * Build a fake Zotero global whose `Notifier` records every
 * `registerObserver` / `unregisterObserver` call so a test can assert
 * whether the auto-reindex observer was wired.
 */
function makeZoteroWithNotifier(): {
  zotero: Parameters<typeof attachAutoReindex>[0]["zotero"];
  registerObserver: ReturnType<typeof vi.fn>;
  unregisterObserver: ReturnType<typeof vi.fn>;
  observers: { observer: NotifierObserver; types: readonly string[]; id: string }[];
} {
  const observers: { observer: NotifierObserver; types: readonly string[]; id: string }[] = [];
  const registerObserver = vi.fn(
    (observer: NotifierObserver, types: readonly string[], id: string): string => {
      observers.push({ observer, types, id });
      return id;
    }
  );
  const unregisterObserver = vi.fn();
  const zotero = {
    debug: vi.fn(),
    Notifier: { registerObserver, unregisterObserver }
  } as unknown as Parameters<typeof attachAutoReindex>[0]["zotero"];
  return { zotero, registerObserver, unregisterObserver, observers };
}

function makeController(): Parameters<typeof attachAutoReindex>[0]["indexingController"] {
  return {
    start: vi.fn(),
    getStatus: () => ({ state: "idle" })
  };
}

describe("attachAutoReindex — e2e-trigger gate (AC-8a)", () => {
  describe("Adv-1: e2e-trigger pref empty → auto-reindex registers normally", () => {
    it("registers a Notifier observer when e2eTriggerPref is undefined", () => {
      const { zotero, registerObserver } = makeZoteroWithNotifier();
      const detach = attachAutoReindex({
        zotero,
        indexingController: makeController(),
        debounceMs: 5_000,
        e2eTriggerPref: undefined
      });
      expect(registerObserver).toHaveBeenCalledTimes(1);
      // The observer must watch the `item` type — that is what add /
      // modify events ride on.
      expect(registerObserver.mock.calls[0]?.[1]).toContain("item");
      detach();
    });

    it("registers a Notifier observer when e2eTriggerPref is the empty string", () => {
      const { zotero, registerObserver } = makeZoteroWithNotifier();
      const detach = attachAutoReindex({
        zotero,
        indexingController: makeController(),
        debounceMs: 5_000,
        e2eTriggerPref: ""
      });
      expect(registerObserver).toHaveBeenCalledTimes(1);
      detach();
    });

    it("registers a Notifier observer when e2eTriggerPref is whitespace-only", () => {
      // A pref that round-tripped through an empty settings field can
      // come back as "   ". That is still "not running under the e2e
      // driver" — the gate must treat it as empty.
      const { zotero, registerObserver } = makeZoteroWithNotifier();
      const detach = attachAutoReindex({
        zotero,
        indexingController: makeController(),
        debounceMs: 5_000,
        e2eTriggerPref: "   "
      });
      expect(registerObserver).toHaveBeenCalledTimes(1);
      detach();
    });

    it("the returned unsubscribe unregisters the observer it registered", () => {
      const { zotero, registerObserver, unregisterObserver } = makeZoteroWithNotifier();
      const detach = attachAutoReindex({
        zotero,
        indexingController: makeController(),
        debounceMs: 5_000,
        e2eTriggerPref: undefined
      });
      const registeredId = registerObserver.mock.results[0]?.value as string;
      detach();
      expect(unregisterObserver).toHaveBeenCalledTimes(1);
      expect(unregisterObserver.mock.calls[0]?.[0]).toBe(registeredId);
    });
  });

  describe("Adv-2: e2e-trigger pref non-empty → no observer, inert unsubscribe", () => {
    it("registers NO Notifier observer when e2eTriggerPref is set", () => {
      const { zotero, registerObserver } = makeZoteroWithNotifier();
      attachAutoReindex({
        zotero,
        indexingController: makeController(),
        debounceMs: 5_000,
        e2eTriggerPref: "all"
      });
      expect(registerObserver).not.toHaveBeenCalled();
    });

    it("registers NO observer for any non-empty trigger value", () => {
      const { zotero, registerObserver } = makeZoteroWithNotifier();
      attachAutoReindex({
        zotero,
        indexingController: makeController(),
        debounceMs: 5_000,
        e2eTriggerPref: "index-start"
      });
      expect(registerObserver).not.toHaveBeenCalled();
    });

    it("returns an unsubscribe that does NOT touch the notifier", () => {
      const { zotero, unregisterObserver } = makeZoteroWithNotifier();
      const detach = attachAutoReindex({
        zotero,
        indexingController: makeController(),
        debounceMs: 5_000,
        e2eTriggerPref: "all"
      });
      // The no-op unsubscribe must be safe to call (idempotent) and
      // must never reach `unregisterObserver` — there is nothing to
      // unregister.
      expect(() => {
        detach();
        detach();
      }).not.toThrow();
      expect(unregisterObserver).not.toHaveBeenCalled();
    });

    it("a value with surrounding whitespace still disables auto-reindex", () => {
      // `e2e-trigger=" all "` is still an active trigger — the gate
      // trims before the empty-check, so a padded value disables.
      const { zotero, registerObserver } = makeZoteroWithNotifier();
      attachAutoReindex({
        zotero,
        indexingController: makeController(),
        debounceMs: 5_000,
        e2eTriggerPref: "  all  "
      });
      expect(registerObserver).not.toHaveBeenCalled();
    });
  });
});
