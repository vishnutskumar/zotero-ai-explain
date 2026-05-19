import { describe, expect, it } from "vitest";

import {
  CHAT_BASE_URL_PREF,
  CHAT_MODEL_PREF,
  EMBED_BASE_URL_PREF,
  EMBEDDING_MODEL_PREF,
  OLLAMA_BASE_URL_PREF,
  createDefaultOllamaSettings,
  loadOllamaSettingsFromPrefs,
  ollamaSettingsToProfile,
  saveOllamaSettingsToPrefs,
  type StringPrefReader,
  type StringPrefWriter
} from "../../src/preferences/ollama-profile.js";

function prefsFrom(values: Record<string, string | undefined>): StringPrefReader {
  return {
    get(name) {
      return values[name];
    }
  };
}

describe("ollama profile defaults", () => {
  it("creates a local-only Ollama profile with chat + embed URLs", () => {
    const settings = createDefaultOllamaSettings();

    expect(settings).toEqual({
      baseUrl: "http://localhost:11434",
      chatBaseUrl: "http://localhost:11434",
      embedBaseUrl: "http://localhost:11434",
      chatModel: "gemma4:e4b",
      embeddingModel: "embeddinggemma",
      localOnly: true
    });

    expect(ollamaSettingsToProfile(settings)).toEqual({
      id: "ollama",
      displayName: "Ollama",
      kind: "ollama",
      baseUrl: "http://localhost:11434",
      model: "gemma4:e4b",
      secret: { kind: "none" },
      sendMode: "local",
      enabled: true
    });
  });

  it("routes chatBaseUrl through ollamaSettingsToProfile (provider profile feeds chat)", () => {
    // The provider profile drives the chat surface. If a user points
    // chatBaseUrl at the llm-proxy while keeping embedBaseUrl on the
    // real Ollama daemon, the profile must reflect the chat URL.
    const settings: ReturnType<typeof createDefaultOllamaSettings> = {
      ...createDefaultOllamaSettings(),
      chatBaseUrl: "http://127.0.0.1:11400/codex",
      embedBaseUrl: "http://localhost:11434"
    };
    const profile = ollamaSettingsToProfile(settings);
    expect(profile.baseUrl).toBe("http://127.0.0.1:11400/codex");
  });
});

describe("loadOllamaSettingsFromPrefs", () => {
  it("returns defaults when no prefs are set", () => {
    const settings = loadOllamaSettingsFromPrefs(prefsFrom({}));
    expect(settings).toEqual(createDefaultOllamaSettings());
  });

  it("seeds chat + embed URLs from the legacy ollama-base-url pref on upgrade", () => {
    // Upgrade path: a prior install only wrote the legacy single base
    // URL. Both new fields must inherit it so the user doesn't have to
    // re-enter their endpoint after the version bump.
    const settings = loadOllamaSettingsFromPrefs(
      prefsFrom({
        "extensions.zotero-ai-explain.ollama-base-url": "http://127.0.0.1:55555"
      })
    );
    expect(settings.baseUrl).toBe("http://127.0.0.1:55555");
    expect(settings.chatBaseUrl).toBe("http://127.0.0.1:55555");
    expect(settings.embedBaseUrl).toBe("http://127.0.0.1:55555");
    expect(settings.chatModel).toBe(createDefaultOllamaSettings().chatModel);
  });

  it("modern chat-base-url / embed-base-url override the legacy fallback", () => {
    const settings = loadOllamaSettingsFromPrefs(
      prefsFrom({
        "extensions.zotero-ai-explain.ollama-base-url": "http://legacy:1234",
        "extensions.zotero-ai-explain.chat-base-url": "http://chat:11400/codex",
        "extensions.zotero-ai-explain.embed-base-url": "http://embed:11434"
      })
    );
    expect(settings.chatBaseUrl).toBe("http://chat:11400/codex");
    expect(settings.embedBaseUrl).toBe("http://embed:11434");
    // baseUrl retains the legacy mirror for any caller still reading it.
    expect(settings.baseUrl).toBe("http://legacy:1234");
  });

  it("ignores empty-string prefs and falls back to defaults", () => {
    const settings = loadOllamaSettingsFromPrefs(
      prefsFrom({
        "extensions.zotero-ai-explain.ollama-base-url": "",
        "extensions.zotero-ai-explain.chat-base-url": "  ",
        "extensions.zotero-ai-explain.embed-base-url": "",
        "extensions.zotero-ai-explain.chat-model": "   "
      })
    );
    expect(settings).toEqual(createDefaultOllamaSettings());
  });

  it("overrides chat and embedding models", () => {
    const settings = loadOllamaSettingsFromPrefs(
      prefsFrom({
        "extensions.zotero-ai-explain.chat-model": "phi3",
        "extensions.zotero-ai-explain.embedding-model": "nomic-embed-text"
      })
    );
    expect(settings.chatModel).toBe("phi3");
    expect(settings.embeddingModel).toBe("nomic-embed-text");
    expect(settings.baseUrl).toBe(createDefaultOllamaSettings().baseUrl);
  });

  it("treats reader exceptions as missing prefs", () => {
    const settings = loadOllamaSettingsFromPrefs({
      get: () => {
        throw new Error("pref backend unavailable");
      }
    });
    expect(settings).toEqual(createDefaultOllamaSettings());
  });
});

describe("saveOllamaSettingsToPrefs", () => {
  type Recorded = { name: string; value: string };
  function makeWriter(): { writer: StringPrefWriter; writes: Recorded[] } {
    const writes: Recorded[] = [];
    return {
      writes,
      writer: {
        set(name, value) {
          writes.push({ name, value });
        }
      }
    };
  }

  it("writes legacy + chat + embed URLs and both models on a single call", () => {
    const { writer, writes } = makeWriter();
    saveOllamaSettingsToPrefs(writer, {
      baseUrl: "http://legacy.host:1234",
      chatBaseUrl: "http://chat.host:9999/codex",
      embedBaseUrl: "http://embed.host:11434",
      chatModel: "gemma3:1b",
      embeddingModel: "snowflake-arctic-embed",
      localOnly: true
    });
    expect(writes).toEqual([
      { name: OLLAMA_BASE_URL_PREF, value: "http://legacy.host:1234" },
      { name: CHAT_BASE_URL_PREF, value: "http://chat.host:9999/codex" },
      { name: EMBED_BASE_URL_PREF, value: "http://embed.host:11434" },
      { name: CHAT_MODEL_PREF, value: "gemma3:1b" },
      { name: EMBEDDING_MODEL_PREF, value: "snowflake-arctic-embed" }
    ]);
  });

  it("mirrors chatBaseUrl into the legacy ollama-base-url key when baseUrl is blank", () => {
    // If the caller leaves the legacy `baseUrl` field empty (e.g., a
    // fresh form that no longer surfaces it), the writer falls back to
    // chatBaseUrl so any legacy consumer keeps seeing a valid URL.
    const { writer, writes } = makeWriter();
    saveOllamaSettingsToPrefs(writer, {
      baseUrl: "",
      chatBaseUrl: "http://only-chat:11400/codex",
      embedBaseUrl: "http://only-embed:11434",
      chatModel: "phi3",
      embeddingModel: "embed",
      localOnly: true
    });
    const legacy = writes.find((w) => w.name === OLLAMA_BASE_URL_PREF);
    expect(legacy?.value).toBe("http://only-chat:11400/codex");
  });

  it("trims whitespace before writing", () => {
    const { writer, writes } = makeWriter();
    saveOllamaSettingsToPrefs(writer, {
      baseUrl: "  http://leg:1  ",
      chatBaseUrl: "  http://chat:2  ",
      embedBaseUrl: "  http://embed:3  ",
      chatModel: "\tgemma3:1b\n",
      embeddingModel: "  embed  ",
      localOnly: true
    });
    expect(writes.map((w) => w.value)).toEqual([
      "http://leg:1",
      "http://chat:2",
      "http://embed:3",
      "gemma3:1b",
      "embed"
    ]);
  });

  it("written values round-trip through loadOllamaSettingsFromPrefs", () => {
    // Adversarial assertion: regression guard against the bug where
    // saved values weren't loaded back on reopen. Any change that
    // re-introduces a persistence gap (writer dropping a pref, reader
    // looking at the wrong key) makes this fail.
    const store = new Map<string, string>();
    const writer: StringPrefWriter = {
      set(name, value) {
        store.set(name, value);
      }
    };
    const reader: StringPrefReader = {
      get(name) {
        return store.get(name);
      }
    };
    saveOllamaSettingsToPrefs(writer, {
      baseUrl: "http://round.trip:99",
      chatBaseUrl: "http://chat:11400/codex",
      embedBaseUrl: "http://embed:11434",
      chatModel: "phi3:mini",
      embeddingModel: "all-minilm",
      localOnly: true
    });
    const loaded = loadOllamaSettingsFromPrefs(reader);
    expect(loaded).toEqual({
      baseUrl: "http://round.trip:99",
      chatBaseUrl: "http://chat:11400/codex",
      embedBaseUrl: "http://embed:11434",
      chatModel: "phi3:mini",
      embeddingModel: "all-minilm",
      localOnly: true
    });
  });

  it("propagates writer exceptions to the caller", () => {
    const writer: StringPrefWriter = {
      set() {
        throw new Error("pref backend write failed");
      }
    };
    expect(() => {
      saveOllamaSettingsToPrefs(writer, createDefaultOllamaSettings());
    }).toThrow(/pref backend write failed/u);
  });
});
