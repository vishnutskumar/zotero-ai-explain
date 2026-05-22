import { describe, expect, it, vi } from "vitest";

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
          pageLabel: null
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
          pageLabel: null
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

  it("sendFollowUp appends a user turn and streams the assistant reply", async () => {
    const provider: ModelProvider = {
      id: "ollama",
      displayName: "Ollama",
      async *streamChat() {
        await Promise.resolve();
        yield { type: "delta", text: "Inline " };
        yield { type: "delta", text: "follow-up reply" };
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
          pageLabel: null
        },
        anchor: null
      },
      ollamaProfile
    );
    store.appendUserMessage(conversation.id, "Explain this: Dense text.");
    store.appendAssistantDelta(conversation.id, "First answer");
    store.complete(conversation.id);

    await controller.sendFollowUp(conversation.id, "Why does it matter?");

    const updated = store.get(conversation.id);
    expect(updated?.messages).toEqual([
      { role: "user", content: "Explain this: Dense text." },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Why does it matter?" },
      { role: "assistant", content: "Inline follow-up reply" }
    ]);
    expect(updated?.status).toBe("completed");
  });

  it("sendFollowUp ignores empty / whitespace-only messages", async () => {
    const streamChat = vi.fn();
    const provider: ModelProvider = {
      id: "ollama",
      displayName: "Ollama",
      async *streamChat(request, signal) {
        streamChat(request, signal);
        yield { type: "message_end" };
        await Promise.resolve();
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
          pageLabel: null
        },
        anchor: null
      },
      ollamaProfile
    );

    await controller.sendFollowUp(conversation.id, "   ");
    expect(streamChat).not.toHaveBeenCalled();
    expect(store.get(conversation.id)?.messages).toEqual([]);
  });

  it("marks the conversation failed when the provider yields an error event", async () => {
    const provider: ModelProvider = {
      id: "ollama",
      displayName: "Ollama",
      async *streamChat() {
        await Promise.resolve();
        yield { type: "message_start", providerId: "ollama", model: "llama3.1" };
        yield {
          type: "error",
          message: "Could not reach Ollama at http://localhost:11434.",
          retryable: true
        };
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
          pageLabel: null
        },
        anchor: null
      },
      ollamaProfile
    );

    await controller.explain(conversation.id);

    const updated = store.get(conversation.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorMessage).toBe("Could not reach Ollama at http://localhost:11434.");
  });
});
