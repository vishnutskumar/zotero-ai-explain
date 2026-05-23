/**
 * Tests for the provider-profile preferences module.
 *
 * Coverage:
 *   T1  defaults select Ollama for both chat and embed.
 *   T2  loadProviderProfileSettingsFromPrefs reads chat-provider, embed-provider, and API keys.
 *   T3  unknown chat-provider strings fall back to "ollama" (forward-compat).
 *   T4  saveProviderProfileSettingsToPrefs writes all 5 new prefs + ollama prefs.
 *   T5  chatApiKeyFor returns null for local providers, the key for API providers.
 *   T6  embedApiKeyFor mirrors the embed selection.
 *   T7  chatProviderIsUrlBased / embedProviderIsUrlBased predicates match.
 *   T8  empty / whitespace API keys round-trip as "" (treated as absent).
 *   T9  write+read round-trip preserves all settings.
 */

import { describe, expect, it } from "vitest";

import { createDefaultOllamaSettings } from "../../src/preferences/ollama-profile.js";
import type { StringPrefReader, StringPrefWriter } from "../../src/preferences/ollama-profile.js";
import {
  ANTHROPIC_API_KEY_PREF,
  CHAT_PROVIDER_PREF,
  EMBED_PROVIDER_PREF,
  GEMINI_API_KEY_PREF,
  OPENAI_API_KEY_PREF,
  chatApiKeyFor,
  chatProviderIsUrlBased,
  createDefaultProviderProfileSettings,
  embedApiKeyFor,
  embedProviderIsUrlBased,
  loadProviderProfileSettingsFromPrefs,
  providerProfileToDisclosure,
  saveProviderProfileSettingsToPrefs,
  type ProviderProfileSettings
} from "../../src/preferences/provider-profile.js";

function prefsFrom(values: Record<string, string | undefined>): StringPrefReader {
  return {
    get(name) {
      return values[name];
    }
  };
}

describe("provider-profile defaults", () => {
  it("T1: defaults to ollama for chat and embed; empty API keys", () => {
    const defaults = createDefaultProviderProfileSettings();
    expect(defaults.chatProvider).toBe("ollama");
    expect(defaults.embedProvider).toBe("ollama");
    expect(defaults.openaiApiKey).toBe("");
    expect(defaults.anthropicApiKey).toBe("");
    expect(defaults.geminiApiKey).toBe("");
    expect(defaults.ollama).toEqual(createDefaultOllamaSettings());
  });
});

describe("loadProviderProfileSettingsFromPrefs", () => {
  it("T2: reads chat-provider, embed-provider, and API keys", () => {
    const settings = loadProviderProfileSettingsFromPrefs(
      prefsFrom({
        [CHAT_PROVIDER_PREF]: "codex-api",
        [EMBED_PROVIDER_PREF]: "openai",
        [OPENAI_API_KEY_PREF]: "sk-openai",
        [ANTHROPIC_API_KEY_PREF]: "sk-ant",
        [GEMINI_API_KEY_PREF]: "gem-key"
      })
    );
    expect(settings.chatProvider).toBe("codex-api");
    expect(settings.embedProvider).toBe("openai");
    expect(settings.openaiApiKey).toBe("sk-openai");
    expect(settings.anthropicApiKey).toBe("sk-ant");
    expect(settings.geminiApiKey).toBe("gem-key");
  });

  it("T3: unknown chat-provider falls back to `ollama`", () => {
    const settings = loadProviderProfileSettingsFromPrefs(
      prefsFrom({
        [CHAT_PROVIDER_PREF]: "future-mystery-provider"
      })
    );
    expect(settings.chatProvider).toBe("ollama");
  });

  it("T3b: unknown embed-provider falls back to `ollama`", () => {
    const settings = loadProviderProfileSettingsFromPrefs(
      prefsFrom({
        [EMBED_PROVIDER_PREF]: "voyage"
      })
    );
    expect(settings.embedProvider).toBe("ollama");
  });

  it('T8: empty / whitespace API keys treated as absent (`""`)', () => {
    const settings = loadProviderProfileSettingsFromPrefs(
      prefsFrom({
        [OPENAI_API_KEY_PREF]: "   ",
        [ANTHROPIC_API_KEY_PREF]: "",
        [GEMINI_API_KEY_PREF]: "\t\n"
      })
    );
    expect(settings.openaiApiKey).toBe("");
    expect(settings.anthropicApiKey).toBe("");
    expect(settings.geminiApiKey).toBe("");
  });

  it("treats reader exceptions as missing prefs", () => {
    const settings = loadProviderProfileSettingsFromPrefs({
      get: () => {
        throw new Error("pref backend unavailable");
      }
    });
    expect(settings.chatProvider).toBe("ollama");
    expect(settings.embedProvider).toBe("ollama");
  });
});

describe("saveProviderProfileSettingsToPrefs", () => {
  function makeWriter(): { writer: StringPrefWriter; writes: Record<string, string> } {
    const writes: Record<string, string> = {};
    return {
      writes,
      writer: {
        set(name, value) {
          writes[name] = value;
        }
      }
    };
  }

  it("T4: writes all chat/embed/API-key prefs alongside ollama prefs", () => {
    const { writer, writes } = makeWriter();
    const settings: ProviderProfileSettings = {
      ...createDefaultProviderProfileSettings(),
      chatProvider: "claude-api",
      embedProvider: "gemini",
      openaiApiKey: "sk-openai",
      anthropicApiKey: "sk-ant",
      geminiApiKey: "gem-key"
    };
    saveProviderProfileSettingsToPrefs(writer, settings);
    expect(writes[CHAT_PROVIDER_PREF]).toBe("claude-api");
    expect(writes[EMBED_PROVIDER_PREF]).toBe("gemini");
    expect(writes[OPENAI_API_KEY_PREF]).toBe("sk-openai");
    expect(writes[ANTHROPIC_API_KEY_PREF]).toBe("sk-ant");
    expect(writes[GEMINI_API_KEY_PREF]).toBe("gem-key");
    // Ollama URL prefs should ALSO be written (the writer delegates).
    expect(writes["extensions.zotero-ai-explain.chat-base-url"]).toBe("http://localhost:11434");
  });

  it("T9: write+read round-trips every field", () => {
    const store = new Map<string, string>();
    const writer: StringPrefWriter = {
      set(name, value) {
        store.set(name, value);
      }
    };
    const reader: StringPrefReader = {
      get(name) {
        return store.get(name);
      }
    };
    const original: ProviderProfileSettings = {
      ...createDefaultProviderProfileSettings(),
      chatProvider: "codex-api",
      embedProvider: "openai",
      openaiApiKey: "sk-openai",
      anthropicApiKey: "sk-ant",
      geminiApiKey: "gem-key"
    };
    saveProviderProfileSettingsToPrefs(writer, original);
    const loaded = loadProviderProfileSettingsFromPrefs(reader);
    expect(loaded).toEqual(original);
  });
});

describe("chatApiKeyFor / embedApiKeyFor", () => {
  const base = createDefaultProviderProfileSettings();

  it("T5: chatApiKeyFor returns null for local providers", () => {
    expect(chatApiKeyFor({ ...base, chatProvider: "ollama" })).toBeNull();
    expect(chatApiKeyFor({ ...base, chatProvider: "codex-cli" })).toBeNull();
    expect(chatApiKeyFor({ ...base, chatProvider: "claude-cli" })).toBeNull();
  });

  it("T5b: chatApiKeyFor returns the OpenAI key for codex-api when set", () => {
    expect(chatApiKeyFor({ ...base, chatProvider: "codex-api", openaiApiKey: "sk-x" })).toBe(
      "sk-x"
    );
    expect(chatApiKeyFor({ ...base, chatProvider: "codex-api", openaiApiKey: "" })).toBeNull();
  });

  it("T5c: chatApiKeyFor returns the Anthropic key for claude-api when set", () => {
    expect(chatApiKeyFor({ ...base, chatProvider: "claude-api", anthropicApiKey: "sk-y" })).toBe(
      "sk-y"
    );
  });

  it("T6: embedApiKeyFor mirrors selection", () => {
    expect(embedApiKeyFor({ ...base, embedProvider: "ollama" })).toBeNull();
    expect(embedApiKeyFor({ ...base, embedProvider: "openai", openaiApiKey: "sk-x" })).toBe("sk-x");
    expect(embedApiKeyFor({ ...base, embedProvider: "gemini", geminiApiKey: "gem-x" })).toBe(
      "gem-x"
    );
  });
});

describe("chatProviderIsUrlBased / embedProviderIsUrlBased", () => {
  it("T7: chat URL-based for ollama / codex-cli / claude-cli, not for API kinds", () => {
    expect(chatProviderIsUrlBased("ollama")).toBe(true);
    expect(chatProviderIsUrlBased("codex-cli")).toBe(true);
    expect(chatProviderIsUrlBased("claude-cli")).toBe(true);
    expect(chatProviderIsUrlBased("codex-api")).toBe(false);
    expect(chatProviderIsUrlBased("claude-api")).toBe(false);
  });

  it("T7b: embed URL-based only for ollama", () => {
    expect(embedProviderIsUrlBased("ollama")).toBe(true);
    expect(embedProviderIsUrlBased("openai")).toBe(false);
    expect(embedProviderIsUrlBased("gemini")).toBe(false);
  });
});

describe("providerProfileToDisclosure", () => {
  function build(overrides: Partial<ProviderProfileSettings> = {}): ProviderProfileSettings {
    const base = createDefaultProviderProfileSettings();
    return {
      ...base,
      ...overrides,
      ollama: { ...base.ollama, ...(overrides.ollama ?? {}) }
    };
  }

  it("T8a: ollama renders as local 'Ollama' with the configured chat model", () => {
    const disclosure = providerProfileToDisclosure(
      build({
        chatProvider: "ollama",
        ollama: { ...createDefaultOllamaSettings(), chatModel: "gemma4:e2b" }
      })
    );
    expect(disclosure).toEqual({ displayName: "Ollama", model: "gemma4:e2b", sendMode: "local" });
  });

  it("T8b: codex-cli renders as remote 'Codex Proxy' with the active chat model", () => {
    const disclosure = providerProfileToDisclosure(
      build({
        chatProvider: "codex-cli",
        ollama: { ...createDefaultOllamaSettings(), chatModel: "gpt-5-codex" }
      })
    );
    expect(disclosure).toEqual({
      displayName: "Codex Proxy",
      model: "gpt-5-codex",
      sendMode: "remote"
    });
  });

  it("T8c: claude-cli renders as remote 'Claude Proxy'", () => {
    const disclosure = providerProfileToDisclosure(
      build({
        chatProvider: "claude-cli",
        ollama: { ...createDefaultOllamaSettings(), chatModel: "claude-sonnet-4-5" }
      })
    );
    expect(disclosure).toEqual({
      displayName: "Claude Proxy",
      model: "claude-sonnet-4-5",
      sendMode: "remote"
    });
  });

  it("T8d: codex-api renders as remote 'OpenAI'", () => {
    const disclosure = providerProfileToDisclosure(
      build({
        chatProvider: "codex-api",
        ollama: { ...createDefaultOllamaSettings(), chatModel: "gpt-4o-mini" }
      })
    );
    expect(disclosure).toEqual({
      displayName: "OpenAI",
      model: "gpt-4o-mini",
      sendMode: "remote"
    });
  });

  it("T8e: claude-api renders as remote 'Anthropic'", () => {
    const disclosure = providerProfileToDisclosure(
      build({
        chatProvider: "claude-api",
        ollama: { ...createDefaultOllamaSettings(), chatModel: "claude-sonnet-4-5" }
      })
    );
    expect(disclosure).toEqual({
      displayName: "Anthropic",
      model: "claude-sonnet-4-5",
      sendMode: "remote"
    });
  });

  it("T8f: regression — never returns 'Ollama' when the active chat provider is not ollama", () => {
    const nonOllama: readonly ProviderProfileSettings["chatProvider"][] = [
      "codex-cli",
      "claude-cli",
      "codex-api",
      "claude-api"
    ];
    for (const chatProvider of nonOllama) {
      const disclosure = providerProfileToDisclosure(build({ chatProvider }));
      expect(disclosure.displayName).not.toBe("Ollama");
    }
  });
});
