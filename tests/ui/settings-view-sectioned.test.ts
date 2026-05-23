/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";

import { createDefaultOllamaSettings } from "../../src/preferences/ollama-profile.js";
import type { DiscoveryResult } from "../../src/preferences/model-discovery.js";
import type { ProviderProfileSettings } from "../../src/preferences/provider-profile.js";
import {
  MODEL_DROPDOWN_CUSTOM,
  renderSettingsView,
  wireSettingsView
} from "../../src/ui/settings-view.js";

function profile(): ProviderProfileSettings {
  return {
    ollama: createDefaultOllamaSettings(),
    chatProvider: "ollama",
    embedProvider: "ollama",
    openaiApiKey: "",
    anthropicApiKey: "",
    geminiApiKey: ""
  };
}

function makeView(opts?: { initialProfile?: ProviderProfileSettings }): HTMLElement {
  const view = renderSettingsView({
    settings: createDefaultOllamaSettings(),
    indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
    providerProfile: opts?.initialProfile ?? profile()
  });
  document.body.append(view);
  return view;
}

describe("settings dialog — sectioned layout (Fix 6)", () => {
  it("renders Chat Backend section with heading and a blurb", () => {
    const view = makeView();
    const chat = view.querySelector(".zotero-ai-chat-section");
    expect(chat).not.toBeNull();
    expect(chat?.textContent).toContain("Chat Backend");
    // AC-19 trimmed the blurb to a single line; just assert it exists.
    const blurb = chat?.querySelector<HTMLParagraphElement>(".zotero-ai-chat-section__blurb");
    expect((blurb?.textContent ?? "").length).toBeGreaterThan(0);
  });

  it("renders Embedding Backend section with heading and a blurb", () => {
    const view = makeView();
    const embed = view.querySelector(".zotero-ai-embed-section");
    expect(embed).not.toBeNull();
    expect(embed?.textContent).toContain("Embedding Backend");
    const blurb = embed?.querySelector<HTMLParagraphElement>(".zotero-ai-embed-section__blurb");
    expect((blurb?.textContent ?? "").length).toBeGreaterThan(0);
  });

  it("renders Library Index section with heading and a blurb", () => {
    const view = makeView();
    const idx = view.querySelector(".zotero-ai-library-index");
    expect(idx).not.toBeNull();
    expect(idx?.textContent).toContain("Library Index");
    const blurb = idx?.querySelector<HTMLParagraphElement>(".zotero-ai-library-index__blurb");
    expect((blurb?.textContent ?? "").length).toBeGreaterThan(0);
  });

  it("Local LLM Proxy section uses the divider style when proxy state is supplied", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      providerProfile: profile(),
      proxy: {
        running: false,
        port: 11400,
        nodeBinaryPath: "/opt/homebrew/bin/node",
        serverScriptPath: "/srv.mjs"
      }
    });
    document.body.append(view);
    const section = view.querySelector<HTMLElement>(".zotero-ai-proxy");
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain("Local LLM Proxy");
    const style = section?.getAttribute("style") ?? "";
    expect(style).toMatch(/border-top:\s*1px solid/u);
    expect(style).toMatch(/padding-top:\s*12px/u);
  });

  it("every settings section uses border-top dividers, not text characters", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      providerProfile: profile(),
      proxy: {
        running: false,
        port: 11400,
        nodeBinaryPath: "/opt/homebrew/bin/node",
        serverScriptPath: "/srv.mjs"
      }
    });
    // No box-drawing line characters in the rendered text.
    expect(view.textContent).not.toMatch(/───/u);
    // Each dividing section carries a border-top inline style.
    const dividers = view.querySelectorAll(
      ".zotero-ai-chat-section, .zotero-ai-embed-section, .zotero-ai-library-index, .zotero-ai-proxy"
    );
    expect(dividers.length).toBeGreaterThanOrEqual(4);
    for (const section of Array.from(dividers)) {
      const style = section.getAttribute("style") ?? "";
      expect(style, section.className).toMatch(/border-top/u);
    }
  });
});

describe("settings dialog — preset dropdown (Fix 1)", () => {
  it("renders the preset selector at the top of the dialog", () => {
    const view = makeView();
    const preset = view.querySelector<HTMLSelectElement>('[name="preset"]');
    expect(preset).not.toBeNull();
    expect(preset?.tagName).toBe("SELECT");
    // Default is local-ollama which matches the bundled defaults.
    expect(preset?.value).toBe("local-ollama");
  });

  it("preset dropdown includes Custom as the trailing option", () => {
    const view = makeView();
    const preset = view.querySelector<HTMLSelectElement>('[name="preset"]');
    const options = Array.from(preset?.options ?? []).map((o) => o.value);
    expect(options[options.length - 1]).toBe("custom");
  });

  it("selecting a preset populates every URL / model / provider field below", () => {
    const view = makeView();
    wireSettingsView({
      view,
      validate: () => Promise.resolve({ ok: true as const }),
      onSave: vi.fn(),
      close: vi.fn(),
      flashMs: 0,
      setTimeout: (h) => {
        h();
        return 0;
      }
    });
    const preset = view.querySelector<HTMLSelectElement>('[name="preset"]');
    if (preset === null) throw new Error("missing preset");
    preset.value = "codex-proxy";
    preset.dispatchEvent(new Event("change", { bubbles: true }));

    const chatUrl = view.querySelector<HTMLInputElement>('[name="chatBaseUrl"]');
    const chatModel = view.querySelector<HTMLInputElement>('[name="chatModel"]');
    const chatProvider = view.querySelector<HTMLSelectElement>('[name="chatProvider"]');
    expect(chatUrl?.value).toBe("http://localhost:11400/codex");
    expect(chatModel?.value).toBe("gpt-5-codex");
    expect(chatProvider?.value).toBe("codex-cli");
    // Preset itself stays at codex-proxy (no shift to custom).
    expect(preset.value).toBe("codex-proxy");
  });

  it("manually editing a URL field after a preset shifts the preset to Custom", () => {
    const view = makeView();
    wireSettingsView({
      view,
      validate: () => Promise.resolve({ ok: true as const }),
      onSave: vi.fn(),
      close: vi.fn(),
      flashMs: 0,
      setTimeout: (h) => {
        h();
        return 0;
      }
    });
    const preset = view.querySelector<HTMLSelectElement>('[name="preset"]');
    if (preset === null) throw new Error("missing preset");
    expect(preset.value).toBe("local-ollama");
    const chatUrl = view.querySelector<HTMLInputElement>('[name="chatBaseUrl"]');
    if (chatUrl === null) throw new Error("missing chat url");
    chatUrl.value = "http://something:9999";
    chatUrl.dispatchEvent(new Event("input", { bubbles: true }));
    expect(preset.value).toBe("custom");
  });

  it("API-key edits do NOT shift the preset to Custom (key-independent)", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      providerProfile: {
        ollama: createDefaultOllamaSettings(),
        chatProvider: "codex-api",
        embedProvider: "openai",
        openaiApiKey: "",
        anthropicApiKey: "",
        geminiApiKey: ""
      }
    });
    document.body.append(view);
    wireSettingsView({
      view,
      validate: () => Promise.resolve({ ok: true as const }),
      onSave: vi.fn(),
      close: vi.fn(),
      flashMs: 0,
      setTimeout: (h) => {
        h();
        return 0;
      }
    });
    const preset = view.querySelector<HTMLSelectElement>('[name="preset"]');
    if (preset === null) throw new Error("missing preset");
    const initialPreset = preset.value;
    const key = view.querySelector<HTMLInputElement>('[name="openaiApiKey"]');
    if (key === null) throw new Error("missing key field");
    key.value = "sk-typed";
    key.dispatchEvent(new Event("input", { bubbles: true }));
    expect(preset.value).toBe(initialPreset);
  });
});

describe("settings dialog — model picker (Fix 2)", () => {
  it("renders model picker dropdown + Refresh button alongside chat/embed model fields", () => {
    const view = makeView();
    const chatPicker = view.querySelector(
      '[data-role="model-picker"][data-target-input="chatModel"]'
    );
    const embedPicker = view.querySelector(
      '[data-role="model-picker"][data-target-input="embeddingModel"]'
    );
    const chatRefresh = view.querySelector(
      '[data-action="refresh-models"][data-target-input="chatModel"]'
    );
    const embedRefresh = view.querySelector(
      '[data-action="refresh-models"][data-target-input="embeddingModel"]'
    );
    expect(chatPicker).not.toBeNull();
    expect(embedPicker).not.toBeNull();
    expect(chatRefresh).not.toBeNull();
    expect(embedRefresh).not.toBeNull();
  });

  it("triggers discovery on mount and populates the picker with returned models + Custom...", async () => {
    const view = makeView();
    const discover = vi.fn(() =>
      Promise.resolve<DiscoveryResult>({
        ok: true,
        models: ["gemma4:e4b", "llama3.2:3b"]
      })
    );
    wireSettingsView({
      view,
      validate: () => Promise.resolve({ ok: true as const }),
      onSave: vi.fn(),
      close: vi.fn(),
      flashMs: 0,
      setTimeout: (h) => {
        h();
        return 0;
      },
      modelDiscovery: {
        discover,
        debounceMs: 0,
        setTimeout: (h) => {
          h();
          return 0;
        },
        clearTimeout: () => undefined
      }
    });
    // Initial discovery fires once for chat AND once for embed.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(discover).toHaveBeenCalledTimes(2);
    const picker = view.querySelector<HTMLSelectElement>(
      '[data-role="model-picker"][data-target-input="chatModel"]'
    );
    const values = Array.from(picker?.options ?? []).map((o) => o.value);
    expect(values).toContain("gemma4:e4b");
    expect(values).toContain("llama3.2:3b");
    expect(values[values.length - 1]).toBe(MODEL_DROPDOWN_CUSTOM);
  });

  it("Refresh button re-fires discovery for the targeted field", async () => {
    const view = makeView();
    const discover = vi.fn(() => Promise.resolve<DiscoveryResult>({ ok: true, models: ["m1"] }));
    wireSettingsView({
      view,
      validate: () => Promise.resolve({ ok: true as const }),
      onSave: vi.fn(),
      close: vi.fn(),
      flashMs: 0,
      setTimeout: (h) => {
        h();
        return 0;
      },
      modelDiscovery: {
        discover,
        debounceMs: 0,
        setTimeout: (h) => {
          h();
          return 0;
        },
        clearTimeout: () => undefined
      }
    });
    await Promise.resolve();
    await Promise.resolve();
    discover.mockClear();
    const refresh = view.querySelector<HTMLButtonElement>(
      '[data-action="refresh-models"][data-target-input="chatModel"]'
    );
    refresh?.click();
    expect(discover).toHaveBeenCalledTimes(1);
    const lastCall = discover.mock.calls[0] as unknown as [{ target: string }];
    expect(lastCall[0].target).toBe("chatModel");
  });

  it("selecting a non-Custom option writes the value into the model input", async () => {
    const view = makeView();
    wireSettingsView({
      view,
      validate: () => Promise.resolve({ ok: true as const }),
      onSave: vi.fn(),
      close: vi.fn(),
      flashMs: 0,
      setTimeout: (h) => {
        h();
        return 0;
      },
      modelDiscovery: {
        discover: () => Promise.resolve<DiscoveryResult>({ ok: true, models: ["llama3.2:3b"] }),
        debounceMs: 0,
        setTimeout: (h) => {
          h();
          return 0;
        },
        clearTimeout: () => undefined
      }
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const picker = view.querySelector<HTMLSelectElement>(
      '[data-role="model-picker"][data-target-input="chatModel"]'
    );
    if (picker === null) throw new Error("missing picker");
    picker.value = "llama3.2:3b";
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    const input = view.querySelector<HTMLInputElement>('[name="chatModel"]');
    expect(input?.value).toBe("llama3.2:3b");
    // AC-22: picking a real model HIDES the custom input.
    expect(input?.hidden).toBe(true);
  });

  it("AC-22: the canonical model input is hidden by default and revealed on Custom...", () => {
    const view = makeView();
    const input = view.querySelector<HTMLInputElement>('[name="chatModel"]');
    expect(input).not.toBeNull();
    expect(input?.hidden).toBe(true);
  });

  it("AC-22: paintPicker reveals the custom input when the persisted value isn't in discovered models", async () => {
    const view = makeView();
    // The default settings ship a `chatModel` value; assert it's NOT
    // in the discovered list so we trigger the reveal path.
    const inputBeforeWiring = view.querySelector<HTMLInputElement>('[name="chatModel"]');
    const persisted = inputBeforeWiring?.value ?? "";
    expect(persisted.length).toBeGreaterThan(0);
    wireSettingsView({
      view,
      validate: () => Promise.resolve({ ok: true as const }),
      onSave: vi.fn(),
      close: vi.fn(),
      flashMs: 0,
      setTimeout: (h) => {
        h();
        return 0;
      },
      modelDiscovery: {
        discover: () =>
          Promise.resolve<DiscoveryResult>({
            ok: true,
            models: ["completely-different-model-name"]
          }),
        debounceMs: 0,
        setTimeout: (h) => {
          h();
          return 0;
        },
        clearTimeout: () => undefined
      }
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const picker = view.querySelector<HTMLSelectElement>(
      '[data-role="model-picker"][data-target-input="chatModel"]'
    );
    expect(picker?.value).toBe(MODEL_DROPDOWN_CUSTOM);
    const input = view.querySelector<HTMLInputElement>('[name="chatModel"]');
    expect(input?.hidden).toBe(false);
    // The canonical value is preserved so the user sees what they had.
    expect(input?.value).toBe(persisted);
  });

  it("selecting Custom... clears the input + lets the user type", async () => {
    const view = makeView();
    wireSettingsView({
      view,
      validate: () => Promise.resolve({ ok: true as const }),
      onSave: vi.fn(),
      close: vi.fn(),
      flashMs: 0,
      setTimeout: (h) => {
        h();
        return 0;
      },
      modelDiscovery: {
        discover: () => Promise.resolve<DiscoveryResult>({ ok: true, models: ["m1"] }),
        debounceMs: 0,
        setTimeout: (h) => {
          h();
          return 0;
        },
        clearTimeout: () => undefined
      }
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const picker = view.querySelector<HTMLSelectElement>(
      '[data-role="model-picker"][data-target-input="chatModel"]'
    );
    const input = view.querySelector<HTMLInputElement>('[name="chatModel"]');
    if (picker === null || input === null) throw new Error("missing picker");
    picker.value = MODEL_DROPDOWN_CUSTOM;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    expect(input.value).toBe("");
    // AC-22: Custom... reveals the input so the user can type a name.
    expect(input.hidden).toBe(false);
  });

  it("paints the error message when discovery returns ok=false", async () => {
    const view = makeView();
    wireSettingsView({
      view,
      validate: () => Promise.resolve({ ok: true as const }),
      onSave: vi.fn(),
      close: vi.fn(),
      flashMs: 0,
      setTimeout: (h) => {
        h();
        return 0;
      },
      modelDiscovery: {
        discover: () =>
          Promise.resolve<DiscoveryResult>({ ok: false, message: "Server unreachable" }),
        debounceMs: 0,
        setTimeout: (h) => {
          h();
          return 0;
        },
        clearTimeout: () => undefined
      }
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const picker = view.querySelector<HTMLSelectElement>(
      '[data-role="model-picker"][data-target-input="chatModel"]'
    );
    expect(picker?.textContent).toContain("Server unreachable");
    // Custom... is still offered even on failure so the user can type a name.
    const values = Array.from(picker?.options ?? []).map((o) => o.value);
    expect(values).toContain(MODEL_DROPDOWN_CUSTOM);
  });
});

describe("settings dialog — proxy section node-binary visibility (AC-20)", () => {
  it("AC-20: shows the Node binary path field with the resolved path prefilled even when detection succeeded", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      providerProfile: profile(),
      proxy: {
        running: false,
        port: 11400,
        nodeBinaryPath: "/opt/homebrew/bin/node",
        serverScriptPath: "/srv.mjs"
      }
    });
    document.body.append(view);
    const visible = view.querySelector('[data-field="proxyNodeBinaryPath"]');
    expect(visible).not.toBeNull();
    const input = view.querySelector<HTMLInputElement>('[name="proxyNodeBinaryPath"]');
    expect(input?.type).toBe("text");
    expect(input?.value).toBe("/opt/homebrew/bin/node");
    // No banner unless detection failed.
    // The banner stays in the DOM (so Detect handler can reveal it on
    // a later failure) but starts hidden when detection succeeded.
    const bannerOnSuccess = view.querySelector<HTMLElement>('[data-role="proxy-node-banner"]');
    expect(bannerOnSuccess).not.toBeNull();
    expect(bannerOnSuccess?.hidden).toBe(true);
  });

  it("AC-20: renders a Detect button next to the Node binary field", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      providerProfile: profile(),
      proxy: {
        running: false,
        port: 11400,
        nodeBinaryPath: "/opt/homebrew/bin/node",
        serverScriptPath: "/srv.mjs"
      }
    });
    document.body.append(view);
    const detect = view.querySelector<HTMLButtonElement>('[data-action="detect-node"]');
    expect(detect).not.toBeNull();
    expect(detect?.textContent).toBe("Detect");
  });

  it("reveals the Node binary path field with a banner when nodeAutoDetectFailed is true", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      providerProfile: profile(),
      proxy: {
        running: false,
        port: 11400,
        nodeBinaryPath: "node",
        serverScriptPath: "/srv.mjs",
        nodeAutoDetectFailed: true
      }
    });
    document.body.append(view);
    const visibleField = view.querySelector('[data-field="proxyNodeBinaryPath"]');
    expect(visibleField).not.toBeNull();
    const banner = view.querySelector('[data-role="proxy-node-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toMatch(/Node not found/u);
  });

  it("never renders a VISIBLE Server script path input — always hidden", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      providerProfile: profile(),
      proxy: {
        running: false,
        port: 11400,
        nodeBinaryPath: "/opt/homebrew/bin/node",
        serverScriptPath: "/abs/server.mjs"
      }
    });
    document.body.append(view);
    expect(view.querySelector('[data-field="proxyServerScriptPath"]')).toBeNull();
    const hidden = view.querySelector<HTMLInputElement>('[name="proxyServerScriptPath"]');
    expect(hidden?.type).toBe("hidden");
    expect(hidden?.value).toBe("/abs/server.mjs");
  });
});
