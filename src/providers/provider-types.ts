import type { SecretReference } from "../secrets/secret-types.js";
import type { SelectionContext } from "../selection/selection-context.js";

export type ProviderKind =
  | "ollama"
  | "openai-responses"
  | "openai-compatible"
  | "anthropic"
  | "gemini"
  | "custom-http"
  | "local-agent-bridge";

export type EmbeddingRequest = {
  readonly baseUrl: string;
  readonly model: string;
  readonly texts: readonly string[];
  readonly signal: AbortSignal;
};

export type EmbeddingProvider = {
  embedTexts(request: EmbeddingRequest): Promise<readonly (readonly number[])[]>;
};

export type ProviderProfile = {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string | null;
  readonly model: string;
  readonly secret: SecretReference;
  readonly sendMode: "local" | "remote";
  readonly enabled: boolean;
};

export type ChatMessage = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
};

export type ChatRequest = {
  readonly selection: SelectionContext;
  readonly messages: readonly ChatMessage[];
  readonly profile: ProviderProfile;
};

export type ChatEvent =
  | { readonly type: "message_start"; readonly providerId: string; readonly model: string }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "message_end" }
  | {
      readonly type: "usage";
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
    }
  | { readonly type: "error"; readonly message: string; readonly retryable: boolean };

export type ModelProvider = {
  readonly id: string;
  readonly displayName: string;
  streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
};
