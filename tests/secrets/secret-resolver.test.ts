import { describe, expect, it } from "vitest";

import { createSecretResolver, redactSecrets } from "../../src/secrets/secret-resolver.js";

describe("createSecretResolver", () => {
  it("resolves environment variable references", async () => {
    const resolver = createSecretResolver({
      env: { PROVIDER_TOKEN_REF: "fixture-token" },
      credentialStore: new Map(),
      localFiles: new Map()
    });

    await expect(
      resolver.resolve({ kind: "environment", name: "PROVIDER_TOKEN_REF" })
    ).resolves.toBe("fixture-token");
  });

  it("redacts resolved secrets from messages", () => {
    expect(redactSecrets("failed with fixture-token token", ["fixture-token"])).toBe(
      "failed with [REDACTED] token"
    );
  });
});
