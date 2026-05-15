import { describe, expect, it } from "vitest";

import { createConversationStore } from "../../src/conversation/conversation-store.js";
import type { ProviderProfile } from "../../src/providers/provider-types.js";
import type { SelectionContext } from "../../src/selection/selection-context.js";

const selection: SelectionContext = {
  quote: "A dense quote.",
  source: {
    itemKey: "I",
    itemTitle: "Paper",
    attachmentKey: "A",
    pageLabel: "3",
    location: "page=3"
  },
  anchor: null
};

const profile: ProviderProfile = {
  id: "local",
  displayName: "Local",
  kind: "openai-compatible",
  baseUrl: "http://localhost:11434",
  model: "llama",
  secret: { kind: "none" },
  sendMode: "local",
  enabled: true
};

describe("createConversationStore", () => {
  it("moves a popup conversation to the sidebar without losing context", () => {
    const store = createConversationStore();
    const created = store.createFromSelection(selection, profile);

    store.appendUserMessage(created.id, "Explain this.");
    store.appendAssistantDelta(created.id, "It means");
    store.moveToSidebar(created.id);

    expect(store.get(created.id)).toMatchObject({
      selection,
      profile,
      visibleSurface: "sidebar",
      messages: [
        { role: "user", content: "Explain this." },
        { role: "assistant", content: "It means" }
      ]
    });
  });

  it("preserves context when a stream is cancelled", () => {
    const store = createConversationStore();
    const created = store.createFromSelection(selection, profile);

    store.markStreaming(created.id);
    store.cancel(created.id);

    expect(store.get(created.id)).toMatchObject({
      selection,
      status: "cancelled",
      errorMessage: null
    });
  });
});
