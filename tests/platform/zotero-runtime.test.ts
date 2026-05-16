/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";

import { createConversationStore } from "../../src/conversation/conversation-store.js";
import { createZoteroRuntime } from "../../src/platform/zotero-runtime.js";
import type { ZoteroUiAdapter } from "../../src/platform/zotero-ui-types.js";
import {
  createDefaultOllamaSettings,
  ollamaSettingsToProfile
} from "../../src/preferences/ollama-profile.js";
import type { PopupController } from "../../src/ui/popup-controller.js";
import type { SidebarController } from "../../src/ui/sidebar-controller.js";
import type { SelectionContext } from "../../src/selection/selection-context.js";

function createSelection(): SelectionContext {
  return {
    quote: "Dense quote.",
    source: {
      itemKey: "I",
      itemTitle: "Paper",
      attachmentKey: "A",
      pageLabel: "3",
      location: "page=3"
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
    addMenuItem(label, action) {
      calls.push(`menu:${label}`);
      if (label === "Zotero AI Explain Settings") {
        action();
      }
      return () => calls.push(`remove-menu:${label}`);
    },
    addReaderCommand(label, action) {
      calls.push(`reader:${label}`);
      readerActions.push(action);
      return () => calls.push(`remove-reader:${label}`);
    },
    openDialog(title, content) {
      calls.push(`dialog:${title}:${content.className}`);
    },
    mountPopup(content) {
      calls.push(`popup:${content.className}`);
      document.body.append(content);
      return () => {
        calls.push("remove-popup");
        content.remove();
      };
    },
    mountSidebar(content) {
      calls.push(`sidebar:${content.className}`);
      document.body.append(content);
      return () => {
        calls.push("remove-sidebar");
        content.remove();
      };
    }
  };
  return { ui, readerActions };
}

describe("createZoteroRuntime", () => {
  it("registers settings and explain commands on startup", async () => {
    const calls: string[] = [];
    const { ui } = createFakeUi(calls);
    const store = createConversationStore();
    const popupController: PopupController = {
      explain: vi.fn(async () => Promise.resolve()),
      cancel: vi.fn(),
      retry: vi.fn(async () => Promise.resolve()),
      continueInSidebar: vi.fn()
    };
    const sidebarController: SidebarController = {
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };

    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      ui,
      store,
      profile: ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController,
      sidebarController,
      disclosure: (profile) => `Send to ${profile.displayName}`
    });

    await runtime.startup();
    await runtime.shutdown();

    expect(calls).toEqual([
      "menu:Zotero AI Explain Settings",
      "dialog:Zotero AI Explain:zotero-ai-settings",
      "reader:Explain with AI",
      "remove-menu:Zotero AI Explain Settings",
      "remove-reader:Explain with AI"
    ]);
  });

  it("starts the popup explain flow when a reader selection fires", async () => {
    const calls: string[] = [];
    const { ui, readerActions } = createFakeUi(calls);
    const store = createConversationStore();
    const popupController: PopupController = {
      explain: vi.fn(async () => Promise.resolve()),
      cancel: vi.fn(),
      retry: vi.fn(async () => Promise.resolve()),
      continueInSidebar: vi.fn()
    };
    const sidebarController: SidebarController = {
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };
    const profile = ollamaSettingsToProfile(createDefaultOllamaSettings());

    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      ui,
      store,
      profile,
      popupController,
      sidebarController,
      disclosure: (resolved) => `Send to ${resolved.displayName} using ${resolved.model}`
    });

    await runtime.startup();
    const readerAction = readerActions[0];
    expect(readerAction).toBeDefined();
    readerAction?.(createSelection());

    const explainMock = vi.mocked(popupController.explain);
    expect(explainMock).toHaveBeenCalledTimes(1);
    const explainCall = explainMock.mock.calls[0];
    expect(explainCall?.[0]).toMatch(/^conversation-/u);
    expect(calls).toContain("popup:zotero-ai-explain-popup");

    const popup = document.querySelector(".zotero-ai-explain-popup");
    expect(popup).not.toBeNull();

    await runtime.shutdown();

    expect(calls).toContain("remove-popup");
    expect(document.querySelector(".zotero-ai-explain-popup")).toBeNull();
  });

  it("moves the conversation to the sidebar when the continue button is clicked", async () => {
    const calls: string[] = [];
    const { ui, readerActions } = createFakeUi(calls);
    const store = createConversationStore();
    const popupController: PopupController = {
      explain: vi.fn(async () => Promise.resolve()),
      cancel: vi.fn(),
      retry: vi.fn(async () => Promise.resolve()),
      continueInSidebar: vi.fn((conversationId: string) => {
        store.moveToSidebar(conversationId);
      })
    };
    const sidebarController: SidebarController = {
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };
    const profile = ollamaSettingsToProfile(createDefaultOllamaSettings());

    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      ui,
      store,
      profile,
      popupController,
      sidebarController,
      disclosure: () => "disclosure"
    });

    await runtime.startup();
    readerActions[0]?.(createSelection());

    const continueButton = document.querySelector<HTMLButtonElement>(
      '[data-action="continue-sidebar"]'
    );
    expect(continueButton).not.toBeNull();
    continueButton?.click();

    expect(vi.mocked(popupController.continueInSidebar)).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".zotero-ai-explain-popup")).toBeNull();
    expect(document.querySelector(".zotero-ai-explain-sidebar")).not.toBeNull();

    await runtime.shutdown();
    expect(document.querySelector(".zotero-ai-explain-sidebar")).toBeNull();
  });
});
