/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ONBOARDING_ACTIONS,
  detectPlatform,
  probeOllamaForOnboarding,
  renderOnboardingView,
  wireOnboardingView,
  type OllamaProbeResult,
  type OnboardingPlatform,
  type OnboardingSideEffects
} from "../../src/ui/onboarding-view.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function mountView(input: Parameters<typeof renderOnboardingView>[0]): HTMLElement {
  const view = renderOnboardingView(input);
  document.body.append(view);
  return view;
}

function makeEffects(overrides: Partial<OnboardingSideEffects> = {}): OnboardingSideEffects {
  return {
    copyToClipboard: vi.fn(async () => Promise.resolve()),
    launchUrl: vi.fn(),
    recheck: vi.fn(async () => Promise.resolve({ state: "ready" } satisfies OllamaProbeResult)),
    close: vi.fn(),
    openSettings: vi.fn(),
    setTimeout: (handler) => {
      handler();
      return 0;
    },
    readyFlashMs: 0,
    ...overrides
  };
}

describe("renderOnboardingView — state branches", () => {
  it("renders an install panel ONLY for the 'ollama-missing' branch", () => {
    const a = mountView({ state: "ollama-missing", platform: "macos" });
    const b = mountView({
      state: "models-missing",
      platform: "macos",
      missingModels: { chat: "gemma4:e2b" }
    });

    expect(a.querySelector(".zotero-ai-onboarding__install")).not.toBeNull();
    expect(b.querySelector(".zotero-ai-onboarding__install")).toBeNull();
    // The lede copy differs by state.
    expect(a.querySelector(".zotero-ai-onboarding__lede")?.textContent).toMatch(/needs Ollama/iu);
    expect(b.querySelector(".zotero-ai-onboarding__lede")?.textContent).toMatch(
      /models this plugin uses aren't pulled/iu
    );
  });

  it("renders no install or pull panel when state is 'ready'", () => {
    const view = mountView({ state: "ready", platform: "macos" });
    expect(view.querySelector(".zotero-ai-onboarding__install")).toBeNull();
    expect(view.querySelector(".zotero-ai-onboarding__pull")).toBeNull();
    // Action row still present so the controller can flash + close.
    expect(view.querySelector(`[data-action="${ONBOARDING_ACTIONS.recheck}"]`)).not.toBeNull();
  });
});

describe("renderOnboardingView — platform-specific install copy", () => {
  it("renders 'brew install ollama' on macos with a download link backup", () => {
    const view = mountView({ state: "ollama-missing", platform: "macos" });
    const install = view.querySelector(".zotero-ai-onboarding__install");
    expect(install?.textContent).toContain("brew install ollama");
    const link = install?.querySelector<HTMLAnchorElement>('[data-action="onboarding-link"]');
    expect(link?.dataset.href).toBe("https://ollama.com/download/Ollama-darwin.zip");
  });

  it("renders the curl one-liner on linux", () => {
    const view = mountView({ state: "ollama-missing", platform: "linux" });
    expect(view.querySelector(".zotero-ai-onboarding__install")?.textContent).toContain(
      "curl -fsSL https://ollama.com/install.sh | sh"
    );
  });

  it("renders the .exe download link on windows (no copyable command)", () => {
    const view = mountView({ state: "ollama-missing", platform: "windows" });
    const install = view.querySelector(".zotero-ai-onboarding__install");
    const link = install?.querySelector<HTMLAnchorElement>('[data-action="onboarding-link"]');
    expect(link?.dataset.href).toBe("https://ollama.com/download/OllamaSetup.exe");
    // No `brew install` / `curl` commands rendered on the Windows branch.
    expect(install?.textContent).not.toMatch(/brew install/iu);
    expect(install?.textContent).not.toMatch(/curl /iu);
  });

  it("falls back to the generic download page on an unknown platform", () => {
    const view = mountView({ state: "ollama-missing", platform: "unknown" });
    const link = view.querySelector<HTMLAnchorElement>('[data-action="onboarding-link"]');
    expect(link?.dataset.href).toBe("https://ollama.com/download");
  });
});

describe("renderOnboardingView — model pull commands", () => {
  it("emits both pull commands when Ollama itself is missing (no probe data)", () => {
    const view = mountView({ state: "ollama-missing", platform: "macos" });
    const pulls = Array.from(view.querySelectorAll(".zotero-ai-onboarding__code-text")).map(
      (el) => el.textContent
    );
    expect(pulls).toEqual(
      expect.arrayContaining(["ollama pull gemma4:e2b", "ollama pull embeddinggemma"])
    );
  });

  it("emits ONLY the pull command for the missing model when state=models-missing", () => {
    const view = mountView({
      state: "models-missing",
      platform: "macos",
      missingModels: { chat: "gemma4:e2b" }
    });
    const pulls = Array.from(view.querySelectorAll(".zotero-ai-onboarding__code-text")).map(
      (el) => el.textContent
    );
    expect(pulls).toContain("ollama pull gemma4:e2b");
    expect(pulls).not.toContain("ollama pull embeddinggemma");
  });

  it("honours custom chat/embedding model names", () => {
    const view = mountView({
      state: "ollama-missing",
      platform: "linux",
      chatModel: "phi3:mini",
      embeddingModel: "nomic-embed-text"
    });
    const pulls = Array.from(view.querySelectorAll(".zotero-ai-onboarding__code-text")).map(
      (el) => el.textContent
    );
    expect(pulls).toEqual(
      expect.arrayContaining(["ollama pull phi3:mini", "ollama pull nomic-embed-text"])
    );
  });
});

describe("renderOnboardingView — privacy + actions", () => {
  it("always renders the privacy note", () => {
    for (const platform of [
      "macos",
      "windows",
      "linux",
      "unknown"
    ] satisfies OnboardingPlatform[]) {
      const view = mountView({ state: "ollama-missing", platform });
      expect(view.textContent).toContain("Document text stays on your machine");
    }
  });

  it("renders Re-check, Skip for now, and Open Settings buttons", () => {
    const view = mountView({ state: "ollama-missing", platform: "macos" });
    expect(view.querySelector(`[data-action="${ONBOARDING_ACTIONS.recheck}"]`)?.textContent).toBe(
      "Re-check"
    );
    expect(view.querySelector(`[data-action="${ONBOARDING_ACTIONS.skip}"]`)?.textContent).toBe(
      "Skip for now"
    );
    expect(
      view.querySelector(`[data-action="${ONBOARDING_ACTIONS.openSettings}"]`)?.textContent
    ).toBe("Open Settings");
  });

  it("renders a copy button beside every code block", () => {
    const view = mountView({ state: "ollama-missing", platform: "linux" });
    const blocks = view.querySelectorAll(".zotero-ai-onboarding__code");
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of Array.from(blocks)) {
      expect(block.querySelector('button[data-action^="onboarding-copy-"]')).not.toBeNull();
    }
  });
});

describe("wireOnboardingView — buttons", () => {
  it("Skip closes without touching openSettings / launchUrl", () => {
    const view = mountView({ state: "ollama-missing", platform: "macos" });
    const effects = makeEffects();
    wireOnboardingView({ view, effects });
    view.querySelector<HTMLButtonElement>(`[data-action="${ONBOARDING_ACTIONS.skip}"]`)?.click();
    expect(effects.close).toHaveBeenCalledTimes(1);
    expect(effects.openSettings).not.toHaveBeenCalled();
    expect(effects.launchUrl).not.toHaveBeenCalled();
  });

  it("Open Settings calls openSettings()", () => {
    const view = mountView({ state: "ollama-missing", platform: "macos" });
    const effects = makeEffects();
    wireOnboardingView({ view, effects });
    view
      .querySelector<HTMLButtonElement>(`[data-action="${ONBOARDING_ACTIONS.openSettings}"]`)
      ?.click();
    expect(effects.openSettings).toHaveBeenCalledTimes(1);
  });

  it("Re-check on ready flashes 'Ready!' and closes", async () => {
    const view = mountView({ state: "ollama-missing", platform: "macos" });
    const effects = makeEffects({
      recheck: vi.fn(async () => Promise.resolve({ state: "ready" } as OllamaProbeResult))
    });
    wireOnboardingView({ view, effects });

    view.querySelector<HTMLButtonElement>(`[data-action="${ONBOARDING_ACTIONS.recheck}"]`)?.click();
    // Drain microtasks for the promise chain.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(effects.recheck).toHaveBeenCalledTimes(1);
    expect(effects.close).toHaveBeenCalledTimes(1);
  });

  it("Re-check that returns models-missing re-renders the dialog in place", async () => {
    const view = mountView({ state: "ollama-missing", platform: "macos" });
    const effects = makeEffects({
      recheck: vi.fn(async () =>
        Promise.resolve({
          state: "models-missing",
          missing: { embed: "embeddinggemma" }
        } as OllamaProbeResult)
      )
    });
    wireOnboardingView({ view, effects });

    view.querySelector<HTMLButtonElement>(`[data-action="${ONBOARDING_ACTIONS.recheck}"]`)?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(view.dataset.state).toBe("models-missing");
    // Install panel is gone, pull panel only has the embedding command.
    expect(view.querySelector(".zotero-ai-onboarding__install")).toBeNull();
    const pulls = Array.from(view.querySelectorAll(".zotero-ai-onboarding__code-text")).map(
      (el) => el.textContent
    );
    expect(pulls).toContain("ollama pull embeddinggemma");
    expect(pulls).not.toContain("ollama pull gemma4:e2b");
    // Re-rendered buttons are wired (clicking Skip still triggers close).
    view.querySelector<HTMLButtonElement>(`[data-action="${ONBOARDING_ACTIONS.skip}"]`)?.click();
    expect(effects.close).toHaveBeenCalled();
  });

  it("Copy button writes the code-block text to the clipboard", async () => {
    const view = mountView({ state: "ollama-missing", platform: "macos" });
    const captured: string[] = [];
    const copy = vi.fn(async (text: string) => {
      captured.push(text);
      await Promise.resolve();
    });
    const effects = makeEffects({ copyToClipboard: copy });
    wireOnboardingView({ view, effects });

    const firstCopy = view.querySelector<HTMLButtonElement>(
      'button[data-action^="onboarding-copy-"]'
    );
    firstCopy?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(copy).toHaveBeenCalledTimes(1);
    // The first copy button belongs to the install command on macos.
    expect(captured[0]).toBe("brew install ollama");
    // The button label flips to "Copied" then is restored to "Copy" by the
    // synchronous setTimeout the effects fixture installs.
    expect(firstCopy?.textContent).toBe("Copy");
  });

  it("external links call launchUrl with the dataset href instead of navigating", () => {
    const view = mountView({ state: "ollama-missing", platform: "windows" });
    const effects = makeEffects();
    wireOnboardingView({ view, effects });
    const link = view.querySelector<HTMLAnchorElement>('[data-action="onboarding-link"]');
    link?.click();
    expect(effects.launchUrl).toHaveBeenCalledTimes(1);
    expect(effects.launchUrl).toHaveBeenCalledWith("https://ollama.com/download/OllamaSetup.exe");
  });

  it("detach() removes every listener so a stale Skip click does NOT call close()", () => {
    const view = mountView({ state: "ollama-missing", platform: "macos" });
    const effects = makeEffects();
    const handle = wireOnboardingView({ view, effects });
    handle.detach();
    view.querySelector<HTMLButtonElement>(`[data-action="${ONBOARDING_ACTIONS.skip}"]`)?.click();
    expect(effects.close).not.toHaveBeenCalled();
  });
});

describe("probeOllamaForOnboarding", () => {
  it("returns 'ollama-missing' when fetch rejects", async () => {
    const result = await probeOllamaForOnboarding({
      baseUrl: "http://localhost:11434",
      chatModel: "x",
      embeddingModel: "y",
      fetch: vi.fn(() => Promise.reject(new Error("ECONNREFUSED")))
    });
    expect(result.state).toBe("ollama-missing");
  });

  it("returns 'ollama-missing' on non-OK response", async () => {
    const result = await probeOllamaForOnboarding({
      baseUrl: "http://localhost:11434",
      chatModel: "x",
      embeddingModel: "y",
      fetch: vi.fn(async () => {
        await Promise.resolve();
        return {
          ok: false,
          status: 500,
          // eslint-disable-next-line @typescript-eslint/require-await
          async json() {
            return {};
          }
        };
      })
    });
    expect(result.state).toBe("ollama-missing");
  });

  it("returns 'models-missing' when only one model is present", async () => {
    const result = await probeOllamaForOnboarding({
      baseUrl: "http://localhost:11434",
      chatModel: "gemma4:e2b",
      embeddingModel: "embeddinggemma",
      fetch: vi.fn(async () => {
        await Promise.resolve();
        return {
          ok: true,
          status: 200,
          // eslint-disable-next-line @typescript-eslint/require-await
          async json() {
            return { models: [{ name: "gemma4:e2b" }] };
          }
        };
      })
    });
    if (result.state !== "models-missing") {
      throw new Error("expected models-missing");
    }
    expect(result.missing.embed).toBe("embeddinggemma");
    expect(result.missing.chat).toBeUndefined();
  });

  it("returns 'ready' when both models are present", async () => {
    const result = await probeOllamaForOnboarding({
      baseUrl: "http://localhost:11434",
      chatModel: "gemma4:e2b",
      embeddingModel: "embeddinggemma",
      fetch: vi.fn(async () => {
        await Promise.resolve();
        return {
          ok: true,
          status: 200,
          // eslint-disable-next-line @typescript-eslint/require-await
          async json() {
            return {
              models: [{ name: "gemma4:e2b" }, { name: "embeddinggemma" }]
            };
          }
        };
      })
    });
    expect(result.state).toBe("ready");
  });

  // Regression: a user who first-runs the plugin after selecting a
  // Codex/Claude Proxy preset has `baseUrl` pointing at the proxy. The
  // proxy enforces bearer auth on `/api/tags`. Without the closure the
  // probe always reported `ollama-missing` for proxy users, popping the
  // onboarding dialog on every launch.
  it("threads getProxyAuthHeader into the fetch init when the dep is provided", async () => {
    const fakeFetch = vi.fn<
      (
        url: string,
        init?: { readonly signal?: AbortSignal; readonly headers?: Record<string, string> }
      ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
    >(async () => {
      await Promise.resolve();
      return {
        ok: true,
        status: 200,
        // eslint-disable-next-line @typescript-eslint/require-await
        async json() {
          return { models: [{ name: "gpt-5-codex" }] };
        }
      };
    });
    const result = await probeOllamaForOnboarding({
      baseUrl: "http://localhost:11400/codex",
      chatModel: "gpt-5-codex",
      embeddingModel: "gpt-5-codex",
      fetch: fakeFetch,
      getProxyAuthHeader: (baseUrl) => {
        expect(baseUrl).toBe("http://localhost:11400/codex");
        return { Authorization: "Bearer onboarding-token" };
      }
    });
    expect(result.state).toBe("ready");
    const headers = fakeFetch.mock.calls[0]?.[1]?.headers;
    expect(headers?.Authorization).toBe("Bearer onboarding-token");
  });

  it("sends no Authorization header when getProxyAuthHeader is omitted (legacy)", async () => {
    const fakeFetch = vi.fn<
      (
        url: string,
        init?: { readonly signal?: AbortSignal; readonly headers?: Record<string, string> }
      ) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
    >(async () => {
      await Promise.resolve();
      return {
        ok: true,
        status: 200,
        // eslint-disable-next-line @typescript-eslint/require-await
        async json() {
          return { models: [{ name: "gemma4:e2b" }, { name: "embeddinggemma" }] };
        }
      };
    });
    await probeOllamaForOnboarding({
      baseUrl: "http://localhost:11434",
      chatModel: "gemma4:e2b",
      embeddingModel: "embeddinggemma",
      fetch: fakeFetch
    });
    const headers = fakeFetch.mock.calls[0]?.[1]?.headers;
    expect(headers).toBeUndefined();
  });
});

describe("detectPlatform", () => {
  it("classifies Darwin / WINNT / Linux from Services.appinfo.OS", () => {
    expect(detectPlatform({ Services: { appinfo: { OS: "Darwin" } } })).toBe("macos");
    expect(detectPlatform({ Services: { appinfo: { OS: "WINNT" } } })).toBe("windows");
    expect(detectPlatform({ Services: { appinfo: { OS: "Linux" } } })).toBe("linux");
  });

  it("falls back to Zotero.oscpu when appinfo.OS is missing", () => {
    expect(detectPlatform({ Zotero: { oscpu: "Intel Mac OS X 10.15" } })).toBe("macos");
    expect(detectPlatform({ Zotero: { oscpu: "Windows NT 10.0" } })).toBe("windows");
  });

  it("returns 'unknown' on a host with no detectable identity", () => {
    expect(detectPlatform({})).toBe("unknown");
  });
});
