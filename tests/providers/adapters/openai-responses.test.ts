import { describe, expect, it } from "vitest";

import { createOpenAIResponsesProvider } from "../../../src/providers/adapters/openai-responses.js";
import { testRequest } from "./adapter-test-helpers.js";

describe("createOpenAIResponsesProvider", () => {
  it("normalizes streaming deltas from Responses API format", async () => {
    const provider = createOpenAIResponsesProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"Hi"}\n\ndata: {"type":"response.completed"}\n\n'
        );
      }
    });

    const events = [];
    for await (const event of provider.streamChat(
      testRequest("openai-responses", null),
      new AbortController().signal
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "delta", text: "Hi" });
    expect(events).toContainEqual({ type: "message_end" });
  });
});
