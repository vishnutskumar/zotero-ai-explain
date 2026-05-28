/* @vitest-environment jsdom */

/**
 * F3 adversarial test — per-message-index citation lookups for the
 * popup/sidebar explain flow.
 *
 * ### PHASE 1 — SPEC SEMANTICS
 * - PREMISE S1: every retrieval that fires inside an explain conversation
 *   must pin its lookup table to the SPECIFIC assistant-turn index it
 *   feeds. Two retrievals in the same conversation must produce two
 *   distinct entries in `conversation.citationLookups`, keyed by the
 *   assistant message indices of the two turns.
 * - PREMISE S2: re-rendering an EARLIER turn must use THAT turn's table.
 *   The pre-F3 bug: both turns shared a mutable `lookupRef.current`, so
 *   a follow-up retrieval overwrote the first turn's lookup; the popup
 *   then re-rendered turn 1 against turn 2's chunks, jumping
 *   `[KEY#0]` to the wrong page.
 *
 * ### PHASE 2 — BLACK-BOX PROBE
 * The probe drives the runtime through the public surface only:
 *   - a real `ConversationStore` (`createConversationStore`),
 *   - a `popupRetrievalChannel` we synthesise so we can publish two
 *     retrievals with different chunk-0 page indices for the same
 *     itemKey,
 *   - the explain reader command (registered by `runtime.startup()`),
 *   - the popup controller's `sendFollowUp` mocked so we can drive a
 *     SECOND assistant turn without spinning up a real provider.
 *
 * Adversarial assertion: turn 1's `[KEY#0]` anchor's `dataset.pageIndex`
 * differs from turn 2's. If a mutable shared lookup were still in
 * play, both anchors would carry the SAME page (the last-written
 * value), and the assertion would fail.
 *
 * Black-box: no internal helpers imported. Imports the public
 * `createConversationStore`, `createZoteroRuntime`, and
 * `buildCitationLookup` ergonomics from the source tree.
 */

import { describe, expect, it, vi } from "vitest";

import { createConversationStore } from "../../src/conversation/conversation-store.js";
import { createIndexingController } from "../../src/indexing/indexing-controller.js";
import { controllerStubDeps } from "../indexing/controller-test-helpers.js";
import {
  createZoteroRuntime,
  type PopupRetrievalChannel,
  type PopupRetrievalEvent
} from "../../src/platform/zotero-runtime.js";
import type { ZoteroUiAdapter } from "../../src/platform/zotero-ui-types.js";
import {
  createDefaultOllamaSettings,
  ollamaSettingsToProfile
} from "../../src/preferences/ollama-profile.js";
import type { PopupController } from "../../src/ui/popup-controller.js";
import type { SidebarController } from "../../src/ui/sidebar-controller.js";
import type { SelectionContext } from "../../src/selection/selection-context.js";
import type { RetrievedChunk } from "../../src/indexing/index-search.js";

function createSelection(): SelectionContext {
  return {
    quote: "Q",
    source: {
      itemKey: "I",
      itemTitle: "Paper",
      attachmentKey: "A",
      pageLabel: "1"
    },
    anchor: null
  };
}

function createFakeUi(calls: string[]): {
  readonly ui: ZoteroUiAdapter;
  readonly readerActions: ((selection: SelectionContext) => void)[];
} {
  const readerActions: ((selection: SelectionContext) => void)[] = [];
  const ui: ZoteroUiAdapter = {
    addMenuItem(label) {
      calls.push(`menu:${label}`);
      return () => calls.push(`remove-menu:${label}`);
    },
    addReaderCommands(commands) {
      for (const command of commands) {
        calls.push(`reader:${command.label}`);
        readerActions.push(command.action);
      }
      return () => undefined;
    },
    addReaderCommand(_label, action) {
      readerActions.push(action);
      return () => undefined;
    },
    openDialog(title, content) {
      calls.push(`dialog:${title}:${content.className}`);
      return {
        close: () => undefined,
        minimize: () => undefined,
        restore: () => undefined
      };
    },
    mountPopup(content) {
      document.body.append(content);
      return () => {
        content.remove();
      };
    },
    mountSidebar(content) {
      document.body.append(content);
      return () => {
        content.remove();
      };
    }
  };
  return { ui, readerActions };
}

function chunk(over: Partial<RetrievedChunk>): RetrievedChunk {
  return {
    itemKey: "ABCD1234",
    title: "Paper",
    text: "excerpt",
    score: 0.9,
    chunkIndex: 0,
    ...over
  };
}

describe("F3 — per-message-index citation lookups (popup explain flow)", () => {
  it("two retrievals on the same conversation produce two distinct lookups keyed by assistant message index", () => {
    const calls: string[] = [];
    const { ui, readerActions } = createFakeUi(calls);
    const store = createConversationStore();
    // Synthetic channel: tests publish chunks directly to subscribers.
    const subscribers = new Set<(event: PopupRetrievalEvent) => void>();
    const channel: PopupRetrievalChannel = {
      publish(event) {
        for (const s of subscribers) s(event);
      },
      subscribe(handler) {
        subscribers.add(handler);
        return () => {
          subscribers.delete(handler);
        };
      }
    };

    const popupController: PopupController = {
      explain: vi.fn(async () => Promise.resolve()),
      cancel: vi.fn(),
      retry: vi.fn(async () => Promise.resolve()),
      continueInSidebar: vi.fn(),
      // Sending a follow-up appends a USER message; the next retrieval's
      // subscriber callback will then key the new assistant turn at the
      // slot AFTER this user message.
      sendFollowUp: vi.fn((id: string, content: string) => {
        store.appendUserMessage(id, content);
        return Promise.resolve();
      })
    };
    const sidebarController: SidebarController = {
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };

    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        ...controllerStubDeps()
      }),
      ui,
      store,
      profile: () => ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController,
      sidebarController,
      disclosure: () => "disclosure",
      popupRetrievalChannel: channel
    });
    void runtime.startup();

    // Fire the "Explain with AI" reader command — the runtime registers
    // a subscriber on the channel for this conversation.
    readerActions[0]?.(createSelection());

    // ConversationStore lifecycle on startExplain: appendSystemMessage
    // (source frame, since the selection has itemKey/title/page),
    // then appendUserMessage. messages.length == 2 at this point.
    // The first retrieval's subscriber will pin its lookup to slot 2
    // (the next assistant delta lands there). HIGH-1: include the
    // conversationId on the publish so the runtime's filter accepts it.
    const convId = conversationId(store);
    channel.publish({
      conversationId: convId,
      chunks: [
        chunk({ itemKey: "ABCD1234", chunkIndex: 0, attachmentKey: "ATT00001", pageIndex: 2 })
      ]
    });
    // Simulate the assistant's first delta arriving — appends an
    // assistant message at index 2.
    store.appendAssistantDelta(convId, "Turn 1 says [ABCD1234#0].");

    // User sends a follow-up. Append the user turn at index 3.
    store.appendUserMessage(convId, "follow-up?");
    // The second retrieval lands here; the next assistant turn will be
    // at index 4. Publish chunks with a different pageIndex for the
    // SAME chunk-0 of the SAME itemKey, exercising the bug scenario.
    channel.publish({
      conversationId: convId,
      chunks: [
        chunk({ itemKey: "ABCD1234", chunkIndex: 0, attachmentKey: "ATT00001", pageIndex: 40 })
      ]
    });
    store.appendAssistantDelta(convId, "Turn 2 says [ABCD1234#0].");

    // Read the store back. Two distinct lookups must exist, keyed by
    // the two distinct assistant indices, carrying DIFFERENT page
    // indices for the same `ABCD1234#0` key.
    const conv = store.get(conversationId(store));
    expect(conv).not.toBeNull();
    if (conv === null) return;
    const lookups = conv.citationLookups;
    // Find the assistant indices that have lookups attached.
    const turn1Lookup = lookups.get(2);
    const turn2Lookup = lookups.get(4);
    expect(turn1Lookup, "turn 1 lookup must exist at message index 2").toBeDefined();
    expect(turn2Lookup, "turn 2 lookup must exist at message index 4").toBeDefined();
    // Adversarial: the two turns' `ABCD1234#0` resolve to DIFFERENT
    // pageIndex values. If a shared mutable lookup were still in play,
    // both would carry the last-written 40.
    expect(turn1Lookup?.get("ABCD1234#0")?.pageIndex).toBe(2);
    expect(turn2Lookup?.get("ABCD1234#0")?.pageIndex).toBe(40);
  });

  it("the rendered popup anchors for two assistant turns carry DIFFERENT data-page-index for the same [KEY#0]", () => {
    // End-to-end adversarial check on the live DOM. Pre-F3 this test
    // would observe turn 1's anchor stamped with turn 2's page (the
    // mutable shared lookup got overwritten before the re-render).
    const calls: string[] = [];
    const { ui, readerActions } = createFakeUi(calls);
    const store = createConversationStore();
    const subscribers = new Set<(event: PopupRetrievalEvent) => void>();
    const channel: PopupRetrievalChannel = {
      publish(event) {
        for (const s of subscribers) s(event);
      },
      subscribe(handler) {
        subscribers.add(handler);
        return () => {
          subscribers.delete(handler);
        };
      }
    };

    const popupController: PopupController = {
      explain: vi.fn(async () => Promise.resolve()),
      cancel: vi.fn(),
      retry: vi.fn(async () => Promise.resolve()),
      continueInSidebar: vi.fn(),
      sendFollowUp: vi.fn((id: string, content: string) => {
        store.appendUserMessage(id, content);
        return Promise.resolve();
      })
    };
    const sidebarController: SidebarController = {
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };

    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        ...controllerStubDeps()
      }),
      ui,
      store,
      profile: () => ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController,
      sidebarController,
      disclosure: () => "disclosure",
      popupRetrievalChannel: channel
    });
    void runtime.startup();
    readerActions[0]?.(createSelection());
    const id = conversationId(store);

    // Turn 1: retrieval -> assistant delta. HIGH-1: stamp the conversation
    // id on each publish so the runtime's per-conversation subscriber
    // accepts the event.
    channel.publish({
      conversationId: id,
      chunks: [chunk({ chunkIndex: 0, attachmentKey: "ATT00001", pageIndex: 2 })]
    });
    store.appendAssistantDelta(id, "Turn 1 cites [ABCD1234#0].");

    // Turn 2: user follow-up -> retrieval -> assistant delta. The
    // follow-up arrives via the controller's `sendFollowUp` which
    // appends a user message; here we append directly to mimic the
    // post-user-turn state.
    store.appendUserMessage(id, "more?");
    channel.publish({
      conversationId: id,
      chunks: [chunk({ chunkIndex: 0, attachmentKey: "ATT00001", pageIndex: 40 })]
    });
    store.appendAssistantDelta(id, "Turn 2 cites [ABCD1234#0].");

    // The runtime's popup `subscribe` callback re-renders on every
    // store mutation; after the four deltas above the popup body +
    // turns container hold the full conversation.
    const popup = document.querySelector(".zotero-ai-explain-popup");
    expect(popup, "popup must be mounted").not.toBeNull();
    // First-assistant turn lives in `.zotero-ai-explain-popup__body`;
    // follow-up assistant turns live in
    // `.zotero-ai-explain-popup__turns`. Query both.
    const body = popup?.querySelector<HTMLElement>(".zotero-ai-explain-popup__body");
    const turnsContainer = popup?.querySelector<HTMLElement>(".zotero-ai-explain-popup__turns");
    const turn1Anchor = body?.querySelector<HTMLAnchorElement>("a[data-item-key]");
    const turn2Anchor = turnsContainer?.querySelector<HTMLAnchorElement>("a[data-item-key]");

    expect(turn1Anchor, "turn 1 anchor must render").not.toBeNull();
    expect(turn2Anchor, "turn 2 anchor must render").not.toBeNull();
    // The load-bearing assertion: the two turns' anchors point to
    // DIFFERENT pages. If a shared mutable lookup were still in play
    // both anchors would carry the same `data-page-index`.
    expect(turn1Anchor?.dataset.pageIndex).toBe("2");
    expect(turn2Anchor?.dataset.pageIndex).toBe("40");
  });

  // -------------------------------------------------------------------
  // HIGH-1 — cross-conversation isolation.
  //
  // The popupRetrievalChannel is a single global publisher. Pre-fix,
  // every conversation's subscriber received every publish, so
  // conversation A publishing a retrieval would also attach its lookup
  // to conversation B's store. The fix stamps a `conversationId` on
  // each publish and has subscribers filter by it.
  // -------------------------------------------------------------------
  it("HIGH-1: a publish stamped with conversation A's id does NOT contaminate conversation B's lookups", () => {
    const calls: string[] = [];
    const { ui, readerActions } = createFakeUi(calls);
    const store = createConversationStore();
    const subscribers = new Set<(event: PopupRetrievalEvent) => void>();
    const channel: PopupRetrievalChannel = {
      publish(event) {
        for (const s of subscribers) s(event);
      },
      subscribe(handler) {
        subscribers.add(handler);
        return () => {
          subscribers.delete(handler);
        };
      }
    };
    const popupController: PopupController = {
      explain: vi.fn(async () => Promise.resolve()),
      cancel: vi.fn(),
      retry: vi.fn(async () => Promise.resolve()),
      continueInSidebar: vi.fn(),
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };
    const sidebarController: SidebarController = {
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        ...controllerStubDeps()
      }),
      ui,
      store,
      profile: () => ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController,
      sidebarController,
      disclosure: () => "disclosure",
      popupRetrievalChannel: channel
    });
    void runtime.startup();
    // Start TWO conversations. Each registers its own subscriber on the
    // shared channel.
    readerActions[0]?.(createSelection());
    const idA = "conversation-1";
    readerActions[0]?.(createSelection());
    const idB = "conversation-2";
    expect(store.get(idA)).not.toBeNull();
    expect(store.get(idB)).not.toBeNull();
    // Only conversation A publishes a retrieval.
    channel.publish({
      conversationId: idA,
      chunks: [chunk({ chunkIndex: 0, pageIndex: 7 })]
    });
    // Conversation B's citationLookups MUST still be empty — the
    // subscriber filter rejected the foreign publish.
    const convA = store.get(idA);
    const convB = store.get(idB);
    expect(convA?.citationLookups.size).toBe(1);
    expect(convB?.citationLookups.size).toBe(0);
  });

  // -------------------------------------------------------------------
  // MED-5 — mid-stream re-retrieval must NOT overwrite the in-flight
  // assistant turn's lookup.
  //
  // When the trailing message is the streaming assistant turn, a
  // late-arriving retrieval used to pin its lookup to that same index
  // and clobber the in-flight chunks. The fix only pins when the last
  // message is the user's question.
  // -------------------------------------------------------------------
  it("MED-5: publish while the trailing message is a streaming assistant turn does NOT overwrite the existing lookup", () => {
    const calls: string[] = [];
    const { ui, readerActions } = createFakeUi(calls);
    const store = createConversationStore();
    const subscribers = new Set<(event: PopupRetrievalEvent) => void>();
    const channel: PopupRetrievalChannel = {
      publish(event) {
        for (const s of subscribers) s(event);
      },
      subscribe(handler) {
        subscribers.add(handler);
        return () => {
          subscribers.delete(handler);
        };
      }
    };
    const popupController: PopupController = {
      explain: vi.fn(async () => Promise.resolve()),
      cancel: vi.fn(),
      retry: vi.fn(async () => Promise.resolve()),
      continueInSidebar: vi.fn(),
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };
    const sidebarController: SidebarController = {
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        ...controllerStubDeps()
      }),
      ui,
      store,
      profile: () => ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController,
      sidebarController,
      disclosure: () => "disclosure",
      popupRetrievalChannel: channel
    });
    void runtime.startup();
    readerActions[0]?.(createSelection());
    const id = conversationId(store);
    // Stream landed: assistant turn at index 2 with an attached lookup.
    channel.publish({
      conversationId: id,
      chunks: [chunk({ chunkIndex: 0, pageIndex: 5 })]
    });
    store.appendAssistantDelta(id, "streaming...");
    // Trailing message is now the in-flight assistant turn. A late
    // publish (race scenario) MUST be ignored — pinning would clobber
    // the lookup the popup is already rendering against.
    channel.publish({
      conversationId: id,
      chunks: [chunk({ chunkIndex: 0, pageIndex: 99 })]
    });
    const conv = store.get(id);
    // The lookup at index 2 must still carry pageIndex 5 — the late
    // publish was discarded.
    expect(conv?.citationLookups.get(2)?.get("ABCD1234#0")?.pageIndex).toBe(5);
  });

  // -------------------------------------------------------------------
  // MED-6 — system-last guard. A publish that fires when the trailing
  // message is a `system` message must not pin to the user's about-to-
  // append slot. The fix requires `last.role === "user"` before pinning.
  // -------------------------------------------------------------------
  it("MED-6: publish while the trailing message is `system` is dropped (no lookup attached)", () => {
    const calls: string[] = [];
    const { ui, readerActions } = createFakeUi(calls);
    const store = createConversationStore();
    const subscribers = new Set<(event: PopupRetrievalEvent) => void>();
    const channel: PopupRetrievalChannel = {
      publish(event) {
        for (const s of subscribers) s(event);
      },
      subscribe(handler) {
        subscribers.add(handler);
        return () => {
          subscribers.delete(handler);
        };
      }
    };
    const popupController: PopupController = {
      explain: vi.fn(async () => Promise.resolve()),
      cancel: vi.fn(),
      retry: vi.fn(async () => Promise.resolve()),
      continueInSidebar: vi.fn(),
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };
    const sidebarController: SidebarController = {
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        ...controllerStubDeps()
      }),
      ui,
      store,
      profile: () => ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController,
      sidebarController,
      disclosure: () => "disclosure",
      popupRetrievalChannel: channel
    });
    void runtime.startup();
    // Use a selection with NO PDF identity so startExplain does NOT
    // seed the source-frame system message before the user turn.
    // Then we inject a system message manually so the trailing message
    // is `system` when we publish.
    readerActions[0]?.({
      quote: "Q",
      source: { itemKey: null, itemTitle: null, attachmentKey: null, pageLabel: null },
      anchor: null
    });
    const id = conversationId(store);
    // After startExplain: only the user message (the selection had no
    // identity, so describeSourceFrame returned null and no system
    // message was appended). Append a trailing system message manually.
    store.appendSystemMessage(id, "late system frame");
    // Now publish. The trailing message is `system`; the subscriber
    // must drop the event entirely.
    channel.publish({
      conversationId: id,
      chunks: [chunk({ chunkIndex: 0, pageIndex: 11 })]
    });
    const conv = store.get(id);
    // No lookup attached at any index — the subscriber bailed.
    expect(conv?.citationLookups.size).toBe(0);
  });
});

/**
 * Recover the conversation id minted by the runtime's `startExplain`
 * call. The ConversationStore mints ids `conversation-1`,
 * `conversation-2`, … monotonically; the first explain in a fresh
 * store always produces `conversation-1`.
 */
function conversationId(store: ReturnType<typeof createConversationStore>): string {
  if (store.get("conversation-1") !== null) return "conversation-1";
  throw new Error("expected conversation-1 to be registered");
}
