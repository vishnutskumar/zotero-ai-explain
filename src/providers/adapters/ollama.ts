import {
  eventFromDelta,
  isRecord,
  messageEndEvent,
  parseJsonPayload,
  readString
} from "../stream-events.js";
import type { EmbeddingProvider, ModelProvider } from "../provider-types.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function baseUrl(profileBaseUrl: string | null): string {
  return (profileBaseUrl ?? "http://localhost:11434").replace(/\/+$/u, "");
}

function connectionError(url: string) {
  return {
    type: "error" as const,
    message: `Could not reach Ollama at ${url}.`,
    retryable: true
  };
}

function readEmbeddings(payload: unknown): readonly (readonly number[])[] {
  if (isRecord(payload) && Array.isArray(payload.embeddings)) {
    return payload.embeddings as readonly (readonly number[])[];
  }
  throw new Error("Ollama embedding response did not include embeddings.");
}

export function createOllamaProvider(deps: {
  readonly fetch: FetchLike;
}): ModelProvider & EmbeddingProvider {
  const id = "ollama";

  return {
    id,
    displayName: "Ollama",
    async *streamChat(request, signal) {
      const url = baseUrl(request.profile.baseUrl);
      yield { type: "message_start", providerId: id, model: request.profile.model };

      try {
        const response = await deps.fetch(`${url}/api/chat`, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: request.profile.model,
            stream: true,
            messages: request.messages
          })
        });

        for (const line of (await response.text())
          .split("\n")
          .filter((entry) => entry.trim().length > 0)) {
          const payload = parseJsonPayload(line);
          const text = readString(payload, ["message", "content"]);
          if (text !== null) {
            yield eventFromDelta(text);
          }
        }

        yield messageEndEvent();
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        yield connectionError(url);
      }
    },
    async embedTexts(request) {
      const url = baseUrl(request.baseUrl);
      const response = await deps.fetch(`${url}/api/embed`, {
        method: "POST",
        signal: request.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: request.model, input: request.texts })
      });
      return readEmbeddings(parseJsonPayload(await response.text()));
    }
  };
}
