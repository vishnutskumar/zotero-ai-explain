/**
 * Direct OpenAI chat completion adapter (Phase 4 direct-API).
 *
 * Talks directly to `https://api.openai.com/v1/chat/completions` with a
 * user-supplied API key — bypassing the local llm-proxy / Codex CLI
 * path entirely. Streams `text/event-stream` deltas and yields them as
 * `ChatEvent` records that match the existing `ModelProvider` contract.
 *
 * Why this lives next to (rather than reusing) `openai-compatible.ts`:
 * the latter is generic transport code that callers wire to any
 * OpenAI-compatible URL (e.g. an internal proxy). This module hard-codes
 * the public OpenAI host, injects the `Authorization` header from a
 * runtime-supplied secret, and surfaces the canonical OpenAI error
 * shape (`{error: {message, type, code}}`) as an explicit `error` event
 * instead of silently terminating the stream.
 */

import {
  eventFromDelta,
  isRecord,
  messageEndEvent,
  readSsePayloads,
  readString
} from "../stream-events.js";
import type { ChatEvent, ModelProvider } from "../provider-types.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

export type OpenAIChatDeps = {
  readonly fetch: FetchLike;
  /**
   * Resolver indirection. The user's API key changes when the settings
   * dialog is saved; reading it through a function means a saved key
   * takes effect on the next chat request without re-wiring the
   * provider registry. Returns null when no key is configured — the
   * adapter then yields a non-retryable `error` event so the popup
   * shows "API key required" instead of failing with a 401.
   */
  readonly getApiKey: () => string | null;
};

/**
 * Build the canonical OpenAI chat error message. The API returns either:
 *   {"error": {"message": "...", "type": "...", "code": "..."}}
 * or, on rate-limit/quota:
 *   HTTP 429 with the same body shape.
 * Falls back to the raw body, then to the HTTP status line.
 */
async function readErrorMessage(response: Response): Promise<string> {
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    // body already consumed — fall through.
  }
  const trimmed = raw.trim();
  if (trimmed.length > 0) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && isRecord(parsed.error)) {
        const message = parsed.error.message;
        if (typeof message === "string" && message.length > 0) {
          return message;
        }
      }
    } catch {
      // not JSON — surface the raw body
    }
    return trimmed;
  }
  const statusText = response.statusText.length > 0 ? ` ${response.statusText}` : "";
  return `HTTP ${String(response.status)}${statusText}`;
}

function isRetryableStatus(status: number): boolean {
  // 429 (rate limit) and 5xx (transient server) are worth a retry; auth
  // failures and validation errors are not.
  return status === 429 || (status >= 500 && status <= 599);
}

export function createOpenAIChatProvider(deps: OpenAIChatDeps): ModelProvider {
  const id = "openai-chat";
  return {
    id,
    displayName: "OpenAI (direct)",
    async *streamChat(request, signal) {
      yield { type: "message_start", providerId: id, model: request.profile.model };

      const apiKey = deps.getApiKey();
      if (apiKey === null || apiKey.length === 0) {
        yield {
          type: "error",
          message: "OpenAI API key is not configured. Add it in Settings.",
          retryable: false
        };
        return;
      }

      let response: Response;
      try {
        response = await deps.fetch(ENDPOINT, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: request.profile.model,
            stream: true,
            messages: request.messages
          })
        });
      } catch (err) {
        if (signal.aborted) {
          throw err;
        }
        yield {
          type: "error",
          message: `Could not reach OpenAI: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true
        };
        return;
      }

      if (!response.ok) {
        const detail = await readErrorMessage(response);
        const event: ChatEvent = {
          type: "error",
          message: `OpenAI error (${String(response.status)}): ${detail}`,
          retryable: isRetryableStatus(response.status)
        };
        yield event;
        return;
      }

      // M6 (Phase 4b codex review): stream the SSE body incrementally
      // so the popup renders deltas as they arrive instead of after the
      // whole completion is buffered. M7: a malformed SSE payload now
      // throws SyntaxError inside the reader; we surface it as an
      // in-band error event so the popup shows a visible failure.
      const body = response.body;
      if (body === null) {
        // No body (shouldn't happen for a successful chat completion but
        // some test transports return null) — fall back to message_end
        // so the iterator terminates cleanly.
        yield messageEndEvent();
        return;
      }
      const reader = body.getReader();
      try {
        for await (const payload of readSsePayloads(reader)) {
          const text = readString(payload, ["choices", "0", "delta", "content"]);
          if (text !== null) {
            yield eventFromDelta(text);
          }
        }
      } catch (err) {
        if (signal.aborted) {
          throw err;
        }
        yield {
          type: "error",
          message: `OpenAI stream parse failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false
        };
        return;
      }

      yield messageEndEvent();
    }
  };
}
