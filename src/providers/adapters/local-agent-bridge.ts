import { eventFromDelta, messageEndEvent, parseJsonPayload, readString } from "../stream-events.js";
import type { ModelProvider } from "../provider-types.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function createLocalAgentBridgeProvider(deps: { readonly fetch: FetchLike }): ModelProvider {
  const id = "local-agent-bridge";
  return {
    id,
    displayName: "Local Agent Bridge",
    async *streamChat(request, signal) {
      const response = await deps.fetch(request.profile.baseUrl ?? "http://localhost:8787", {
        method: "POST",
        signal
      });
      yield { type: "message_start", providerId: id, model: request.profile.model };

      for (const line of (await response.text())
        .split("\n")
        .filter((entry) => entry.trim().length > 0)) {
        const payload = parseJsonPayload(line);
        const text = readString(payload, ["text"]);
        if (text !== null) {
          yield eventFromDelta(text);
        }
      }

      yield messageEndEvent();
    }
  };
}
