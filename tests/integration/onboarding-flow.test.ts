/* @vitest-environment jsdom */

/**
 * Integration test for the first-run onboarding flow.
 *
 * Scenario: a brand-new user opens Zotero with the plugin installed but
 * no Ollama daemon running. The probe should fail; the dialog should
 * appear; the user runs `brew install ollama` and `ollama pull …` in a
 * terminal; clicks Re-check; the probe now succeeds; the dialog flashes
 * "Ready!" and closes; the onboarding-shown pref is persisted so the
 * dialog does not reappear on the next startup.
 *
 * These tests exercise the full chain: probe → renderer → wire-up →
 * Re-check → close → pref write. They use the real DialogHandle adapter
 * so the dialog's mount/dismount is observable in the document.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ONBOARDING_SHOWN_PREF,
  markOnboardingShown,
  readOnboardingShown
} from "../../src/preferences/onboarding-state.js";
import type { StringPrefReader, StringPrefWriter } from "../../src/preferences/ollama-profile.js";
import {
  ONBOARDING_ACTIONS,
  probeOllamaForOnboarding,
  renderOnboardingView,
  wireOnboardingView,
  type OllamaProbeResult,
  type OnboardingSideEffects
} from "../../src/ui/onboarding-view.js";

type PrefStore = {
  values: Map<string, string>;
  reader: StringPrefReader;
  writer: StringPrefWriter;
};

function makePrefStore(initial: Record<string, string> = {}): PrefStore {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    values,
    reader: { get: (name) => values.get(name) },
    writer: {
      set(name, value) {
        values.set(name, value);
      },
      clear(name) {
        values.delete(name);
      }
    }
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("onboarding flow — first-run probe", () => {
  it("renders the dialog when probe fails and the pref is missing", async () => {
    const prefs = makePrefStore();
    expect(readOnboardingShown(prefs.reader)).toBe(false);

    // First probe: connection refused → ollama-missing.
    const result = await probeOllamaForOnboarding({
      baseUrl: "http://localhost:11434",
      chatModel: "gemma4:e2b",
      embeddingModel: "embeddinggemma",
      fetch: vi.fn(() => Promise.reject(new Error("ECONNREFUSED")))
    });
    if (result.state !== "ollama-missing") {
      throw new Error(`expected ollama-missing, got ${result.state}`);
    }

    // Render the dialog body — in production it lands inside a chrome dialog.
    const view = renderOnboardingView({ state: result.state, platform: "macos" });
    document.body.append(view);

    expect(view.dataset.state).toBe("ollama-missing");
    expect(view.querySelector(".zotero-ai-onboarding__install")).not.toBeNull();
    // Pref still not set — the controller writes it on dismissal, not on render.
    expect(prefs.values.size).toBe(0);
  });
});

describe("onboarding flow — Re-check transitions ollama-missing → ready", () => {
  it("flashes Ready! and closes after the user resolves both deficiencies", async () => {
    const prefs = makePrefStore();
    // First probe is the one that triggered the dialog; on re-check the
    // server is up and both models are pulled.
    const probeReady = vi.fn(async () =>
      Promise.resolve({ state: "ready" } satisfies OllamaProbeResult)
    );
    const view = renderOnboardingView({ state: "ollama-missing", platform: "linux" });
    document.body.append(view);

    let closed = false;
    const effects: OnboardingSideEffects = {
      copyToClipboard: vi.fn(async () => Promise.resolve()),
      launchUrl: vi.fn(),
      recheck: probeReady,
      close: () => {
        closed = true;
        markOnboardingShown(prefs.writer);
        view.remove();
      },
      openSettings: vi.fn(),
      setTimeout: (handler) => {
        handler();
        return 0;
      },
      readyFlashMs: 0
    };
    wireOnboardingView({ view, effects });

    view.querySelector<HTMLButtonElement>(`[data-action="${ONBOARDING_ACTIONS.recheck}"]`)?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(probeReady).toHaveBeenCalledTimes(1);
    expect(closed).toBe(true);
    expect(document.body.contains(view)).toBe(false);
    // Pref persisted so the next startup will skip the dialog.
    expect(prefs.values.get(ONBOARDING_SHOWN_PREF)).toBe("true");
    expect(readOnboardingShown(prefs.reader)).toBe(true);
  });

  it("transitions from ollama-missing → models-missing in place on Re-check", async () => {
    const view = renderOnboardingView({ state: "ollama-missing", platform: "macos" });
    document.body.append(view);

    const effects: OnboardingSideEffects = {
      copyToClipboard: vi.fn(async () => Promise.resolve()),
      launchUrl: vi.fn(),
      recheck: vi.fn(async () =>
        Promise.resolve({
          state: "models-missing",
          missing: { chat: "gemma4:e2b" }
        } satisfies OllamaProbeResult)
      ),
      close: vi.fn(),
      openSettings: vi.fn(),
      setTimeout: (handler) => {
        handler();
        return 0;
      }
    };
    wireOnboardingView({ view, effects });

    view.querySelector<HTMLButtonElement>(`[data-action="${ONBOARDING_ACTIONS.recheck}"]`)?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(view.dataset.state).toBe("models-missing");
    expect(effects.close).not.toHaveBeenCalled();
    // The new body should mention the chat pull command but NOT the install panel.
    expect(view.querySelector(".zotero-ai-onboarding__install")).toBeNull();
    const pulls = Array.from(view.querySelectorAll(".zotero-ai-onboarding__code-text")).map(
      (el) => el.textContent
    );
    expect(pulls).toContain("ollama pull gemma4:e2b");
    expect(pulls).not.toContain("ollama pull embeddinggemma");
  });
});

describe("onboarding flow — Skip and Open Settings dismissal", () => {
  it("Skip closes the dialog and the controller marks the pref shown", () => {
    const prefs = makePrefStore();
    const view = renderOnboardingView({ state: "ollama-missing", platform: "macos" });
    document.body.append(view);
    let closed = false;
    const effects: OnboardingSideEffects = {
      copyToClipboard: vi.fn(async () => Promise.resolve()),
      launchUrl: vi.fn(),
      recheck: vi.fn(async () => Promise.resolve({ state: "ready" } satisfies OllamaProbeResult)),
      close: () => {
        closed = true;
        markOnboardingShown(prefs.writer);
        view.remove();
      },
      openSettings: vi.fn()
    };
    wireOnboardingView({ view, effects });

    view.querySelector<HTMLButtonElement>(`[data-action="${ONBOARDING_ACTIONS.skip}"]`)?.click();

    expect(closed).toBe(true);
    expect(document.body.contains(view)).toBe(false);
    expect(prefs.values.get(ONBOARDING_SHOWN_PREF)).toBe("true");
  });
});
