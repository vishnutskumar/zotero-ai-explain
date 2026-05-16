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
      pageLabel: "4",
      location: "page 4"
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
});
