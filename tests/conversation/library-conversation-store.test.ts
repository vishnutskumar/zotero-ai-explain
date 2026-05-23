import { describe, expect, it } from "vitest";

import { createLibraryConversationStore } from "../../src/conversation/library-conversation-store.js";
import { buildCitationLookup } from "../../src/ui/citation-lookup.js";
import type { CitationLookup } from "../../src/ui/citation-lookup.js";
import type { RetrievedChunk } from "../../src/indexing/index-search.js";

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

/**
 * Fault Localization: AC-6 — per-message citation lookup tables on the store.
 *
 * ### PHASE 1 — SPEC SEMANTICS
 * - PREMISE S1: `LibraryChatState` gains `citationLookups:
 *   ReadonlyMap<number, CitationLookup>` keyed by the assistant message's index.
 * - PREMISE S2: `attachCitationLookup(messageIndex, lookup)` pins a lookup table
 *   to a specific message index. The table is per-TURN — attaching turn 2's
 *   table must NOT overwrite turn 1's.
 * - PREMISE S3: initial state has an empty `citationLookups` map.
 * - PREMISE S4: `reset()` clears the `citationLookups` map alongside messages.
 *
 * ### PHASE 3 — DIVERGENCE ANALYSIS
 * - CLAIM D1: the store may keep a single (singleton) lookup, so a later
 *   attach overwrites an earlier turn's table.
 * - CLAIM D2: `reset()` may clear messages but leak stale lookup tables.
 * - CLAIM D3: `attachCitationLookup` may not notify subscribers, so the view
 *   never re-renders with the resolved citations.
 */
describe("LibraryConversationStore.attachCitationLookup", () => {
  function chunk(over: Partial<RetrievedChunk> = {}): RetrievedChunk {
    return { itemKey: "ABCD1234", title: "T", text: "x", score: 0.9, chunkIndex: 0, ...over };
  }
  function lookupWithPage(pageIndex: number): CitationLookup {
    return buildCitationLookup([
      chunk({ itemKey: "ABCD1234", chunkIndex: 0, attachmentKey: "ATT00001", pageIndex })
    ]);
  }

  it("starts with an empty citationLookups map", () => {
    // PREMISE S3.
    const store = createLibraryConversationStore();
    expect(store.getState().citationLookups.size).toBe(0);
  });

  it("pins a lookup table to a specific message index", () => {
    const store = createLibraryConversationStore();
    store.appendUserMessage("Q1");
    store.markStreaming();
    store.appendAssistantDelta("A1 [ABCD1234#0]");
    store.complete();
    store.attachCitationLookup(1, lookupWithPage(2));
    const table = store.getState().citationLookups.get(1);
    expect(table).toBeDefined();
    expect(table?.get("ABCD1234#0")?.pageIndex).toBe(2);
  });

  it("keeps each turn's table separate — a later attach does not overwrite an earlier one", () => {
    // Adversarial D1 / PREMISE S2.
    const store = createLibraryConversationStore();
    store.appendUserMessage("Q1");
    store.appendAssistantDelta("A1 [ABCD1234#0]");
    store.attachCitationLookup(1, lookupWithPage(2));
    store.appendUserMessage("Q2");
    store.appendAssistantDelta("A2 [ABCD1234#0]");
    store.attachCitationLookup(3, lookupWithPage(40));

    const lookups = store.getState().citationLookups;
    expect(lookups.get(1)?.get("ABCD1234#0")?.pageIndex).toBe(2);
    expect(lookups.get(3)?.get("ABCD1234#0")?.pageIndex).toBe(40);
  });

  it("clears the citationLookups map on reset()", () => {
    // Adversarial D2 / PREMISE S4.
    const store = createLibraryConversationStore();
    store.appendUserMessage("Q1");
    store.appendAssistantDelta("A1");
    store.attachCitationLookup(1, lookupWithPage(2));
    store.reset();
    expect(store.getState().citationLookups.size).toBe(0);
  });

  it("notifies subscribers when a lookup table is attached", () => {
    // Adversarial D3.
    const store = createLibraryConversationStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.attachCitationLookup(1, lookupWithPage(2));
    unsubscribe();
    expect(notifications).toBeGreaterThan(0);
  });
});
