import { describe, expect, it } from "vitest";

import { createCustomHttpProvider } from "../../../src/providers/adapters/custom-http.js";
import { testRequest } from "./adapter-test-helpers.js";

describe("createCustomHttpProvider", () => {
  it("normalizes text from custom HTTP JSON format", async () => {
    const provider = createCustomHttpProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response('{"text":"Hi"}');
      }
    });

    const events = [];
    for await (const event of provider.streamChat(
      testRequest("custom-http", "https://example.test"),
      new AbortController().signal
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "delta", text: "Hi" });
    expect(events).toContainEqual({ type: "message_end" });
  });
});
