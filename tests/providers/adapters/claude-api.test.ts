/**
 * Adversarial tests for `createClaudeApiProvider` (Phase 4 direct-API).
 *
 * Coverage:
 *   T1  emits message_start / SSE text_delta / message_end for a success.
 *   T2  surfaces missing-key error WITHOUT firing fetch.
 *   T3  splits system messages out of the messages array (Anthropic 400 protection).
 *   T4  sends x-api-key + anthropic-version headers.
 *   T5  surfaces 401 invalid-key as non-retryable error.
 *   T6  treats 429 as retryable.
 *   T7  re-throws AbortError when the signal is aborted.
 *   T8  rejects an empty messages-array request before hitting network.
 *   T9  parseAnthropicSse skips malformed JSON payloads instead of throwing.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createClaudeApiProvider,
  parseAnthropicSse
} from "../../../src/providers/adapters/claude-api.js";
import type { ChatRequest, ProviderProfile } from "../../../src/providers/provider-types.js";

const profile: ProviderProfile = {
  id: "claude-api",
  displayName: "Claude (direct)",
  kind: "anthropic",
  baseUrl: null,
  model: "claude-sonnet-4-7",
  secret: { kind: "none" },
  sendMode: "remote",
  enabled: true
};

const baseSelection = {
  quote: "q",
  source: {
    itemKey: null,
    itemTitle: null,
    attachmentKey: null,
    pageLabel: null
  },
  anchor: null
};

const request: ChatRequest = {
  selection: baseSelection,
  messages: [
    { role: "system", content: "you are helpful" },
    { role: "user", content: "explain" }
  ],
  profile
};

function anthropicSse(deltas: readonly string[]): string {
  const lines: string[] = [];
  for (const d of deltas) {
    lines.push("event: content_block_delta");
    lines.push(
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: d } })}`
    );
    lines.push("");
  }
  lines.push("event: message_stop");
  lines.push(`data: ${JSON.stringify({ type: "message_stop" })}`);
  return lines.join("\n");
}

describe("createClaudeApiProvider", () => {
  it("T1: emits message_start, text deltas, message_end", async () => {
    const provider = createClaudeApiProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(anthropicSse(["Alpha ", "beta"]));
      },
      getApiKey: () => "sk-ant-test"
    });
    const events = [];
    for await (const e of provider.streamChat(request, new AbortController().signal)) {
      events.push(e);
    }
    expect(events[0]).toEqual({
      type: "message_start",
      providerId: "claude-api",
      model: "claude-sonnet-4-7"
    });
    expect(events.filter((e) => e.type === "delta")).toEqual([
      { type: "delta", text: "Alpha " },
      { type: "delta", text: "beta" }
    ]);
    expect(events.at(-1)).toEqual({ type: "message_end" });
  });

  it("T2: surfaces missing-key error without firing fetch", async () => {
    const fetchSpy = vi.fn();
    const provider = createClaudeApiProvider({
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

  it("T3: hoists `system` out of messages into the top-level field", async () => {
    const seenInit = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () => {
      await Promise.resolve();
      return new Response(anthropicSse(["ok"]));
    });
    const provider = createClaudeApiProvider({
      fetch: seenInit,
      getApiKey: () => "sk-ant-test"
    });
    const events = [];
    for await (const e of provider.streamChat(
      {
        ...request,
        messages: [
          { role: "system", content: "system A" },
          { role: "system", content: "system B" },
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" }
        ]
      },
      new AbortController().signal
    )) {
      events.push(e);
    }
    const body = JSON.parse(seenInit.mock.calls[0]?.[1].body as string) as Record<string, unknown>;
    expect(body.system).toBe("system A\n\nsystem B");
    expect(body.messages).toEqual([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" }
    ]);
    expect(body.stream).toBe(true);
    expect(body.model).toBe("claude-sonnet-4-7");
  });

  it("T4: sends x-api-key and anthropic-version headers", async () => {
    const seenInit = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () => {
      await Promise.resolve();
      return new Response(anthropicSse(["ok"]));
    });
    const provider = createClaudeApiProvider({
      fetch: seenInit,
      getApiKey: () => "sk-ant-secret"
    });
    for await (const _event of provider.streamChat(request, new AbortController().signal)) {
      void _event;
    }
    const headers = (seenInit.mock.calls[0]?.[1].headers ?? {}) as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-secret");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(seenInit.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/v1/messages");
  });

  it("T5: surfaces 401 as non-retryable error", async () => {
    const provider = createClaudeApiProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "invalid x-api-key" }
          }),
          { status: 401, statusText: "Unauthorized" }
        );
      },
      getApiKey: () => "sk-ant-bad"
    });
    const events = [];
    for await (const e of provider.streamChat(request, new AbortController().signal)) {
      events.push(e);
    }
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.message).toMatch(/invalid x-api-key/u);
      expect(last.retryable).toBe(false);
    }
  });

  it("T6: treats 429 as retryable", async () => {
    const provider = createClaudeApiProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "slow down" }
          }),
          { status: 429, statusText: "Too Many Requests" }
        );
      },
      getApiKey: () => "sk-ant-test"
    });
    const events = [];
    for await (const e of provider.streamChat(request, new AbortController().signal)) {
      events.push(e);
    }
    const last = events.at(-1);
    if (last?.type === "error") {
      expect(last.retryable).toBe(true);
    } else {
      throw new Error("expected error event");
    }
  });

  it("T7: re-throws AbortError when signal aborted before fetch", async () => {
    const ac = new AbortController();
    const provider = createClaudeApiProvider({
      fetch: async (_input, init) => {
        await Promise.resolve();
        if (init.signal?.aborted === true) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return new Response(anthropicSse(["x"]));
      },
      getApiKey: () => "sk-ant-test"
    });
    ac.abort();
    let threw = false;
    try {
      for await (const _event of provider.streamChat(request, ac.signal)) {
        void _event;
      }
    } catch (err) {
      threw = true;
      expect(err instanceof Error ? err.name : "").toBe("AbortError");
    }
    expect(threw).toBe(true);
  });

  it("T8: rejects a request with no non-system messages before firing fetch", async () => {
    const fetchSpy = vi.fn();
    const provider = createClaudeApiProvider({
      fetch: fetchSpy as never,
      getApiKey: () => "sk-ant-test"
    });
    const events = [];
    for await (const e of provider.streamChat(
      {
        ...request,
        messages: [{ role: "system", content: "only system" }]
      },
      new AbortController().signal
    )) {
      events.push(e);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.retryable).toBe(false);
      expect(last.message).toMatch(/at least one user/iu);
    }
  });

  it("T9: parseAnthropicSse skips malformed JSON payloads instead of throwing", () => {
    const sse = [
      "event: content_block_delta",
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "first" } })}`,
      "",
      "data: {not json",
      "",
      "event: message_stop",
      `data: ${JSON.stringify({ type: "message_stop" })}`
    ].join("\n");
    const parsed = parseAnthropicSse(sse);
    // Both well-formed payloads should be present; the malformed line is dropped.
    expect(parsed.length).toBe(2);
  });

  /**
   * M7 (Phase 4b codex review): the streaming adapter MUST surface a
   * malformed `data:` payload as an in-band `error` event instead of
   * silently completing with a blank assistant turn. Pre-fix,
   * `parseAnthropicSse` skipped malformed payloads and the adapter
   * yielded `message_end`, so a corrupted Anthropic stream rendered
   * "completed" with no visible failure.
   */
  it("M7: malformed SSE payload surfaces as an in-band `error` event in streamChat", async () => {
    const text = [
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "good " } })}`,
      "",
      "data: {bad json",
      ""
    ].join("\n");
    const provider = createClaudeApiProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(text);
      },
      getApiKey: () => "sk-ant-test"
    });
    const events = [];
    for await (const e of provider.streamChat(request, new AbortController().signal)) {
      events.push(e);
    }
    expect(events.find((e) => e.type === "delta")).toEqual({ type: "delta", text: "good " });
    expect(events.some((e) => e.type === "message_end")).toBe(false);
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.message).toMatch(/parse failed/iu);
    }
  });

  /**
   * M6 (Phase 4b codex review): incremental SSE streaming. The adapter
   * must yield deltas as ReadableStream chunks arrive instead of
   * buffering the full response body. We enqueue the first chunk
   * eagerly and the second only after observing the first delta.
   */
  it("M6: yields Anthropic deltas incrementally as SSE chunks arrive", async () => {
    let enqueueNext: () => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "alpha" } })}\n\n`
          )
        );
        enqueueNext = () => {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "beta" } })}\n\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
            )
          );
          controller.close();
        };
      }
    });
    const provider = createClaudeApiProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(stream);
      },
      getApiKey: () => "sk-ant-test"
    });
    const events = [];
    let firstDeltaSeen = false;
    for await (const e of provider.streamChat(request, new AbortController().signal)) {
      events.push(e);
      if (e.type === "delta" && !firstDeltaSeen) {
        firstDeltaSeen = true;
        enqueueNext();
      }
    }
    expect(events.filter((e) => e.type === "delta")).toEqual([
      { type: "delta", text: "alpha" },
      { type: "delta", text: "beta" }
    ]);
    expect(events.at(-1)).toEqual({ type: "message_end" });
  });
});
