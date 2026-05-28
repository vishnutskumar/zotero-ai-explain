/* @vitest-environment jsdom */

/**
 * Integration test for the full settings save flow.
 *
 * The user-reported bug: typing a new chat model into the settings
 * dialog and clicking Save (or, before this fix, blurring the field)
 * didn't actually persist — reopening showed the old value, and
 * "Explain with AI" still tried to use the old model.
 *
 * Root cause: `renderSettingsView` had no Save action wired at all, and
 * the codebase had no `Zotero.Prefs.set` bridge. This test exercises
 * the post-fix path end-to-end:
 *
 *   1. Open settings via the menu callback registered by the runtime.
 *   2. Type new values into each input.
 *   3. Click Save. Validation `fetch` returns the models as available.
 *   4. Assert the pref writer received all three keys with the typed values.
 *   5. Assert the dialog closed.
 *   6. Re-open the menu. Assert the dialog now renders the SAVED values
 *      (not the original defaults), proving the runtime's in-memory
 *      cache stays in sync.
 *   7. Construct a fresh runtime with the persisted prefs and confirm
 *      it picks them up (i.e., the next startup reads what we wrote).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createConversationStore } from "../../src/conversation/conversation-store.js";
import { createIndexingController } from "../../src/indexing/indexing-controller.js";
import { controllerStubDeps } from "../indexing/controller-test-helpers.js";
import { createZoteroRuntime } from "../../src/platform/zotero-runtime.js";
import { createZoteroUiAdapter, type ZoteroGlobal } from "../../src/platform/zotero-ui-adapter.js";
import {
  CHAT_BASE_URL_PREF,
  CHAT_MODEL_PREF,
  EMBED_BASE_URL_PREF,
  EMBEDDING_MODEL_PREF,
  OLLAMA_BASE_URL_PREF,
  createDefaultOllamaSettings,
  loadOllamaSettingsFromPrefs,
  ollamaSettingsToProfile,
  type StringPrefReader,
  type StringPrefWriter
} from "../../src/preferences/ollama-profile.js";
import type { PopupController } from "../../src/ui/popup-controller.js";
import type { SidebarController } from "../../src/ui/sidebar-controller.js";

type PrefStore = {
  values: Map<string, string>;
  writer: StringPrefWriter;
  reader: StringPrefReader;
};

function makePrefStore(initial: Record<string, string> = {}): PrefStore {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    values,
    writer: {
      set(name, value) {
        values.set(name, value);
      }
    },
    reader: {
      get(name) {
        return values.get(name);
      }
    }
  };
}

function makeFakeFetch(models: readonly string[]): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    // url is captured by the spy's mock.calls so the test can assert on
    // the exact URL Ollama was probed at.
    void url;
    await Promise.resolve();
    return {
      ok: true,
      status: 200,
      // eslint-disable-next-line @typescript-eslint/require-await
      async json() {
        return { models: models.map((name) => ({ name })) };
      }
    };
  });
}

function makeStubControllers(): {
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

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.innerHTML = "<head></head><body></body>";
});

describe("settings save flow (integration)", () => {
  it("persists user-typed values and the dialog reflects them on reopen", async () => {
    const prefs = makePrefStore();
    const fakeFetch = makeFakeFetch(["gemma4:e2b", "embedding-v2"]);
    const onSettingsChange = vi.fn();
    const { popupController, sidebarController } = makeStubControllers();

    // Track every menu callback registered via the *real* UI adapter so
    // the test can fire the "open settings" command on demand instead of
    // relying on a stale capture from runtime construction.
    const menuCallbacks: { label: string; action: () => void }[] = [];
    const debug = vi.fn();
    const zotero: ZoteroGlobal = {
      debug,
      getMainWindow: () => window
    };
    const realUi = createZoteroUiAdapter({ Zotero: zotero, pluginId: "test" });
    const ui: typeof realUi = {
      ...realUi,
      addMenuItem(label, action) {
        menuCallbacks.push({ label, action });
        return realUi.addMenuItem(label, action);
      }
    };

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
      prefsWriter: prefs.writer,
      fetch: fakeFetch,
      onSettingsChange
    });

    await runtime.startup();

    // Open the dialog.
    menuCallbacks.find((m) => m.label === "Zotero AI Explain Settings")?.action();

    const chatUrlInput = document.querySelector<HTMLInputElement>('[name="chatBaseUrl"]');
    const embedUrlInput = document.querySelector<HTMLInputElement>('[name="embedBaseUrl"]');
    const chatInput = document.querySelector<HTMLInputElement>('[name="chatModel"]');
    const embedInput = document.querySelector<HTMLInputElement>('[name="embeddingModel"]');
    expect(chatUrlInput?.value).toBe("http://localhost:11434");
    expect(embedUrlInput?.value).toBe("http://localhost:11434");
    expect(chatInput?.value).toBe("gemma4:e4b");

    // Type new values.
    if (chatUrlInput) chatUrlInput.value = "http://localhost:11434";
    if (embedUrlInput) embedUrlInput.value = "http://localhost:11434";
    if (chatInput) chatInput.value = "gemma4:e2b";
    if (embedInput) embedInput.value = "embedding-v2";

    // The save flow schedules close() via setTimeout for the "Saved"
    // flash. Switch to fake timers BEFORE the click so we can fast-
    // forward past the 1s flash without waiting in real time.
    vi.useFakeTimers();
    document.querySelector<HTMLButtonElement>('[data-action="save-settings"]')?.click();

    // Drain microtasks (validate + onSave) under fake timers. The
    // promise chain inside the Save handler awaits validate() — fake
    // timers don't pause microtasks, so the promise still settles.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    // Now jump past the 1s "Saved" flash window so close() fires.
    await vi.advanceTimersByTimeAsync(1100);
    vi.useRealTimers();

    // Pref writes happened with the typed values. Both modern keys + the
    // legacy mirror must be set so an older code path reading the legacy
    // key still resolves to a working URL.
    expect(prefs.values.get(CHAT_BASE_URL_PREF)).toBe("http://localhost:11434");
    expect(prefs.values.get(EMBED_BASE_URL_PREF)).toBe("http://localhost:11434");
    expect(prefs.values.get(OLLAMA_BASE_URL_PREF)).toBe("http://localhost:11434");
    expect(prefs.values.get(CHAT_MODEL_PREF)).toBe("gemma4:e2b");
    expect(prefs.values.get(EMBEDDING_MODEL_PREF)).toBe("embedding-v2");

    // Validate probes BOTH URLs (chat + embed) — same endpoint here, so
    // two fetches that both hit /api/tags.
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(fakeFetch.mock.calls[0]?.[0]).toBe("http://localhost:11434/api/tags");
    expect(fakeFetch.mock.calls[1]?.[0]).toBe("http://localhost:11434/api/tags");

    // onSettingsChange fired with the new values.
    expect(onSettingsChange).toHaveBeenCalledTimes(1);
    expect(onSettingsChange.mock.calls[0]?.[0]).toMatchObject({
      chatBaseUrl: "http://localhost:11434",
      embedBaseUrl: "http://localhost:11434",
      chatModel: "gemma4:e2b",
      embeddingModel: "embedding-v2"
    });

    // The dialog is now gone.
    expect(document.querySelector(".zotero-ai-dialog")).toBeNull();

    // Reopen and confirm the saved values render.
    menuCallbacks.find((m) => m.label === "Zotero AI Explain Settings")?.action();
    const chatInput2 = document.querySelector<HTMLInputElement>('[name="chatModel"]');
    const embedInput2 = document.querySelector<HTMLInputElement>('[name="embeddingModel"]');
    expect(chatInput2?.value).toBe("gemma4:e2b");
    expect(embedInput2?.value).toBe("embedding-v2");

    // And: a freshly-constructed runtime that reads from the pref store
    // sees the same values — the next plugin startup will pick them up.
    expect(loadOllamaSettingsFromPrefs(prefs.reader)).toMatchObject({
      baseUrl: "http://localhost:11434",
      chatBaseUrl: "http://localhost:11434",
      embedBaseUrl: "http://localhost:11434",
      chatModel: "gemma4:e2b",
      embeddingModel: "embedding-v2"
    });

    await runtime.shutdown();
  });

  it("does NOT persist when validation fails", async () => {
    const prefs = makePrefStore();
    // Server only knows the default model, not the user's new pick.
    const fakeFetch = makeFakeFetch(["gemma4:e4b", "embeddinggemma"]);
    const onSettingsChange = vi.fn();
    const { popupController, sidebarController } = makeStubControllers();

    const menuCallbacks: { label: string; action: () => void }[] = [];
    const realUi = createZoteroUiAdapter({
      Zotero: { debug: vi.fn(), getMainWindow: () => window },
      pluginId: "test"
    });
    const ui: typeof realUi = {
      ...realUi,
      addMenuItem(label, action) {
        menuCallbacks.push({ label, action });
        return realUi.addMenuItem(label, action);
      }
    };

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
      prefsWriter: prefs.writer,
      fetch: fakeFetch,
      onSettingsChange
    });
    await runtime.startup();

    menuCallbacks.find((m) => m.label === "Zotero AI Explain Settings")?.action();

    const chat = document.querySelector<HTMLInputElement>('[name="chatModel"]');
    if (chat) chat.value = "nope:1b";
    document.querySelector<HTMLButtonElement>('[data-action="save-settings"]')?.click();

    // Validation now probes BOTH the chat and embed URL in parallel and
    // each probe awaits two stages (fetch + json). Drain enough
    // microtasks for the Promise.all to settle and showErrors to run.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    // Pref store unchanged, callback not fired, dialog still open.
    expect(prefs.values.size).toBe(0);
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(document.querySelector(".zotero-ai-dialog")).not.toBeNull();
    const errEl = document.querySelector<HTMLElement>('[data-error-for="chatModel"]');
    expect(errEl?.hidden).toBe(false);
    expect(errEl?.textContent).toContain("nope:1b");

    await runtime.shutdown();
  });

  it("threads getProxyAuthHeader into the Save-button URL probe (proxy preset)", async () => {
    // Regression: clicking Save with a Codex/Claude Proxy URL surfaced
    // "Server responded 401 for /api/tags" because the runtime's
    // `probeOneUrl` never attached the proxy bearer. With the closure
    // threaded through, the GET reaches `/api/tags` with the bearer
    // and validation passes.
    const prefs = makePrefStore({
      [CHAT_BASE_URL_PREF]: "http://localhost:11400/codex",
      [EMBED_BASE_URL_PREF]: "http://localhost:11400/codex",
      [CHAT_MODEL_PREF]: "gpt-5-codex",
      [EMBEDDING_MODEL_PREF]: "gpt-5-codex"
    });
    const fakeFetch = makeFakeFetch(["gpt-5-codex"]);
    const { popupController, sidebarController } = makeStubControllers();

    const menuCallbacks: { label: string; action: () => void }[] = [];
    const realUi = createZoteroUiAdapter({
      Zotero: { debug: vi.fn(), getMainWindow: () => window },
      pluginId: "test"
    });
    const ui: typeof realUi = {
      ...realUi,
      addMenuItem(label, action) {
        menuCallbacks.push({ label, action });
        return realUi.addMenuItem(label, action);
      }
    };

    // The closure returns the bearer regardless of input here so the
    // assertion below can pin it; in production it self-gates on
    // hostname/port (the buildProxyAuthHeader unit tests pin that).
    const fakeBearer = "Bearer proxy-token-zzz";
    const getProxyAuthHeader = vi.fn((): Record<string, string> => ({ Authorization: fakeBearer }));

    const initial = {
      ...createDefaultOllamaSettings(),
      baseUrl: "http://localhost:11400/codex",
      chatBaseUrl: "http://localhost:11400/codex",
      embedBaseUrl: "http://localhost:11400/codex",
      chatModel: "gpt-5-codex",
      embeddingModel: "gpt-5-codex"
    };
    const runtime = createZoteroRuntime({
      settings: initial,
      indexingController: createIndexingController({
        logger: { debug: () => undefined },
        ...controllerStubDeps()
      }),
      ui,
      store: createConversationStore(),
      profile: () => ollamaSettingsToProfile(initial),
      popupController,
      sidebarController,
      disclosure: () => "disclosure",
      prefsWriter: prefs.writer,
      fetch: fakeFetch,
      getProxyAuthHeader
    });
    await runtime.startup();

    menuCallbacks.find((m) => m.label === "Zotero AI Explain Settings")?.action();

    vi.useFakeTimers();
    document.querySelector<HTMLButtonElement>('[data-action="save-settings"]')?.click();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(1100);
    vi.useRealTimers();

    // Both validate probes (chat + embed) went through with the bearer.
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    type FetchInit = { readonly headers?: Record<string, string> };
    const init0 = fakeFetch.mock.calls[0]?.[1] as FetchInit | undefined;
    const init1 = fakeFetch.mock.calls[1]?.[1] as FetchInit | undefined;
    expect(init0?.headers?.Authorization).toBe(fakeBearer);
    expect(init1?.headers?.Authorization).toBe(fakeBearer);
    // And the closure was invoked with the trimmed base URL (no
    // `/api/tags` suffix) so the production closure's hostname/port
    // gate sees the form it was designed for.
    expect(getProxyAuthHeader).toHaveBeenCalledWith("http://localhost:11400/codex");

    await runtime.shutdown();
  });

  it("Cancel never writes prefs and closes the dialog", async () => {
    const prefs = makePrefStore();
    const fakeFetch = makeFakeFetch(["gemma4:e4b"]);
    const { popupController, sidebarController } = makeStubControllers();

    const menuCallbacks: { label: string; action: () => void }[] = [];
    const realUi = createZoteroUiAdapter({
      Zotero: { debug: vi.fn(), getMainWindow: () => window },
      pluginId: "test"
    });
    const ui: typeof realUi = {
      ...realUi,
      addMenuItem(label, action) {
        menuCallbacks.push({ label, action });
        return realUi.addMenuItem(label, action);
      }
    };

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
      prefsWriter: prefs.writer,
      fetch: fakeFetch
    });
    await runtime.startup();

    menuCallbacks.find((m) => m.label === "Zotero AI Explain Settings")?.action();

    const chat = document.querySelector<HTMLInputElement>('[name="chatModel"]');
    if (chat) chat.value = "ignored-because-cancel";

    document.querySelector<HTMLButtonElement>('[data-action="cancel-settings"]')?.click();

    expect(prefs.values.size).toBe(0);
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(document.querySelector(".zotero-ai-dialog")).toBeNull();

    await runtime.shutdown();
  });
});
