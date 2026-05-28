import { describe, expect, it, vi } from "vitest";

import {
  backendForChatProvider,
  backendForEmbedProvider,
  discoverModels,
  type DiscoveryFetch
} from "../../src/preferences/model-discovery.js";

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload)
  });
}

/**
 * Build a routing fetcher: returns `tagsPayload` for /api/tags and
 * `versionPayload` for /api/version. Lets each test compose the two
 * probes the Ollama discovery path now makes (model list + version
 * floor) without re-implementing the routing in every block.
 */
function routingFetcher(
  tagsPayload: { payload: unknown; status?: number },
  versionPayload: { payload: unknown; status?: number } = {
    payload: { version: "0.24.0" }
  }
) {
  return vi.fn<DiscoveryFetch>((url: string) => {
    if (url.endsWith("/api/tags")) {
      return jsonResponse(tagsPayload.payload, tagsPayload.status ?? 200);
    }
    if (url.endsWith("/api/version")) {
      return jsonResponse(versionPayload.payload, versionPayload.status ?? 200);
    }
    return jsonResponse({}, 404);
  });
}

describe("discoverModels — Ollama", () => {
  it("calls GET ${url}/api/tags then /api/version and returns deduped + sorted model names", async () => {
    const fetcher = routingFetcher({
      payload: {
        models: [
          { name: "gemma4:e4b" },
          { name: "embeddinggemma" },
          { name: "gemma4:e4b" } // duplicate
        ]
      }
    });
    const result = await discoverModels({
      backend: "ollama",
      url: "http://localhost:11434/",
      fetch: fetcher,
      timeoutMs: 0
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.message}`);
    expect(result.models).toEqual(["embeddinggemma", "gemma4:e4b"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://localhost:11434/api/tags");
    expect(fetcher.mock.calls[1]?.[0]).toBe("http://localhost:11434/api/version");
    // Version probe returned 0.24.0 (≥ MIN_OLLAMA_VERSION) → no warning.
    expect(result.warning).toBeUndefined();
  });

  it("surfaces a warning when /api/version reports a daemon older than MIN_OLLAMA_VERSION", async () => {
    const fetcher = routingFetcher(
      { payload: { models: [{ name: "embeddinggemma" }] } },
      { payload: { version: "0.6.6" } }
    );
    const result = await discoverModels({
      backend: "ollama",
      url: "http://localhost:11434",
      fetch: fetcher,
      timeoutMs: 0
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.message}`);
    expect(result.models).toEqual(["embeddinggemma"]);
    expect(result.warning).toBeDefined();
    expect(result.warning).toMatch(/0\.6\.6/u);
    expect(result.warning).toMatch(/Upgrade Ollama/u);
  });

  it("returns the model list with no warning when the version probe errors (best-effort)", async () => {
    const fetcher = routingFetcher(
      { payload: { models: [{ name: "embeddinggemma" }] } },
      { payload: {}, status: 500 }
    );
    const result = await discoverModels({
      backend: "ollama",
      url: "http://localhost:11434",
      fetch: fetcher,
      timeoutMs: 0
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.message}`);
    expect(result.models).toEqual(["embeddinggemma"]);
    // 500 on /api/version → kind: "unreachable" — not surfaced as a UI warning
    // because the model-list probe already succeeded (i.e. the daemon IS up).
    expect(result.warning).toBeUndefined();
  });

  it("returns an error when the response is non-2xx", async () => {
    const fetcher = vi.fn<DiscoveryFetch>(() => jsonResponse({}, 500));
    const result = await discoverModels({
      backend: "ollama",
      url: "http://localhost:11434",
      fetch: fetcher,
      timeoutMs: 0
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/500/u);
  });

  it("returns an error when the fetch throws", async () => {
    const fetcher = vi.fn<DiscoveryFetch>(() => {
      throw new Error("ECONNREFUSED");
    });
    const result = await discoverModels({
      backend: "ollama",
      url: "http://localhost:11434",
      fetch: fetcher,
      timeoutMs: 0
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("ECONNREFUSED");
  });
});

describe("discoverModels — proxy", () => {
  it("uses the same /api/tags path as Ollama (proxy mirrors the Ollama shape)", async () => {
    const fetcher = vi.fn<DiscoveryFetch>(() =>
      jsonResponse({ models: [{ name: "gpt-5-codex" }] })
    );
    const result = await discoverModels({
      backend: "proxy",
      url: "http://localhost:11400/codex",
      fetch: fetcher,
      timeoutMs: 0
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.message}`);
    expect(result.models).toEqual(["gpt-5-codex"]);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://localhost:11400/codex/api/tags");
  });

  // Regression: the proxy enforces bearer auth on `/api/tags`. Without
  // the closure, the settings-dialog "list models" dropdown 401s every
  // user on the Codex/Claude Proxy presets. The dep is optional so
  // legacy callers that don't wire the proxy lifecycle still work.
  it("threads the Authorization header from getProxyAuthHeader into the fetch init", async () => {
    const fetcher = vi.fn<DiscoveryFetch>(() =>
      jsonResponse({ models: [{ name: "gpt-5-codex" }] })
    );
    const result = await discoverModels({
      backend: "proxy",
      url: "http://localhost:11400/codex",
      fetch: fetcher,
      timeoutMs: 0,
      getProxyAuthHeader: (baseUrl) => {
        // The trimmed URL flows through; assert here so we catch
        // accidental trailing-slash drift in either direction.
        expect(baseUrl).toBe("http://localhost:11400/codex");
        return { Authorization: "Bearer proxy-token-xyz" };
      }
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.message}`);
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(init?.headers?.Authorization).toBe("Bearer proxy-token-xyz");
  });

  it("sends no Authorization header when getProxyAuthHeader returns undefined", async () => {
    // The closure self-gates on hostname/port. A user with the Local
    // Ollama preset (backend === ollama, but URL matches a real daemon)
    // must NOT receive the proxy bearer because the closure returns
    // undefined for any non-proxy host/port.
    const fetcher = vi.fn<DiscoveryFetch>(() => jsonResponse({ models: [{ name: "gemma4:e4b" }] }));
    const result = await discoverModels({
      backend: "ollama",
      url: "http://localhost:11434",
      fetch: fetcher,
      timeoutMs: 0,
      getProxyAuthHeader: () => undefined
    });
    if (!result.ok) throw new Error("expected ok");
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(init?.headers).toBeUndefined();
  });

  it("omits Authorization when getProxyAuthHeader dep is not provided (backward compat)", async () => {
    const fetcher = vi.fn<DiscoveryFetch>(() => jsonResponse({ models: [] }));
    await discoverModels({
      backend: "proxy",
      url: "http://localhost:11400/codex",
      fetch: fetcher,
      timeoutMs: 0
    });
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(init?.headers).toBeUndefined();
  });
});

describe("discoverModels — OpenAI", () => {
  it("calls GET ${url}/models with Bearer auth and parses data[].id", async () => {
    const fetcher = vi.fn<DiscoveryFetch>(() =>
      jsonResponse({
        data: [{ id: "gpt-4o-mini" }, { id: "text-embedding-3-small" }]
      })
    );
    const result = await discoverModels({
      backend: "openai",
      url: "https://api.openai.com/v1",
      apiKey: "sk-test",
      fetch: fetcher,
      timeoutMs: 0
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.models).toEqual(["gpt-4o-mini", "text-embedding-3-small"]);
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(init?.headers?.Authorization).toBe("Bearer sk-test");
  });

  it("returns an error message when API key is missing", async () => {
    const fetcher = vi.fn<DiscoveryFetch>(() => jsonResponse({}));
    const result = await discoverModels({
      backend: "openai",
      url: "https://api.openai.com/v1",
      apiKey: "",
      fetch: fetcher,
      timeoutMs: 0
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/API key/u);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("discoverModels — Anthropic", () => {
  it("uses x-api-key + anthropic-version headers", async () => {
    const fetcher = vi.fn<DiscoveryFetch>(() =>
      jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] })
    );
    const result = await discoverModels({
      backend: "anthropic",
      url: "https://api.anthropic.com/v1",
      apiKey: "sk-ant",
      fetch: fetcher,
      timeoutMs: 0
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.models).toEqual(["claude-sonnet-4-5"]);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect(init?.headers?.["x-api-key"]).toBe("sk-ant");
    expect(init?.headers?.["anthropic-version"]).toBeDefined();
  });
});

describe("discoverModels — Gemini", () => {
  it("appends ?key=... and strips the models/ prefix", async () => {
    const fetcher = vi.fn<DiscoveryFetch>(() =>
      jsonResponse({
        models: [{ name: "models/text-embedding-004" }, { name: "models/gemini-1.5-flash" }]
      })
    );
    const result = await discoverModels({
      backend: "gemini",
      url: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gem-test",
      fetch: fetcher,
      timeoutMs: 0
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.models).toEqual(["gemini-1.5-flash", "text-embedding-004"]);
    const [url] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models?key=gem-test");
  });

  it("percent-encodes the API key into the URL", async () => {
    const fetcher = vi.fn<DiscoveryFetch>(() => jsonResponse({ models: [] }));
    await discoverModels({
      backend: "gemini",
      url: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "gem with spaces+&",
      fetch: fetcher,
      timeoutMs: 0
    });
    const [url] = fetcher.mock.calls[0] ?? [];
    expect(url).toContain("key=gem%20with%20spaces%2B%26");
  });
});

describe("discoverModels — malformed payloads", () => {
  it("returns an empty model list when 'models' is missing", async () => {
    const fetcher = vi.fn<DiscoveryFetch>(() => jsonResponse({}));
    const result = await discoverModels({
      backend: "ollama",
      url: "http://localhost:11434",
      fetch: fetcher,
      timeoutMs: 0
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.models).toEqual([]);
  });

  it("skips entries without a string name", async () => {
    const fetcher = vi.fn<DiscoveryFetch>(() =>
      jsonResponse({ models: [{ name: null }, { other: "x" }, { name: "valid" }] })
    );
    const result = await discoverModels({
      backend: "ollama",
      url: "http://localhost:11434",
      fetch: fetcher,
      timeoutMs: 0
    });
    if (!result.ok) throw new Error("expected ok");
    expect(result.models).toEqual(["valid"]);
  });
});

describe("backendForChatProvider / backendForEmbedProvider", () => {
  it("maps chat providers to their canonical discovery backend", () => {
    expect(backendForChatProvider("ollama")).toBe("ollama");
    expect(backendForChatProvider("codex-cli")).toBe("proxy");
    expect(backendForChatProvider("claude-cli")).toBe("proxy");
    expect(backendForChatProvider("codex-api")).toBe("openai");
    expect(backendForChatProvider("claude-api")).toBe("anthropic");
  });

  it("maps embed providers to their canonical discovery backend", () => {
    expect(backendForEmbedProvider("ollama")).toBe("ollama");
    expect(backendForEmbedProvider("openai")).toBe("openai");
    expect(backendForEmbedProvider("gemini")).toBe("gemini");
  });
});
