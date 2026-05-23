/**
 * Adversarial tests for `createOpenAIEmbedProvider`.
 *
 * Coverage:
 *   T1  decodes the canonical {data: [{embedding: [...]}]} shape.
 *   T2  throws when no API key configured (does not fire fetch).
 *   T3  sends Bearer auth + correct model + input fields.
 *   T4  throws a diagnostic on 401 (auth failure).
 *   T5  throws on 429 / rate limit.
 *   T6  throws when the response doesn't include `data`.
 *   T7  throws on non-numeric vector entries.
 *   T8  throws on dimension mismatch when expectedDimensions is set.
 *   T9  returns [] when `texts` is empty without firing fetch.
 *   T10 surfaces non-JSON body as a diagnostic.
 */

import { describe, expect, it, vi } from "vitest";

import { createOpenAIEmbedProvider } from "../../../src/providers/adapters/openai-embed.js";

describe("createOpenAIEmbedProvider", () => {
  it("T1: decodes embeddings from {data: [{embedding: [...]}]}", async () => {
    const provider = createOpenAIEmbedProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(
          JSON.stringify({
            data: [
              { embedding: [0.1, 0.2, 0.3], index: 0 },
              { embedding: [0.4, 0.5, 0.6], index: 1 }
            ]
          })
        );
      },
      getApiKey: () => "sk-test"
    });
    const result = await provider.embedTexts({
      baseUrl: "ignored",
      model: "text-embedding-3-small",
      texts: ["a", "b"],
      signal: new AbortController().signal
    });
    expect(result).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6]
    ]);
  });

  it("T2: throws when no API key (no fetch)", async () => {
    const fetchSpy = vi.fn();
    const provider = createOpenAIEmbedProvider({
      fetch: fetchSpy as never,
      getApiKey: () => null
    });
    await expect(
      provider.embedTexts({
        baseUrl: "ignored",
        model: "text-embedding-3-small",
        texts: ["a"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/api key/iu);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("T3: sends Bearer auth + correct body", async () => {
    const seenInit = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () => {
      await Promise.resolve();
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }));
    });
    const provider = createOpenAIEmbedProvider({
      fetch: seenInit,
      getApiKey: () => "sk-real"
    });
    await provider.embedTexts({
      baseUrl: "ignored",
      model: "text-embedding-3-large",
      texts: ["only one"],
      signal: new AbortController().signal
    });
    expect(seenInit.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/embeddings");
    const headers = (seenInit.mock.calls[0]?.[1].headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-real");
    const body = JSON.parse(seenInit.mock.calls[0]?.[1].body as string) as Record<string, unknown>;
    expect(body.model).toBe("text-embedding-3-large");
    expect(body.input).toEqual(["only one"]);
  });

  it("T4: throws a diagnostic on 401", async () => {
    const provider = createOpenAIEmbedProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(
          JSON.stringify({ error: { message: "Invalid API key.", type: "invalid_request_error" } }),
          { status: 401 }
        );
      },
      getApiKey: () => "sk-bad"
    });
    await expect(
      provider.embedTexts({
        baseUrl: "ignored",
        model: "text-embedding-3-small",
        texts: ["a"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/401.*Invalid API key/u);
  });

  it("T5: throws on 429 rate limit with embedded message", async () => {
    const provider = createOpenAIEmbedProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(
          JSON.stringify({ error: { message: "Rate limit reached", type: "rate_limit_error" } }),
          { status: 429 }
        );
      },
      getApiKey: () => "sk-test"
    });
    await expect(
      provider.embedTexts({
        baseUrl: "ignored",
        model: "text-embedding-3-small",
        texts: ["a"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/429.*Rate limit/u);
  });

  it("T6: throws when response lacks `data`", async () => {
    const provider = createOpenAIEmbedProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(JSON.stringify({ embeddings: [[1, 2]] }));
      },
      getApiKey: () => "sk-test"
    });
    await expect(
      provider.embedTexts({
        baseUrl: "ignored",
        model: "text-embedding-3-small",
        texts: ["a"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/did not include .*data/u);
  });

  it("T7: throws when vector contains non-numeric values", async () => {
    const provider = createOpenAIEmbedProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, "nope", 0.3] }] }));
      },
      getApiKey: () => "sk-test"
    });
    await expect(
      provider.embedTexts({
        baseUrl: "ignored",
        model: "text-embedding-3-small",
        texts: ["a"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/non-numeric/u);
  });

  it("T8: throws on dimension mismatch when expectedDimensions is set", async () => {
    const provider = createOpenAIEmbedProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }));
      },
      getApiKey: () => "sk-test",
      expectedDimensions: 1536
    });
    await expect(
      provider.embedTexts({
        baseUrl: "ignored",
        model: "text-embedding-3-small",
        texts: ["a"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/dimension mismatch.*expected 1536/u);
  });

  it("T9: short-circuits empty texts to [] without firing fetch", async () => {
    const fetchSpy = vi.fn();
    const provider = createOpenAIEmbedProvider({
      fetch: fetchSpy as never,
      getApiKey: () => "sk-test"
    });
    const result = await provider.embedTexts({
      baseUrl: "ignored",
      model: "text-embedding-3-small",
      texts: [],
      signal: new AbortController().signal
    });
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("T10: surfaces a non-JSON response body as a diagnostic", async () => {
    const provider = createOpenAIEmbedProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response("not json blob", { status: 200 });
      },
      getApiKey: () => "sk-test"
    });
    await expect(
      provider.embedTexts({
        baseUrl: "ignored",
        model: "text-embedding-3-small",
        texts: ["a"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/was not JSON/u);
  });
});
