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
});
