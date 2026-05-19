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

describe("discoverModels — Ollama", () => {
  it("calls GET ${url}/api/tags and returns deduped + sorted model names", async () => {
    const fetcher = vi.fn<DiscoveryFetch>(() =>
      jsonResponse({
        models: [
          { name: "gemma4:e4b" },
          { name: "embeddinggemma" },
          { name: "gemma4:e4b" } // duplicate
        ]
      })
    );
    const result = await discoverModels({
      backend: "ollama",
      url: "http://localhost:11434/",
      fetch: fetcher,
      timeoutMs: 0
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.message}`);
    expect(result.models).toEqual(["embeddinggemma", "gemma4:e4b"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://localhost:11434/api/tags");
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
