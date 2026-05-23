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
    pageLabel: "3"
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

  it("notifies subscribers of every mutation and stops after unsubscribe", () => {
    const store = createConversationStore();
    const created = store.createFromSelection(selection, profile);

    const snapshots: { status: string; messages: number }[] = [];
    const unsubscribe = store.subscribe(created.id, (conversation) => {
      snapshots.push({
        status: conversation.status,
        messages: conversation.messages.length
      });
    });

    store.appendUserMessage(created.id, "Explain this.");
    store.markStreaming(created.id);
    store.appendAssistantDelta(created.id, "It ");
    store.appendAssistantDelta(created.id, "means");
    store.complete(created.id);

    expect(snapshots).toEqual([
      { status: "idle", messages: 1 },
      { status: "streaming", messages: 1 },
      { status: "streaming", messages: 2 },
      { status: "streaming", messages: 2 },
      { status: "completed", messages: 2 }
    ]);

    unsubscribe();
    store.moveToSidebar(created.id);
    store.appendUserMessage(created.id, "Follow up?");

    expect(snapshots).toHaveLength(5);
  });
});
