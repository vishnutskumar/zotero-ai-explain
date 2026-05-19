/* @vitest-environment jsdom */

/**
 * Targeted tests for the runtime's new `proxy` dep — the seam through
 * which bootstrap.ts hands the WiredProxy lifecycle into
 * `openSettingsDialog`. The runtime is in charge of:
 *
 *   1. Calling `proxy.snapshot()` once per dialog open so the rendered
 *      "Local LLM proxy" section reflects current state.
 *   2. Wiring the Start button so it calls `proxy.applyValues(values)`
 *      (to persist user edits) BEFORE `proxy.start()` (to spawn).
 *   3. Wiring the Stop button so it calls `proxy.stop()`.
 *   4. Omitting the proxy section entirely when `proxy` is undefined
 *      (preserves prior behavior for tests / hosts without the seam).
 */

import { describe, expect, it, vi } from "vitest";

import { createConversationStore } from "../../src/conversation/conversation-store.js";
import { createIndexingController } from "../../src/indexing/indexing-controller.js";
import { controllerStubDeps } from "../indexing/controller-test-helpers.js";
import { createZoteroRuntime, type ProxyRuntimeHandle } from "../../src/platform/zotero-runtime.js";
import type { ZoteroUiAdapter } from "../../src/platform/zotero-ui-types.js";
import {
  createDefaultOllamaSettings,
  ollamaSettingsToProfile
} from "../../src/preferences/ollama-profile.js";
import type { ProxySettingsState } from "../../src/ui/settings-view.js";
import type { PopupController } from "../../src/ui/popup-controller.js";
import type { SidebarController } from "../../src/ui/sidebar-controller.js";

function makeProxyHandle(initial: ProxySettingsState): {
  handle: ProxyRuntimeHandle;
  log: string[];
  startResult: { resolveNext: (result: { pid: number } | { error: string }) => void };
} {
  const log: string[] = [];
  let current = { ...initial };
  let resolveStart: ((r: { pid: number } | { error: string }) => void) | null = null;
  const handle: ProxyRuntimeHandle = {
    snapshot: () => {
      log.push("snapshot");
      return { ...current };
    },
    applyValues: (values) => {
      log.push(
        `applyValues:${values.nodeBinaryPath}|${values.serverScriptPath}|${String(values.port)}`
      );
      current = { ...current, ...values };
      return { ...current };
    },
    start: () => {
      log.push("start");
      return new Promise((resolve) => {
        resolveStart = resolve;
      });
    },
    stop: () => {
      log.push("stop");
      current = { ...current, running: false };
      return Promise.resolve();
    }
  };
  return {
    handle,
    log,
    startResult: {
      resolveNext: (r) => {
        if (resolveStart !== null) {
          resolveStart(r);
          resolveStart = null;
        }
      }
    }
  };
}

function createFakeUi(): { ui: ZoteroUiAdapter; lastDialogRoot: () => HTMLElement | null } {
  let lastRoot: HTMLElement | null = null;
  const ui: ZoteroUiAdapter = {
    addMenuItem(label, action) {
      if (label === "Zotero AI Explain Settings") {
        action();
      }
      return () => undefined;
    },
    addReaderCommand() {
      return () => undefined;
    },
    openDialog(_title, content) {
      lastRoot = content;
      document.body.append(content);
      return {
        close: () => {
          content.remove();
          lastRoot = null;
        },
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
  return { ui, lastDialogRoot: () => lastRoot };
}

function makeStubs(): {
  store: ReturnType<typeof createConversationStore>;
  popupController: PopupController;
  sidebarController: SidebarController;
} {
  return {
    store: createConversationStore(),
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

describe("createZoteroRuntime proxy threading", () => {
  it("renders the proxy section with the snapshot when a proxy handle is supplied", async () => {
    const { ui, lastDialogRoot } = createFakeUi();
    const { store, popupController, sidebarController } = makeStubs();
    const { handle, log } = makeProxyHandle({
      nodeBinaryPath: "/usr/local/bin/node",
      serverScriptPath: "/repo/scripts/llm-proxy/server.mjs",
      port: 11400,
      running: false
    });

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
      disclosure: () => "x",
      proxy: handle
    });

    await runtime.startup();

    // openSettingsDialog ran via the fake ui's addMenuItem; the proxy
    // section must be present in the rendered DOM and the snapshot
    // call must have happened.
    expect(log).toContain("snapshot");
    const root = lastDialogRoot();
    expect(root).not.toBeNull();
    const proxySection = root?.querySelector(".zotero-ai-proxy");
    expect(proxySection).not.toBeNull();
    // Pre-populated inputs match the snapshot.
    const portInput = root?.querySelector<HTMLInputElement>('[name="proxyPort"]');
    expect(portInput?.value).toBe("11400");
    const nodeInput = root?.querySelector<HTMLInputElement>('[name="proxyNodeBinaryPath"]');
    expect(nodeInput?.value).toBe("/usr/local/bin/node");

    await runtime.shutdown();
  });

  it("omits the proxy section when no proxy handle is supplied", async () => {
    const { ui, lastDialogRoot } = createFakeUi();
    const { store, popupController, sidebarController } = makeStubs();

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
      disclosure: () => "x"
    });

    await runtime.startup();
    const root = lastDialogRoot();
    expect(root).not.toBeNull();
    // Proxy section must NOT render when no handle is supplied (the
    // prior shape for tests / hosts without the proxy seam).
    expect(root?.querySelector(".zotero-ai-proxy")).toBeNull();
    await runtime.shutdown();
  });

  it("routes Start clicks through applyValues -> start in the right order", async () => {
    const { ui, lastDialogRoot } = createFakeUi();
    const { store, popupController, sidebarController } = makeStubs();
    const { handle, log, startResult } = makeProxyHandle({
      nodeBinaryPath: "/usr/local/bin/node",
      serverScriptPath: "/repo/server.mjs",
      port: 11400,
      running: false
    });

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
      disclosure: () => "x",
      proxy: handle
    });

    await runtime.startup();
    const root = lastDialogRoot();
    expect(root).not.toBeNull();

    // The user edits the port input then clicks Start.
    const portInput = root?.querySelector<HTMLInputElement>('[name="proxyPort"]');
    if (portInput === null || portInput === undefined) throw new Error("port input missing");
    portInput.value = "12345";

    const startBtn = root?.querySelector<HTMLButtonElement>('[data-action="start-proxy"]');
    expect(startBtn).not.toBeNull();
    startBtn?.click();

    // Resolve the in-flight start so the click handler's await
    // doesn't dangle past shutdown.
    startResult.resolveNext({ pid: 9999 });
    // Flush microtasks for the async click handler.
    await Promise.resolve();
    await Promise.resolve();

    // applyValues must precede start, and applyValues must include the
    // edited port.
    const applyIdx = log.findIndex((entry) => entry.startsWith("applyValues:"));
    const startIdx = log.indexOf("start");
    expect(applyIdx).toBeGreaterThanOrEqual(0);
    expect(startIdx).toBeGreaterThan(applyIdx);
    expect(log[applyIdx]).toContain("12345");

    await runtime.shutdown();
  });

  it("routes Stop clicks through proxy.stop", async () => {
    const { ui, lastDialogRoot } = createFakeUi();
    const { store, popupController, sidebarController } = makeStubs();
    const { handle, log } = makeProxyHandle({
      nodeBinaryPath: "/usr/local/bin/node",
      serverScriptPath: "/repo/server.mjs",
      port: 11400,
      // Render with running=true so the Stop button is enabled.
      running: true
    });

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
      disclosure: () => "x",
      proxy: handle
    });

    await runtime.startup();
    const root = lastDialogRoot();
    const stopBtn = root?.querySelector<HTMLButtonElement>('[data-action="stop-proxy"]');
    expect(stopBtn).not.toBeNull();
    expect(stopBtn?.disabled).toBe(false);
    stopBtn?.click();
    // Flush microtasks for the async stop handler.
    await Promise.resolve();
    await Promise.resolve();

    expect(log).toContain("stop");
    await runtime.shutdown();
  });
});
