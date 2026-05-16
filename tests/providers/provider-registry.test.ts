import { describe, expect, it } from "vitest";

import { createProviderRegistry } from "../../src/providers/provider-registry.js";
import type { ModelProvider, ProviderProfile } from "../../src/providers/provider-types.js";

const profile = (kind: ProviderProfile["kind"], id = kind): ProviderProfile => ({
  id,
  displayName: id,
  kind,
  baseUrl:
    kind === "openai-responses" || kind === "anthropic" || kind === "gemini"
      ? null
      : "http://localhost:11434",
  model: "test-model",
  secret: { kind: "none" },
  sendMode: kind === "openai-compatible" || kind === "ollama" ? "local" : "remote",
  enabled: true
});

const provider = (id: string): ModelProvider => ({
  id,
  displayName: id,
  async *streamChat() {
    await Promise.resolve();
    yield { type: "message_start", providerId: id, model: "test-model" };
    yield { type: "message_end" };
  }
});

describe("createProviderRegistry", () => {
  it("resolves every required provider family", () => {
    const registry = createProviderRegistry([
      provider("ollama"),
      provider("openai-responses"),
      provider("openai-compatible"),
      provider("anthropic"),
      provider("gemini"),
      provider("custom-http"),
      provider("local-agent-bridge")
    ]);

    for (const kind of [
      "ollama",
      "openai-responses",
      "openai-compatible",
      "anthropic",
      "gemini",
      "custom-http",
      "local-agent-bridge"
    ] as const) {
      expect(registry.resolve(profile(kind)).id).toBe(kind);
    }
  });

  it("rejects disabled profiles before resolving an adapter", () => {
    const registry = createProviderRegistry([provider("openai-compatible")]);

    expect(() => registry.resolve({ ...profile("openai-compatible"), enabled: false })).toThrow(
      "Provider profile is disabled."
    );
  });
});
