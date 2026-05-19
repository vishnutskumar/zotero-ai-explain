import type { ProviderProfile } from "../providers/provider-types.js";

export type OllamaSettings = {
  /**
   * Legacy single base URL. Retained so older callers and the e2e
   * driver continue to work. When loading from prefs the modern
   * `chatBaseUrl` / `embedBaseUrl` fields take precedence; this field
   * is only consulted as a fallback when neither modern pref is set
   * (covers the upgrade-from-prior-version case where a user only had
   * `ollama-base-url` written).
   */
  readonly baseUrl: string;
  /** URL used for chat completions (forwarded into the ProviderProfile). */
  readonly chatBaseUrl: string;
  /** URL used for embeddings (consumed by the indexing controller). */
  readonly embedBaseUrl: string;
  readonly chatModel: string;
  readonly embeddingModel: string;
  readonly localOnly: boolean;
};

/**
 * Minimal pref reader contract. Mirrors the Zotero.Prefs.get interface
 * (returns `string | undefined`) but is typed narrowly so this module
 * stays free of platform imports and remains unit-testable with a stub.
 */
export type StringPrefReader = {
  get(name: string): string | undefined;
};

/**
 * Minimal pref writer contract. Mirrors the Zotero.Prefs.set interface
 * (write a string into the named pref) but is typed narrowly so this
 * module stays free of platform imports and remains unit-testable with
 * a stub. `clear(name)` deletes the pref entry (used when the user
 * blanks an override and we want the next read to fall back to defaults).
 */
export type StringPrefWriter = {
  set(name: string, value: string): void;
  clear?(name: string): void;
};

/** Pref-name constants. Exported so tests and adapters share the same source of truth. */
export const OLLAMA_BASE_URL_PREF = "extensions.zotero-ai-explain.ollama-base-url";
export const CHAT_BASE_URL_PREF = "extensions.zotero-ai-explain.chat-base-url";
export const EMBED_BASE_URL_PREF = "extensions.zotero-ai-explain.embed-base-url";
export const CHAT_MODEL_PREF = "extensions.zotero-ai-explain.chat-model";
export const EMBEDDING_MODEL_PREF = "extensions.zotero-ai-explain.embedding-model";

const DEFAULT_BASE_URL = "http://localhost:11434";

export function createDefaultOllamaSettings(): OllamaSettings {
  return {
    baseUrl: DEFAULT_BASE_URL,
    chatBaseUrl: DEFAULT_BASE_URL,
    embedBaseUrl: DEFAULT_BASE_URL,
    chatModel: "gemma4:e4b",
    embeddingModel: "embeddinggemma",
    localOnly: true
  };
}

export function ollamaSettingsToProfile(settings: OllamaSettings): ProviderProfile {
  return {
    id: "ollama",
    displayName: "Ollama",
    kind: "ollama",
    // The ProviderProfile feeds chat traffic; use the chat URL so the
    // user can route chat through the local llm-proxy / codex while
    // keeping embeddings on a real Ollama daemon.
    baseUrl: settings.chatBaseUrl,
    model: settings.chatModel,
    secret: { kind: "none" },
    sendMode: "local",
    enabled: true
  };
}

/**
 * Read Ollama settings overrides from the preferences store. Falls back to
 * `createDefaultOllamaSettings()` for any pref that is absent or empty.
 *
 * Prefs honored:
 *   extensions.zotero-ai-explain.chat-base-url
 *   extensions.zotero-ai-explain.embed-base-url
 *   extensions.zotero-ai-explain.ollama-base-url   (legacy fallback)
 *   extensions.zotero-ai-explain.chat-model
 *   extensions.zotero-ai-explain.embedding-model
 *
 * Upgrade behavior: when the modern `chat-base-url` / `embed-base-url`
 * prefs are missing but the legacy `ollama-base-url` is present, we
 * use the legacy value as the seed for BOTH the chat and embed URL so
 * a prior single-URL install transparently keeps working.
 */
export function loadOllamaSettingsFromPrefs(prefs: StringPrefReader): OllamaSettings {
  const defaults = createDefaultOllamaSettings();
  const legacyBaseUrl = readNonEmpty(prefs, OLLAMA_BASE_URL_PREF);
  const chatBaseUrl = readNonEmpty(prefs, CHAT_BASE_URL_PREF);
  const embedBaseUrl = readNonEmpty(prefs, EMBED_BASE_URL_PREF);
  const chatModel = readNonEmpty(prefs, CHAT_MODEL_PREF);
  const embeddingModel = readNonEmpty(prefs, EMBEDDING_MODEL_PREF);
  const resolvedBaseUrl = legacyBaseUrl ?? defaults.baseUrl;
  return {
    baseUrl: resolvedBaseUrl,
    chatBaseUrl: chatBaseUrl ?? legacyBaseUrl ?? defaults.chatBaseUrl,
    embedBaseUrl: embedBaseUrl ?? legacyBaseUrl ?? defaults.embedBaseUrl,
    chatModel: chatModel ?? defaults.chatModel,
    embeddingModel: embeddingModel ?? defaults.embeddingModel,
    localOnly: defaults.localOnly
  };
}

/**
 * Persist the supplied Ollama settings into the pref store. Each field
 * is trimmed and written as a string.
 *
 * Five prefs are written on every save:
 *   - chat-base-url  (modern)
 *   - embed-base-url (modern)
 *   - ollama-base-url (legacy; mirrored from chatBaseUrl so any legacy
 *     consumer reading the old key still sees a sensible URL)
 *   - chat-model
 *   - embedding-model
 *
 * Writing all five every time means a partially-corrupted pref store
 * recovers in a single round trip.
 */
export function saveOllamaSettingsToPrefs(
  writer: StringPrefWriter,
  settings: OllamaSettings
): void {
  const chat = settings.chatBaseUrl.trim();
  const embed = settings.embedBaseUrl.trim();
  // Legacy mirror: use whatever the user typed as chatBaseUrl. If they
  // had separate URLs the chat value wins for the legacy key because
  // any caller still reading `baseUrl` is overwhelmingly the chat
  // surface (the indexing controller reads `embedBaseUrl` directly).
  const legacy = settings.baseUrl.trim().length > 0 ? settings.baseUrl.trim() : chat;
  writer.set(OLLAMA_BASE_URL_PREF, legacy);
  writer.set(CHAT_BASE_URL_PREF, chat);
  writer.set(EMBED_BASE_URL_PREF, embed);
  writer.set(CHAT_MODEL_PREF, settings.chatModel.trim());
  writer.set(EMBEDDING_MODEL_PREF, settings.embeddingModel.trim());
}

function readNonEmpty(prefs: StringPrefReader, name: string): string | null {
  let value: string | undefined;
  try {
    value = prefs.get(name);
  } catch {
    return null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
