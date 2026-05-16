import { describe, expect, it } from "vitest";

import { createProviderProfileStore } from "../../src/preferences/provider-profile-store.js";

describe("createProviderProfileStore", () => {
  it("stores provider profiles without resolving or serializing secret values", () => {
    const memory = new Map<string, string>();
    const store = createProviderProfileStore({
      get: (key) => memory.get(key) ?? null,
      set: (key, value) => memory.set(key, value)
    });

    store.saveAll([
      {
        id: "openai",
        displayName: "OpenAI",
        kind: "openai-responses",
        baseUrl: null,
        model: "gpt-test",
        secret: { kind: "environment", name: "PROVIDER_TOKEN_REF" },
        sendMode: "remote",
        enabled: true
      }
    ]);

    expect(memory.get("providers")).toContain("PROVIDER_TOKEN_REF");
    expect(memory.get("providers")).not.toContain("fixture-token");
  });
});
