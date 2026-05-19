/**
 * Adversarial tests for `createGeminiEmbedProvider`.
 *
 * Coverage:
 *   T1  decodes the canonical {embeddings: [{values: [...]}]} shape.
 *   T2  throws when no API key (no fetch).
 *   T3  sends key as a query param + adds models/ prefix in the body.
 *   T4  surfaces 400 with a Gemini error message.
 *   T5  treats 429 / 503 errors as a diagnostic.
 *   T6  throws when the response lacks `embeddings`.
 *   T7  throws on non-numeric values in vectors.
 *   T8  throws on dimension mismatch when expectedDimensions is set.
 *   T9  short-circuits empty texts.
 *   T10 surfaces non-JSON body as a diagnostic.
 */

import { describe, expect, it, vi } from "vitest";

import { createGeminiEmbedProvider } from "../../../src/providers/adapters/gemini-embed.js";

describe("createGeminiEmbedProvider", () => {
  it("T1: decodes embeddings from {embeddings: [{values: [...]}]}", async () => {
    const provider = createGeminiEmbedProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(
          JSON.stringify({
            embeddings: [{ values: [0.1, 0.2, 0.3] }, { values: [0.4, 0.5, 0.6] }]
          })
        );
      },
      getApiKey: () => "gem-test"
    });
    const result = await provider.embedTexts({
      baseUrl: "ignored",
      model: "text-embedding-004",
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
    const provider = createGeminiEmbedProvider({
      fetch: fetchSpy as never,
      getApiKey: () => null
    });
    await expect(
      provider.embedTexts({
        baseUrl: "ignored",
        model: "text-embedding-004",
        texts: ["a"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/api key/iu);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("T3: sends key in query string + adds models/ prefix in body", async () => {
    const seenInit = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () => {
      await Promise.resolve();
      return new Response(JSON.stringify({ embeddings: [{ values: [1, 2] }] }));
    });
    const provider = createGeminiEmbedProvider({
      fetch: seenInit,
      getApiKey: () => "gem-secret"
    });
    await provider.embedTexts({
      baseUrl: "ignored",
      model: "text-embedding-004",
      texts: ["one"],
      signal: new AbortController().signal
    });
    const url = seenInit.mock.calls[0]?.[0] ?? "";
    expect(url).toMatch(/text-embedding-004:batchEmbedContents/u);
    expect(url).toMatch(/key=gem-secret/u);
    const body = JSON.parse(seenInit.mock.calls[0]?.[1].body as string) as {
      requests: { model: string; content: { parts: { text: string }[] } }[];
    };
    expect(body.requests[0]?.model).toBe("models/text-embedding-004");
    expect(body.requests[0]?.content.parts[0]?.text).toBe("one");
  });

  it("T4: surfaces 400 with the Gemini error message", async () => {
    const provider = createGeminiEmbedProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(
          JSON.stringify({
            error: { code: 400, message: "API key not valid", status: "INVALID_ARGUMENT" }
          }),
          { status: 400 }
        );
      },
      getApiKey: () => "gem-bad"
    });
    await expect(
      provider.embedTexts({
        baseUrl: "ignored",
        model: "text-embedding-004",
        texts: ["a"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/400.*API key not valid/u);
  });

  it("T5: surfaces a 503 server error verbatim", async () => {
    const provider = createGeminiEmbedProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response("backend overloaded", { status: 503 });
      },
      getApiKey: () => "gem-test"
    });
    await expect(
      provider.embedTexts({
        baseUrl: "ignored",
        model: "text-embedding-004",
        texts: ["a"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/503.*backend overloaded/u);
  });

  it("T6: throws when `embeddings` is missing", async () => {
    const provider = createGeminiEmbedProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(JSON.stringify({ data: [] }));
      },
      getApiKey: () => "gem-test"
    });
    await expect(
      provider.embedTexts({
        baseUrl: "ignored",
        model: "text-embedding-004",
        texts: ["a"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/did not include .*embeddings/u);
  });

  it("T7: throws on non-numeric values", async () => {
    const provider = createGeminiEmbedProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(JSON.stringify({ embeddings: [{ values: [0.1, "oops"] }] }));
      },
      getApiKey: () => "gem-test"
    });
    await expect(
      provider.embedTexts({
        baseUrl: "ignored",
        model: "text-embedding-004",
        texts: ["a"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/non-numeric/u);
  });

  it("T8: throws on dimension mismatch when expectedDimensions is set", async () => {
    const provider = createGeminiEmbedProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(JSON.stringify({ embeddings: [{ values: [1, 2, 3] }] }));
      },
      getApiKey: () => "gem-test",
      expectedDimensions: 768
    });
    await expect(
      provider.embedTexts({
        baseUrl: "ignored",
        model: "text-embedding-004",
        texts: ["a"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/dimension mismatch.*expected 768/u);
  });

  it("T9: short-circuits empty texts to [] without firing fetch", async () => {
    const fetchSpy = vi.fn();
    const provider = createGeminiEmbedProvider({
      fetch: fetchSpy as never,
      getApiKey: () => "gem-test"
    });
    const result = await provider.embedTexts({
      baseUrl: "ignored",
      model: "text-embedding-004",
      texts: [],
      signal: new AbortController().signal
    });
    expect(result).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("T10: surfaces non-JSON body as a diagnostic", async () => {
    const provider = createGeminiEmbedProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response("not-json", { status: 200 });
      },
      getApiKey: () => "gem-test"
    });
    await expect(
      provider.embedTexts({
        baseUrl: "ignored",
        model: "text-embedding-004",
        texts: ["a"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/was not JSON/u);
  });
});
