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

function makeStreamingProvider(): {
  provider: ReturnType<typeof createOllamaProvider>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  encode: (input: string) => Uint8Array;
} {
  // `start` runs synchronously inside `new ReadableStream(...)`, so the
  // controller is captured by the time the constructor returns.
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    }
  });
  const encoder = new TextEncoder();
  const provider = createOllamaProvider({
    fetch: async () => {
      await Promise.resolve();
      return new Response(stream);
    }
  });
  return { provider, controller, encode: (input) => encoder.encode(input) };
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
  it("AC-17 codex P2: yields a non-retryable error event when response.body is null", async () => {
    const provider = createOllamaProvider({
      fetch: async () => {
        await Promise.resolve();
        // A 200 OK with no body. Some misbehaving proxies return this
        // shape; without explicit handling the iterator emitted only
        // message_start + message_end (silent success on a protocol
        // failure).
        return new Response(null, { status: 200 });
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
      expect(last.message.toLowerCase()).toContain("empty response body");
      expect(last.retryable).toBe(false);
    }
  });

  it("AC-17: decodes a multi-byte UTF-8 character split across two stream chunks", async () => {
    const { provider, controller } = makeStreamingProvider();
    // "你好" — the first character is U+4F60 (E4 BD A0 in UTF-8). We
    // split between the second and third byte so the decoder MUST
    // buffer the partial sequence across read() calls.
    const utf8 = new Uint8Array([
      0x7b, 0x22, 0x6d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x22, 0x3a, 0x7b, 0x22, 0x63, 0x6f,
      0x6e, 0x74, 0x65, 0x6e, 0x74, 0x22, 0x3a, 0x22, 0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd, 0x22,
      0x7d, 0x2c, 0x22, 0x64, 0x6f, 0x6e, 0x65, 0x22, 0x3a, 0x74, 0x72, 0x75, 0x65, 0x7d, 0x0a
    ]);
    const splitAt = 25; // mid-character (between E4 BD and A0)
    controller.enqueue(utf8.slice(0, splitAt));
    controller.enqueue(utf8.slice(splitAt));
    controller.close();
    const iter = provider.streamChat(request, new AbortController().signal)[Symbol.asyncIterator]();
    expect((await iter.next()).value).toMatchObject({ type: "message_start" });
    expect((await iter.next()).value).toEqual({ type: "delta", text: "你好" });
    expect((await iter.next()).value).toEqual({ type: "message_end" });
  });

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

  it("AC-17: yields the first delta before the upstream stream closes", async () => {
    const { provider, controller, encode } = makeStreamingProvider();
    const enqueueLine = (line: object): void => {
      controller.enqueue(encode(`${JSON.stringify(line)}\n`));
    };
    const iter = provider.streamChat(request, new AbortController().signal)[Symbol.asyncIterator]();

    expect((await iter.next()).value).toMatchObject({ type: "message_start" });

    enqueueLine({ message: { content: "First " }, done: false });
    expect((await iter.next()).value).toEqual({ type: "delta", text: "First " });

    enqueueLine({ message: { content: "second" }, done: true });
    controller.close();

    expect((await iter.next()).value).toEqual({ type: "delta", text: "second" });
    expect((await iter.next()).value).toEqual({ type: "message_end" });
    expect((await iter.next()).done).toBe(true);
  });

  it("AC-17: buffers a JSON line that spans multiple stream chunks", async () => {
    const { provider, controller, encode } = makeStreamingProvider();
    const iter = provider.streamChat(request, new AbortController().signal)[Symbol.asyncIterator]();
    expect((await iter.next()).value).toMatchObject({ type: "message_start" });

    const fullLine = `${JSON.stringify({ message: { content: "Hello world" }, done: true })}\n`;
    const splitAt = Math.floor(fullLine.length / 2);
    controller.enqueue(encode(fullLine.slice(0, splitAt)));
    controller.enqueue(encode(fullLine.slice(splitAt)));
    controller.close();

    expect((await iter.next()).value).toEqual({ type: "delta", text: "Hello world" });
    expect((await iter.next()).value).toEqual({ type: "message_end" });
    expect((await iter.next()).done).toBe(true);
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

  // ---------------------------------------------------------------------
  // B1 / B2 — proxy bearer-token header injection via getProxyAuthHeader.
  //
  // The adapter MUST honor the optional `getProxyAuthHeader` dep so the
  // bootstrap closure can attach `Authorization: Bearer <uuid>` for the
  // bundled LLM proxy without leaking the header to real Ollama daemons.
  // When the dep returns undefined (or is omitted entirely), no
  // Authorization header is sent — that's the backward-compatible path
  // legacy callers and direct-Ollama-daemon configurations rely on.
  // ---------------------------------------------------------------------
  it("B1 (streamChat): attaches Authorization header returned by getProxyAuthHeader", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const provider = createOllamaProvider({
      fetch: async (_input, init) => {
        await Promise.resolve();
        // Normalize the headers init shape into a plain record so the
        // assertion below can hit it without juggling Headers vs object.
        const h: Record<string, string> = {};
        const raw = (init.headers ?? {}) as Record<string, string>;
        for (const [k, v] of Object.entries(raw)) h[k.toLowerCase()] = v;
        capturedHeaders.push(h);
        return new Response(JSON.stringify({ message: { content: "ok" }, done: true }), {
          status: 200
        });
      },
      getProxyAuthHeader: (url) => {
        // Closure receives the normalized baseUrl (no /api/chat suffix),
        // so the bootstrap-side prefix match can hit the configured
        // proxy URL cleanly.
        expect(url).toBe("http://localhost:11434");
        return { Authorization: "Bearer test-token-aaaa" };
      }
    });
    const events = [];
    for await (const event of provider.streamChat(request, new AbortController().signal)) {
      events.push(event);
    }
    expect(capturedHeaders).toHaveLength(1);
    expect(capturedHeaders[0]?.authorization).toBe("Bearer test-token-aaaa");
    expect(capturedHeaders[0]?.["content-type"]).toBe("application/json");
  });

  it("B1 (embedTexts): attaches Authorization header returned by getProxyAuthHeader", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const provider = createOllamaProvider({
      fetch: async (_input, init) => {
        await Promise.resolve();
        const h: Record<string, string> = {};
        const raw = (init.headers ?? {}) as Record<string, string>;
        for (const [k, v] of Object.entries(raw)) h[k.toLowerCase()] = v;
        capturedHeaders.push(h);
        return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 });
      },
      getProxyAuthHeader: (url) => {
        expect(url).toBe("http://127.0.0.1:11400/codex");
        return { Authorization: "Bearer test-token-bbbb" };
      }
    });
    await provider.embedTexts({
      baseUrl: "http://127.0.0.1:11400/codex",
      model: "nomic-embed-text",
      texts: ["hello"],
      signal: new AbortController().signal
    });
    expect(capturedHeaders).toHaveLength(1);
    expect(capturedHeaders[0]?.authorization).toBe("Bearer test-token-bbbb");
  });

  it("B2 (streamChat): omits the Authorization header when getProxyAuthHeader returns undefined", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const provider = createOllamaProvider({
      fetch: async (_input, init) => {
        await Promise.resolve();
        const h: Record<string, string> = {};
        const raw = (init.headers ?? {}) as Record<string, string>;
        for (const [k, v] of Object.entries(raw)) h[k.toLowerCase()] = v;
        capturedHeaders.push(h);
        return new Response(JSON.stringify({ message: { content: "ok" }, done: true }), {
          status: 200
        });
      },
      // The accessor exists but returns undefined — the "request is for
      // the real Ollama daemon, not the local proxy" branch.
      getProxyAuthHeader: () => undefined
    });
    const events = [];
    for await (const event of provider.streamChat(request, new AbortController().signal)) {
      events.push(event);
    }
    expect(capturedHeaders).toHaveLength(1);
    expect(capturedHeaders[0]?.authorization).toBeUndefined();
  });

  it("B2 (embedTexts): omits the Authorization header when the dep is OMITTED entirely (backward compat)", async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const provider = createOllamaProvider({
      fetch: async (_input, init) => {
        await Promise.resolve();
        const h: Record<string, string> = {};
        const raw = (init.headers ?? {}) as Record<string, string>;
        for (const [k, v] of Object.entries(raw)) h[k.toLowerCase()] = v;
        capturedHeaders.push(h);
        return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 });
      }
      // No `getProxyAuthHeader` — legacy callers / tests that don't
      // thread the proxy lifecycle must continue to work unchanged.
    });
    await provider.embedTexts({
      baseUrl: "http://localhost:11434",
      model: "nomic-embed-text",
      texts: ["hello"],
      signal: new AbortController().signal
    });
    expect(capturedHeaders).toHaveLength(1);
    expect(capturedHeaders[0]?.authorization).toBeUndefined();
  });
});
