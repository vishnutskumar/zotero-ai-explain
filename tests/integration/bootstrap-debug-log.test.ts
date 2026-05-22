/* @vitest-environment jsdom */

/**
 * AC-8b — the bootstrap "ollama config" debug log emits the split
 * chat/embed URLs.
 *
 * Before AC-8b, `startup()` logged only the legacy single field:
 *   `Zotero AI Explain ollama config: baseUrl=<value>`
 * After the split-URL change, chat traffic and embed traffic can point
 * at different endpoints (e.g. chat through the local llm-proxy, embed
 * at a real Ollama daemon). A log line that surfaces only `baseUrl`
 * hides the chat URL when a user has set `chat-base-url` but no legacy
 * `ollama-base-url`. AC-8b changes the line to:
 *   `Zotero AI Explain ollama config: chatBaseUrl=<chat> embedBaseUrl=<embed> (legacy baseUrl=<legacy>)`
 *
 * These tests run the real `startup()` against stubbed chrome globals
 * and scrape the captured `Zotero.debug` output — the same surface the
 * e2e suite scrapes — so they assert the actual shipped log shape.
 *
 * Adversarial cases (from the plan):
 *  - User has only `chat-base-url` set → log emits the chat URL, not the
 *    default :11434.
 *  - User has only legacy `ollama-base-url` set → `chatBaseUrl` falls
 *    through to the legacy value (`ollama-profile.ts:105`), so the log
 *    surfaces the legacy URL on `chatBaseUrl`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZoteroBootstrapContext } from "../../src/bootstrap.js";
import {
  CHAT_BASE_URL_PREF,
  EMBED_BASE_URL_PREF,
  OLLAMA_BASE_URL_PREF
} from "../../src/preferences/ollama-profile.js";

type GT = typeof globalThis & {
  ChromeUtils?: unknown;
  Components?: unknown;
  IOUtils?: unknown;
  fetch?: unknown;
};

/**
 * Run `startup()` with the supplied prefs and return every line passed
 * to `Zotero.debug`. Chrome globals are stubbed minimally — the proxy
 * lifecycle, IOUtils, and onboarding all degrade gracefully when their
 * dependencies are absent, which is exactly what we want: a clean
 * `startup()` whose only interesting output is the debug log.
 */
async function captureStartupDebugLog(prefs: Map<string, string>): Promise<string[]> {
  const gt = globalThis as GT;
  const prior = { fetch: gt.fetch };
  // Fail the onboarding probe fast (no network) so startup does not
  // stall on a real fetch. The probe failure just routes onboarding to
  // "ollama-missing", which is harmless here.
  gt.fetch = (): Promise<Response> =>
    Promise.reject(new TypeError("fetch stubbed for bootstrap-debug-log test"));

  const lines: string[] = [];
  const Zotero = {
    debug: (message: string): void => {
      lines.push(message);
    },
    getMainWindow: () => window,
    initializationPromise: Promise.resolve(),
    uiReadyPromise: Promise.resolve(),
    Prefs: {
      get: (name: string): string | undefined => prefs.get(name),
      set: (name: string, value: string | number | boolean): void => {
        prefs.set(name, String(value));
      },
      clear: (name: string): void => {
        prefs.delete(name);
      }
    },
    DataDirectory: { dir: "/var/test-fixture/zotero-ai-explain-test" }
  };
  const context: ZoteroBootstrapContext = {
    pluginId: "zotero-ai-explain@test",
    Zotero,
    reason: 1
  };

  try {
    const bootstrap = await import("../../src/bootstrap.js");
    await bootstrap.startup(context);
    await bootstrap.shutdown(context);
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (prior.fetch === undefined) {
      delete gt.fetch;
    } else {
      gt.fetch = prior.fetch;
    }
  }
  return lines;
}

/** Pull the single `ollama config:` debug line out of the captured log. */
function ollamaConfigLine(lines: readonly string[]): string {
  const match = lines.find((l) => l.includes("ollama config:"));
  if (match === undefined) {
    throw new Error(`no "ollama config:" debug line found. Captured lines:\n${lines.join("\n")}`);
  }
  return match;
}

describe("bootstrap ollama-config debug log (AC-8b)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("emits chatBaseUrl, embedBaseUrl, and legacy baseUrl in one line", async () => {
    const prefs = new Map<string, string>([
      [CHAT_BASE_URL_PREF, "http://chat.example:11434"],
      [EMBED_BASE_URL_PREF, "http://embed.example:11434"]
    ]);
    const line = ollamaConfigLine(await captureStartupDebugLog(prefs));
    expect(line).toContain("chatBaseUrl=http://chat.example:11434");
    expect(line).toContain("embedBaseUrl=http://embed.example:11434");
    expect(line).toContain("legacy baseUrl=");
  });

  it("emits the chat URL — not the default :11434 — when only chat-base-url is set", async () => {
    // Adversarial: a user who set ONLY `chat-base-url` (no legacy
    // `ollama-base-url`). The log MUST surface their chat URL. The old
    // `baseUrl=`-only line would have shown the default :11434 because
    // `baseUrl` falls back to the default when no legacy pref exists.
    const prefs = new Map<string, string>([[CHAT_BASE_URL_PREF, "http://localhost:11400/codex"]]);
    const line = ollamaConfigLine(await captureStartupDebugLog(prefs));
    expect(line).toContain("chatBaseUrl=http://localhost:11400/codex");
    // The chat URL must be visible on the chatBaseUrl field, not buried
    // as an unreachable default.
    expect(line).not.toMatch(/chatBaseUrl=http:\/\/localhost:11434\b/u);
  });

  it("falls through to the legacy ollama-base-url via chatBaseUrl for a legacy install", async () => {
    // Adversarial: a legacy install that only ever wrote
    // `ollama-base-url`. `loadOllamaSettingsFromPrefs` seeds BOTH
    // chatBaseUrl and embedBaseUrl from the legacy value
    // (`ollama-profile.ts:105`), so the log must surface the legacy URL
    // on `chatBaseUrl` — never the bundled default.
    const prefs = new Map<string, string>([[OLLAMA_BASE_URL_PREF, "http://legacy-host:9999"]]);
    const line = ollamaConfigLine(await captureStartupDebugLog(prefs));
    expect(line).toContain("chatBaseUrl=http://legacy-host:9999");
    expect(line).toContain("embedBaseUrl=http://legacy-host:9999");
    expect(line).toContain("legacy baseUrl=http://legacy-host:9999");
  });

  it("a modern chat-base-url takes precedence over a legacy ollama-base-url", async () => {
    // When BOTH are present the modern pref wins for chatBaseUrl; the
    // legacy field still mirrors the legacy pref.
    const prefs = new Map<string, string>([
      [OLLAMA_BASE_URL_PREF, "http://legacy-host:9999"],
      [CHAT_BASE_URL_PREF, "http://modern-chat:11400"]
    ]);
    const line = ollamaConfigLine(await captureStartupDebugLog(prefs));
    expect(line).toContain("chatBaseUrl=http://modern-chat:11400");
    // embedBaseUrl has no modern override → falls through to legacy.
    expect(line).toContain("embedBaseUrl=http://legacy-host:9999");
    expect(line).toContain("legacy baseUrl=http://legacy-host:9999");
  });

  it("uses the bundled default when no URL pref is set at all", async () => {
    const line = ollamaConfigLine(await captureStartupDebugLog(new Map()));
    expect(line).toContain("chatBaseUrl=http://localhost:11434");
    expect(line).toContain("embedBaseUrl=http://localhost:11434");
  });
});
