/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";

import { createZoteroRuntime } from "../../src/platform/zotero-runtime.js";
import { createDefaultOllamaSettings } from "../../src/preferences/ollama-profile.js";

describe("createZoteroRuntime", () => {
  it("registers settings and explain commands on startup", async () => {
    const calls: string[] = [];
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      ui: {
        addMenuItem(label, action) {
          calls.push(`menu:${label}`);
          if (label === "Zotero AI Explain Settings") {
            action();
          }
          return () => calls.push(`remove-menu:${label}`);
        },
        addReaderCommand(label) {
          calls.push(`reader:${label}`);
          return () => calls.push(`remove-reader:${label}`);
        },
        openDialog(title, content) {
          calls.push(`dialog:${title}:${content.className}`);
        },
        mountPopup() {
          calls.push("popup");
          return () => calls.push("remove-popup");
        },
        mountSidebar() {
          calls.push("sidebar");
          return () => calls.push("remove-sidebar");
        }
      },
      onExplain: vi.fn()
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
});
