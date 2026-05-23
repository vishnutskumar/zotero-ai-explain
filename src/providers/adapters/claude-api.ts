/**
 * Direct Anthropic Messages API adapter (Phase 4 direct-API).
 *
 * Hits `https://api.anthropic.com/v1/messages` with `x-api-key` +
 * `anthropic-version: 2023-06-01`. Anthropic streams via Server-Sent
 * Events but the event payload shape differs from OpenAI's SSE:
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,
 *          "delta":{"type":"text_delta","text":"hello"}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 *
 * We parse the data payloads (ignoring the `event:` line because the
 * `type` field in the JSON body is canonical) and emit `ChatEvent`
 * deltas. The system prompt is hoisted out of `messages` because
 * Anthropic accepts it as a separate top-level `system` field —
 * passing a role:"system" entry inside `messages` is a 400.
 */

import {
  eventFromDelta,
  isRecord,
  messageEndEvent,
  readSsePayloads,
  readString
} from "../stream-events.js";
import type { ChatEvent, ChatMessage, ModelProvider } from "../provider-types.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

export type ClaudeApiDeps = {
  readonly fetch: FetchLike;
  readonly getApiKey: () => string | null;
  /** Override the upper bound on the response token count. */
  readonly maxTokens?: number;
};

type AnthropicMessageInput = {
  readonly system: string | null;
  readonly messages: readonly { role: "user" | "assistant"; content: string }[];
};

/**
 * Anthropic rejects a `system` entry inside `messages` (400 with
 * `messages.0.role: Input tag 'system' found using ...`). Split it off
 * here and join all system prompts with double newlines — multiple
 * system roles are unusual but possible (the explain flow chains a
 * disclosure + selection prompt as separate system messages).
 */
function splitAnthropicMessages(messages: readonly ChatMessage[]): AnthropicMessageInput {
  const systems: string[] = [];
  const others: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systems.push(m.content);
    } else {
      others.push({ role: m.role, content: m.content });
    }
  }
  return {
    system: systems.length > 0 ? systems.join("\n\n") : null,
    messages: others
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    // fall through to status line
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
      // not JSON
    }
    return trimmed;
  }
  const statusText = response.statusText.length > 0 ? ` ${response.statusText}` : "";
  return `HTTP ${String(response.status)}${statusText}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Parse Anthropic's SSE response body. Returns an ordered list of
 * data-payload records. We ignore `event:` framing because the JSON
 * body's `type` field is the canonical discriminator (and the event
 * line is sometimes absent under proxy layers that re-frame the
 * stream).
 *
 * Exported so tests can hit it without mocking fetch.
 *
 * Note: this parser is permissive — malformed payloads are skipped so
 * callers can still emit any well-formed deltas that arrived first.
 * The streaming adapter uses the incremental
 * `readSsePayloads` helper (in stream-events.ts) for the same fetch
 * body and surfaces malformed JSON as an in-band error event (M7).
 */
export function parseAnthropicSse(text: string): readonly unknown[] {
  const payloads: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice("data:".length).trim();
    if (raw.length === 0) continue;
    try {
      payloads.push(JSON.parse(raw));
    } catch {
      // Malformed payload — skip; downstream emits "" for missing deltas.
    }
  }
  return payloads;
}

export function createClaudeApiProvider(deps: ClaudeApiDeps): ModelProvider {
  const id = "claude-api";
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
  return {
    id,
    displayName: "Claude (direct)",
    async *streamChat(request, signal) {
      yield { type: "message_start", providerId: id, model: request.profile.model };

      const apiKey = deps.getApiKey();
      if (apiKey === null || apiKey.length === 0) {
        yield {
          type: "error",
          message: "Anthropic API key is not configured. Add it in Settings.",
          retryable: false
        };
        return;
      }

      const { system, messages } = splitAnthropicMessages(request.messages);
      if (messages.length === 0) {
        // Anthropic rejects an empty messages array with 400; surface
        // it as a non-retryable client error rather than asking the
        // server.
        yield {
          type: "error",
          message: "Claude API requires at least one user message.",
          retryable: false
        };
        return;
      }

      const body: Record<string, unknown> = {
        model: request.profile.model,
        max_tokens: maxTokens,
        stream: true,
        messages
      };
      if (system !== null) {
        body.system = system;
      }

      let response: Response;
      try {
        response = await deps.fetch(ENDPOINT, {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION
          },
          body: JSON.stringify(body)
        });
      } catch (err) {
        if (signal.aborted) {
          throw err;
        }
        yield {
          type: "error",
          message: `Could not reach Anthropic: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true
        };
        return;
      }

      if (!response.ok) {
        const detail = await readErrorMessage(response);
        const event: ChatEvent = {
          type: "error",
          message: `Anthropic error (${String(response.status)}): ${detail}`,
          retryable: isRetryableStatus(response.status)
        };
        yield event;
        return;
      }

      // M6 + M7 (Phase 4b codex review): stream the SSE body
      // incrementally and surface malformed JSON as an in-band error
      // event instead of silently completing with a blank assistant
      // turn.
      const responseBody = response.body;
      if (responseBody === null) {
        yield messageEndEvent();
        return;
      }
      const reader = responseBody.getReader();
      try {
        for await (const payload of readSsePayloads(reader)) {
          const text = readString(payload, ["delta", "text"]);
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
          message: `Claude stream parse failed: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false
        };
        return;
      }

      yield messageEndEvent();
    }
  };
}
