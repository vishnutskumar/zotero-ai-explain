/* @vitest-environment jsdom */

/**
 * Integration tests for the NotebookLM-style library-chat flow.
 *
 * The flow under test:
 *   1. User opens "Ask your library" via Tools menu.
 *   2. Types a question, submits.
 *   3. Runtime embeds the question via the embedding provider.
 *   4. Runtime retrieves top-K chunks from the persisted IndexFile.
 *   5. Runtime invokes provider.streamChat with a prompt that contains
 *      the excerpts; deltas accumulate into the visible assistant body.
 *   6. Citations rendered in the assistant message become clickable links
 *      that invoke the openItem callback with the matching item key.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConversationStore } from "../../src/conversation/conversation-store.js";
import { createIndexingController } from "../../src/indexing/indexing-controller.js";
import type { IndexFile } from "../../src/indexing/library-crawler.js";
import type { IndexStorage } from "../../src/indexing/index-storage.js";
import { createZoteroRuntime } from "../../src/platform/zotero-runtime.js";
import type { ZoteroUiAdapter } from "../../src/platform/zotero-ui-types.js";
import {
  createDefaultOllamaSettings,
  ollamaSettingsToProfile
} from "../../src/preferences/ollama-profile.js";
import type {
  ChatEvent,
  EmbeddingProvider,
  ModelProvider
} from "../../src/providers/provider-types.js";
import type { PopupController } from "../../src/ui/popup-controller.js";
import type { SidebarController } from "../../src/ui/sidebar-controller.js";
import { stubCrawlerProvider, stubCrawlerSettings } from "../indexing/controller-test-helpers.js";

function makeIndex(): IndexFile {
  // 3-dim embeddings; "ALPHA001" sits on the X axis so a query of [1,0,0]
  // ranks it first. Item keys are 8-char (Zotero's key shape) — AC-6's
  // citation token alphabet is exactly `[A-Z0-9]{8}`.
  return {
    schemaVersion: 2,
    indexedAt: new Date(0).toISOString(),
    items: {
      ALPHA001: {
        title: "Alpha paper",
        chunks: [
          { text: "ALPHA contains X.", embedding: [1, 0, 0], sourceKind: "metadata" },
          {
            text: "ALPHA also has unrelated content.",
            embedding: [0, 1, 0],
            sourceKind: "metadata"
          }
        ]
      },
      BETA0001: {
        title: "Beta paper",
        chunks: [
          {
            text: "BETA mentions X tangentially.",
            embedding: [0.5, 0.5, 0],
            sourceKind: "metadata"
          }
        ]
      }
    }
  };
}

function fakeStorage(file: IndexFile | null): IndexStorage {
  return {
    read() {
      return Promise.resolve(file);
    },
    readWithMigration() {
      return Promise.resolve({ file, migrationPending: false });
    },
    readItemCount() {
      return Promise.resolve(file === null ? 0 : Object.keys(file.items).length);
    },
    write() {
      return Promise.resolve();
    },
    writeItem() {
      return Promise.resolve();
    },
    writeTmp() {
      return Promise.resolve();
    },
    commitMigration() {
      return Promise.resolve();
    },
    abandonMigration() {
      return Promise.resolve();
    },
    writeMarker() {
      return Promise.resolve();
    },
    removeMarker() {
      return Promise.resolve();
    },
    hasMarker() {
      return Promise.resolve(false);
    },
    clear() {
      return Promise.resolve();
    },
    path() {
      return "/var/test-fixture/test.json";
    }
  };
}

/**
 * Shared fake-Zotero stub for the crawler. Hosted here (not inlined into
 * each runtime() spec) so the lint rule about async-without-await stays
 * silent at one place rather than at every call site.
 */
function fakeCrawlerZotero() {
  return {
    Libraries: { userLibraryID: 1 },
    Items: {
      getAll: () => Promise.resolve([]),
      get: () => null
    }
  };
}

function createFakeUi(calls: string[]): {
  readonly ui: ZoteroUiAdapter;
  readonly menuActions: Map<string, () => void>;
} {
  const menuActions = new Map<string, () => void>();
  const ui: ZoteroUiAdapter = {
    addMenuItem(label, action) {
      calls.push(`menu:${label}`);
      menuActions.set(label, action);
      return () => calls.push(`remove-menu:${label}`);
    },
    addReaderCommands(commands) {
      for (const command of commands) {
        calls.push(`reader:${command.label}`);
      }
      return () => {
        for (const command of commands) {
          calls.push(`remove-reader:${command.label}`);
        }
      };
    },
    addReaderCommand(label) {
      calls.push(`reader:${label}`);
      return () => calls.push(`remove-reader:${label}`);
    },
    openDialog(title, content) {
      calls.push(`dialog:${title}:${content.className}`);
      document.body.append(content);
      return {
        close: () => {
          calls.push(`close-dialog:${title}`);
          content.remove();
        },
        minimize: () => calls.push(`minimize-dialog:${title}`),
        restore: () => calls.push(`restore-dialog:${title}`)
      };
    },
    mountPopup(content) {
      calls.push(`popup:${content.className}`);
      document.body.append(content);
      return () => {
        content.remove();
      };
    },
    mountSidebar(content) {
      calls.push(`sidebar:${content.className}`);
      document.body.append(content);
      return () => {
        content.remove();
      };
    }
  };
  return { ui, menuActions };
}

function makeFakeProvider(opts: {
  readonly deltas: readonly string[];
  readonly capturedPrompts: string[][];
  readonly embedding?: readonly number[];
}): ModelProvider & EmbeddingProvider {
  async function* streamChat(request: {
    readonly messages: readonly { readonly content: string }[];
  }): AsyncIterable<ChatEvent> {
    opts.capturedPrompts.push(request.messages.map((m) => m.content));
    yield { type: "message_start", providerId: "ollama", model: "x" };
    for (const d of opts.deltas) {
      yield { type: "delta", text: d };
      await Promise.resolve();
    }
    yield { type: "message_end" };
  }
  return {
    id: "ollama",
    displayName: "Ollama",
    streamChat: (request) => streamChat(request),
    embedTexts(request) {
      const embedding = opts.embedding ?? [1, 0, 0];
      return Promise.resolve(request.texts.map(() => embedding));
    }
  };
}

describe("library chat integration", () => {
  afterEach(() => {
    // Each test mounts a fresh dialog via the fake UI's `openDialog`,
    // which appends to document.body. Vitest runs tests serially in the
    // same jsdom; without an explicit purge, stale dialog content from a
    // prior test leaks into the next test's querySelector results.
    document.body.replaceChildren();
  });

  it("registers an 'Ask your library' Tools menu entry on startup", async () => {
    const calls: string[] = [];
    const { ui } = createFakeUi(calls);
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
    const fakeProvider = makeFakeProvider({ deltas: [], capturedPrompts: [] });
    const indexStorage = fakeStorage(makeIndex());
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        zotero: fakeCrawlerZotero(),
        provider: stubCrawlerProvider(),
        settings: stubCrawlerSettings(),
        storage: indexStorage
      }),
      ui,
      store: createConversationStore(),
      profile: () => ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController,
      sidebarController,
      disclosure: () => "disclosure",
      libraryChat: {
        provider: fakeProvider,
        embeddingProvider: fakeProvider,
        indexStorage,
        embedSettings: { baseUrl: "http://localhost:11434", model: "embed" },
        openItem: vi.fn()
      }
    });

    await runtime.startup();
    expect(calls).toContain("menu:Ask your library");
    await runtime.shutdown();
  });

  it("opens a dialog and streams an answer that cites the top item key when the user submits a question", async () => {
    const calls: string[] = [];
    const { ui, menuActions } = createFakeUi(calls);
    const capturedPrompts: string[][] = [];
    const fakeProvider = makeFakeProvider({
      deltas: ["Alpha discusses X [ALPHA001#0]."],
      capturedPrompts,
      embedding: [1, 0, 0]
    });
    const indexStorage = fakeStorage(makeIndex());
    const openItem = vi.fn();
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        zotero: fakeCrawlerZotero(),
        provider: stubCrawlerProvider(),
        settings: stubCrawlerSettings(),
        storage: indexStorage
      }),
      ui,
      store: createConversationStore(),
      profile: () => ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController: {
        explain: vi.fn(async () => Promise.resolve()),
        cancel: vi.fn(),
        retry: vi.fn(async () => Promise.resolve()),
        continueInSidebar: vi.fn(),
        sendFollowUp: vi.fn(async () => Promise.resolve())
      },
      sidebarController: { sendFollowUp: vi.fn(async () => Promise.resolve()) },
      disclosure: () => "disclosure",
      libraryChat: {
        provider: fakeProvider,
        embeddingProvider: fakeProvider,
        indexStorage,
        embedSettings: { baseUrl: "http://localhost:11434", model: "embed" },
        openItem
      }
    });

    await runtime.startup();
    const openLibrary = menuActions.get("Ask your library");
    expect(openLibrary).toBeDefined();
    openLibrary?.();

    // Submit a question.
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '.zotero-ai-library-chat [name="question"]'
    );
    const form = document.querySelector<HTMLFormElement>(".zotero-ai-library-chat__form");
    expect(textarea).not.toBeNull();
    expect(form).not.toBeNull();
    if (textarea) {
      textarea.value = "What does ALPHA say about X?";
    }
    form?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    // Wait for async submit pipeline (embed + stream + render).
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }

    // The prompt must contain ALPHA001's excerpt with its chunk-scoped
    // `[itemKey#chunkIndex]` token (AC-6).
    expect(capturedPrompts.length).toBe(1);
    const prompt = capturedPrompts[0]?.join("\n") ?? "";
    expect(prompt).toContain("[ALPHA001#0]");
    expect(prompt).toContain("ALPHA contains X.");
    expect(prompt).toContain("Question: What does ALPHA say about X?");

    // The streamed answer should render as a clickable citation link that
    // resolves against the per-turn lookup table.
    const link = document.querySelector<HTMLAnchorElement>(
      ".zotero-ai-library-chat a[data-item-key]"
    );
    expect(link).not.toBeNull();
    expect(link?.dataset.itemKey).toBe("ALPHA001");
    link?.click();
    // AC-6/AC-7: `openItem` receives the resolved citation object, not a
    // bare string. The ALPHA001 chunk 0 is a metadata chunk so no page.
    expect(openItem).toHaveBeenCalledWith(expect.objectContaining({ itemKey: "ALPHA001" }));

    await runtime.shutdown();
  });

  it("shows an empty-state message when the index is missing instead of calling the provider", async () => {
    const calls: string[] = [];
    const { ui, menuActions } = createFakeUi(calls);
    const capturedPrompts: string[][] = [];
    const fakeProvider = makeFakeProvider({ deltas: ["Should not stream"], capturedPrompts });
    const indexStorage = fakeStorage(null); // no index
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        zotero: fakeCrawlerZotero(),
        provider: stubCrawlerProvider(),
        settings: stubCrawlerSettings(),
        storage: indexStorage
      }),
      ui,
      store: createConversationStore(),
      profile: () => ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController: {
        explain: vi.fn(async () => Promise.resolve()),
        cancel: vi.fn(),
        retry: vi.fn(async () => Promise.resolve()),
        continueInSidebar: vi.fn(),
        sendFollowUp: vi.fn(async () => Promise.resolve())
      },
      sidebarController: { sendFollowUp: vi.fn(async () => Promise.resolve()) },
      disclosure: () => "disclosure",
      libraryChat: {
        provider: fakeProvider,
        embeddingProvider: fakeProvider,
        indexStorage,
        embedSettings: { baseUrl: "http://localhost:11434", model: "embed" },
        openItem: vi.fn()
      }
    });

    await runtime.startup();
    menuActions.get("Ask your library")?.();
    const empty = document.querySelector(".zotero-ai-library-chat__empty");
    const emptyText = empty?.textContent ?? "";
    expect(emptyText.toLowerCase()).toContain("index your library");
    await runtime.shutdown();
  });

  it("renders a clear error when the embedding dimension does not match the index", async () => {
    const calls: string[] = [];
    const { ui, menuActions } = createFakeUi(calls);
    const fakeProvider = makeFakeProvider({
      deltas: ["should not appear"],
      capturedPrompts: [],
      embedding: [1, 0] // 2-dim — index uses 3-dim
    });
    const indexStorage = fakeStorage(makeIndex());
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        zotero: fakeCrawlerZotero(),
        provider: stubCrawlerProvider(),
        settings: stubCrawlerSettings(),
        storage: indexStorage
      }),
      ui,
      store: createConversationStore(),
      profile: () => ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController: {
        explain: vi.fn(async () => Promise.resolve()),
        cancel: vi.fn(),
        retry: vi.fn(async () => Promise.resolve()),
        continueInSidebar: vi.fn(),
        sendFollowUp: vi.fn(async () => Promise.resolve())
      },
      sidebarController: { sendFollowUp: vi.fn(async () => Promise.resolve()) },
      disclosure: () => "disclosure",
      libraryChat: {
        provider: fakeProvider,
        embeddingProvider: fakeProvider,
        indexStorage,
        embedSettings: { baseUrl: "http://localhost:11434", model: "embed" },
        openItem: vi.fn()
      }
    });

    await runtime.startup();
    menuActions.get("Ask your library")?.();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '.zotero-ai-library-chat [name="question"]'
    );
    if (textarea) {
      textarea.value = "Q";
    }
    document
      .querySelector<HTMLFormElement>(".zotero-ai-library-chat__form")
      ?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }

    const body = document.querySelector(".zotero-ai-library-chat__messages");
    const bodyText = body?.textContent ?? "";
    expect(bodyText.toLowerCase()).toContain("dimension");
    await runtime.shutdown();
  });

  it("'New conversation' clears the thread so a fresh question starts empty", async () => {
    const calls: string[] = [];
    const { ui, menuActions } = createFakeUi(calls);
    const capturedPrompts: string[][] = [];
    const fakeProvider = makeFakeProvider({
      deltas: ["First answer [ALPHA001#0]."],
      capturedPrompts,
      embedding: [1, 0, 0]
    });
    const indexStorage = fakeStorage(makeIndex());
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        zotero: fakeCrawlerZotero(),
        provider: stubCrawlerProvider(),
        settings: stubCrawlerSettings(),
        storage: indexStorage
      }),
      ui,
      store: createConversationStore(),
      profile: () => ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController: {
        explain: vi.fn(async () => Promise.resolve()),
        cancel: vi.fn(),
        retry: vi.fn(async () => Promise.resolve()),
        continueInSidebar: vi.fn(),
        sendFollowUp: vi.fn(async () => Promise.resolve())
      },
      sidebarController: { sendFollowUp: vi.fn(async () => Promise.resolve()) },
      disclosure: () => "disclosure",
      libraryChat: {
        provider: fakeProvider,
        embeddingProvider: fakeProvider,
        indexStorage,
        embedSettings: { baseUrl: "http://localhost:11434", model: "embed" },
        openItem: vi.fn()
      }
    });

    await runtime.startup();
    menuActions.get("Ask your library")?.();
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '.zotero-ai-library-chat [name="question"]'
    );
    if (textarea) {
      textarea.value = "Q1";
    }
    document
      .querySelector<HTMLFormElement>(".zotero-ai-library-chat__form")
      ?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    expect(
      document.querySelector(".zotero-ai-library-chat__messages")?.textContent ?? ""
    ).toContain("First answer");

    document.querySelector<HTMLButtonElement>('[data-action="new-conversation"]')?.click();
    const messagesAfter = document.querySelector(".zotero-ai-library-chat__messages");
    // After reset the message list shows only the empty-state placeholder
    // (no user/assistant turn rendered). No assistant body should remain.
    expect(messagesAfter?.querySelector(".zotero-ai-library-chat__body")).toBeNull();
    expect(messagesAfter?.querySelector(".zotero-ai-library-chat__empty")).not.toBeNull();
    await runtime.shutdown();
  });

  /**
   * M4 (Phase 4b codex review) — guard against concurrent submits.
   *
   * Without the guard, dispatching two submit events in quick
   * succession appends two user turns and starts two parallel streams
   * whose deltas interleave into a single garbled assistant message
   * (the library store always appends to the last assistant turn).
   *
   * The fix tracks an in-flight submit via a closure boolean and
   * rejects second-and-later concurrent submits until the first
   * stream resolves.
   */
  it("M4: a concurrent second submit while the first stream is in flight is rejected", async () => {
    const calls: string[] = [];
    const { ui, menuActions } = createFakeUi(calls);
    const capturedPrompts: string[][] = [];

    // Deferred stream — we resolve when we want the first submit to
    // finish. While it's pending, the second submit must be rejected
    // by the M4 guard.
    let release: () => void = () => undefined;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const provider: ModelProvider & EmbeddingProvider = {
      id: "ollama",
      displayName: "Ollama",
      async *streamChat(request) {
        capturedPrompts.push(request.messages.map((m) => m.content));
        yield { type: "message_start", providerId: "ollama", model: "x" };
        yield { type: "delta", text: "first " };
        await releasePromise;
        yield { type: "delta", text: "answer" };
        yield { type: "message_end" };
      },
      embedTexts(request) {
        return Promise.resolve(request.texts.map(() => [1, 0, 0]));
      }
    };
    const indexStorage = fakeStorage(makeIndex());
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        zotero: fakeCrawlerZotero(),
        provider: stubCrawlerProvider(),
        settings: stubCrawlerSettings(),
        storage: indexStorage
      }),
      ui,
      store: createConversationStore(),
      profile: () => ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController: {
        explain: vi.fn(async () => Promise.resolve()),
        cancel: vi.fn(),
        retry: vi.fn(async () => Promise.resolve()),
        continueInSidebar: vi.fn(),
        sendFollowUp: vi.fn(async () => Promise.resolve())
      },
      sidebarController: { sendFollowUp: vi.fn(async () => Promise.resolve()) },
      disclosure: () => "disclosure",
      libraryChat: {
        provider,
        embeddingProvider: provider,
        indexStorage,
        embedSettings: { baseUrl: "http://localhost:11434", model: "embed" },
        openItem: vi.fn()
      }
    });

    await runtime.startup();
    menuActions.get("Ask your library")?.();

    // First submit — starts the stream.
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '.zotero-ai-library-chat [name="question"]'
    );
    if (textarea) textarea.value = "first question";
    document
      .querySelector<HTMLFormElement>(".zotero-ai-library-chat__form")
      ?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    // Drain enough microtasks for the embed + streamChat to fire and
    // yield the first delta (but not enough to release the deferred).
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }

    // Second submit — must be rejected by the in-flight guard. We have
    // to re-query the textarea because the library chat view rebuilds
    // its DOM tree on every store notification.
    const textarea2 = document.querySelector<HTMLTextAreaElement>(
      '.zotero-ai-library-chat [name="question"]'
    );
    if (textarea2) textarea2.value = "second question (should be rejected)";
    document
      .querySelector<HTMLFormElement>(".zotero-ai-library-chat__form")
      ?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }

    // Critical: only ONE prompt was captured, not two.
    expect(capturedPrompts.length).toBe(1);

    // Release the first stream so the test cleans up.
    release();
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }

    // After the first stream completes, a new submit should be allowed.
    expect(capturedPrompts.length).toBe(1);
    const textarea3 = document.querySelector<HTMLTextAreaElement>(
      '.zotero-ai-library-chat [name="question"]'
    );
    if (textarea3) textarea3.value = "third question (after release)";
    document
      .querySelector<HTMLFormElement>(".zotero-ai-library-chat__form")
      ?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }

    expect(capturedPrompts.length).toBe(2);
    await runtime.shutdown();
  });

  /**
   * M4 (Phase 4b codex review iter 3) — reset() must invalidate any
   * in-flight stream.
   *
   * The iter 2 fix guarded against double-submit but left a hole:
   * reset() cleared the boolean guard without aborting the in-flight
   * stream, so deltas arriving after reset() appended into the freshly
   * reset (empty) conversation — painting an old answer onto a new
   * thread.
   *
   * The fix swaps the boolean for a per-submit token; reset() clears
   * the token and the stream loop drops any further events whose token
   * is no longer current.
   */
  it("M4 iter 3: reset() drops deltas that arrive after the reset", async () => {
    const calls: string[] = [];
    const { ui, menuActions } = createFakeUi(calls);
    const capturedPrompts: string[][] = [];

    // Deferred mid-stream — the first delta lands immediately, then we
    // hold the stream until the test calls release(). reset() runs in
    // between, and the second delta (after release) must be dropped.
    let release: () => void = () => undefined;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const provider: ModelProvider & EmbeddingProvider = {
      id: "ollama",
      displayName: "Ollama",
      async *streamChat(request) {
        capturedPrompts.push(request.messages.map((m) => m.content));
        yield { type: "message_start", providerId: "ollama", model: "x" };
        yield { type: "delta", text: "pre-reset " };
        await releasePromise;
        // This delta arrives AFTER reset() and must NOT land in the
        // freshly-reset conversation.
        yield { type: "delta", text: "post-reset-leak" };
        yield { type: "message_end" };
      },
      embedTexts(request) {
        return Promise.resolve(request.texts.map(() => [1, 0, 0]));
      }
    };
    const indexStorage = fakeStorage(makeIndex());
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        zotero: fakeCrawlerZotero(),
        provider: stubCrawlerProvider(),
        settings: stubCrawlerSettings(),
        storage: indexStorage
      }),
      ui,
      store: createConversationStore(),
      profile: () => ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController: {
        explain: vi.fn(async () => Promise.resolve()),
        cancel: vi.fn(),
        retry: vi.fn(async () => Promise.resolve()),
        continueInSidebar: vi.fn(),
        sendFollowUp: vi.fn(async () => Promise.resolve())
      },
      sidebarController: { sendFollowUp: vi.fn(async () => Promise.resolve()) },
      disclosure: () => "disclosure",
      libraryChat: {
        provider,
        embeddingProvider: provider,
        indexStorage,
        embedSettings: { baseUrl: "http://localhost:11434", model: "embed" },
        openItem: vi.fn()
      }
    });

    await runtime.startup();
    menuActions.get("Ask your library")?.();

    // Submit — stream emits "pre-reset " then awaits releasePromise.
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '.zotero-ai-library-chat [name="question"]'
    );
    if (textarea) textarea.value = "Q1";
    document
      .querySelector<HTMLFormElement>(".zotero-ai-library-chat__form")
      ?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }

    // Sanity: the first delta landed.
    expect(
      document.querySelector(".zotero-ai-library-chat__messages")?.textContent ?? ""
    ).toContain("pre-reset");

    // Reset — must invalidate the in-flight stream.
    document.querySelector<HTMLButtonElement>('[data-action="new-conversation"]')?.click();
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    // Now release the held stream so it tries to yield the post-reset
    // delta. With the fix, the token check drops the event before it
    // touches the store.
    release();
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }

    // The post-reset message list must NOT contain the leaked delta —
    // it should still be the empty-state view because reset() cleared
    // the thread and no fresh submit happened.
    const messages = document.querySelector(".zotero-ai-library-chat__messages");
    const text = messages?.textContent ?? "";
    expect(text).not.toContain("post-reset-leak");
    // The empty-state placeholder is still the only thing rendered.
    expect(messages?.querySelector(".zotero-ai-library-chat__empty")).not.toBeNull();
    expect(messages?.querySelector(".zotero-ai-library-chat__body")).toBeNull();

    await runtime.shutdown();
  });

  /**
   * M4 iter 3 — after reset(), a new submit must NOT be rejected by a
   * stale in-flight guard. The boolean fix had the right behavior here
   * (reset cleared the guard) but the token fix must preserve it: a
   * fresh submit after reset() should be allowed to start a new stream.
   */
  it("M4 iter 3: after reset() a fresh submit is allowed (does not see stale in-flight guard)", async () => {
    const calls: string[] = [];
    const { ui, menuActions } = createFakeUi(calls);
    const capturedPrompts: string[][] = [];

    let release1: () => void = () => undefined;
    const release1Promise = new Promise<void>((resolve) => {
      release1 = resolve;
    });

    const provider: ModelProvider & EmbeddingProvider = {
      id: "ollama",
      displayName: "Ollama",
      async *streamChat(request) {
        capturedPrompts.push(request.messages.map((m) => m.content));
        yield { type: "message_start", providerId: "ollama", model: "x" };
        if (capturedPrompts.length === 1) {
          yield { type: "delta", text: "first" };
          await release1Promise;
          yield { type: "delta", text: "-late" };
        } else {
          // Second stream — runs to completion immediately.
          yield { type: "delta", text: "fresh answer [ALPHA001#0]." };
        }
        yield { type: "message_end" };
      },
      embedTexts(request) {
        return Promise.resolve(request.texts.map(() => [1, 0, 0]));
      }
    };
    const indexStorage = fakeStorage(makeIndex());
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        zotero: fakeCrawlerZotero(),
        provider: stubCrawlerProvider(),
        settings: stubCrawlerSettings(),
        storage: indexStorage
      }),
      ui,
      store: createConversationStore(),
      profile: () => ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController: {
        explain: vi.fn(async () => Promise.resolve()),
        cancel: vi.fn(),
        retry: vi.fn(async () => Promise.resolve()),
        continueInSidebar: vi.fn(),
        sendFollowUp: vi.fn(async () => Promise.resolve())
      },
      sidebarController: { sendFollowUp: vi.fn(async () => Promise.resolve()) },
      disclosure: () => "disclosure",
      libraryChat: {
        provider,
        embeddingProvider: provider,
        indexStorage,
        embedSettings: { baseUrl: "http://localhost:11434", model: "embed" },
        openItem: vi.fn()
      }
    });

    await runtime.startup();
    menuActions.get("Ask your library")?.();

    const textarea = document.querySelector<HTMLTextAreaElement>(
      '.zotero-ai-library-chat [name="question"]'
    );
    if (textarea) textarea.value = "Q1";
    document
      .querySelector<HTMLFormElement>(".zotero-ai-library-chat__form")
      ?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
    expect(capturedPrompts.length).toBe(1);

    // Reset mid-stream.
    document.querySelector<HTMLButtonElement>('[data-action="new-conversation"]')?.click();
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    // Fresh submit — must NOT be blocked by the prior in-flight guard.
    const textarea2 = document.querySelector<HTMLTextAreaElement>(
      '.zotero-ai-library-chat [name="question"]'
    );
    if (textarea2) textarea2.value = "Q2";
    document
      .querySelector<HTMLFormElement>(".zotero-ai-library-chat__form")
      ?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }

    // A second prompt was captured — the fresh submit was allowed
    // through despite the first stream still being pending.
    expect(capturedPrompts.length).toBe(2);
    const text = document.querySelector(".zotero-ai-library-chat__messages")?.textContent ?? "";
    expect(text).toContain("fresh answer");
    // The first stream's pre-reset prefix must NOT be present.
    expect(text).not.toContain("first");

    // Release the first stream so the test can shut down cleanly. Its
    // tail delta lands on a stale token and is dropped.
    release1();
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }

    // Final assertion: the late delta from the first stream did not
    // bleed into the (already-completed) second conversation.
    const finalText =
      document.querySelector(".zotero-ai-library-chat__messages")?.textContent ?? "";
    expect(finalText).not.toContain("-late");

    await runtime.shutdown();
  });
});
