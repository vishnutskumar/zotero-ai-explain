import { describe, expect, it, vi } from "vitest";

import {
  MIN_OLLAMA_VERSION,
  checkOllamaVersion,
  compareVersions,
  isAtLeast,
  parseVersion,
  type VersionFetch
} from "../../src/preferences/ollama-version.js";

function jsonResponse(payload: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload)
  });
}

describe("parseVersion", () => {
  it("parses canonical MAJOR.MINOR.PATCH", () => {
    expect(parseVersion("0.24.0")).toEqual({ major: 0, minor: 24, patch: 0 });
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion("10.0.0")).toEqual({ major: 10, minor: 0, patch: 0 });
  });

  it("strips an optional leading v", () => {
    expect(parseVersion("v0.24.0")).toEqual({ major: 0, minor: 24, patch: 0 });
  });

  it("strips a prerelease suffix and a build-metadata suffix for ordering", () => {
    expect(parseVersion("0.24.0-rc1")).toEqual({ major: 0, minor: 24, patch: 0 });
    expect(parseVersion("0.24.0+build.123")).toEqual({ major: 0, minor: 24, patch: 0 });
    expect(parseVersion("0.24.0-rc1+build.7")).toEqual({ major: 0, minor: 24, patch: 0 });
  });

  it("trims surrounding whitespace", () => {
    expect(parseVersion("  0.24.0  ")).toEqual({ major: 0, minor: 24, patch: 0 });
  });

  it("returns null for malformed inputs", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("0.24")).toBeNull();
    expect(parseVersion("0.24.x")).toBeNull();
    expect(parseVersion("not-a-version")).toBeNull();
    expect(parseVersion("1")).toBeNull();
  });
});

describe("compareVersions / isAtLeast", () => {
  const v = (raw: string) => {
    const parsed = parseVersion(raw);
    if (parsed === null) throw new Error(`bad fixture: ${raw}`);
    return parsed;
  };

  it("orders by major then minor then patch", () => {
    expect(compareVersions(v("0.10.0"), v("0.10.0"))).toBe(0);
    expect(compareVersions(v("0.10.0"), v("0.11.0"))).toBeLessThan(0);
    expect(compareVersions(v("0.11.0"), v("0.10.0"))).toBeGreaterThan(0);
    expect(compareVersions(v("0.10.5"), v("0.10.1"))).toBeGreaterThan(0);
    expect(compareVersions(v("1.0.0"), v("0.99.99"))).toBeGreaterThan(0);
  });

  it("isAtLeast accepts equal and newer; rejects older", () => {
    expect(isAtLeast(v("0.10.0"), v("0.10.0"))).toBe(true);
    expect(isAtLeast(v("0.24.0"), v("0.10.0"))).toBe(true);
    expect(isAtLeast(v("0.9.99"), v("0.10.0"))).toBe(false);
    expect(isAtLeast(v("0.6.6"), v("0.10.0"))).toBe(false);
  });
});

describe("MIN_OLLAMA_VERSION", () => {
  it("is a well-formed semver string", () => {
    expect(parseVersion(MIN_OLLAMA_VERSION)).not.toBeNull();
  });
});

describe("checkOllamaVersion", () => {
  it("returns ok when the daemon reports a version at or above MIN_OLLAMA_VERSION", async () => {
    const fetcher = vi.fn<VersionFetch>(() => jsonResponse({ version: "0.24.0" }));
    const result = await checkOllamaVersion("http://localhost:11434", fetcher);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("unreachable");
    expect(result.version).toBe("0.24.0");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://localhost:11434/api/version");
  });

  it("strips a trailing slash from the base URL", async () => {
    const fetcher = vi.fn<VersionFetch>(() => jsonResponse({ version: "0.24.0" }));
    await checkOllamaVersion("http://localhost:11434/", fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://localhost:11434/api/version");
  });

  it("returns below-min when the daemon reports an older version", async () => {
    const fetcher = vi.fn<VersionFetch>(() => jsonResponse({ version: "0.6.6" }));
    const result = await checkOllamaVersion("http://localhost:11434", fetcher);
    expect(result.kind).toBe("below-min");
    if (result.kind !== "below-min") throw new Error("unreachable");
    expect(result.version).toBe("0.6.6");
    expect(result.minimum).toBe(MIN_OLLAMA_VERSION);
    expect(result.message).toMatch(/0\.6\.6/u);
    expect(result.message).toMatch(/embeddinggemma/u);
    expect(result.message).toMatch(/Upgrade Ollama/u);
  });

  it("returns unknown when the response has no version field", async () => {
    const fetcher = vi.fn<VersionFetch>(() => jsonResponse({}));
    const result = await checkOllamaVersion("http://localhost:11434", fetcher);
    expect(result.kind).toBe("unknown");
  });

  it("returns unknown when the version field is unparseable", async () => {
    const fetcher = vi.fn<VersionFetch>(() => jsonResponse({ version: "abc.def" }));
    const result = await checkOllamaVersion("http://localhost:11434", fetcher);
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("unreachable");
    expect(result.raw).toBe("abc.def");
  });

  it("returns unreachable when the fetch throws", async () => {
    const fetcher = vi.fn<VersionFetch>(() => {
      throw new Error("ECONNREFUSED");
    });
    const result = await checkOllamaVersion("http://localhost:11434", fetcher);
    expect(result.kind).toBe("unreachable");
    if (result.kind !== "unreachable") throw new Error("unreachable");
    expect(result.message).toContain("ECONNREFUSED");
  });

  it("returns unreachable on a non-2xx response", async () => {
    const fetcher = vi.fn<VersionFetch>(() => jsonResponse({}, 500));
    const result = await checkOllamaVersion("http://localhost:11434", fetcher);
    expect(result.kind).toBe("unreachable");
    if (result.kind !== "unreachable") throw new Error("unreachable");
    expect(result.message).toMatch(/500/u);
  });
});
