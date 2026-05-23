/**
 * Adversarial tests for `createOpenAIChatProvider` (Phase 4 direct-API).
 *
 * Coverage:
 *   T1  emits message_start / SSE deltas / message_end on a successful stream.
 *   T2  surfaces an `error` event when no API key is configured (no fetch fired).
 *   T3  passes Authorization: Bearer + correct body shape.
 *   T4  surfaces a 401 / invalid_api_key as a non-retryable `error` event.
 *   T5  surfaces a 429 rate limit as a retryable `error` event.
 *   T6  treats 5xx server errors as retryable.
 *   T7  propagates AbortError when the signal is aborted mid-stream.
 *   T8  swallows malformed JSON in SSE payloads (skips them without throwing).
 *   T9  uses the key returned by getApiKey at request time (read each call).
 */

import { describe, expect, it, vi } from "vitest";

import { createOpenAIChatProvider } from "../../../src/providers/adapters/openai-chat.js";
import type { ChatRequest, ProviderProfile } from "../../../src/providers/provider-types.js";

const profile: ProviderProfile = {
  id: "openai-chat",
  displayName: "OpenAI (direct)",
  kind: "openai-compatible",
  baseUrl: null,
  model: "gpt-5.2-codex",
  secret: { kind: "none" },
  sendMode: "remote",
  enabled: true
};

const request: ChatRequest = {
  selection: {
    quote: "q",
    source: {
      itemKey: null,
      itemTitle: null,
      attachmentKey: null,
      pageLabel: null
    },
    anchor: null
  },
  messages: [
    { role: "system", content: "be helpful" },
    { role: "user", content: "explain" }
  ],
  profile
};

function sseStream(deltas: readonly string[]): string {
  const lines: string[] = [];
  for (const d of deltas) {
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}`);
    lines.push("");
  }
  lines.push("data: [DONE]");
  return lines.join("\n");
}

describe("createOpenAIChatProvider", () => {
  it("T1: emits message_start, deltas in order, message_end", async () => {
    const provider = createOpenAIChatProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(sseStream(["Hello ", "world", "!"]));
      },
      getApiKey: () => "sk-test"
    });
    const events = [];
    for await (const e of provider.streamChat(request, new AbortController().signal)) {
      events.push(e);
    }
    expect(events[0]).toEqual({
      type: "message_start",
      providerId: "openai-chat",
      model: "gpt-5.2-codex"
    });
    expect(events.slice(1, 4)).toEqual([
      { type: "delta", text: "Hello " },
      { type: "delta", text: "world" },
      { type: "delta", text: "!" }
    ]);
    expect(events.at(-1)).toEqual({ type: "message_end" });
  });

  it("T2: yields an `error` event when no API key is configured (no fetch fired)", async () => {
    const fetchSpy = vi.fn();
    const provider = createOpenAIChatProvider({
      fetch: fetchSpy as never,
      getApiKey: () => null
    });
    const events = [];
    for await (const e of provider.streamChat(request, new AbortController().signal)) {
      events.push(e);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.message).toMatch(/api key/iu);
      expect(last.retryable).toBe(false);
    }
  });

  it("T3: sends Authorization: Bearer + correct chat completion body", async () => {
    const seenInit = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () => {
      await Promise.resolve();
      return new Response(sseStream(["ok"]));
    });
    const provider = createOpenAIChatProvider({
      fetch: seenInit,
      getApiKey: () => "sk-secret"
    });
    const events = [];
    for await (const e of provider.streamChat(request, new AbortController().signal)) {
      events.push(e);
    }
    const callArgs = seenInit.mock.calls[0];
    expect(callArgs?.[0]).toBe("https://api.openai.com/v1/chat/completions");
    const headers = (callArgs?.[1].headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-secret");
    const body = JSON.parse(callArgs?.[1].body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.2-codex",
      stream: true,
      messages: [
        { role: "system", content: "be helpful" },
        { role: "user", content: "explain" }
      ]
    });
  });

  it("T4: surfaces a 401 / invalid api key error as non-retryable", async () => {
    const provider = createOpenAIChatProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(
          JSON.stringify({ error: { message: "Invalid API key.", type: "invalid_request_error" } }),
          { status: 401, statusText: "Unauthorized" }
        );
      },
      getApiKey: () => "sk-bad"
    });
    const events = [];
    for await (const e of provider.streamChat(request, new AbortController().signal)) {
      events.push(e);
    }
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.message).toMatch(/401/u);
      expect(last.message).toMatch(/invalid api key/iu);
      expect(last.retryable).toBe(false);
    }
  });

  it("T5: surfaces a 429 rate-limit as retryable", async () => {
    const provider = createOpenAIChatProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(
          JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit" } }),
          { status: 429, statusText: "Too Many Requests" }
        );
      },
      getApiKey: () => "sk-test"
    });
    const events = [];
    for await (const e of provider.streamChat(request, new AbortController().signal)) {
      events.push(e);
    }
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.retryable).toBe(true);
    }
  });

  it("T6: treats 5xx server errors as retryable", async () => {
    const provider = createOpenAIChatProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response("internal explosion", {
          status: 503,
          statusText: "Service Unavailable"
        });
      },
      getApiKey: () => "sk-test"
    });
    const events = [];
    for await (const e of provider.streamChat(request, new AbortController().signal)) {
      events.push(e);
    }
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.retryable).toBe(true);
      expect(last.message).toMatch(/503/u);
    }
  });

  it("T7: re-throws AbortError when the signal aborted mid-stream", async () => {
    const ac = new AbortController();
    const provider = createOpenAIChatProvider({
      fetch: async (_input, init) => {
        await Promise.resolve();
        // Mimic fetch's abort behaviour.
        if (init.signal?.aborted === true) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return new Response(sseStream(["x"]));
      },
      getApiKey: () => "sk-test"
    });
    ac.abort();
    const iter = provider.streamChat(request, ac.signal);
    const events = [];
    let threw = false;
    try {
      for await (const e of iter) {
        events.push(e);
      }
    } catch (err) {
      threw = true;
      expect(err instanceof Error ? err.name : "").toBe("AbortError");
    }
    expect(threw).toBe(true);
  });

  it("T8: malformed SSE payloads surface as an in-band `error` event (M7)", async () => {
    // M7 fix (Phase 4b codex review): the streaming reader now yields
    // an explicit `error` event when a `data:` payload fails to parse,
    // instead of letting JSON.parse propagate as an unhandled
    // throw (which the legacy buffered parser did). The popup
    // controller surfaces in-band errors via store.fail(), so this
    // gives the user a visible failure rather than a thrown promise.
    const text = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "good" } }] })}`,
      "",
      "data: {not json",
      "",
      "data: [DONE]"
    ].join("\n");
    const provider = createOpenAIChatProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(text);
      },
      getApiKey: () => "sk-test"
    });
    const events = [];
    for await (const e of provider.streamChat(request, new AbortController().signal)) {
      events.push(e);
    }
    // The well-formed delta arrives first (streaming preserves the
    // pre-failure tokens).
    expect(events.find((e) => e.type === "delta")).toEqual({ type: "delta", text: "good" });
    // The terminal event is an error, NOT message_end.
    expect(events.some((e) => e.type === "message_end")).toBe(false);
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.message).toMatch(/parse failed/iu);
      expect(last.retryable).toBe(false);
    }
  });

  it("T9: getApiKey is invoked per request (not cached at creation)", async () => {
    let count = 0;
    const provider = createOpenAIChatProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(sseStream(["ok"]));
      },
      getApiKey: () => {
        count += 1;
        return count === 1 ? "sk-first" : "sk-second";
      }
    });
    for await (const _event of provider.streamChat(request, new AbortController().signal)) {
      void _event;
    }
    for await (const _event of provider.streamChat(request, new AbortController().signal)) {
      void _event;
    }
    expect(count).toBe(2);
  });

  /**
   * M6 (Phase 4b codex review): the adapter streams the SSE body
   * incrementally via a ReadableStream reader instead of buffering the
   * whole body via `response.text()`. We assert this by enqueueing
   * SSE events one chunk at a time and confirming the first delta
   * arrives before the second chunk is enqueued.
   */
  it("M6: yields deltas incrementally as SSE chunks arrive (real streaming)", async () => {
    let enqueueNextChunk: () => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        // First chunk: a single SSE event with content "alpha".
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: "alpha" } }] })}\n\n`
          )
        );
        // The test releases this lambda after observing the first
        // delta so the second chunk only flows post-observation.
        enqueueNextChunk = () => {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "beta" } }] })}\n\ndata: [DONE]\n\n`
            )
          );
          controller.close();
        };
      }
    });
    const provider = createOpenAIChatProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(stream);
      },
      getApiKey: () => "sk-test"
    });

    const events = [];
    let firstDeltaSeen = false;
    for await (const e of provider.streamChat(request, new AbortController().signal)) {
      events.push(e);
      if (e.type === "delta" && !firstDeltaSeen) {
        firstDeltaSeen = true;
        // CRITICAL assertion: we see "alpha" before "beta" is even
        // enqueued in the stream. Pre-fix (buffered text()), the
        // adapter would await the full body before yielding anything.
        enqueueNextChunk();
      }
    }

    expect(events.filter((e) => e.type === "delta")).toEqual([
      { type: "delta", text: "alpha" },
      { type: "delta", text: "beta" }
    ]);
    expect(events.at(-1)).toEqual({ type: "message_end" });
  });
});
