import { describe, expect, it } from "vitest";

import {
  createDefaultOllamaSettings,
  ollamaSettingsToProfile
} from "../../src/preferences/ollama-profile.js";

describe("ollama profile defaults", () => {
  it("creates a local-only Ollama profile", () => {
    const settings = createDefaultOllamaSettings();

    expect(settings).toEqual({
      baseUrl: "http://localhost:11434",
      chatModel: "gemma4:e4b",
      embeddingModel: "embeddinggemma",
      localOnly: true
    });

    expect(ollamaSettingsToProfile(settings)).toEqual({
      id: "ollama",
      displayName: "Ollama",
      kind: "ollama",
      baseUrl: "http://localhost:11434",
      model: "gemma4:e4b",
      secret: { kind: "none" },
      sendMode: "local",
      enabled: true
    });
  });
});
