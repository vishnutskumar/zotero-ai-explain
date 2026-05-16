import {
  eventFromDelta,
  isRecord,
  messageEndEvent,
  parseJsonPayload,
  readString
} from "../stream-events.js";
import type { ModelProvider } from "../provider-types.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function createGeminiProvider(deps: { readonly fetch: FetchLike }): ModelProvider {
  const id = "gemini";
  return {
    id,
    displayName: "Gemini",
    async *streamChat(request, signal) {
      const response = await deps.fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${request.profile.model}:streamGenerateContent`,
        { method: "POST", signal }
      );
      yield { type: "message_start", providerId: id, model: request.profile.model };

      const payload = parseJsonPayload(await response.text());
      const chunks = Array.isArray(payload) ? payload : [payload];
      for (const chunk of chunks) {
        if (isRecord(chunk)) {
          const text = readString(chunk, ["candidates", "0", "content", "parts", "0", "text"]);
          if (text !== null) {
            yield eventFromDelta(text);
          }
        }
      }

      yield messageEndEvent();
    }
  };
}
