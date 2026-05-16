import { describe, expect, it } from "vitest";

import { createLocalAgentBridgeProvider } from "../../../src/providers/adapters/local-agent-bridge.js";
import { testRequest } from "./adapter-test-helpers.js";

describe("createLocalAgentBridgeProvider", () => {
  it("normalizes newline-delimited local agent events", async () => {
    const provider = createLocalAgentBridgeProvider({
      fetch: async () => {
        await Promise.resolve();
        return new Response('{"event":"delta","text":"Hi"}\n{"event":"done"}\n');
      }
    });

    const events = [];
    for await (const event of provider.streamChat(
      testRequest("local-agent-bridge"),
      new AbortController().signal
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "delta", text: "Hi" });
    expect(events).toContainEqual({ type: "message_end" });
  });
});
