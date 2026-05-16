import { describe, expect, it } from "vitest";

import { createGeminiProvider } from "../../../src/providers/adapters/gemini.js";
import { testRequest } from "./adapter-test-helpers.js";

describe("createGeminiProvider", () => {
  it("normalizes text from Gemini response format", async () => {
    const provider = createGeminiProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response('[{"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}]');
      }
    });

    const events = [];
    for await (const event of provider.streamChat(
      testRequest("gemini", null),
      new AbortController().signal
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "delta", text: "Hi" });
    expect(events).toContainEqual({ type: "message_end" });
  });
});
