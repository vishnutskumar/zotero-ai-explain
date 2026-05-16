import {
  eventFromDelta,
  messageEndEvent,
  parseSseDataPayloads,
  readString
} from "../stream-events.js";
import type { ModelProvider } from "../provider-types.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function createOpenAICompatibleProvider(deps: { readonly fetch: FetchLike }): ModelProvider {
  const id = "openai-compatible";
  return {
    id,
    displayName: "OpenAI Compatible",
    async *streamChat(request, signal) {
      const response = await deps.fetch(`${request.profile.baseUrl ?? ""}/v1/chat/completions`, {
        method: "POST",
        signal
      });
      yield { type: "message_start", providerId: id, model: request.profile.model };

      for (const payload of parseSseDataPayloads(await response.text())) {
        const text = readString(payload, ["choices", "0", "delta", "content"]);
        if (text !== null) {
          yield eventFromDelta(text);
        }
      }

      yield messageEndEvent();
    }
  };
}
