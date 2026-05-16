import { describe, expect, it } from "vitest";

import { createOpenAICompatibleProvider } from "../../../src/providers/adapters/openai-compatible.js";
import { testRequest } from "./adapter-test-helpers.js";

describe("createOpenAICompatibleProvider", () => {
  it("normalizes streaming deltas from chat completions format", async () => {
    let called = false;
    const provider = createOpenAICompatibleProvider({
      fetch: async () => {
        await Promise.resolve();
        called = true;
        return new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n');
      }
    });

    const events = [];
    for await (const event of provider.streamChat(
      testRequest("openai-compatible"),
      new AbortController().signal
    )) {
      events.push(event);
    }

    expect(called).toBe(true);
    expect(events).toContainEqual({ type: "delta", text: "Hi" });
    expect(events).toContainEqual({ type: "message_end" });
  });
});
