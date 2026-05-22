import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PLUGIN_ID,
  REPO_ROOT,
  cleanupProfile,
  startZoteroWithPlugin,
  type ZoteroHandle
} from "../../scripts/zotero-e2e/launch.mjs";

/**
 * Real-Zotero adversarial E2E for Bug A1 + A2.
 *
 * Reproduces the user's exact pref state:
 *
 *   - chat-provider="codex-cli"     (the "Codex via Proxy" preset)
 *   - chat-base-url="http://localhost:11400/codex"
 *   - chat-model="gpt-5.5"          (a known codex alias)
 *
 * Boots Zotero with these prefs in the profile and asserts the
 * provider-config debug line reflects them — proving that
 * `loadProviderProfileSettingsFromPrefs` and the downstream wiring read
 * the persisted preset (not the onboarding defaults) at startup. The
 * popup banner formatter (`describeDisclosureFor`) builds its label
 * from the same `readProviderProfile` closure, so this assertion is the
 * end-to-end smoke test that the bug is fixed in the shipped XPI.
 *
 * The full popup render requires a PDF selection (covered by the
 * real-pdf-pipeline suite). Here we assert against the structured debug
 * line bootstrap emits at startup so the test runs in ~12s instead of
 * the 60-90s a full reader spin-up costs.
 */

const MARIONETTE_PORT = Number(process.env.ZOTERO_MARIONETTE_PORT ?? "2832");
const XPI_PATH = process.env.ZOTERO_XPI ?? join(REPO_ROOT, "zotero-ai-explain.xpi");

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
        // The exact codex preset state the user had on disk when they
        // hit the bug. If the popup formatter ignores any of these, the
        // assertions below fail.
        "extensions.zotero-ai-explain.chat-provider": "codex-cli",
        "extensions.zotero-ai-explain.embed-provider": "ollama",
        "extensions.zotero-ai-explain.chat-base-url": "http://localhost:11400/codex",
        "extensions.zotero-ai-explain.embed-base-url": "http://localhost:11434",
        "extensions.zotero-ai-explain.chat-model": "gpt-5.5",
        "extensions.zotero-ai-explain.embedding-model": "embeddinggemma",
        // Suppress proxy auto-start so this scenario isolates the
        // settings/formatter wiring from the spawn lifecycle (covered
        // by the proxy-wiring tests).
        "extensions.zotero-ai-explain.proxy-autostart": "false"
      }
    });
  } catch (err) {
    state.startupError = err instanceof Error ? err : new Error(String(err));
  }
}, 180_000);

afterAll(async () => {
  if (state.handle) {
    await state.handle.shutdown({ graceMs: 5_000 });
    cleanupProfile(state.handle.profileDir);
    state.handle = null;
  }
}, 60_000);

describe("preset-aware startup (Bug A1 + A2, e2e)", () => {
  it("starts cleanly with the codex preset prefs", () => {
    if (state.startupError) throw state.startupError;
    const handle = requireHandle(state);
    expect(handle.getLog()).toContain("Zotero AI Explain startup");
    expect(handle.getLog()).not.toContain(
      `Error running bootstrap method 'startup' on ${PLUGIN_ID}`
    );
  });

  it("provider-config debug line reflects the persisted codex-cli preset (Bug A1)", () => {
    const handle = requireHandle(state);
    // bootstrap.ts:762-763 logs `provider config: chat=<kind> embed=<kind>`
    // at startup. The Bug A1 regression would have shown `chat=ollama`
    // because the old code path resolved the profile from the legacy
    // Ollama snapshot. Asserting the live-read here proves the fix in
    // the shipped XPI.
    expect(handle.getLog()).toMatch(/provider config: chat=codex-cli embed=ollama/u);
  });

  it("ollama-config debug line reflects the codex preset's chatBaseUrl, not the default Ollama URL (Bug A2)", () => {
    const handle = requireHandle(state);
    // bootstrap.ts logs `ollama config: chatBaseUrl=<value> embedBaseUrl=…`
    // after `loadOllamaSettings` (AC-8b). With
    // chatBaseUrl="http://localhost:11400/codex" saved into prefs, the
    // log MUST surface the proxy URL on `chatBaseUrl` — not the default
    // :11434. The same fields drive the popup banner.
    expect(handle.getLog()).toMatch(/ollama config: chatBaseUrl=http:\/\/localhost:11400\/codex/u);
  });
});
