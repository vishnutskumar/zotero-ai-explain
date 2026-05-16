import {
  eventFromDelta,
  messageEndEvent,
  parseSseDataPayloads,
  readString
} from "../stream-events.js";
import type { ModelProvider } from "../provider-types.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function createAnthropicProvider(deps: { readonly fetch: FetchLike }): ModelProvider {
  const id = "anthropic";
  return {
    id,
    displayName: "Anthropic",
    async *streamChat(request, signal) {
      const response = await deps.fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal
      });
      yield { type: "message_start", providerId: id, model: request.profile.model };

      for (const payload of parseSseDataPayloads(await response.text())) {
        const text = readString(payload, ["delta", "text"]);
        if (text !== null) {
          yield eventFromDelta(text);
        }
      }

      yield messageEndEvent();
    }
  };
}
