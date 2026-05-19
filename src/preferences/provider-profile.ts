/**
 * Provider profile preferences (Phase 4 direct-API).
 *
 * Extends `ollama-profile.ts` with explicit chat and embedding backend
 * selectors plus per-provider API keys. The legacy URL-based fields are
 * preserved verbatim so existing installs (chat URL, embed URL,
 * chat/embed model) keep working — when `chatProvider` is unset we
 * default to `"ollama"`, mirroring the prior behavior.
 *
 * Storage:
 *   API keys live in plain text under the Zotero pref tree
 *   (`extensions.zotero-ai-explain.*-api-key`). Zotero's prefs.js lives
 *   inside the OS-secured user profile; we surface a warning in the
 *   settings UI so the user knows.
 */

import type { OllamaSettings, StringPrefReader, StringPrefWriter } from "./ollama-profile.js";
import {
  createDefaultOllamaSettings,
  loadOllamaSettingsFromPrefs,
  saveOllamaSettingsToPrefs
} from "./ollama-profile.js";

export type ChatProviderKind = "ollama" | "codex-cli" | "claude-cli" | "codex-api" | "claude-api";

export type EmbedProviderKind = "ollama" | "openai" | "gemini";

export type ProviderProfileSettings = {
  /** Legacy URL + model settings the Ollama path consumes. */
  readonly ollama: OllamaSettings;
  /** Which backend handles chat completions. */
  readonly chatProvider: ChatProviderKind;
  /** Which backend handles embeddings. */
  readonly embedProvider: EmbedProviderKind;
  /** Per-provider API keys. Stored verbatim; empty string == "absent". */
  readonly openaiApiKey: string;
  readonly anthropicApiKey: string;
  readonly geminiApiKey: string;
};

export const CHAT_PROVIDER_PREF = "extensions.zotero-ai-explain.chat-provider";
export const EMBED_PROVIDER_PREF = "extensions.zotero-ai-explain.embed-provider";
export const OPENAI_API_KEY_PREF = "extensions.zotero-ai-explain.openai-api-key";
export const ANTHROPIC_API_KEY_PREF = "extensions.zotero-ai-explain.anthropic-api-key";
export const GEMINI_API_KEY_PREF = "extensions.zotero-ai-explain.gemini-api-key";

const CHAT_PROVIDER_KINDS: readonly ChatProviderKind[] = [
  "ollama",
  "codex-cli",
  "claude-cli",
  "codex-api",
  "claude-api"
];
const EMBED_PROVIDER_KINDS: readonly EmbedProviderKind[] = ["ollama", "openai", "gemini"];

function parseChatProvider(value: string | null): ChatProviderKind {
  if (value === null) return "ollama";
  return (CHAT_PROVIDER_KINDS as readonly string[]).includes(value)
    ? (value as ChatProviderKind)
    : "ollama";
}

function parseEmbedProvider(value: string | null): EmbedProviderKind {
  if (value === null) return "ollama";
  return (EMBED_PROVIDER_KINDS as readonly string[]).includes(value)
    ? (value as EmbedProviderKind)
    : "ollama";
}

function readNonEmpty(prefs: StringPrefReader, name: string): string | null {
  let value: string | undefined;
  try {
    value = prefs.get(name);
  } catch {
    return null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function createDefaultProviderProfileSettings(): ProviderProfileSettings {
  return {
    ollama: createDefaultOllamaSettings(),
    chatProvider: "ollama",
    embedProvider: "ollama",
    openaiApiKey: "",
    anthropicApiKey: "",
    geminiApiKey: ""
  };
}

export function loadProviderProfileSettingsFromPrefs(
  prefs: StringPrefReader
): ProviderProfileSettings {
  const ollama = loadOllamaSettingsFromPrefs(prefs);
  const chatProvider = parseChatProvider(readNonEmpty(prefs, CHAT_PROVIDER_PREF));
  const embedProvider = parseEmbedProvider(readNonEmpty(prefs, EMBED_PROVIDER_PREF));
  const openaiApiKey = readNonEmpty(prefs, OPENAI_API_KEY_PREF) ?? "";
  const anthropicApiKey = readNonEmpty(prefs, ANTHROPIC_API_KEY_PREF) ?? "";
  const geminiApiKey = readNonEmpty(prefs, GEMINI_API_KEY_PREF) ?? "";
  return {
    ollama,
    chatProvider,
    embedProvider,
    openaiApiKey,
    anthropicApiKey,
    geminiApiKey
  };
}

export function saveProviderProfileSettingsToPrefs(
  writer: StringPrefWriter,
  settings: ProviderProfileSettings
): void {
  // The URL + chat/embed-model fields keep flowing through the legacy
  // writer so existing readers (and the e2e driver) keep seeing the
  // values they expect.
  saveOllamaSettingsToPrefs(writer, settings.ollama);
  writer.set(CHAT_PROVIDER_PREF, settings.chatProvider);
  writer.set(EMBED_PROVIDER_PREF, settings.embedProvider);
  writer.set(OPENAI_API_KEY_PREF, settings.openaiApiKey.trim());
  writer.set(ANTHROPIC_API_KEY_PREF, settings.anthropicApiKey.trim());
  writer.set(GEMINI_API_KEY_PREF, settings.geminiApiKey.trim());
}

/**
 * Look up the API key associated with the chosen chat provider, or
 * null when the provider is local / proxy-based. The settings UI uses
 * this to decide whether to surface the "API key required" warning.
 */
export function chatApiKeyFor(settings: ProviderProfileSettings): string | null {
  switch (settings.chatProvider) {
    case "codex-api":
      return settings.openaiApiKey.length > 0 ? settings.openaiApiKey : null;
    case "claude-api":
      return settings.anthropicApiKey.length > 0 ? settings.anthropicApiKey : null;
    case "ollama":
    case "codex-cli":
    case "claude-cli":
      return null;
  }
}

export function embedApiKeyFor(settings: ProviderProfileSettings): string | null {
  switch (settings.embedProvider) {
    case "openai":
      return settings.openaiApiKey.length > 0 ? settings.openaiApiKey : null;
    case "gemini":
      return settings.geminiApiKey.length > 0 ? settings.geminiApiKey : null;
    case "ollama":
      return null;
  }
}

/**
 * Whether the chat provider requires a network probe against a
 * URL-based endpoint (Ollama / proxy). Direct API providers are
 * probed with a model-list request to their canonical host instead.
 */
export function chatProviderIsUrlBased(kind: ChatProviderKind): boolean {
  return kind === "ollama" || kind === "codex-cli" || kind === "claude-cli";
}

export function embedProviderIsUrlBased(kind: EmbedProviderKind): boolean {
  return kind === "ollama";
}

export type ProviderDisclosureFields = {
  readonly displayName: string;
  readonly model: string;
  readonly sendMode: "local" | "remote";
};

/**
 * Build the data the popup banner needs to describe where selected text
 * is going. Driven by the active `chatProvider` so the label reflects
 * the real backend, not the legacy "Ollama" hardcode.
 *
 * `sendMode` is "local" only for the in-process Ollama path. Codex/Claude
 * CLI proxies hop through localhost but ultimately ship text to OpenAI/
 * Anthropic servers, so they are "remote" for the user-facing disclosure.
 */
export function providerProfileToDisclosure(
  settings: ProviderProfileSettings
): ProviderDisclosureFields {
  const model = settings.ollama.chatModel;
  switch (settings.chatProvider) {
    case "ollama":
      return { displayName: "Ollama", model, sendMode: "local" };
    case "codex-cli":
      return { displayName: "Codex Proxy", model, sendMode: "remote" };
    case "claude-cli":
      return { displayName: "Claude Proxy", model, sendMode: "remote" };
    case "codex-api":
      return { displayName: "OpenAI", model, sendMode: "remote" };
    case "claude-api":
      return { displayName: "Anthropic", model, sendMode: "remote" };
  }
}
