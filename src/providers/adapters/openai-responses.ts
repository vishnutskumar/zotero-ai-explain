import {
  eventFromDelta,
  messageEndEvent,
  parseSseDataPayloads,
  readString
} from "../stream-events.js";
import type { ModelProvider } from "../provider-types.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function createOpenAIResponsesProvider(deps: { readonly fetch: FetchLike }): ModelProvider {
  const id = "openai-responses";
  return {
    id,
    displayName: "OpenAI",
    async *streamChat(request, signal) {
      const response = await deps.fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal
      });
      yield { type: "message_start", providerId: id, model: request.profile.model };

      for (const payload of parseSseDataPayloads(await response.text())) {
        const delta = readString(payload, ["delta"]);
        if (delta !== null) {
          yield eventFromDelta(delta);
        }
      }

      yield messageEndEvent();
    }
  };
}
