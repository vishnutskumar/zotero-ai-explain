import { describe, expect, it } from "vitest";

import { createLibraryConversationStore } from "../../src/conversation/library-conversation-store.js";

describe("createLibraryConversationStore", () => {
  it("starts in an idle state with an empty message list", () => {
    const store = createLibraryConversationStore();
    const snapshot = store.getState();
    expect(snapshot.status).toBe("idle");
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.errorMessage).toBeNull();
  });

  it("appends user messages and streaming-state assistant deltas", () => {
    const store = createLibraryConversationStore();
    store.appendUserMessage("What is the topic?");
    store.markStreaming();
    store.appendAssistantDelta("It ");
    store.appendAssistantDelta("is X.");
    store.complete();

    const snapshot = store.getState();
    expect(snapshot.status).toBe("completed");
    expect(snapshot.messages).toEqual([
      { role: "user", content: "What is the topic?" },
      { role: "assistant", content: "It is X." }
    ]);
  });

  it("captures failures and stops appending deltas implicitly via state", () => {
    const store = createLibraryConversationStore();
    store.appendUserMessage("Question");
    store.markStreaming();
    store.fail("Could not reach provider");
    const snapshot = store.getState();
    expect(snapshot.status).toBe("failed");
    expect(snapshot.errorMessage).toBe("Could not reach provider");
  });

  it("resets the conversation to idle and clears messages", () => {
    const store = createLibraryConversationStore();
    store.appendUserMessage("First");
    store.markStreaming();
    store.appendAssistantDelta("Reply");
    store.complete();
    store.reset();
    expect(store.getState()).toMatchObject({
      status: "idle",
      messages: [],
      errorMessage: null
    });
  });

  it("notifies subscribers on every mutation and stops after unsubscribe", () => {
    const store = createLibraryConversationStore();
    const statuses: string[] = [];
    const unsubscribe = store.subscribe((s) => {
      statuses.push(s.status);
    });
    store.appendUserMessage("hi");
    store.markStreaming();
    store.appendAssistantDelta("ok");
    store.complete();
    unsubscribe();
    store.reset();
    expect(statuses).toEqual(["idle", "streaming", "streaming", "completed"]);
  });

  it("preserves prior turns as a multi-turn thread", () => {
    const store = createLibraryConversationStore();
    store.appendUserMessage("Q1");
    store.markStreaming();
    store.appendAssistantDelta("A1");
    store.complete();
    store.appendUserMessage("Q2");
    store.markStreaming();
    store.appendAssistantDelta("A2");
    store.complete();
    expect(store.getState().messages).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
      { role: "assistant", content: "A2" }
    ]);
  });
});
