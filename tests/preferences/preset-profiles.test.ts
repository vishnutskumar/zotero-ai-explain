import { describe, expect, it } from "vitest";

import { createDefaultOllamaSettings } from "../../src/preferences/ollama-profile.js";
import {
  PRESET_DESCRIPTORS,
  PRESET_MODELS,
  PRESET_URLS,
  applyPreset,
  detectPreset
} from "../../src/preferences/preset-profiles.js";
import type { ProviderProfileSettings } from "../../src/preferences/provider-profile.js";

function makeProfile(): ProviderProfileSettings {
  return {
    ollama: createDefaultOllamaSettings(),
    chatProvider: "ollama",
    embedProvider: "ollama",
    openaiApiKey: "",
    anthropicApiKey: "",
    geminiApiKey: ""
  };
}

describe("PRESET_DESCRIPTORS", () => {
  it("exposes every documented preset id and the trailing 'custom' fallback", () => {
    const ids = PRESET_DESCRIPTORS.map((d) => d.id);
    expect(ids).toEqual([
      "local-ollama",
      "codex-proxy",
      "claude-proxy",
      "openai-direct",
      "anthropic-direct",
      "custom"
    ]);
  });

  it("every preset descriptor carries a non-empty label and hint", () => {
    for (const d of PRESET_DESCRIPTORS) {
      expect(d.label.length, `label for ${d.id}`).toBeGreaterThan(0);
      expect(d.hint.length, `hint for ${d.id}`).toBeGreaterThan(0);
    }
  });
});

describe("applyPreset", () => {
  it("custom preset is a pass-through (no fields mutated)", () => {
    const input = {
      ...makeProfile(),
      ollama: {
        ...createDefaultOllamaSettings(),
        chatBaseUrl: "http://my:1234",
        chatModel: "weird-model"
      }
    };
    const result = applyPreset("custom", input);
    expect(result).toEqual(input);
    // Object identity preserved so callers can detect a no-op.
    expect(result).toBe(input);
  });

  it("local-ollama preset routes both URLs at localhost and selects ollama providers", () => {
    const input = makeProfile();
    const result = applyPreset("local-ollama", input);
    expect(result.chatProvider).toBe("ollama");
    expect(result.embedProvider).toBe("ollama");
    expect(result.ollama.chatBaseUrl).toBe(PRESET_URLS.ollama);
    expect(result.ollama.embedBaseUrl).toBe(PRESET_URLS.ollama);
    expect(result.ollama.chatModel).toBe(PRESET_MODELS.ollamaChat);
    expect(result.ollama.embeddingModel).toBe(PRESET_MODELS.ollamaEmbed);
  });

  it("codex-proxy preset selects codex-cli + proxy URL, embed stays on Ollama", () => {
    const result = applyPreset("codex-proxy", makeProfile());
    expect(result.chatProvider).toBe("codex-cli");
    expect(result.embedProvider).toBe("ollama");
    expect(result.ollama.chatBaseUrl).toBe(PRESET_URLS.proxyCodex);
    expect(result.ollama.embedBaseUrl).toBe(PRESET_URLS.ollama);
    expect(result.ollama.chatModel).toBe(PRESET_MODELS.codex);
  });

  it("claude-proxy preset selects claude-cli + proxy URL", () => {
    const result = applyPreset("claude-proxy", makeProfile());
    expect(result.chatProvider).toBe("claude-cli");
    expect(result.embedProvider).toBe("ollama");
    expect(result.ollama.chatBaseUrl).toBe(PRESET_URLS.proxyClaude);
    expect(result.ollama.chatModel).toBe(PRESET_MODELS.claude);
  });

  it("openai-direct preset uses canonical OpenAI host for both chat + embed", () => {
    const result = applyPreset("openai-direct", makeProfile());
    expect(result.chatProvider).toBe("codex-api");
    expect(result.embedProvider).toBe("openai");
    expect(result.ollama.chatBaseUrl).toBe(PRESET_URLS.openai);
    expect(result.ollama.embedBaseUrl).toBe(PRESET_URLS.openai);
    expect(result.ollama.chatModel).toBe(PRESET_MODELS.openaiChat);
    expect(result.ollama.embeddingModel).toBe(PRESET_MODELS.openaiEmbed);
  });

  it("anthropic-direct preset uses Anthropic chat + Ollama embed (Anthropic has no embed API)", () => {
    const result = applyPreset("anthropic-direct", makeProfile());
    expect(result.chatProvider).toBe("claude-api");
    expect(result.embedProvider).toBe("ollama");
    expect(result.ollama.chatBaseUrl).toBe(PRESET_URLS.anthropic);
    expect(result.ollama.embedBaseUrl).toBe(PRESET_URLS.ollama);
  });

  it("preserves API keys across preset application", () => {
    const input: ProviderProfileSettings = {
      ...makeProfile(),
      openaiApiKey: "sk-test-openai",
      anthropicApiKey: "sk-ant-test",
      geminiApiKey: "gem-test"
    };
    for (const preset of [
      "local-ollama",
      "codex-proxy",
      "claude-proxy",
      "openai-direct",
      "anthropic-direct"
    ] as const) {
      const result = applyPreset(preset, input);
      expect(result.openaiApiKey, preset).toBe("sk-test-openai");
      expect(result.anthropicApiKey, preset).toBe("sk-ant-test");
      expect(result.geminiApiKey, preset).toBe("gem-test");
    }
  });
});

describe("detectPreset", () => {
  it("returns 'local-ollama' for the bundled defaults", () => {
    const id = detectPreset(applyPreset("local-ollama", makeProfile()));
    expect(id).toBe("local-ollama");
  });

  it("returns 'custom' when chat URL diverges from any preset", () => {
    const input = applyPreset("local-ollama", makeProfile());
    const mutated: ProviderProfileSettings = {
      ...input,
      ollama: {
        ...input.ollama,
        chatBaseUrl: "http://nonstandard:9999"
      }
    };
    expect(detectPreset(mutated)).toBe("custom");
  });

  it("round-trips every non-custom preset back to itself", () => {
    for (const preset of [
      "local-ollama",
      "codex-proxy",
      "claude-proxy",
      "openai-direct",
      "anthropic-direct"
    ] as const) {
      const applied = applyPreset(preset, makeProfile());
      expect(detectPreset(applied), preset).toBe(preset);
    }
  });

  it("ignores API keys — different keys still detect the same preset", () => {
    const base = applyPreset("openai-direct", makeProfile());
    const withKey: ProviderProfileSettings = { ...base, openaiApiKey: "sk-different" };
    expect(detectPreset(withKey)).toBe("openai-direct");
  });
});
