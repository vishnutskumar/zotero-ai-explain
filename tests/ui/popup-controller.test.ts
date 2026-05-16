import { describe, expect, it } from "vitest";

import { createConversationStore } from "../../src/conversation/conversation-store.js";
import type { ModelProvider, ProviderProfile } from "../../src/providers/provider-types.js";
import { createPopupController } from "../../src/ui/popup-controller.js";

const profile: ProviderProfile = {
  id: "openai",
  displayName: "OpenAI",
  kind: "openai-responses",
  baseUrl: null,
  model: "gpt-test",
  secret: { kind: "environment", name: "PROVIDER_TOKEN_REF" },
  sendMode: "remote",
  enabled: true
};

const ollamaProfile: ProviderProfile = {
  id: "ollama",
  displayName: "Ollama",
  kind: "ollama",
  baseUrl: "http://localhost:11434",
  model: "llama3.1",
  secret: { kind: "none" },
  sendMode: "local",
  enabled: true
};

describe("createPopupController", () => {
  it("streams explanation deltas into the conversation", async () => {
    const provider: ModelProvider = {
      id: "openai-responses",
      displayName: "OpenAI",
      async *streamChat() {
        await Promise.resolve();
        yield { type: "message_start", providerId: "openai-responses", model: "gpt-test" };
        yield { type: "delta", text: "Clear " };
        yield { type: "delta", text: "answer" };
        yield { type: "message_end" };
      }
    };

    const store = createConversationStore();
    const controller = createPopupController({ store, provider });
    const conversation = store.createFromSelection(
      {
        quote: "Dense text.",
        source: {
          itemKey: null,
          itemTitle: null,
          attachmentKey: null,
          pageLabel: null,
          location: null
        },
        anchor: null
      },
      profile
    );

    await controller.explain(conversation.id);

    expect(store.get(conversation.id)).toMatchObject({
      status: "completed",
      messages: [{ role: "assistant", content: "Clear answer" }]
    });
  });

  it("streams explanation deltas from an ollama provider", async () => {
    const provider: ModelProvider = {
      id: "ollama",
      displayName: "Ollama",
      async *streamChat() {
        await Promise.resolve();
        yield { type: "message_start", providerId: "ollama", model: "llama3.1" };
        yield { type: "delta", text: "Local " };
        yield { type: "delta", text: "answer" };
        yield { type: "message_end" };
      }
    };

    const store = createConversationStore();
    const controller = createPopupController({ store, provider });
    const conversation = store.createFromSelection(
      {
        quote: "Dense text.",
        source: {
          itemKey: null,
          itemTitle: null,
          attachmentKey: null,
          pageLabel: null,
          location: null
        },
        anchor: null
      },
      ollamaProfile
    );

    await controller.explain(conversation.id);

    expect(store.get(conversation.id)).toMatchObject({
      status: "completed",
      messages: [{ role: "assistant", content: "Local answer" }]
    });
  });
});
