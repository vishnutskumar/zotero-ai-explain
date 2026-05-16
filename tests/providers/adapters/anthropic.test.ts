import { describe, expect, it } from "vitest";

import { createAnthropicProvider } from "../../../src/providers/adapters/anthropic.js";
import { testRequest } from "./adapter-test-helpers.js";

describe("createAnthropicProvider", () => {
  it("normalizes streaming deltas from Anthropic format", async () => {
    const provider = createAnthropicProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(
          'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hi"}}\n\nevent: message_stop\ndata: {}\n\n'
        );
      }
    });

    const events = [];
    for await (const event of provider.streamChat(
      testRequest("anthropic", null),
      new AbortController().signal
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "delta", text: "Hi" });
    expect(events).toContainEqual({ type: "message_end" });
  });
});
