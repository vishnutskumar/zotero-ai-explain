import { describe, expect, it } from "vitest";

import { validateProviderProfile } from "../../src/preferences/provider-profile-validation.js";

describe("validateProviderProfile", () => {
  it("accepts local OpenAI-compatible profiles without a secret", () => {
    expect(
      validateProviderProfile({
        id: "ollama",
        displayName: "Ollama",
        kind: "openai-compatible",
        baseUrl: "http://localhost:11434",
        model: "llama3",
        secret: { kind: "none" },
        sendMode: "local",
        enabled: true
      })
    ).toEqual({ ok: true });
  });

  it("requires a base URL for custom HTTP providers", () => {
    expect(
      validateProviderProfile({
        id: "custom",
        displayName: "Custom",
        kind: "custom-http",
        baseUrl: null,
        model: "x",
        secret: { kind: "none" },
        sendMode: "remote",
        enabled: true
      })
    ).toEqual({ ok: false, reason: "custom-http providers require a base URL." });
  });

  it("accepts local Ollama profiles without a secret", () => {
    expect(
      validateProviderProfile({
        id: "ollama",
        displayName: "Ollama",
        kind: "ollama",
        baseUrl: "http://localhost:11434",
        model: "llama3.1",
        secret: { kind: "none" },
        sendMode: "local",
        enabled: true
      })
    ).toEqual({ ok: true });
  });
});
