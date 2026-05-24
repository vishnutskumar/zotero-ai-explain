/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";

import { createConversationStore } from "../../src/conversation/conversation-store.js";
import { createIndexingController } from "../../src/indexing/indexing-controller.js";
import { controllerStubDeps } from "../indexing/controller-test-helpers.js";
import {
  createZoteroRuntime,
  type PopupRetrievalChannel,
  type RuntimeFetch
} from "../../src/platform/zotero-runtime.js";
import type { ZoteroUiAdapter } from "../../src/platform/zotero-ui-types.js";
import {
  createDefaultOllamaSettings,
  ollamaSettingsToProfile
} from "../../src/preferences/ollama-profile.js";
import { createDefaultProviderProfileSettings } from "../../src/preferences/provider-profile.js";
import type { ProviderProfile } from "../../src/providers/provider-types.js";
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
      pageLabel: "3"
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
    addReaderCommands(commands) {
      for (const command of commands) {
        calls.push(`reader:${command.label}`);
        readerActions.push(command.action);
      }
      return () => {
        for (const command of commands) {
          calls.push(`remove-reader:${command.label}`);
        }
      };
    },
    addReaderCommand(label, action) {
      calls.push(`reader:${label}`);
      readerActions.push(action);
      return () => calls.push(`remove-reader:${label}`);
    },
    openDialog(title, content) {
      calls.push(`dialog:${title}:${content.className}`);
      return {
        close: () => calls.push(`close-dialog:${title}`),
        minimize: () => calls.push(`minimize-dialog:${title}`),
        restore: () => calls.push(`restore-dialog:${title}`)
      };
    },
    mountPopup(content) {
      calls.push(`popup:${content.className}`);
      document.body.append(content);
      return () => {
        calls.push("remove-popup");
        content.remove();
      };
    },
    mountSidebar(content, options) {
      calls.push(`sidebar:${content.className}`);
      document.body.append(content);
      let disposed = false;
      const dispose = (): void => {
        if (disposed) {
          return;
        }
        disposed = true;
        calls.push("remove-sidebar");
        content.remove();
        options?.onDismiss?.();
      };
      // Mirror the real adapter: the close button lives inside the mounted
      // content (the sidebar view) and the adapter wires its click to
      // dispose. Tests rely on this to exercise the runtime's close path.
      const close = content.querySelector<HTMLButtonElement>('[data-action="close-sidebar"]');
      close?.addEventListener("click", dispose);
      return dispose;
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
      disclosure: () => "Send to Ollama"
    });

    await runtime.startup();
    await runtime.shutdown();

    expect(calls).toEqual([
      "menu:Zotero AI Explain Settings",
      "dialog:Zotero AI Explain:zotero-ai-settings",
      "reader:Explain with AI",
      "reader:Ask a question",
      "remove-menu:Zotero AI Explain Settings",
      "remove-reader:Explain with AI",
      "remove-reader:Ask a question"
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
      continueInSidebar: vi.fn(),
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };
    const sidebarController: SidebarController = {
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };
    const profile = ollamaSettingsToProfile(createDefaultOllamaSettings());

    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        ...controllerStubDeps()
      }),
      ui,
      store,
      profile: () => profile,
      popupController,
      sidebarController,
      disclosure: () => `Send to ${profile.displayName} using ${profile.model}`
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

  it("reads the disclosure live on every popup render (Bug A2: no startup-snapshot freeze)", async () => {
    // Regression: bootstrap used to bind a `(profile) => string` formatter
    // closing over the startup-time profile. After a user changed the chat
    // provider in settings, the popup banner still showed the old name
    // because the disclosure was never recomputed. With the live-read
    // formatter contract, the runtime must call disclosure() afresh each
    // time it renders the popup, so a mutable source-of-truth in the
    // formatter closure flows through immediately.
    const { ui, readerActions } = createFakeUi([]);
    const store = createConversationStore();
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
    const profile = ollamaSettingsToProfile(createDefaultOllamaSettings());
    let live = { displayName: "Ollama", model: "gemma4:e4b" };

    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        ...controllerStubDeps()
      }),
      ui,
      store,
      profile: () => profile,
      popupController,
      sidebarController,
      disclosure: () => `Send to ${live.displayName} using ${live.model}`
    });

    await runtime.startup();

    readerActions[0]?.(createSelection());
    const firstPopup = document.querySelector<HTMLElement>(".zotero-ai-explain-popup__disclosure");
    expect(firstPopup?.textContent).toBe("Send to Ollama using gemma4:e4b");

    // Simulate the user switching to the Codex Proxy preset.
    live = { displayName: "Codex Proxy", model: "gpt-5-codex" };

    // Tear down + re-render the popup the way the runtime does on a new
    // selection.
    const firstHost = document.querySelector(".zotero-ai-explain-popup");
    firstHost?.remove();
    readerActions[0]?.(createSelection());

    const secondPopup = document.querySelector<HTMLElement>(".zotero-ai-explain-popup__disclosure");
    expect(secondPopup?.textContent).toBe("Send to Codex Proxy using gpt-5-codex");

    await runtime.shutdown();
  });

  it("reads the active profile live for every explain so request URL/model reflect saves (codex review #5)", async () => {
    // Regression: bootstrap used to pass `profile: ProviderProfile`
    // (a startup snapshot) into the runtime. The popup explain path
    // then attached that snapshot to every conversation, and the chat
    // adapter read `request.profile.baseUrl` / `model` from it — so a
    // user who changed presets/models mid-session got correct labels
    // (after the Bug A2 fix) but still routed to the OLD endpoint.
    //
    // The contract now passes `profile: () => ProviderProfile` and the
    // runtime invokes it per explain. This test mutates the closure's
    // backing store between two explains and asserts the conversation
    // captured the second profile, not the first. We intercept the
    // store via a spy on `createFromSelection` because the public store
    // contract does not expose a list() — the spy lets us see exactly
    // which profile each call observed.
    const { ui, readerActions } = createFakeUi([]);
    const baseStore = createConversationStore();
    const profilesObserved: ProviderProfile[] = [];
    const store: typeof baseStore = {
      ...baseStore,
      createFromSelection(selection, profile) {
        profilesObserved.push(profile);
        return baseStore.createFromSelection(selection, profile);
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
    const initialProfile = ollamaSettingsToProfile(createDefaultOllamaSettings());
    let currentProfile = initialProfile;
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        ...controllerStubDeps()
      }),
      ui,
      store,
      profile: () => currentProfile,
      popupController,
      sidebarController,
      disclosure: () => "disclosure"
    });
    await runtime.startup();
    try {
      readerActions[0]?.(createSelection());
      expect(profilesObserved.at(-1)?.baseUrl).toBe(initialProfile.baseUrl);
      expect(profilesObserved.at(-1)?.model).toBe(initialProfile.model);

      // Simulate the user saving a Codex-preset preference mid-session.
      // The closure now returns a different profile; the next explain
      // MUST attach that one to the new conversation.
      currentProfile = {
        ...initialProfile,
        displayName: "Codex Proxy",
        baseUrl: "http://localhost:11400/codex",
        model: "gpt-5-codex"
      };
      // Remove the first popup so the runtime re-renders a fresh one
      // on the next explain.
      document.querySelector(".zotero-ai-explain-popup")?.remove();
      readerActions[0]?.(createSelection());

      expect(profilesObserved).toHaveLength(2);
      expect(profilesObserved[1]?.baseUrl).toBe("http://localhost:11400/codex");
      expect(profilesObserved[1]?.model).toBe("gpt-5-codex");
    } finally {
      await runtime.shutdown();
    }
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
      }),
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };
    const sidebarController: SidebarController = {
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };
    const profile = ollamaSettingsToProfile(createDefaultOllamaSettings());

    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        ...controllerStubDeps()
      }),
      ui,
      store,
      profile: () => profile,
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

  it("clicking the sidebar close button dismisses the sidebar and tears down the subscription", async () => {
    const calls: string[] = [];
    const { ui, readerActions } = createFakeUi(calls);
    const store = createConversationStore();
    const popupController: PopupController = {
      explain: vi.fn(async () => Promise.resolve()),
      cancel: vi.fn(),
      retry: vi.fn(async () => Promise.resolve()),
      continueInSidebar: vi.fn((conversationId: string) => {
        store.moveToSidebar(conversationId);
      }),
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
      disclosure: () => "disclosure"
    });

    await runtime.startup();
    readerActions[0]?.(createSelection());

    // Move into the sidebar so the close affordance is in the DOM.
    const continueButton = document.querySelector<HTMLButtonElement>(
      '[data-action="continue-sidebar"]'
    );
    continueButton?.click();

    const sidebar = document.querySelector(".zotero-ai-explain-sidebar");
    expect(sidebar).not.toBeNull();
    const close = document.querySelector<HTMLButtonElement>('[data-action="close-sidebar"]');
    expect(close).not.toBeNull();

    close?.click();

    // The sidebar must be gone and the test fake's dispose call recorded.
    expect(document.querySelector(".zotero-ai-explain-sidebar")).toBeNull();
    expect(calls).toContain("remove-sidebar");

    // After close, store updates must not throw (no stale subscriber on a
    // removed DOM tree). If the runtime forgot to unsubscribe, the
    // subscriber would attempt to mutate the detached <ol> and the next
    // store.appendUserMessage would surface that bug.
    const conversationId = vi.mocked(popupController.explain).mock.calls[0]?.[0] ?? "missing";
    expect(() => {
      store.appendUserMessage(conversationId, "follow-up after close");
    }).not.toThrow();

    await runtime.shutdown();
  });

  it("forwards the selection anchor to mountPopup so the adapter can position it (AC1)", async () => {
    const calls: string[] = [];
    const { ui, readerActions } = createFakeUi(calls);
    const mountPopupSpy = vi.spyOn(ui, "mountPopup");
    const store = createConversationStore();
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
      disclosure: () => "disclosure"
    });

    await runtime.startup();
    const anchoredSelection: SelectionContext = {
      quote: "Q",
      source: {
        itemKey: "I",
        itemTitle: null,
        attachmentKey: null,
        pageLabel: null
      },
      anchor: { left: 100, top: 200, width: 80, height: 24 }
    };
    readerActions[0]?.(anchoredSelection);

    expect(mountPopupSpy).toHaveBeenCalled();
    const [, options] = mountPopupSpy.mock.calls[0] ?? [];
    expect(options?.anchor).toEqual({ left: 100, top: 200, width: 80, height: 24 });
    expect(typeof options?.onDismiss).toBe("function");
    await runtime.shutdown();
  });

  it("submitting the inline follow-up form invokes popupController.sendFollowUp (AC5)", async () => {
    const calls: string[] = [];
    const { ui, readerActions } = createFakeUi(calls);
    const store = createConversationStore();
    const sendFollowUp = vi.fn(async () => Promise.resolve());
    const popupController: PopupController = {
      explain: vi.fn(async () => Promise.resolve()),
      cancel: vi.fn(),
      retry: vi.fn(async () => Promise.resolve()),
      continueInSidebar: vi.fn(),
      sendFollowUp
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
      disclosure: () => "disclosure"
    });

    await runtime.startup();
    readerActions[0]?.(createSelection());

    const form = document.querySelector<HTMLFormElement>(".zotero-ai-explain-popup__form");
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '.zotero-ai-explain-popup__form [name="followUp"]'
    );
    expect(form).not.toBeNull();
    expect(textarea).not.toBeNull();
    if (textarea) {
      textarea.value = "Why does it matter?";
    }
    form?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    expect(sendFollowUp).toHaveBeenCalledTimes(1);
    const args = sendFollowUp.mock.calls[0] as unknown as [string, string];
    expect(args[1]).toBe("Why does it matter?");
    // Textarea should be cleared after submit.
    expect(textarea?.value).toBe("");

    await runtime.shutdown();
  });

  it("popup body switches from loading indicator to streamed content (AC4)", async () => {
    const calls: string[] = [];
    const { ui, readerActions } = createFakeUi(calls);
    const store = createConversationStore();
    const popupController: PopupController = {
      explain: vi.fn(async (conversationId: string) => {
        store.markStreaming(conversationId);
        store.appendAssistantDelta(conversationId, "Hello world");
        store.complete(conversationId);
        await Promise.resolve();
      }),
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
      disclosure: () => "disclosure"
    });

    await runtime.startup();
    readerActions[0]?.(createSelection());

    // Wait microtasks so the explain promise resolves and the store
    // notifies subscribers.
    await Promise.resolve();
    await Promise.resolve();

    const body = document.querySelector<HTMLElement>(".zotero-ai-explain-popup__body");
    const loading = document.querySelector<HTMLElement>(".zotero-ai-explain-popup__loading");
    expect(body?.textContent).toBe("Hello world");
    expect(loading?.hidden).toBe(true);

    await runtime.shutdown();
  });
});

/**
 * H3 (Phase 4b codex review) — direct-API validation MUST include auth headers.
 *
 * Pre-fix, the Save handler probed `/v1/models` with just an
 * AbortSignal. Both api.openai.com and api.anthropic.com require an
 * Authorization (or x-api-key) header to return 200 — without it,
 * every valid key was rejected at Save time.
 *
 * After the fix, the runtime forwards the right header per provider so
 * a real key validates. These tests assert the fetch sees the headers,
 * not just the URL.
 */
describe("createZoteroRuntime direct-API validation auth headers (H3)", () => {
  function controllers(): {
    popupController: PopupController;
    sidebarController: SidebarController;
  } {
    return {
      popupController: {
        explain: vi.fn(async () => Promise.resolve()),
        cancel: vi.fn(),
        retry: vi.fn(async () => Promise.resolve()),
        continueInSidebar: vi.fn(),
        sendFollowUp: vi.fn(async () => Promise.resolve())
      },
      sidebarController: {
        sendFollowUp: vi.fn(async () => Promise.resolve())
      }
    };
  }

  function fakeFetch(): {
    readonly fetch: RuntimeFetch;
    readonly calls: { url: string; headers: Record<string, string> | undefined }[];
  } {
    const calls: { url: string; headers: Record<string, string> | undefined }[] = [];
    const fetchImpl: RuntimeFetch = async (input, init) => {
      await Promise.resolve();
      calls.push({ url: input, headers: init?.headers });
      // Default: succeed. Specific tests override via the calls
      // inspection; here we always return 200 because the goal of this
      // suite is "did the runtime SEND the auth header?".
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({})
      };
    };
    return { fetch: fetchImpl, calls };
  }

  /**
   * Helper: open settings with a provider profile already in scope and
   * fill in an API key + click Save. Returns when the save handler has
   * fired so callers can inspect the fetch calls.
   */
  async function openSaveWith(
    providerKind: "codex-api" | "claude-api",
    apiKey: string,
    fetchImpl: RuntimeFetch
  ): Promise<void> {
    // Clean DOM between invocations so leftover form nodes from a prior
    // run don't satisfy the next test's queries.
    document.body.innerHTML = "";
    const calls: string[] = [];
    const { ui: baseUi } = createFakeUi(calls);
    // Wrap openDialog to actually mount the content; the base fake just
    // records the call without attaching, but we need the form in the
    // DOM so the Save click handler runs.
    const ui: ZoteroUiAdapter = {
      ...baseUi,
      openDialog(_title, content) {
        document.body.append(content);
        return {
          close: () => {
            content.remove();
          },
          minimize: () => undefined,
          restore: () => undefined
        };
      }
    };
    const { popupController, sidebarController } = controllers();
    const profile = createDefaultProviderProfileSettings();
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        ...controllerStubDeps()
      }),
      ui,
      store: createConversationStore(),
      profile: () => ollamaSettingsToProfile(createDefaultOllamaSettings()),
      popupController,
      sidebarController,
      disclosure: () => "disclosure",
      providerProfile: profile,
      fetch: fetchImpl
    });
    await runtime.startup();
    // The fake UI's openDialog mounts content into the document; the
    // runtime constructs the settings view inside its own constructor
    // (openSettingsDialog). Trigger it via openSettings() so the form
    // appears in the DOM.
    runtime.openSettings();

    // Fill provider selector + API key field.
    const chatProviderSel = document.querySelector<HTMLSelectElement>('[name="chatProvider"]');
    if (chatProviderSel) {
      chatProviderSel.value = providerKind;
      chatProviderSel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const keyInputName = providerKind === "codex-api" ? "openaiApiKey" : "anthropicApiKey";
    const keyInput = document.querySelector<HTMLInputElement>(`[name="${keyInputName}"]`);
    if (keyInput) {
      keyInput.value = apiKey;
    }
    // Click Save; the runtime probes validation asynchronously.
    document.querySelector<HTMLButtonElement>('[data-action="save-settings"]')?.click();
    // Drain microtasks so the validate Promise.all settles.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    await runtime.shutdown();
  }

  it("H3: OpenAI chat validation sends Authorization: Bearer <key>", async () => {
    const { fetch, calls } = fakeFetch();
    await openSaveWith("codex-api", "sk-openai-test", fetch);
    const probe = calls.find((c) => c.url === "https://api.openai.com/v1/models");
    expect(probe).toBeDefined();
    expect(probe?.headers).toBeDefined();
    expect(probe?.headers?.Authorization).toBe("Bearer sk-openai-test");
  });

  it("H3: Anthropic chat validation sends x-api-key + anthropic-version headers", async () => {
    const { fetch, calls } = fakeFetch();
    await openSaveWith("claude-api", "sk-ant-test", fetch);
    const probe = calls.find((c) => c.url === "https://api.anthropic.com/v1/models");
    expect(probe).toBeDefined();
    expect(probe?.headers).toBeDefined();
    expect(probe?.headers?.["x-api-key"]).toBe("sk-ant-test");
    expect(probe?.headers?.["anthropic-version"]).toBe("2023-06-01");
  });

  it("H3: a missing-key save still surfaces a clear validation error (no fetch fired)", async () => {
    const { fetch, calls } = fakeFetch();
    // Empty key — validation must fail without firing the auth probe.
    await openSaveWith("codex-api", "", fetch);
    const probe = calls.find((c) => c.url === "https://api.openai.com/v1/models");
    expect(probe).toBeUndefined();
    // Error message rendered in the DOM for the openaiApiKey field.
    const err = document.querySelector<HTMLElement>('[data-error-for="openaiApiKey"]');
    expect(err?.textContent ?? "").toMatch(/required/iu);
  });
});

/**
 * FINDING-2 (Phase 4b codex review, AC-2) — PDF identity must reach the
 * LLM prompt frame.
 *
 * `selection.source` carries `itemKey` / `itemTitle` / `attachmentKey` /
 * `pageIndex` / `pageLabel`, but pre-fix the runtime never put any of it
 * into the actual provider messages. The provider receives
 * `conversation.messages`, so a `system` message with the rendered
 * source frame is the prompt-frame surface AC-2 (plan L409-420) requires.
 *
 * These tests trigger the explain + ask-question reader actions and
 * inspect the conversation store's messages — the exact array
 * `popup-controller` forwards to `provider.streamChat({ messages })`.
 */
describe("createZoteroRuntime PDF-identity prompt frame (FINDING-2 / AC-2)", () => {
  function controllers(): {
    popupController: PopupController;
    sidebarController: SidebarController;
  } {
    return {
      popupController: {
        explain: vi.fn(async () => Promise.resolve()),
        cancel: vi.fn(),
        retry: vi.fn(async () => Promise.resolve()),
        continueInSidebar: vi.fn(),
        sendFollowUp: vi.fn(async () => Promise.resolve())
      },
      sidebarController: {
        sendFollowUp: vi.fn(async () => Promise.resolve())
      }
    };
  }

  async function bootRuntime(): Promise<{
    readonly store: ReturnType<typeof createConversationStore>;
    readonly readerActions: ((selection: SelectionContext) => void)[];
    readonly shutdown: () => Promise<void>;
  }> {
    const calls: string[] = [];
    const { ui, readerActions } = createFakeUi(calls);
    const store = createConversationStore();
    const { popupController, sidebarController } = controllers();
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
      disclosure: () => "disclosure"
    });
    await runtime.startup();
    return { store, readerActions, shutdown: () => runtime.shutdown() };
  }

  /**
   * Pull the single in-flight conversation's messages. The runtime
   * creates exactly one conversation per reader action; `conversation-1`
   * is its deterministic id (the store's counter starts at 1).
   */
  function messagesOf(store: ReturnType<typeof createConversationStore>): readonly {
    role: string;
    content: string;
  }[] {
    const conversation = store.get("conversation-1");
    expect(conversation, "no conversation created by the reader action").not.toBeNull();
    return conversation?.messages ?? [];
  }

  it("explain seeds a system frame carrying the document title, page reference, and Zotero keys", async () => {
    const selection: SelectionContext = {
      quote: "Dense quote.",
      source: {
        itemKey: "ITEMKEY1",
        itemTitle: "On the Nature of Things",
        attachmentKey: "ATTACH01",
        pageLabel: "12"
      },
      anchor: null
    };
    const { store, readerActions, shutdown } = await bootRuntime();
    readerActions[0]?.(selection);

    const messages = messagesOf(store);
    const systemFrame = messages.find((m) => m.role === "system");
    expect(systemFrame, "explain must seed a system prompt frame").toBeDefined();
    const frame = systemFrame?.content ?? "";
    expect(frame).toContain("On the Nature of Things");
    expect(frame).toContain("Page: 12");
    expect(frame).toContain("ITEMKEY1");
    expect(frame).toContain("ATTACH01");
    // The quote still rides as the user message.
    expect(messages.some((m) => m.role === "user" && m.content.includes("Dense quote."))).toBe(
      true
    );
    await shutdown();
  });

  it("explain renders pageIndex 0 as page '1' (never dropped as falsy)", async () => {
    // The reader event carried `pageIndex: 0` and no `pageLabel`. Page 0
    // is a real first page — the frame must show "Page: 1", not skip it.
    const selection: SelectionContext = {
      quote: "First page text.",
      source: {
        itemKey: "ITEMKEY2",
        itemTitle: "Intro Paper",
        attachmentKey: null,
        pageLabel: null,
        pageIndex: 0
      },
      anchor: null
    };
    const { store, readerActions, shutdown } = await bootRuntime();
    readerActions[0]?.(selection);

    const frame = messagesOf(store).find((m) => m.role === "system")?.content ?? "";
    expect(frame).toContain("Page: 1");
    await shutdown();
  });

  it("explain falls back to String(pageIndex + 1) when pageLabel is absent", async () => {
    const selection: SelectionContext = {
      quote: "Mid-document text.",
      source: {
        itemKey: "ITEMKEY3",
        itemTitle: "Long Paper",
        attachmentKey: null,
        pageLabel: null,
        pageIndex: 16
      },
      anchor: null
    };
    const { store, readerActions, shutdown } = await bootRuntime();
    readerActions[0]?.(selection);

    const frame = messagesOf(store).find((m) => m.role === "system")?.content ?? "";
    expect(frame).toContain("Page: 17");
    await shutdown();
  });

  it("ask-question carries the source frame alongside the sticky quote frame", async () => {
    const selection: SelectionContext = {
      quote: "A passage to ask about.",
      source: {
        itemKey: "ITEMKEY4",
        itemTitle: "Reference Work",
        attachmentKey: "ATTACH04",
        pageLabel: null,
        pageIndex: 0
      },
      anchor: null
    };
    const { store, readerActions, shutdown } = await bootRuntime();
    // readerActions[1] is the "Ask a question" command.
    readerActions[1]?.(selection);

    const systemMessages = messagesOf(store).filter((m) => m.role === "system");
    // One sticky-quote frame + one source frame.
    expect(systemMessages.length).toBeGreaterThanOrEqual(2);
    const joined = systemMessages.map((m) => m.content).join("\n");
    expect(joined).toContain("A passage to ask about.");
    expect(joined).toContain("Reference Work");
    expect(joined).toContain("Page: 1");
    expect(joined).toContain("ITEMKEY4");
    expect(joined).toContain("ATTACH04");
    await shutdown();
  });

  it("degrades gracefully: no source frame when the selection carries no identity", async () => {
    // A non-reader / identity-less selection — every source field null
    // and no pageIndex. The runtime must NOT seed an empty source frame;
    // the explain request degrades to quote-only exactly as before.
    const selection: SelectionContext = {
      quote: "Shortcut selection.",
      source: {
        itemKey: null,
        itemTitle: null,
        attachmentKey: null,
        pageLabel: null
      },
      anchor: null
    };
    const { store, readerActions, shutdown } = await bootRuntime();
    readerActions[0]?.(selection);

    const messages = messagesOf(store);
    expect(messages.some((m) => m.role === "system")).toBe(false);
    expect(
      messages.some((m) => m.role === "user" && m.content.includes("Shortcut selection."))
    ).toBe(true);
    await shutdown();
  });
});

/**
 * P5 simplify HIGH (efficiency) — PopupRetrievalChannel subscriber leak.
 *
 * Regression: `startExplain` / `startAskQuestion` subscribed once per
 * conversation to the popup retrieval channel and tore down the
 * subscription in `popup.onDismiss` (and `cleanupExplain` at shutdown).
 * The "Continue in sidebar" button programmatically unmounted the popup
 * WITHOUT firing the popup's `onDismiss`, and the sidebar's `onDismiss`
 * only tore down the sidebar-store subscription. Each
 * popup → continue → sidebar → dismiss cycle therefore leaked one
 * subscriber permanently; every subsequent publish fanned out to every
 * leaked subscriber.
 *
 * These tests pin the fix:
 *   1. After the full popup → sidebar → dismiss cycle the channel's
 *      subscriber count drops to zero.
 *   2. Three consecutive cycles never grow the subscriber count above
 *      one in-flight subscriber AND finish at zero.
 *   3. Direct popup dismissal (no sidebar transition) also drops the
 *      subscriber count to zero.
 */
describe("PopupRetrievalChannel subscriber lifetime (P5 efficiency H)", () => {
  type SubscriberCountingChannel = {
    readonly publish: (chunks: readonly unknown[]) => void;
    readonly subscribe: (handler: (chunks: readonly unknown[]) => void) => () => void;
    subscriberCount(): number;
  };

  function makeCountingChannel(): SubscriberCountingChannel {
    const handlers = new Set<(chunks: readonly unknown[]) => void>();
    return {
      publish(chunks) {
        for (const h of handlers) h(chunks);
      },
      subscribe(handler) {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
        };
      },
      subscriberCount(): number {
        return handlers.size;
      }
    };
  }

  function selection(): SelectionContext {
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

  async function bootWithChannel(): Promise<{
    readonly channel: SubscriberCountingChannel;
    readonly readerActions: ((selection: SelectionContext) => void)[];
    readonly shutdown: () => Promise<void>;
  }> {
    const calls: string[] = [];
    const { ui, readerActions } = createFakeUi(calls);
    const store = createConversationStore();
    const channel = makeCountingChannel();
    const popupController: PopupController = {
      explain: vi.fn(async () => Promise.resolve()),
      cancel: vi.fn(),
      retry: vi.fn(async () => Promise.resolve()),
      // Mirror production: `continueInSidebar` mutates the store so the
      // sidebar mount has a conversation to render against.
      continueInSidebar: vi.fn((conversationId: string) => {
        store.moveToSidebar(conversationId);
      }),
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
      // Cast: the test counting-channel mirrors the production shape
      // (publish + subscribe), but uses `readonly unknown[]` so the test
      // doesn't depend on the RetrievedChunk shape.
      popupRetrievalChannel: channel as unknown as PopupRetrievalChannel
    });
    await runtime.startup();
    return { channel, readerActions, shutdown: () => runtime.shutdown() };
  }

  it("popup → continue → sidebar → dismiss tears the subscriber down", async () => {
    const { channel, readerActions, shutdown } = await bootWithChannel();
    try {
      // Trigger the explain reader command; the runtime subscribes once.
      readerActions[0]?.(selection());
      expect(channel.subscriberCount()).toBe(1);

      // Click "Continue in sidebar" — the popup unmounts and the
      // sidebar mounts. The subscription must transfer ownership (still
      // exactly one subscriber alive).
      const continueButton = document.querySelector<HTMLButtonElement>(
        '[data-action="continue-sidebar"]'
      );
      expect(continueButton).not.toBeNull();
      continueButton?.click();
      expect(channel.subscriberCount()).toBe(1);

      // Click the sidebar close — the sidebar's `onDismiss` fires and
      // must tear down the retrieval subscription.
      const close = document.querySelector<HTMLButtonElement>('[data-action="close-sidebar"]');
      expect(close).not.toBeNull();
      close?.click();
      expect(channel.subscriberCount()).toBe(0);
    } finally {
      await shutdown();
      // Runtime shutdown is idempotent — count must remain zero.
      expect(channel.subscriberCount()).toBe(0);
    }
  });

  it("three popup → continue → sidebar → dismiss cycles leave subscriberCount at zero", async () => {
    const { channel, readerActions, shutdown } = await bootWithChannel();
    try {
      for (let i = 0; i < 3; i += 1) {
        readerActions[0]?.(selection());
        // One subscription per active explain — the channel must never
        // grow beyond one in-flight subscriber across the loop.
        expect(channel.subscriberCount()).toBe(1);
        document.querySelector<HTMLButtonElement>('[data-action="continue-sidebar"]')?.click();
        expect(channel.subscriberCount()).toBe(1);
        document.querySelector<HTMLButtonElement>('[data-action="close-sidebar"]')?.click();
        expect(channel.subscriberCount()).toBe(0);
      }
    } finally {
      await shutdown();
      expect(channel.subscriberCount()).toBe(0);
    }
  });

  it("runtime shutdown after a popup explain (no sidebar transition) tears the subscriber down", async () => {
    // Direct popup dismissal in production fires `onDismiss`, which the
    // fake adapter doesn't trigger; runtime shutdown calls
    // `cleanupExplain` which routes through the same `tearDownRetrieval`
    // owner, so the leak invariant is identical: count must reach zero
    // after the conversation is torn down by ANY teardown path.
    const { channel, readerActions, shutdown } = await bootWithChannel();
    readerActions[0]?.(selection());
    expect(channel.subscriberCount()).toBe(1);
    await shutdown();
    expect(channel.subscriberCount()).toBe(0);
  });

  it("ask-question flow tears the subscriber down on runtime shutdown", async () => {
    // Ask-question subscribes through the same channel; the cleanup
    // helper mirrors the explain path. Pin it so a future refactor that
    // diverges the two flows can't reintroduce the leak on one side.
    const { channel, readerActions, shutdown } = await bootWithChannel();
    // readerActions[1] is the "Ask a question" command (registered
    // second per the startup order asserted earlier in this file).
    readerActions[1]?.(selection());
    expect(channel.subscriberCount()).toBe(1);
    await shutdown();
    expect(channel.subscriberCount()).toBe(0);
  });
});
