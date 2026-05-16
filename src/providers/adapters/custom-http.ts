import { eventFromDelta, messageEndEvent, parseJsonPayload, readString } from "../stream-events.js";
import type { ModelProvider } from "../provider-types.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function createCustomHttpProvider(deps: { readonly fetch: FetchLike }): ModelProvider {
  const id = "custom-http";
  return {
    id,
    displayName: "Custom HTTP",
    async *streamChat(request, signal) {
      const response = await deps.fetch(request.profile.baseUrl ?? "", { method: "POST", signal });
      yield { type: "message_start", providerId: id, model: request.profile.model };

      const text = readString(parseJsonPayload(await response.text()), ["text"]);
      if (text !== null) {
        yield eventFromDelta(text);
      }

      yield messageEndEvent();
    }
  };
}
