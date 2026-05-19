import { describe, expect, it } from "vitest";

import { createConversationStore } from "../../src/conversation/conversation-store.js";
import type { ModelProvider, ProviderProfile } from "../../src/providers/provider-types.js";
import { createSidebarController } from "../../src/ui/sidebar-controller.js";

const profile: ProviderProfile = {
  id: "local",
  displayName: "Ollama",
  kind: "openai-compatible",
  baseUrl: "http://localhost:11434",
  model: "llama3",
  secret: { kind: "none" },
  sendMode: "local",
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

describe("createSidebarController", () => {
  it("adds follow-up messages to the existing conversation", async () => {
    const provider: ModelProvider = {
      id: "openai-compatible",
      displayName: "Ollama",
      async *streamChat() {
        await Promise.resolve();
        yield { type: "delta", text: "Follow-up answer" };
        yield { type: "message_end" };
      }
    };
    const store = createConversationStore();
    const conversation = store.createFromSelection(
      {
        quote: "Dense text.",
        source: {
          itemKey: "I",
          itemTitle: "Paper",
          attachmentKey: "A",
          pageLabel: "1",
          location: "page=1"
        },
        anchor: null
      },
      profile
    );
    store.moveToSidebar(conversation.id);

    await createSidebarController({ store, provider }).sendFollowUp(
      conversation.id,
      "Why does it matter?"
    );

    expect(store.get(conversation.id)?.messages).toEqual([
      { role: "user", content: "Why does it matter?" },
      { role: "assistant", content: "Follow-up answer" }
    ]);
  });

  it("appends follow-up deltas from an ollama provider", async () => {
    const provider: ModelProvider = {
      id: "ollama",
      displayName: "Ollama",
      async *streamChat() {
        await Promise.resolve();
        yield { type: "delta", text: "Ollama follow-up" };
        yield { type: "message_end" };
      }
    };
    const store = createConversationStore();
    const conversation = store.createFromSelection(
      {
        quote: "Dense text.",
        source: {
          itemKey: "I",
          itemTitle: "Paper",
          attachmentKey: "A",
          pageLabel: "1",
          location: "page=1"
        },
        anchor: null
      },
      ollamaProfile
    );
    store.moveToSidebar(conversation.id);

    await createSidebarController({ store, provider }).sendFollowUp(
      conversation.id,
      "Why does it matter?"
    );

    expect(store.get(conversation.id)?.messages).toEqual([
      { role: "user", content: "Why does it matter?" },
      { role: "assistant", content: "Ollama follow-up" }
    ]);
  });

  /**
   * M5 (Phase 4b codex review) — sidebar follow-up must honor provider
   * `error` events.
   *
   * Pre-fix, the controller only handled `delta` events and always
   * called store.complete() when the iterator finished. An in-band
   * provider error (yielded as `{type: "error"}` for e.g. OpenAI 401
   * or Ollama "model not found") was silently swallowed and the
   * sidebar rendered a blank successful turn.
   */
  it("M5: surfaces a provider error event via store.fail() (not complete)", async () => {
    const provider: ModelProvider = {
      id: "openai-chat",
      displayName: "OpenAI",
      async *streamChat() {
        await Promise.resolve();
        yield {
          type: "error",
          message: "OpenAI error (401): Invalid API key.",
          retryable: false
        };
        // No further deltas or message_end — mirrors the adapter
        // behavior of returning after an error event.
      }
    };
    const store = createConversationStore();
    const conversation = store.createFromSelection(
      {
        quote: "Dense text.",
        source: {
          itemKey: "I",
          itemTitle: "Paper",
          attachmentKey: "A",
          pageLabel: "1",
          location: "page=1"
        },
        anchor: null
      },
      profile
    );
    store.moveToSidebar(conversation.id);

    await createSidebarController({ store, provider }).sendFollowUp(
      conversation.id,
      "Why does it matter?"
    );

    const updated = store.get(conversation.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorMessage).toMatch(/invalid api key/iu);
    // The user message was appended; no assistant turn was created.
    expect(updated?.messages).toEqual([{ role: "user", content: "Why does it matter?" }]);
  });

  it("M5: a delta followed by an error event preserves the partial delta and still fails", async () => {
    const provider: ModelProvider = {
      id: "openai-chat",
      displayName: "OpenAI",
      async *streamChat() {
        await Promise.resolve();
        yield { type: "delta", text: "Partial " };
        yield {
          type: "error",
          message: "Stream truncated.",
          retryable: true
        };
      }
    };
    const store = createConversationStore();
    const conversation = store.createFromSelection(
      {
        quote: "x",
        source: {
          itemKey: "I",
          itemTitle: null,
          attachmentKey: null,
          pageLabel: null,
          location: null
        },
        anchor: null
      },
      profile
    );
    store.moveToSidebar(conversation.id);

    await createSidebarController({ store, provider }).sendFollowUp(conversation.id, "go");

    const updated = store.get(conversation.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.errorMessage).toContain("Stream truncated");
    // The user can see what got streamed before the failure.
    expect(updated?.messages).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "Partial " }
    ]);
  });
});
