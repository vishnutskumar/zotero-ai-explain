/**
 * Tests for `computeIndexPath`, `computeIndexFileName`, `slugifyModel`,
 * and `parseIndexPath`.
 *
 * Coverage:
 *   T1  Ollama / embeddinggemma -> short slug.
 *   T2  OpenAI text-embedding-3-large -> `3-large`.
 *   T3  OpenAI text-embedding-3-small -> `3-small`.
 *   T4  Gemini text-embedding-004 (with `models/` prefix variants) -> `004`.
 *   T5  joins data dir without double slash when dir ends with `/`.
 *   T6  slugifies tag-suffixed Ollama model names (strip `:tag`).
 *   T7  parseIndexPath round-trips computeIndexFileName for ollama+embeddinggemma.
 *   T8  parseIndexPath returns null on a non-matching filename.
 *   T9  parseIndexPath accepts a full absolute path or a bare filename.
 *  T10  empty model defaults to a stable slug instead of failing.
 *  T11  legacy filename helper returns the historical single-file path.
 */

import { describe, expect, it } from "vitest";

import {
  computeIndexFileName,
  computeIndexPath,
  legacyIndexPath,
  LEGACY_INDEX_FILE_NAME,
  parseIndexPath,
  slugifyModel
} from "../../src/indexing/index-path.js";

describe("slugifyModel", () => {
  it("T1: short-slugs embeddinggemma", () => {
    expect(slugifyModel("embeddinggemma")).toBe("embeddinggemma");
  });

  it("T2: short-slugs text-embedding-3-large to 3-large", () => {
    expect(slugifyModel("text-embedding-3-large")).toBe("3-large");
  });

  it("T3: short-slugs text-embedding-3-small to 3-small", () => {
    expect(slugifyModel("text-embedding-3-small")).toBe("3-small");
  });

  it("T4: short-slugs Gemini's text-embedding-004 with or without `models/` prefix", () => {
    expect(slugifyModel("text-embedding-004")).toBe("004");
    expect(slugifyModel("models/text-embedding-004")).toBe("004");
  });

  it("T6: drops Ollama `:tag` suffix", () => {
    expect(slugifyModel("embeddinggemma:latest")).toBe("embeddinggemma");
    expect(slugifyModel("phi3:mini")).toBe("phi3");
  });

  it("T10: empty input falls back to a stable slug", () => {
    expect(slugifyModel("")).toBe("default");
    expect(slugifyModel("   ")).toBe("default");
  });
});

describe("computeIndexFileName", () => {
  it("ollama+embeddinggemma -> zotero-ai-explain-index-ollama-embeddinggemma.json", () => {
    expect(computeIndexFileName({ provider: "ollama", model: "embeddinggemma" })).toBe(
      "zotero-ai-explain-index-ollama-embeddinggemma.json"
    );
  });

  it("openai+text-embedding-3-large -> ...-openai-3-large.json", () => {
    expect(computeIndexFileName({ provider: "openai", model: "text-embedding-3-large" })).toBe(
      "zotero-ai-explain-index-openai-3-large.json"
    );
  });

  it("openai+text-embedding-3-small -> ...-openai-3-small.json", () => {
    expect(computeIndexFileName({ provider: "openai", model: "text-embedding-3-small" })).toBe(
      "zotero-ai-explain-index-openai-3-small.json"
    );
  });

  it("gemini+text-embedding-004 -> ...-gemini-004.json", () => {
    expect(computeIndexFileName({ provider: "gemini", model: "text-embedding-004" })).toBe(
      "zotero-ai-explain-index-gemini-004.json"
    );
  });
});

describe("computeIndexPath", () => {
  it("joins dataDir + filename", () => {
    expect(
      computeIndexPath("/var/test-fixture/zotero-data", {
        provider: "ollama",
        model: "embeddinggemma"
      })
    ).toBe("/var/test-fixture/zotero-data/zotero-ai-explain-index-ollama-embeddinggemma.json");
  });

  it("T5: does not double the separator when dataDir ends with `/`", () => {
    const path = computeIndexPath("/var/test-fixture/zotero-data/", {
      provider: "ollama",
      model: "embeddinggemma"
    });
    expect(path).not.toContain("//zotero-ai-explain-index");
    expect(path.endsWith(".json")).toBe(true);
  });
});

describe("parseIndexPath", () => {
  it("T7: round-trips an ollama+embeddinggemma filename", () => {
    const name = computeIndexFileName({ provider: "ollama", model: "embeddinggemma" });
    expect(parseIndexPath(name)).toEqual({ provider: "ollama", modelSlug: "embeddinggemma" });
  });

  it("T7b: round-trips an openai+3-small filename", () => {
    const name = computeIndexFileName({ provider: "openai", model: "text-embedding-3-small" });
    expect(parseIndexPath(name)).toEqual({ provider: "openai", modelSlug: "3-small" });
  });

  it("T8: returns null on a non-matching filename", () => {
    expect(parseIndexPath("random-file.json")).toBeNull();
    expect(parseIndexPath("zotero-ai-explain-index.json")).toBeNull();
    expect(parseIndexPath("zotero-ai-explain-index-unknown-foo.json")).toBeNull();
  });

  it("T9: strips a directory prefix from the input", () => {
    expect(parseIndexPath("/some/dir/zotero-ai-explain-index-gemini-004.json")).toEqual({
      provider: "gemini",
      modelSlug: "004"
    });
  });
});

describe("legacy helpers", () => {
  it("T11: legacy filename constant matches the historical name", () => {
    expect(LEGACY_INDEX_FILE_NAME).toBe("zotero-ai-explain-index.json");
    expect(legacyIndexPath("/var/test-fixture/zotero-data")).toBe(
      "/var/test-fixture/zotero-data/zotero-ai-explain-index.json"
    );
  });
});
