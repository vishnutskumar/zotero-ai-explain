/**
 * Provider presets — single-click configurations that pre-populate every
 * field in the settings dialog.
 *
 * Each preset maps to a `ProviderProfileSettings` snapshot the renderer
 * applies onto the form when the user selects it. The "custom" sentinel
 * leaves the form as-is so advanced users can hand-tune any field
 * without the preset clobbering their edits.
 *
 * Selecting a preset is the 1-click path; advanced users override
 * individual fields. After ANY manual edit the preset selector should
 * shift back to "custom" so the dropdown never silently misrepresents
 * the live form values.
 */

import type { OllamaSettings } from "./ollama-profile.js";
import type {
  ChatProviderKind,
  EmbedProviderKind,
  ProviderProfileSettings
} from "./provider-profile.js";

export type PresetId =
  | "local-ollama"
  | "codex-proxy"
  | "claude-proxy"
  | "openai-direct"
  | "anthropic-direct"
  | "custom";

export type PresetDescriptor = {
  readonly id: PresetId;
  readonly label: string;
  readonly hint: string;
};

export const PRESET_DESCRIPTORS: readonly PresetDescriptor[] = [
  {
    id: "local-ollama",
    label: "Local Ollama (free, private)",
    hint: "Chat + embeddings on your machine via Ollama."
  },
  {
    id: "codex-proxy",
    label: "Codex via Proxy (uses ChatGPT login)",
    hint: "Chat through the bundled proxy + Codex CLI; embeddings on Ollama."
  },
  {
    id: "claude-proxy",
    label: "Claude via Proxy (uses Claude subscription)",
    hint: "Chat through the bundled proxy + Claude CLI; embeddings on Ollama."
  },
  {
    id: "openai-direct",
    label: "OpenAI Direct (needs API key)",
    hint: "Direct OpenAI API for chat + embeddings. Requires an OpenAI API key."
  },
  {
    id: "anthropic-direct",
    label: "Anthropic Direct (needs API key)",
    hint: "Direct Anthropic API for chat; embeddings on Ollama (Anthropic has no embed API)."
  },
  {
    id: "custom",
    label: "Custom",
    hint: "Keep whatever is currently configured."
  }
];

/**
 * Default URLs each preset uses. Centralized so the renderer and
 * applyPreset() share a single source of truth.
 */
export const PRESET_URLS = {
  ollama: "http://localhost:11434",
  proxyCodex: "http://localhost:11400/codex",
  proxyClaude: "http://localhost:11400/claude",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1"
} as const;

/**
 * Default model identifiers each preset suggests. Surfaced through the
 * preset table so a brand-new install lands on a model that exists for
 * the chosen backend (codex defaults to `gpt-5-codex`, claude defaults
 * to a current Sonnet identifier — both the proxy backends recognize
 * those names today).
 */
export const PRESET_MODELS = {
  ollamaChat: "gemma4:e4b",
  ollamaEmbed: "embeddinggemma",
  codex: "gpt-5-codex",
  claude: "claude-sonnet-4-5",
  openaiChat: "gpt-4o-mini",
  openaiEmbed: "text-embedding-3-small",
  anthropicChat: "claude-sonnet-4-5"
} as const;

type PresetTemplate = {
  readonly chatProvider: ChatProviderKind;
  readonly embedProvider: EmbedProviderKind;
  readonly chatBaseUrl: string;
  readonly embedBaseUrl: string;
  readonly chatModel: string;
  readonly embeddingModel: string;
};

const PRESET_TEMPLATES: Readonly<Record<Exclude<PresetId, "custom">, PresetTemplate>> = {
  "local-ollama": {
    chatProvider: "ollama",
    embedProvider: "ollama",
    chatBaseUrl: PRESET_URLS.ollama,
    embedBaseUrl: PRESET_URLS.ollama,
    chatModel: PRESET_MODELS.ollamaChat,
    embeddingModel: PRESET_MODELS.ollamaEmbed
  },
  "codex-proxy": {
    chatProvider: "codex-cli",
    embedProvider: "ollama",
    chatBaseUrl: PRESET_URLS.proxyCodex,
    embedBaseUrl: PRESET_URLS.ollama,
    chatModel: PRESET_MODELS.codex,
    embeddingModel: PRESET_MODELS.ollamaEmbed
  },
  "claude-proxy": {
    chatProvider: "claude-cli",
    embedProvider: "ollama",
    chatBaseUrl: PRESET_URLS.proxyClaude,
    embedBaseUrl: PRESET_URLS.ollama,
    chatModel: PRESET_MODELS.claude,
    embeddingModel: PRESET_MODELS.ollamaEmbed
  },
  "openai-direct": {
    chatProvider: "codex-api",
    embedProvider: "openai",
    chatBaseUrl: PRESET_URLS.openai,
    embedBaseUrl: PRESET_URLS.openai,
    chatModel: PRESET_MODELS.openaiChat,
    embeddingModel: PRESET_MODELS.openaiEmbed
  },
  "anthropic-direct": {
    chatProvider: "claude-api",
    embedProvider: "ollama",
    chatBaseUrl: PRESET_URLS.anthropic,
    embedBaseUrl: PRESET_URLS.ollama,
    chatModel: PRESET_MODELS.anthropicChat,
    embeddingModel: PRESET_MODELS.ollamaEmbed
  }
};

/**
 * Apply a preset onto an existing profile snapshot, returning a new
 * snapshot with the preset's URLs / models / providers and the existing
 * API keys preserved. The "custom" preset returns the input unchanged
 * so the dropdown selection is purely cosmetic in that branch.
 */
export function applyPreset(
  presetId: PresetId,
  current: ProviderProfileSettings
): ProviderProfileSettings {
  if (presetId === "custom") {
    return current;
  }
  const template = PRESET_TEMPLATES[presetId];
  const nextOllama: OllamaSettings = {
    ...current.ollama,
    baseUrl: template.chatBaseUrl,
    chatBaseUrl: template.chatBaseUrl,
    embedBaseUrl: template.embedBaseUrl,
    chatModel: template.chatModel,
    embeddingModel: template.embeddingModel
  };
  return {
    ollama: nextOllama,
    chatProvider: template.chatProvider,
    embedProvider: template.embedProvider,
    openaiApiKey: current.openaiApiKey,
    anthropicApiKey: current.anthropicApiKey,
    geminiApiKey: current.geminiApiKey
  };
}

/**
 * Reverse-lookup: given a snapshot, which preset does it match exactly?
 * Returns "custom" when no template matches. Used by the renderer to
 * decide which preset to select when first painting the dropdown so the
 * UI reflects the on-disk configuration accurately.
 *
 * Matching is exact on chatProvider/embedProvider/chatBaseUrl/
 * embedBaseUrl/chatModel/embeddingModel. API keys are ignored — they
 * vary by user and don't change which preset applies.
 */
export function detectPreset(snapshot: ProviderProfileSettings): PresetId {
  for (const id of Object.keys(PRESET_TEMPLATES) as (keyof typeof PRESET_TEMPLATES)[]) {
    const t = PRESET_TEMPLATES[id];
    if (
      snapshot.chatProvider === t.chatProvider &&
      snapshot.embedProvider === t.embedProvider &&
      snapshot.ollama.chatBaseUrl === t.chatBaseUrl &&
      snapshot.ollama.embedBaseUrl === t.embedBaseUrl &&
      snapshot.ollama.chatModel === t.chatModel &&
      snapshot.ollama.embeddingModel === t.embeddingModel
    ) {
      return id;
    }
  }
  return "custom";
}
