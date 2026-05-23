/* @vitest-environment jsdom */

/**
 * Adversarial state-transition tests.
 *
 * Motivation: the bugs the user hit (popup said "Ollama using gemma4:e2b"
 * after they selected codex+gpt-5.5; proxy auto-spawned a second copy on
 * top of an orphan; codex CLI exited -1 with no helpful message) all
 * lived in **state transitions across module seams**. Existing unit
 * tests cover each module in isolation; existing E2E tests cover the
 * happy path with prefs set at startup. Neither catches a "user changes
 * preset mid-session and the popup reads a stale snapshot" regression.
 *
 * This file targets that gap. Each scenario:
 *
 *   1. Stands up the real component wiring (`providerProfileToDisclosure`,
 *      `wireProxyLifecycle`, real prefs reader/writer) — not a stub.
 *   2. Simulates the OS edges (subprocess spawn, fetch, child stderr).
 *   3. Mutates state mid-test (changes a pref, releases an exit code,
 *      flips a probe response).
 *   4. Asserts the user-facing surface reflects the new state.
 *
 * Coverage:
 *
 *   - Bug A1+A2: popup label updates when chatProvider changes; never
 *     shows "Ollama" when codex/claude is active; never shows the
 *     onboarding-default model when the user has saved a different one.
 *   - Bug B1: proxy lifecycle skips spawn when /api/tags is already
 *     responding on the port; snapshot reflects externallyManaged.
 *   - Bug B2: codex CLI ENOENT surfaces as a user-actionable message
 *     mentioning PROXY_CODEX_BIN, not "exited with code -1".
 *   - Bug B2 (cont.): /api/diagnostics roundtrip — bootstrap stitches a
 *     diagnostics payload into the settings snapshot and the dialog
 *     renders the discovered-binary block.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createDefaultProviderProfileSettings,
  loadProviderProfileSettingsFromPrefs,
  providerProfileToDisclosure,
  saveProviderProfileSettingsToPrefs
} from "../../src/preferences/provider-profile.js";
import { applyPreset } from "../../src/preferences/preset-profiles.js";
import { providerDisclosure } from "../../src/ui/privacy-label.js";
import {
  createProxyLifecycle,
  type ProxyFetch,
  type SubprocessHandle,
  type SubprocessLike
} from "../../src/platform/proxy-lifecycle.js";
import { wireProxyLifecycle } from "../../src/platform/wire-proxy-lifecycle.js";
import { describeCodexFailure } from "../../scripts/llm-proxy/backends/codex.mjs";
import { describeClaudeFailure } from "../../scripts/llm-proxy/backends/claude.mjs";
import { enrichEnvironmentPath, findBinary } from "../../scripts/llm-proxy/path-discovery.mjs";
import { renderSettingsView, updateProxyStatus } from "../../src/ui/settings-view.js";
import type { StringPrefReader, StringPrefWriter } from "../../src/preferences/ollama-profile.js";

/**
 * In-memory pref store that satisfies both reader and writer contracts.
 * Used in place of Zotero.Prefs so tests prove the save→read path that
 * the live plugin actually uses.
 */
function memPrefs(): {
  readonly reader: StringPrefReader;
  readonly writer: StringPrefWriter;
  readonly store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    reader: {
      get: (name) => store.get(name)
    },
    writer: {
      set: (name, value) => {
        store.set(name, value);
      },
      clear: (name) => {
        store.delete(name);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Bug A1 + A2 — popup label reflects active provider via real prefs path
// ---------------------------------------------------------------------------

describe("popup label tracks active chat provider through the real pref path (Bug A1 + A2)", () => {
  // Regression: bootstrap captured `profile` from `loadOllamaSettings()`
  // at startup. The disclosure call site fed that startup snapshot into
  // a `(profile) => string` formatter, so a user who changed the chat
  // provider in settings (which writes prefs) and then triggered a
  // popup got the OLD provider's label — even though the request itself
  // routed correctly (the chat adapter reads live prefs via a closure).
  //
  // The fix moved the formatter to `() => string` and built the
  // disclosure via `providerProfileToDisclosure(readProviderProfile())`.
  // This integration test exercises the full path:
  //
  //     write codex preset → load prefs → providerProfileToDisclosure
  //                                      → providerDisclosure → string
  //
  // and asserts each leg.

  it("after applyPreset('codex-proxy') + save, the disclosure NEVER mentions Ollama", () => {
    const { reader, writer } = memPrefs();
    // Seed with the onboarding default the user had on disk before
    // they hit the bug (gemma4:e2b is the literal in
    // `src/ui/onboarding-view.ts:42`).
    const seeded = {
      ...createDefaultProviderProfileSettings(),
      ollama: {
        ...createDefaultProviderProfileSettings().ollama,
        chatModel: "gemma4:e2b"
      }
    };
    saveProviderProfileSettingsToPrefs(writer, seeded);

    // User switches to the Codex preset via the dropdown.
    const afterPreset = applyPreset("codex-proxy", loadProviderProfileSettingsFromPrefs(reader));
    saveProviderProfileSettingsToPrefs(writer, afterPreset);

    const live = loadProviderProfileSettingsFromPrefs(reader);
    const fields = providerProfileToDisclosure(live);
    const label = providerDisclosure(fields);

    expect(live.chatProvider).toBe("codex-cli");
    expect(label).not.toMatch(/Ollama/u);
    expect(label).toContain("Codex Proxy");
    expect(label).toContain("gpt-5-codex");
    expect(label).toContain("sent to"); // remote wording
  });

  it("changing the chat-model pref alone updates the label on the next read (no stale snapshot)", () => {
    const { reader, writer } = memPrefs();
    saveProviderProfileSettingsToPrefs(
      writer,
      applyPreset("codex-proxy", createDefaultProviderProfileSettings())
    );

    const labelBefore = providerDisclosure(
      providerProfileToDisclosure(loadProviderProfileSettingsFromPrefs(reader))
    );
    expect(labelBefore).toContain("gpt-5-codex");

    // User edits the chat-model field directly to "gpt-5.5" (one of the
    // codex-recognized aliases) and clicks save. The dialog wires this
    // through `saveProviderProfileSettingsToPrefs`.
    const next = loadProviderProfileSettingsFromPrefs(reader);
    saveProviderProfileSettingsToPrefs(writer, {
      ...next,
      ollama: { ...next.ollama, chatModel: "gpt-5.5" }
    });

    const labelAfter = providerDisclosure(
      providerProfileToDisclosure(loadProviderProfileSettingsFromPrefs(reader))
    );
    expect(labelAfter).toContain("gpt-5.5");
    expect(labelAfter).toContain("Codex Proxy");
    expect(labelAfter).not.toBe(labelBefore);
  });

  it("toggling preset across every chatProvider kind never leaks Ollama into a non-ollama label", () => {
    const { reader, writer } = memPrefs();
    const presets = ["codex-proxy", "claude-proxy", "openai-direct", "anthropic-direct"] as const;
    const expectedDisplay: Record<(typeof presets)[number], string> = {
      "codex-proxy": "Codex Proxy",
      "claude-proxy": "Claude Proxy",
      "openai-direct": "OpenAI",
      "anthropic-direct": "Anthropic"
    };
    for (const preset of presets) {
      saveProviderProfileSettingsToPrefs(
        writer,
        applyPreset(preset, loadProviderProfileSettingsFromPrefs(reader))
      );
      const live = loadProviderProfileSettingsFromPrefs(reader);
      const label = providerDisclosure(providerProfileToDisclosure(live));
      expect(label).toContain(expectedDisplay[preset]);
      expect(label).not.toMatch(/Ollama/u);
    }
    // And the round-trip back to local-ollama puts Ollama back.
    saveProviderProfileSettingsToPrefs(
      writer,
      applyPreset("local-ollama", loadProviderProfileSettingsFromPrefs(reader))
    );
    const localLabel = providerDisclosure(
      providerProfileToDisclosure(loadProviderProfileSettingsFromPrefs(reader))
    );
    expect(localLabel).toContain("Ollama");
    expect(localLabel).toContain("processed locally"); // local wording
  });
});

// ---------------------------------------------------------------------------
// Bug B1 — probe-before-spawn through wire layer + UI
// ---------------------------------------------------------------------------

function neverWaitsChild(pid: number): SubprocessHandle {
  return {
    pid,
    wait: () =>
      new Promise<{ readonly exitCode: number | null }>(() => {
        // pending forever; tests release explicitly when they need an exit
      }),
    kill: () => undefined
  };
}

function recordingSubprocess(): {
  readonly subprocess: SubprocessLike;
  readonly spawns: number;
} {
  let spawns = 0;
  const subprocess: SubprocessLike = {
    call: vi.fn(() => {
      spawns += 1;
      return Promise.resolve(neverWaitsChild(1000 + spawns));
    })
  };
  return {
    subprocess,
    get spawns() {
      return spawns;
    }
  };
}

describe("orphan proxy on :PORT skips spawn and surfaces in the UI (Bug B1)", () => {
  it("end-to-end: a foreign /api/tags responder causes externallyManaged=true and the Stop button is disabled", async () => {
    // Stage 1: simulate the user's exact dev-machine state — port
    // already responding to /api/tags. The lifecycle MUST detect this
    // and skip the spawn rather than EADDRINUSE-crash a second copy.
    const sub = recordingSubprocess();
    const probe: ProxyFetch = () => Promise.resolve({ ok: true, status: 200 });
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      fetch: probe
    });

    const result = await wired.start();
    expect(result).toEqual({ external: true });
    expect(sub.spawns).toBe(0); // critical — never spawned
    expect(wired.snapshot().externallyManaged).toBe(true);
    expect(wired.snapshot().running).toBe(true);

    // Stage 2: render the settings dialog with this snapshot and prove
    // the user sees the right thing — pill says "External", Stop is
    // disabled, the hint message explains why.
    const view = renderSettingsView({
      settings: {
        baseUrl: "http://localhost:11434",
        chatBaseUrl: "http://localhost:11434",
        embedBaseUrl: "http://localhost:11434",
        chatModel: "gpt-5-codex",
        embeddingModel: "embeddinggemma",
        localOnly: true
      },
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      proxy: {
        running: wired.snapshot().running,
        port: wired.snapshot().port,
        nodeBinaryPath: wired.snapshot().nodeBinaryPath,
        serverScriptPath: wired.snapshot().serverScriptPath,
        externallyManaged: wired.snapshot().externallyManaged
      }
    });
    const pill = view.querySelector<HTMLElement>('[data-role="proxy-status"]');
    const stop = view.querySelector<HTMLButtonElement>('[data-action="stop-proxy"]');
    expect(pill?.textContent).toBe("External on :11400");
    expect(stop?.disabled).toBe(true);
  });

  it("when the foreign process disappears, the next start() spawns afresh (no zombie state)", async () => {
    const sub = recordingSubprocess();
    let probeOk = true;
    const probe: ProxyFetch = () => Promise.resolve({ ok: probeOk, status: probeOk ? 200 : 404 });
    const lifecycle = createProxyLifecycle({
      subprocess: sub.subprocess,
      nodeBinaryPath: "/fake/node",
      serverScriptPath: "/fake/server.mjs",
      port: 11400,
      probeTimeoutMs: 50,
      stopGracePeriodMs: 0,
      fetch: probe
    });
    expect(await lifecycle.start()).toEqual({ external: true });
    await lifecycle.stop(); // clears the externally-managed flag
    probeOk = false;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(await lifecycle.start()).toEqual({ pid: expect.any(Number) });
    expect(lifecycle.isExternallyManaged()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bug B2 — codex CLI failure surfaces an actionable message, not -1
// ---------------------------------------------------------------------------

describe("codex/claude spawn failure is reported with an actionable message (Bug B2)", () => {
  it("ENOENT becomes a helpful install / PROXY_CODEX_BIN message", () => {
    // The pre-fix behavior surfaced "codex exited with code -1" with
    // no further detail. The new code path through describeCodexFailure
    // turns ENOENT into something the user can act on.
    const detail = describeCodexFailure({
      spawnError: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
      stderr: "",
      exitCode: -1,
      codexCommand: "codex"
    });
    expect(detail).toMatch(/codex CLI not found/u);
    expect(detail).toMatch(/PROXY_CODEX_BIN/u);
    // Crucial: the message must NOT contain the misleading "exited
    // with code -1" wording that originally confused the user.
    expect(detail).not.toMatch(/exited with code -1/u);
  });

  it("claude CLI ENOENT mirrors the same shape (no cross-CLI confusion)", () => {
    const detail = describeClaudeFailure({
      spawnError: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
      stderr: "",
      exitCode: -1,
      claudeCommand: "claude"
    });
    expect(detail).toMatch(/claude CLI not found/u);
    expect(detail).toMatch(/PROXY_CLAUDE_BIN/u);
    expect(detail).not.toContain("codex"); // never leak the wrong CLI name
  });

  it("with stderr present, the message reports what codex actually printed (not the ENOENT path)", () => {
    // Distinct from the ENOENT case: codex actually ran and exited
    // non-zero (e.g. invalid API key). The user must see codex's own
    // stderr, not the install hint.
    const detail = describeCodexFailure({
      spawnError: null,
      stderr: "Error: invalid API key",
      exitCode: 1,
      codexCommand: "/opt/homebrew/bin/codex"
    });
    expect(detail).toBe("Error: invalid API key");
    expect(detail).not.toMatch(/not found/u);
    expect(detail).not.toMatch(/PROXY_CODEX_BIN/u);
  });
});

// ---------------------------------------------------------------------------
// Bug B2 — login-shell PATH enrichment makes findBinary("codex") succeed
// even when the parent env is Zotero's stripped GUI-app PATH.
// ---------------------------------------------------------------------------

describe("PATH discovery rescues the Zotero GUI-app PATH (Bug B2)", () => {
  it("after enrichEnvironmentPath() from a stripped PATH, findBinary('codex') resolves to the discovered prefix", async () => {
    // Simulate the exact Mac Zotero startup environment.
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      SHELL: "/bin/zsh"
    };
    const enrichment = await enrichEnvironmentPath({
      env,
      platform: "darwin",
      // Pretend the user's `/bin/zsh -lc 'printf "%s" "$PATH"'` printed a
      // homebrew-aware PATH.
      discover: () => Promise.resolve("/opt/homebrew/bin:/usr/local/bin:/usr/bin")
    });
    expect(enrichment.source).toBe("shell");
    expect(env.PATH).toContain("/opt/homebrew/bin");

    // Now findBinary should resolve codex through the enriched PATH.
    const lookup = findBinary("codex", {
      env,
      isExecutable: (p: string) => p === "/opt/homebrew/bin/codex",
      platform: "darwin"
    });
    expect(lookup.path).toBe("/opt/homebrew/bin/codex");
  });

  it("when shell discovery fails, the fallback list still rescues a Homebrew install", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/zsh"
    };
    const enrichment = await enrichEnvironmentPath({
      env,
      platform: "darwin",
      // Simulate a broken .zshrc — shell exits with no output.
      discover: () => Promise.resolve(null),
      // Only /opt/homebrew/bin exists on this fake disk.
      exists: (p: string) => p === "/opt/homebrew/bin"
    });
    expect(enrichment.source).toBe("fallback");
    expect(env.PATH).toContain("/opt/homebrew/bin");
    const lookup = findBinary("codex", {
      env,
      isExecutable: (p: string) => p === "/opt/homebrew/bin/codex",
      platform: "darwin"
    });
    expect(lookup.path).toBe("/opt/homebrew/bin/codex");
  });
});

// ---------------------------------------------------------------------------
// Bug B2 — diagnostics propagate from wire layer through the settings UI.
// ---------------------------------------------------------------------------

describe("/api/diagnostics flows through wire-proxy-lifecycle into the settings UI (Bug B2)", () => {
  it("a 'codex missing, claude found' diagnostics payload paints both binary rows correctly", async () => {
    const sub = recordingSubprocess();
    const diagnosticsBody = {
      binaries: {
        codex: { path: null, searchedCount: 2 },
        claude: { path: "/opt/homebrew/bin/claude" }
      },
      path: {
        enrichment: {
          source: "shell" as const,
          shellUsed: "/bin/zsh",
          addedCount: 1
        }
      }
    };
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      diagnosticsFetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(diagnosticsBody)
        })
    });

    await wired.start();
    expect(wired.snapshot().diagnostics).toEqual(diagnosticsBody);

    // Render the dialog from the snapshot and assert the user-visible
    // surface. This is the assertion the original bug was missing —
    // "the proxy is alive but codex is unfindable" needs to be
    // recoverable from inspecting the dialog.
    const snap = wired.snapshot();
    const view = renderSettingsView({
      settings: {
        baseUrl: "http://localhost:11434",
        chatBaseUrl: "http://localhost:11434",
        embedBaseUrl: "http://localhost:11434",
        chatModel: "gpt-5-codex",
        embeddingModel: "embeddinggemma",
        localOnly: true
      },
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      proxy: {
        running: snap.running,
        port: snap.port,
        nodeBinaryPath: snap.nodeBinaryPath,
        serverScriptPath: snap.serverScriptPath,
        ...(snap.diagnostics !== undefined ? { diagnostics: snap.diagnostics } : {})
      }
    });
    const codexRow = view.querySelector<HTMLElement>('[data-role="proxy-binary-codex"]');
    const claudeRow = view.querySelector<HTMLElement>('[data-role="proxy-binary-claude"]');
    const pathRow = view.querySelector<HTMLElement>('[data-role="proxy-path-source"]');
    expect(codexRow?.dataset.found).toBe("false");
    expect(codexRow?.textContent).toMatch(/not found/u);
    expect(codexRow?.textContent).toContain("PROXY_CODEX_BIN");
    expect(claudeRow?.dataset.found).toBe("true");
    expect(claudeRow?.textContent).toContain("/opt/homebrew/bin/claude");
    expect(pathRow?.textContent).toContain("/bin/zsh");
  });

  it("a snapshot update with new diagnostics replaces the rendered block in place (no stale rows)", () => {
    // The user starts the proxy, sees codex-not-found, sets
    // PROXY_CODEX_BIN, restarts. The second start's diagnostics replace
    // the first's block — assertion is on the post-update DOM.
    const view = renderSettingsView({
      settings: {
        baseUrl: "http://localhost:11434",
        chatBaseUrl: "http://localhost:11434",
        embedBaseUrl: "http://localhost:11434",
        chatModel: "gpt-5-codex",
        embeddingModel: "embeddinggemma",
        localOnly: true
      },
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      proxy: {
        running: true,
        port: 11400,
        nodeBinaryPath: "/usr/local/bin/node",
        serverScriptPath: "/abs/server.mjs",
        diagnostics: {
          binaries: {
            codex: { path: null, searchedCount: 1 },
            claude: { path: null, searchedCount: 1 }
          },
          path: { enrichment: null }
        }
      }
    });
    const codexRowBefore = view.querySelector<HTMLElement>('[data-role="proxy-binary-codex"]');
    expect(codexRowBefore?.dataset.found).toBe("false");

    updateProxyStatus(view, {
      running: true,
      port: 11400,
      diagnostics: {
        binaries: {
          codex: { path: "/custom/codex" },
          claude: { path: null, searchedCount: 1 }
        },
        path: { enrichment: null }
      }
    });
    const codexRowAfter = view.querySelector<HTMLElement>('[data-role="proxy-binary-codex"]');
    expect(codexRowAfter?.dataset.found).toBe("true");
    expect(codexRowAfter?.textContent).toContain("/custom/codex");
    // The DOM must contain exactly one diagnostics block — a buggy
    // update could append a second one and leave the stale rows visible.
    expect(view.querySelectorAll('[data-role="proxy-diagnostics"]').length).toBe(1);
  });

  it("clearing diagnostics on a subsequent stop removes the block entirely (no zombie rows)", () => {
    const view = renderSettingsView({
      settings: {
        baseUrl: "http://localhost:11434",
        chatBaseUrl: "http://localhost:11434",
        embedBaseUrl: "http://localhost:11434",
        chatModel: "gpt-5-codex",
        embeddingModel: "embeddinggemma",
        localOnly: true
      },
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      proxy: {
        running: true,
        port: 11400,
        nodeBinaryPath: "/usr/local/bin/node",
        serverScriptPath: "/abs/server.mjs",
        diagnostics: {
          binaries: {
            codex: { path: "/opt/homebrew/bin/codex" },
            claude: { path: "/opt/homebrew/bin/claude" }
          },
          path: { enrichment: null }
        }
      }
    });
    expect(view.querySelector('[data-role="proxy-diagnostics"]')).not.toBeNull();
    updateProxyStatus(view, { running: false, port: 11400 });
    expect(view.querySelector('[data-role="proxy-diagnostics"]')).toBeNull();
  });
});
