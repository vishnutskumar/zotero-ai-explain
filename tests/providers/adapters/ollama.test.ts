import { describe, expect, it } from "vitest";

import { createOllamaProvider } from "../../../src/providers/adapters/ollama.js";
import type { ChatRequest, ProviderProfile } from "../../../src/providers/provider-types.js";

const profile: ProviderProfile = {
  id: "ollama",
  displayName: "Ollama",
  kind: "ollama",
  baseUrl: "http://localhost:11434",
  model: "llama3.1",
  secret: { kind: "none" },
  sendMode: "local",
  enabled: true
};

const request: ChatRequest = {
  selection: {
    quote: "Dense paragraph",
    source: {
      itemKey: "ITEM",
      itemTitle: "Paper",
      attachmentKey: "ATTACH",
      pageLabel: "4"
    },
    anchor: null
  },
  messages: [{ role: "user", content: "Explain this" }],
  profile
};

function bodyText(init: RequestInit): string {
  return typeof init.body === "string" ? init.body : "";
}

describe("createOllamaProvider", () => {
  it("streams chat deltas from Ollama /api/chat", async () => {
    const calls: { input: string; init: RequestInit }[] = [];
    const provider = createOllamaProvider({
      fetch: async (input, init) => {
        await Promise.resolve();
        calls.push({ input, init });
        return new Response(
          [
            JSON.stringify({ message: { content: "First " }, done: false }),
            JSON.stringify({ message: { content: "second" }, done: true })
          ].join("\n")
        );
      }
    });

    const events = [];
    for await (const event of provider.streamChat(request, new AbortController().signal)) {
      events.push(event);
    }

    expect(calls[0]?.input).toBe("http://localhost:11434/api/chat");
    expect(JSON.parse(bodyText(calls[0]?.init ?? {}))).toMatchObject({
      model: "llama3.1",
      stream: true,
      messages: [{ role: "user", content: "Explain this" }]
    });
    expect(events).toEqual([
      { type: "message_start", providerId: "ollama", model: "llama3.1" },
      { type: "delta", text: "First " },
      { type: "delta", text: "second" },
      { type: "message_end" }
    ]);
  });

  it("creates embeddings through Ollama /api/embed", async () => {
    const provider = createOllamaProvider({
      fetch: async (input, init) => {
        await Promise.resolve();
        expect(input).toBe("http://localhost:11434/api/embed");
        expect(JSON.parse(bodyText(init))).toEqual({
          model: "nomic-embed-text",
          input: ["chunk one", "chunk two"]
        });
        return new Response(
          JSON.stringify({
            embeddings: [
              [1, 2],
              [3, 4]
            ]
          })
        );
      }
    });

    await expect(
      provider.embedTexts({
        baseUrl: "http://localhost:11434",
        model: "nomic-embed-text",
        texts: ["chunk one", "chunk two"],
        signal: new AbortController().signal
      })
    ).resolves.toEqual([
      [1, 2],
      [3, 4]
    ]);
  });

  it("reports connection failures as retryable chat errors", async () => {
    const provider = createOllamaProvider({
      fetch: async () => {
        await Promise.resolve();
        throw new TypeError("fetch failed");
      }
    });

    const events = [];
    for await (const event of provider.streamChat(request, new AbortController().signal)) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      type: "error",
      message: "Could not reach Ollama at http://localhost:11434.",
      retryable: true
    });
  });

  it("surfaces a non-OK chat response with Ollama's JSON error message", async () => {
    // Reproduction of the AC8 bug: a 404 with `{"error":"model 'X' not found"}`
    // used to be silently swallowed (zero deltas yielded, then `message_end`),
    // so the popup rendered an empty body. Now the adapter must emit an
    // explicit `error` event before returning so popup-controller can
    // surface it via `fail()`.
    const provider = createOllamaProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response('{"error":"model \\"nonexistent\\" not found"}', {
          status: 404,
          statusText: "Not Found"
        });
      }
    });

    const events = [];
    for await (const event of provider.streamChat(request, new AbortController().signal)) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "message_start", providerId: "ollama", model: "llama3.1" });
    // No deltas, no message_end — the error must be the terminal event.
    expect(events.some((e) => e.type === "delta")).toBe(false);
    expect(events.some((e) => e.type === "message_end")).toBe(false);
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.message).toContain('model "nonexistent" not found');
      expect(last.retryable).toBe(false);
    }
  });

  it("surfaces a 500 chat response with a non-JSON body verbatim", async () => {
    const provider = createOllamaProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response("internal boom\n", {
          status: 500,
          statusText: "Internal Server Error"
        });
      }
    });

    const events = [];
    for await (const event of provider.streamChat(request, new AbortController().signal)) {
      events.push(event);
    }

    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.message).toContain("internal boom");
    }
  });

  it("falls back to HTTP status line when the error body is empty", async () => {
    const provider = createOllamaProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response("", { status: 502, statusText: "Bad Gateway" });
      }
    });

    const events = [];
    for await (const event of provider.streamChat(request, new AbortController().signal)) {
      events.push(event);
    }

    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.message).toContain("502");
      expect(last.message.toLowerCase()).toContain("bad gateway");
    }
  });

  it("throws a diagnostic error from embedTexts on a non-OK response with JSON error", async () => {
    // Mirror of the streamChat bug for the embedding path. The
    // library-crawler's K=3 circuit breaker depends on a thrown Error, not
    // the silent "did not include embeddings" path.
    const provider = createOllamaProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response('{"error":"model \\"embeddinggemma\\" not found"}', {
          status: 404,
          statusText: "Not Found"
        });
      }
    });

    await expect(
      provider.embedTexts({
        baseUrl: "http://localhost:11434",
        model: "embeddinggemma",
        texts: ["chunk one"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/embeddinggemma.*not found/u);
  });

  it("throws with the raw 500 body when embedTexts hits a non-JSON server error", async () => {
    const provider = createOllamaProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response("embed pipeline crashed", {
          status: 500,
          statusText: "Internal Server Error"
        });
      }
    });

    await expect(
      provider.embedTexts({
        baseUrl: "http://localhost:11434",
        model: "embeddinggemma",
        texts: ["chunk one"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/embed pipeline crashed/u);
  });

  it("throws with the HTTP status line when embedTexts gets an empty error body", async () => {
    const provider = createOllamaProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response("", { status: 503, statusText: "Service Unavailable" });
      }
    });

    await expect(
      provider.embedTexts({
        baseUrl: "http://localhost:11434",
        model: "embeddinggemma",
        texts: ["chunk one"],
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/503.*Service Unavailable/u);
  });

  /**
   * H2 (Phase 4b codex review) — terminal error chunks in NDJSON.
   *
   * The local llm-proxy returns HTTP 200 with NDJSON bodies that
   * include a terminal `{error}` or `{done_reason: "error"}` chunk on
   * upstream Codex/Claude failures. Before the fix, the adapter only
   * read `message.content`; an error chunk produced zero deltas and a
   * cheerful message_end — exactly the BUG-AC8-1 silent-empty failure
   * for proxy-routed traffic.
   */
  it("H2: surfaces a top-level NDJSON error chunk as a terminal error event", async () => {
    const provider = createOllamaProvider({
      fetch: async () => {
        await Promise.resolve();
        // Proxy-shaped error chunk (server.mjs:142-151).
        return new Response(
          [
            JSON.stringify({ message: { content: "partial " }, done: false }),
            JSON.stringify({ error: "codex exited 127: command not found" })
          ].join("\n")
        );
      }
    });

    const events = [];
    for await (const event of provider.streamChat(request, new AbortController().signal)) {
      events.push(event);
    }

    // Partial delta is preserved (the user sees what got streamed).
    expect(events.filter((e) => e.type === "delta")).toEqual([{ type: "delta", text: "partial " }]);
    // No message_end — the error must be terminal.
    expect(events.some((e) => e.type === "message_end")).toBe(false);
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.message).toContain("codex exited 127: command not found");
      expect(last.retryable).toBe(false);
    }
  });

  it("H2: surfaces a done_reason=error NDJSON chunk even without explicit error string", async () => {
    const provider = createOllamaProvider({
      fetch: async () => {
        await Promise.resolve();
        // backends/ollama.mjs:45-53 shape — error flag carried in done_reason.
        return new Response(JSON.stringify({ done: true, done_reason: "error" }));
      }
    });

    const events = [];
    for await (const event of provider.streamChat(request, new AbortController().signal)) {
      events.push(event);
    }

    expect(events.some((e) => e.type === "message_end")).toBe(false);
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      // Fallback message when the chunk carries no detail string.
      expect(last.message).toMatch(/error/iu);
    }
  });

  it("H2: surfaces a done_reason=error NDJSON chunk that ALSO carries an error string verbatim", async () => {
    const provider = createOllamaProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(
          JSON.stringify({
            done: true,
            done_reason: "error",
            error: "upstream timeout after 60s"
          })
        );
      }
    });

    const events = [];
    for await (const event of provider.streamChat(request, new AbortController().signal)) {
      events.push(event);
    }

    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.message).toContain("upstream timeout after 60s");
    }
  });
});
