import type { ProviderProfile } from "../providers/provider-types.js";

export type OllamaSettings = {
  readonly baseUrl: string;
  readonly chatModel: string;
  readonly embeddingModel: string;
  readonly localOnly: boolean;
};

export function createDefaultOllamaSettings(): OllamaSettings {
  return {
    baseUrl: "http://localhost:11434",
    chatModel: "llama3.1",
    embeddingModel: "nomic-embed-text",
    localOnly: true
  };
}

export function ollamaSettingsToProfile(settings: OllamaSettings): ProviderProfile {
  return {
    id: "ollama",
    displayName: "Ollama",
    kind: "ollama",
    baseUrl: settings.baseUrl,
    model: settings.chatModel,
    secret: { kind: "none" },
    sendMode: "local",
    enabled: true
  };
}
