/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import { createDefaultOllamaSettings } from "../../src/preferences/ollama-profile.js";
import { renderSettingsView } from "../../src/ui/settings-view.js";

describe("renderSettingsView", () => {
  it("renders Ollama settings and local-only disclosure", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: {
        state: "idle",
        totalItems: 0,
        indexedItems: 0,
        failedItems: 0
      }
    });

    expect(view.querySelector<HTMLInputElement>('[name="baseUrl"]')?.value).toBe(
      "http://localhost:11434"
    );
    expect(view.querySelector<HTMLInputElement>('[name="chatModel"]')?.value).toBe("gemma4:e4b");
    expect(view.querySelector<HTMLInputElement>('[name="embeddingModel"]')?.value).toBe(
      "embeddinggemma"
    );
    expect(view.textContent).toContain("Local only");
    expect(view.textContent).toContain("Index library");
  });
});
