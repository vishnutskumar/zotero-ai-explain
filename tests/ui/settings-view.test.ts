/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";

import { createDefaultOllamaSettings } from "../../src/preferences/ollama-profile.js";
import {
  renderSettingsView,
  updateProxyStatus,
  wireSettingsView,
  type ProxyLifecycleCallbacks,
  type ProxySettingsFormValues,
  type ProxySettingsState,
  type SettingsValidator
} from "../../src/ui/settings-view.js";

describe("renderSettingsView", () => {
  it("renders Chat URL and Embedding URL inputs plus models and local-only disclosure", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: {
        state: "idle",
        totalItems: 0,
        indexedItems: 0,
        failedItems: 0
      }
    });

    expect(view.querySelector<HTMLInputElement>('[name="chatBaseUrl"]')?.value).toBe(
      "http://localhost:11434"
    );
    expect(view.querySelector<HTMLInputElement>('[name="embedBaseUrl"]')?.value).toBe(
      "http://localhost:11434"
    );
    expect(view.querySelector<HTMLInputElement>('[name="chatModel"]')?.value).toBe("gemma4:e4b");
    expect(view.querySelector<HTMLInputElement>('[name="embeddingModel"]')?.value).toBe(
      "embeddinggemma"
    );
    expect(view.textContent).toContain("Local only");
    // The "Library Index" section is always rendered with its action buttons.
    expect(view.textContent).toContain("Library Index");
  });

  it("keeps a hidden legacy baseUrl input mirroring the chat URL", () => {
    // The e2e driver scrapes `[name="baseUrl"]` for log output; the
    // hidden mirror keeps that pipeline intact even though the visible
    // form now exposes two separate URLs.
    const settings = {
      ...createDefaultOllamaSettings(),
      chatBaseUrl: "http://127.0.0.1:55555",
      embedBaseUrl: "http://other:11434"
    };
    const view = renderSettingsView({
      settings,
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 }
    });
    const legacy = view.querySelector<HTMLInputElement>('[name="baseUrl"]');
    expect(legacy).not.toBeNull();
    expect(legacy?.type).toBe("hidden");
    expect(legacy?.value).toBe("http://127.0.0.1:55555");
  });

  it("renders the four indexing action buttons unconditionally", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 }
    });

    expect(view.querySelector('[data-action="start-index"]')).not.toBeNull();
    expect(view.querySelector('[data-action="pause-index"]')).not.toBeNull();
    expect(view.querySelector('[data-action="resume-index"]')).not.toBeNull();
    expect(view.querySelector('[data-action="clear-index"]')).not.toBeNull();
  });

  it("never displays internal 'Phase 2' / 'not yet implemented' copy", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "running", totalItems: 5, indexedItems: 1, failedItems: 0 }
    });

    const text = view.textContent;
    expect(text).not.toMatch(/phase\s*2/iu);
    expect(text).not.toMatch(/not yet implemented/iu);
  });

  it("renders a Save (primary) button and a Cancel button", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 }
    });
    const save = view.querySelector<HTMLButtonElement>('[data-action="save-settings"]');
    const cancel = view.querySelector<HTMLButtonElement>('[data-action="cancel-settings"]');
    expect(save).not.toBeNull();
    expect(cancel).not.toBeNull();
    expect(save?.textContent).toBe("Save");
    expect(cancel?.textContent).toBe("Cancel");
  });

  it("renders an inline error placeholder per editable field", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 }
    });
    expect(view.querySelector('[data-error-for="chatBaseUrl"]')).not.toBeNull();
    expect(view.querySelector('[data-error-for="embedBaseUrl"]')).not.toBeNull();
    expect(view.querySelector('[data-error-for="chatModel"]')).not.toBeNull();
    expect(view.querySelector('[data-error-for="embeddingModel"]')).not.toBeNull();
  });

  it("omits the proxy section when not configured", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 }
    });
    expect(view.querySelector('[data-action="start-proxy"]')).toBeNull();
    expect(view.querySelector('[data-action="stop-proxy"]')).toBeNull();
    expect(view.querySelector('[data-role="proxy-status"]')).toBeNull();
  });

  it("renders the proxy section when proxy state is supplied", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      proxy: {
        running: false,
        port: 11400,
        nodeBinaryPath: "/usr/local/bin/node",
        serverScriptPath: "/abs/path/to/server.mjs"
      }
    });
    const pill = view.querySelector<HTMLElement>('[data-role="proxy-status"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe("Not running");
    expect(pill?.dataset.running).toBe("false");
    const start = view.querySelector<HTMLButtonElement>('[data-action="start-proxy"]');
    const stop = view.querySelector<HTMLButtonElement>('[data-action="stop-proxy"]');
    expect(start?.disabled).toBe(false);
    expect(stop?.disabled).toBe(true);
    expect(view.querySelector<HTMLInputElement>('[name="proxyNodeBinaryPath"]')?.value).toBe(
      "/usr/local/bin/node"
    );
    expect(view.querySelector<HTMLInputElement>('[name="proxyServerScriptPath"]')?.value).toBe(
      "/abs/path/to/server.mjs"
    );
    expect(view.querySelector<HTMLInputElement>('[name="proxyPort"]')?.value).toBe("11400");
  });

  it("disables Start and enables Stop when the proxy is running", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      proxy: {
        running: true,
        port: 11400,
        nodeBinaryPath: "/usr/local/bin/node",
        serverScriptPath: "/abs/path/server.mjs"
      }
    });
    const start = view.querySelector<HTMLButtonElement>('[data-action="start-proxy"]');
    const stop = view.querySelector<HTMLButtonElement>('[data-action="stop-proxy"]');
    expect(start?.disabled).toBe(true);
    expect(stop?.disabled).toBe(false);
    expect(view.querySelector<HTMLElement>('[data-role="proxy-status"]')?.textContent).toBe(
      "Running on :11400"
    );
  });

  it("renders the diagnostics block with a found codex and missing claude (Bug B2)", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      proxy: {
        running: true,
        port: 11400,
        nodeBinaryPath: "/usr/local/bin/node",
        serverScriptPath: "/abs/path/server.mjs",
        diagnostics: {
          binaries: {
            codex: { path: "/opt/homebrew/bin/codex" },
            claude: { path: null, searchedCount: 2 }
          },
          path: {
            enrichment: {
              source: "shell",
              shellUsed: "/bin/zsh",
              addedCount: 1
            }
          }
        }
      }
    });
    const codexRow = view.querySelector<HTMLElement>('[data-role="proxy-binary-codex"]');
    const claudeRow = view.querySelector<HTMLElement>('[data-role="proxy-binary-claude"]');
    const pathRow = view.querySelector<HTMLElement>('[data-role="proxy-path-source"]');
    expect(codexRow?.dataset.found).toBe("true");
    expect(codexRow?.textContent).toContain("/opt/homebrew/bin/codex");
    expect(claudeRow?.dataset.found).toBe("false");
    expect(claudeRow?.textContent).toMatch(/not found/u);
    expect(claudeRow?.textContent).toContain("PROXY_CLAUDE_BIN");
    expect(claudeRow?.textContent).toMatch(/Searched 2 directories/u);
    // The trimmed response (codex review #2) does NOT include the
    // searched paths — assert we don't leak $HOME via the row.
    expect(claudeRow?.textContent).not.toContain("/usr/bin/claude");
    expect(pathRow?.textContent).toContain("/bin/zsh");
  });

  it("hides the diagnostics block when no diagnostics are supplied", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      proxy: {
        running: false,
        port: 11400,
        nodeBinaryPath: "/usr/local/bin/node",
        serverScriptPath: "/abs/path/server.mjs"
      }
    });
    expect(view.querySelector('[data-role="proxy-diagnostics"]')).toBeNull();
  });

  it("renders 'External on :PORT' and disables Stop when the proxy is externally managed (Bug B1)", () => {
    // When the lifecycle skipped its spawn because someone else was
    // already serving the port (orphan proxy, manual `npm run proxy:llm`),
    // the snapshot carries externallyManaged=true. The Stop button must
    // be disabled because the plugin cannot kill a process it did not
    // spawn. The pill label must distinguish this state from a normal
    // "Running on :PORT" so the user knows the situation.
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      proxy: {
        running: true,
        port: 11400,
        nodeBinaryPath: "/usr/local/bin/node",
        serverScriptPath: "/abs/path/server.mjs",
        externallyManaged: true
      }
    });
    const pill = view.querySelector<HTMLElement>('[data-role="proxy-status"]');
    const start = view.querySelector<HTMLButtonElement>('[data-action="start-proxy"]');
    const stop = view.querySelector<HTMLButtonElement>('[data-action="stop-proxy"]');
    const message = view.querySelector<HTMLElement>('[data-role="proxy-message"]');
    expect(pill?.textContent).toBe("External on :11400");
    expect(pill?.dataset.externallyManaged).toBe("true");
    expect(start?.disabled).toBe(true);
    expect(stop?.disabled).toBe(true);
    expect(message?.textContent).toContain("Another process is already serving this port");
  });
});

// ---------------------------------------------------------------------------
// wireSettingsView — Save/Cancel/validation behavior
// ---------------------------------------------------------------------------

type Wired = {
  view: HTMLElement;
  validate: ReturnType<typeof vi.fn>;
  onSave: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  flush: () => Promise<void>;
};

function mountWired(options?: {
  validate?: SettingsValidator;
  initial?: ReturnType<typeof createDefaultOllamaSettings>;
}): Wired {
  const initial = options?.initial ?? createDefaultOllamaSettings();
  const view = renderSettingsView({
    settings: initial,
    indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 }
  });
  document.body.append(view);
  const validate = vi.fn(options?.validate ?? (async () => Promise.resolve({ ok: true as const })));
  const onSave = vi.fn();
  const close = vi.fn();
  wireSettingsView({
    view,
    validate,
    onSave,
    close,
    flashMs: 0,
    setTimeout: (handler) => {
      // Synchronous flush so tests don't depend on real timers.
      handler();
      return 0;
    }
  });
  return {
    view,
    validate,
    onSave,
    close,
    async flush() {
      // Drain the microtask queue so async validate() resolves.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}

describe("wireSettingsView Save flow", () => {
  it("invokes onSave with the typed chat + embed URLs when validation passes", async () => {
    const w = mountWired();
    const chatUrl = w.view.querySelector<HTMLInputElement>('[name="chatBaseUrl"]');
    const embedUrl = w.view.querySelector<HTMLInputElement>('[name="embedBaseUrl"]');
    const chat = w.view.querySelector<HTMLInputElement>('[name="chatModel"]');
    const embed = w.view.querySelector<HTMLInputElement>('[name="embeddingModel"]');
    if (chatUrl) chatUrl.value = "http://localhost:55555";
    if (embedUrl) embedUrl.value = "http://localhost:11434";
    if (chat) chat.value = "gemma4:e2b";
    if (embed) embed.value = "nomic-embed-text";

    w.view.querySelector<HTMLButtonElement>('[data-action="save-settings"]')?.click();
    await w.flush();

    expect(w.validate).toHaveBeenCalledTimes(1);
    expect(w.validate.mock.calls[0]?.[0]).toEqual({
      chatBaseUrl: "http://localhost:55555",
      embedBaseUrl: "http://localhost:11434",
      chatModel: "gemma4:e2b",
      embeddingModel: "nomic-embed-text"
    });
    expect(w.onSave).toHaveBeenCalledTimes(1);
    expect(w.onSave.mock.calls[0]?.[0]).toEqual({
      chatBaseUrl: "http://localhost:55555",
      embedBaseUrl: "http://localhost:11434",
      chatModel: "gemma4:e2b",
      embeddingModel: "nomic-embed-text"
    });
    expect(w.close).toHaveBeenCalledTimes(1);
    // Legacy hidden mirror must reflect the chat URL the user just saved.
    const legacy = w.view.querySelector<HTMLInputElement>('[name="baseUrl"]');
    expect(legacy?.value).toBe("http://localhost:55555");
  });

  it("flashes 'Saved' before closing", async () => {
    let closeCalled = false;
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 }
    });
    document.body.append(view);
    // Latch what the status text looked like at the moment close() ran.
    let statusAtClose = "";
    const status = view.querySelector<HTMLElement>('[data-role="status"]');
    wireSettingsView({
      view,
      validate: async () => Promise.resolve({ ok: true as const }),
      onSave: vi.fn(),
      close: () => {
        statusAtClose = status?.textContent ?? "";
        closeCalled = true;
      },
      flashMs: 50,
      setTimeout: (handler) => {
        handler();
        return 0;
      }
    });
    view.querySelector<HTMLButtonElement>('[data-action="save-settings"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(closeCalled).toBe(true);
    expect(statusAtClose).toBe("Saved");
  });

  it("renders the inline error and keeps the dialog open when validation fails", async () => {
    const w = mountWired({
      validate: async () =>
        Promise.resolve({
          ok: false as const,
          errors: [
            {
              field: "chatModel" as const,
              message: 'Model "gemma4:e4b" is not available at the chat URL.'
            }
          ]
        })
    });
    w.view.querySelector<HTMLButtonElement>('[data-action="save-settings"]')?.click();
    await w.flush();

    const errEl = w.view.querySelector<HTMLElement>('[data-error-for="chatModel"]');
    expect(errEl).not.toBeNull();
    expect(errEl?.hidden).toBe(false);
    expect(errEl?.textContent).toContain("gemma4:e4b");
    expect(w.onSave).not.toHaveBeenCalled();
    expect(w.close).not.toHaveBeenCalled();
  });

  it("re-enables the Save button after a validation failure so the user can retry", async () => {
    const w = mountWired({
      validate: async () =>
        Promise.resolve({
          ok: false as const,
          errors: [{ field: "chatBaseUrl" as const, message: "Cannot reach chat URL." }]
        })
    });
    const save = w.view.querySelector<HTMLButtonElement>('[data-action="save-settings"]');
    save?.click();
    await w.flush();
    expect(save?.disabled).toBe(false);
  });

  it("shows the global error inline when validate() throws", async () => {
    const w = mountWired({
      validate: () => Promise.reject(new Error("network is down"))
    });
    w.view.querySelector<HTMLButtonElement>('[data-action="save-settings"]')?.click();
    await w.flush();
    const status = w.view.querySelector<HTMLElement>('[data-role="status"]');
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toContain("network is down");
    expect(w.close).not.toHaveBeenCalled();
  });

  it("clears the inline error as soon as the user edits the field", async () => {
    const w = mountWired({
      validate: async () =>
        Promise.resolve({
          ok: false as const,
          errors: [{ field: "chatModel" as const, message: "bad model" }]
        })
    });
    w.view.querySelector<HTMLButtonElement>('[data-action="save-settings"]')?.click();
    await w.flush();
    const errEl = w.view.querySelector<HTMLElement>('[data-error-for="chatModel"]');
    expect(errEl?.hidden).toBe(false);

    const chat = w.view.querySelector<HTMLInputElement>('[name="chatModel"]');
    if (chat) {
      chat.value = "gemma4:e2b";
      chat.dispatchEvent(new Event("input", { bubbles: true }));
    }
    expect(errEl?.hidden).toBe(true);
  });

  it("flags empty required URL fields without calling validate (no network round-trip)", async () => {
    const w = mountWired();
    const chatUrl = w.view.querySelector<HTMLInputElement>('[name="chatBaseUrl"]');
    const embedUrl = w.view.querySelector<HTMLInputElement>('[name="embedBaseUrl"]');
    if (chatUrl) chatUrl.value = "";
    if (embedUrl) embedUrl.value = "";
    w.view.querySelector<HTMLButtonElement>('[data-action="save-settings"]')?.click();
    await w.flush();

    expect(w.view.querySelector<HTMLElement>('[data-error-for="chatBaseUrl"]')?.hidden).toBe(false);
    expect(w.view.querySelector<HTMLElement>('[data-error-for="embedBaseUrl"]')?.hidden).toBe(
      false
    );
    expect(w.validate).not.toHaveBeenCalled();
    expect(w.onSave).not.toHaveBeenCalled();
  });
});

describe("wireSettingsView Cancel flow", () => {
  it("invokes close() and never calls onSave or validate", () => {
    const w = mountWired();
    w.view.querySelector<HTMLButtonElement>('[data-action="cancel-settings"]')?.click();
    expect(w.close).toHaveBeenCalledTimes(1);
    expect(w.onSave).not.toHaveBeenCalled();
    expect(w.validate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Proxy section wiring
// ---------------------------------------------------------------------------

describe("wireSettingsView proxy lifecycle", () => {
  function mountWithProxy(state: ProxySettingsState, proxy: ProxyLifecycleCallbacks) {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      proxy: state
    });
    document.body.append(view);
    wireSettingsView({
      view,
      validate: async () => Promise.resolve({ ok: true as const }),
      onSave: vi.fn(),
      close: vi.fn(),
      flashMs: 0,
      setTimeout: (handler) => {
        handler();
        return 0;
      },
      proxy
    });
    return view;
  }

  it("calls proxy.start with values read from the live form when Start is clicked", async () => {
    // Codex review #4: the click handler no longer optimistically
    // flips the status pill — the authoritative state arrives via
    // wire-proxy-lifecycle's onStateChange → updateProxyStatus push.
    // This test now simulates that push and asserts the pill matches
    // (mirrors the real production flow rather than a brittle local
    // overwrite).
    const calls: ProxySettingsFormValues[] = [];
    const start = vi.fn(async (values: ProxySettingsFormValues): Promise<void> => {
      calls.push(values);
      return Promise.resolve();
    });
    const stop = vi.fn(async () => Promise.resolve());
    const readValues = vi.fn(() => ({
      nodeBinaryPath: "/usr/local/bin/node",
      serverScriptPath: "/abs/server.mjs",
      port: 11400
    }));
    const view = mountWithProxy(
      {
        running: false,
        port: 11400,
        nodeBinaryPath: "/usr/local/bin/node",
        serverScriptPath: "/abs/server.mjs"
      },
      { start, stop, readValues }
    );
    // User edits port in the form before clicking Start.
    const portInput = view.querySelector<HTMLInputElement>('[name="proxyPort"]');
    if (portInput) portInput.value = "11500";

    view.querySelector<HTMLButtonElement>('[data-action="start-proxy"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual({
      nodeBinaryPath: "/usr/local/bin/node",
      serverScriptPath: "/abs/server.mjs",
      port: 11500
    });
    // Simulate the wire layer's onStateChange push — production calls
    // updateProxyStatus after the spawn completes. The pill is the
    // surface the user sees; assert it reflects the pushed state.
    updateProxyStatus(view, { running: true, port: 11500 });
    const pill = view.querySelector<HTMLElement>('[data-role="proxy-status"]');
    expect(pill?.dataset.running).toBe("true");
    expect(pill?.textContent).toBe("Running on :11500");
  });

  it("calls proxy.stop when Stop is clicked and flips status to not running", async () => {
    const stop = vi.fn(async () => Promise.resolve());
    const view = mountWithProxy(
      {
        running: true,
        port: 11400,
        nodeBinaryPath: "/usr/local/bin/node",
        serverScriptPath: "/abs/server.mjs"
      },
      {
        start: vi.fn(async () => Promise.resolve()),
        stop,
        readValues: () => ({
          nodeBinaryPath: "/usr/local/bin/node",
          serverScriptPath: "/abs/server.mjs",
          port: 11400
        })
      }
    );
    view.querySelector<HTMLButtonElement>('[data-action="stop-proxy"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(stop).toHaveBeenCalledTimes(1);
    // Same as above — wire layer pushes state after stop resolves.
    updateProxyStatus(view, { running: false, port: 11400 });
    const pill = view.querySelector<HTMLElement>('[data-role="proxy-status"]');
    expect(pill?.dataset.running).toBe("false");
    expect(pill?.textContent).toBe("Not running");
  });

  it("does not optimistically flip an external proxy to plugin-managed when Start is clicked (codex review #4)", async () => {
    // Regression: when an external process is already serving the port,
    // wireProxyLifecycle's start() returns { external: true } and the
    // onStateChange push carries externallyManaged=true. The click
    // handler USED to overwrite that with `running:true` and the Stop
    // button briefly looked re-enabled. With the optimistic overwrite
    // removed, the authoritative external snapshot stands.
    const start = vi.fn(async () => Promise.resolve());
    const stop = vi.fn(async () => Promise.resolve());
    const view = mountWithProxy(
      {
        running: false,
        port: 11400,
        nodeBinaryPath: "/usr/local/bin/node",
        serverScriptPath: "/abs/server.mjs"
      },
      {
        start,
        stop,
        readValues: () => ({
          nodeBinaryPath: "/usr/local/bin/node",
          serverScriptPath: "/abs/server.mjs",
          port: 11400
        })
      }
    );
    view.querySelector<HTMLButtonElement>('[data-action="start-proxy"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    // Wire layer pushes the authoritative external snapshot AFTER
    // start() resolves. The pill paints "External", Stop stays
    // disabled. Pre-fix, the click handler's `running:true` overwrite
    // would have temporarily painted "Running" with Stop enabled.
    updateProxyStatus(view, { running: true, port: 11400, externallyManaged: true });
    const pill = view.querySelector<HTMLElement>('[data-role="proxy-status"]');
    const stopBtn = view.querySelector<HTMLButtonElement>('[data-action="stop-proxy"]');
    expect(pill?.textContent).toBe("External on :11400");
    expect(stopBtn?.disabled).toBe(true);
  });

  it("surfaces start errors in the proxy message element", async () => {
    const start = vi.fn(() => Promise.reject(new Error("Node not found")));
    const view = mountWithProxy(
      {
        running: false,
        port: 11400,
        nodeBinaryPath: "",
        serverScriptPath: ""
      },
      {
        start,
        stop: vi.fn(async () => Promise.resolve()),
        readValues: () => ({
          nodeBinaryPath: "",
          serverScriptPath: "",
          port: 11400
        })
      }
    );
    view.querySelector<HTMLButtonElement>('[data-action="start-proxy"]')?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const message = view.querySelector<HTMLElement>('[data-role="proxy-message"]');
    expect(message?.textContent).toContain("Node not found");
    const pill = view.querySelector<HTMLElement>('[data-role="proxy-status"]');
    expect(pill?.dataset.running).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// Phase 4 direct-API: provider selectors + API-key inputs
// ---------------------------------------------------------------------------

describe("renderSettingsView providerProfile section", () => {
  it("does not render provider section when providerProfile is omitted (legacy callers)", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 }
    });
    expect(view.querySelector('[name="chatProvider"]')).toBeNull();
    expect(view.querySelector('[name="embedProvider"]')).toBeNull();
    expect(view.querySelector('[name="openaiApiKey"]')).toBeNull();
  });

  it("renders chat + embed selectors and three password fields when providerProfile is supplied", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      providerProfile: {
        ollama: createDefaultOllamaSettings(),
        chatProvider: "ollama",
        embedProvider: "ollama",
        openaiApiKey: "",
        anthropicApiKey: "",
        geminiApiKey: ""
      }
    });
    const chat = view.querySelector<HTMLSelectElement>('[name="chatProvider"]');
    const embed = view.querySelector<HTMLSelectElement>('[name="embedProvider"]');
    expect(chat).not.toBeNull();
    expect(embed).not.toBeNull();
    expect(chat?.value).toBe("ollama");
    expect(embed?.value).toBe("ollama");
    expect(view.querySelector<HTMLInputElement>('[name="openaiApiKey"]')?.type).toBe("password");
    expect(view.querySelector<HTMLInputElement>('[name="anthropicApiKey"]')?.type).toBe("password");
    expect(view.querySelector<HTMLInputElement>('[name="geminiApiKey"]')?.type).toBe("password");
  });

  it("hides API key rows when no provider needs them (default ollama+ollama)", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      providerProfile: {
        ollama: createDefaultOllamaSettings(),
        chatProvider: "ollama",
        embedProvider: "ollama",
        openaiApiKey: "",
        anthropicApiKey: "",
        geminiApiKey: ""
      }
    });
    expect(view.querySelector<HTMLElement>('[data-provider-key-for="openai"]')?.hidden).toBe(true);
    expect(view.querySelector<HTMLElement>('[data-provider-key-for="anthropic"]')?.hidden).toBe(
      true
    );
    expect(view.querySelector<HTMLElement>('[data-provider-key-for="gemini"]')?.hidden).toBe(true);
  });

  it("shows the OpenAI key row when chat provider is codex-api", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      providerProfile: {
        ollama: createDefaultOllamaSettings(),
        chatProvider: "codex-api",
        embedProvider: "ollama",
        openaiApiKey: "sk-test",
        anthropicApiKey: "",
        geminiApiKey: ""
      }
    });
    expect(view.querySelector<HTMLElement>('[data-provider-key-for="openai"]')?.hidden).toBe(false);
    expect(view.querySelector<HTMLElement>('[data-provider-key-for="anthropic"]')?.hidden).toBe(
      true
    );
    expect(view.querySelector<HTMLInputElement>('[name="openaiApiKey"]')?.value).toBe("sk-test");
  });

  it("shows Anthropic key row when chat provider is claude-api", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      providerProfile: {
        ollama: createDefaultOllamaSettings(),
        chatProvider: "claude-api",
        embedProvider: "ollama",
        openaiApiKey: "",
        anthropicApiKey: "sk-ant",
        geminiApiKey: ""
      }
    });
    expect(view.querySelector<HTMLElement>('[data-provider-key-for="anthropic"]')?.hidden).toBe(
      false
    );
    expect(view.querySelector<HTMLInputElement>('[name="anthropicApiKey"]')?.value).toBe("sk-ant");
  });

  it("shows the Gemini key row when embed provider is gemini", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      providerProfile: {
        ollama: createDefaultOllamaSettings(),
        chatProvider: "ollama",
        embedProvider: "gemini",
        openaiApiKey: "",
        anthropicApiKey: "",
        geminiApiKey: "gem-key"
      }
    });
    expect(view.querySelector<HTMLElement>('[data-provider-key-for="gemini"]')?.hidden).toBe(false);
  });

  it("renders the Local LLM Proxy section ABOVE the chat/embed dropdowns (sectioned layout)", () => {
    // When the proxy isn't running, the chat-model dropdown reads "not
    // available" — users who hadn't realised they needed to start the
    // proxy first kept submitting bugs about it. Anchoring Start/Stop at
    // the top of the dialog makes the dependency obvious. This test
    // pins the order so we don't quietly regress it again.
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      providerProfile: {
        ollama: createDefaultOllamaSettings(),
        chatProvider: "ollama",
        embedProvider: "ollama",
        openaiApiKey: "",
        anthropicApiKey: "",
        geminiApiKey: ""
      },
      proxy: {
        running: false,
        port: 11400,
        nodeBinaryPath: "/usr/local/bin/node",
        serverScriptPath: "/abs/server.mjs"
      }
    });
    const proxySection = view.querySelector<HTMLElement>(".zotero-ai-proxy");
    const chatHeading = Array.from(view.querySelectorAll("h3")).find(
      (h) => h.textContent === "Chat Backend"
    );
    const embedHeading = Array.from(view.querySelectorAll("h3")).find(
      (h) => h.textContent === "Embedding Backend"
    );
    if (proxySection === null) throw new Error("expected proxy section in sectioned layout");
    if (chatHeading === undefined) throw new Error("expected Chat Backend heading");
    if (embedHeading === undefined) throw new Error("expected Embedding Backend heading");
    // DOCUMENT_POSITION_FOLLOWING = 4 when the argument follows the receiver
    // in document order.
    expect(proxySection.compareDocumentPosition(chatHeading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(proxySection.compareDocumentPosition(embedHeading)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("warns the user that API keys are stored locally in plain text", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      providerProfile: {
        ollama: createDefaultOllamaSettings(),
        chatProvider: "ollama",
        embedProvider: "ollama",
        openaiApiKey: "",
        anthropicApiKey: "",
        geminiApiKey: ""
      }
    });
    const warning = view.querySelector<HTMLElement>(".zotero-ai-providers__warning");
    expect(warning?.textContent ?? "").toMatch(/plain text/iu);
  });
});

describe("updateProxyStatus", () => {
  it("updates the rendered pill and button states out of band", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      proxy: {
        running: false,
        port: 11400,
        nodeBinaryPath: "/usr/local/bin/node",
        serverScriptPath: "/abs/server.mjs"
      }
    });
    updateProxyStatus(view, { running: true, port: 11401, message: "auto-restarted" });
    const pill = view.querySelector<HTMLElement>('[data-role="proxy-status"]');
    expect(pill?.dataset.running).toBe("true");
    expect(pill?.textContent).toBe("Running on :11401");
    const message = view.querySelector<HTMLElement>('[data-role="proxy-message"]');
    expect(message?.textContent).toBe("auto-restarted");
    expect(message?.hidden).toBe(false);
    expect(view.querySelector<HTMLButtonElement>('[data-action="start-proxy"]')?.disabled).toBe(
      true
    );
    expect(view.querySelector<HTMLButtonElement>('[data-action="stop-proxy"]')?.disabled).toBe(
      false
    );
  });
});
