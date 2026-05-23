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

/**
 * Yield NDJSON lines as their terminating newline arrives. Replaces
 * the `await response.text().split("\n")` path so the first delta
 * surfaces without waiting for the upstream stream to close.
 */
async function* readNdjsonLines(body: ReadableStream<Uint8Array> | null): AsyncIterable<string> {
  if (body === null) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamDone = false;
  try {
    while (!streamDone) {
      const { value, done } = await reader.read();
      streamDone = done;
      if (value !== undefined) {
        buffer += decoder.decode(value, { stream: true });
        let newlineIdx = buffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          if (line.trim().length > 0) {
            yield line;
          }
          newlineIdx = buffer.indexOf("\n");
        }
      }
    }
    // The upstream may close without a trailing newline; flush any
    // pending multi-byte sequences from the decoder and emit the
    // residual line if it has content.
    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Detect a terminal error chunk in an NDJSON line and return its
 * human-readable message, or null if the chunk is not a terminal error.
 *
 * Two shapes count as terminal:
 *
 *   1. `{error: "..."}` — top-level error string. Emitted by the
 *      llm-proxy server.mjs:142-151 when an upstream CLI exits non-zero.
 *   2. `{done: true, done_reason: "error", error?: "..."}` — emitted by
 *      scripts/llm-proxy/backends/ollama.mjs:45-53 on transport errors.
 *
 * When `done_reason === "error"` is present but `error` is missing,
 * fall back to "Upstream error" so callers always have a message to
 * render.
 */
function readTerminalErrorMessage(payload: Record<string, unknown>): string | null {
  const topLevelError = payload.error;
  if (typeof topLevelError === "string" && topLevelError.length > 0) {
    return topLevelError;
  }
  if (payload.done_reason === "error") {
    if (typeof topLevelError === "string" && topLevelError.length > 0) {
      return topLevelError;
    }
    return "Upstream error";
  }
  return null;
}

/**
 * Extract a human-readable diagnostic from a non-OK Ollama HTTP response.
 *
 * Ollama's standard error shape is `{"error": "<message>"}` (e.g., for an
 * unknown model it returns HTTP 404 with `{"error":"model 'foo' not found"}`).
 * Fall back to the raw body if it is not JSON-with-an-`error`-field, and
 * finally to `<status> <statusText>` if the body is empty.
 */
async function readErrorMessage(response: Response): Promise<string> {
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    // Body already consumed or transport error reading it — fall through to
    // the status line.
  }
  const trimmed = raw.trim();
  if (trimmed.length > 0) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && typeof parsed.error === "string" && parsed.error.length > 0) {
        return parsed.error;
      }
    } catch {
      // Not JSON — surface the raw body verbatim.
    }
    return trimmed;
  }
  const statusText = response.statusText.length > 0 ? ` ${response.statusText}` : "";
  return `HTTP ${String(response.status)}${statusText}`;
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

        if (!response.ok) {
          // Ollama returns HTTP 4xx/5xx with a JSON `{error: string}` body
          // for things like unknown-model (404). Without this check the
          // NDJSON parser below sees zero `message.content` deltas and the
          // popup silently shows an empty body. Surface it as an in-band
          // error event so the popup-controller renders it via `fail()`.
          const detail = await readErrorMessage(response);
          yield {
            type: "error",
            message: `Ollama error: ${detail}`,
            retryable: false
          };
          return;
        }

        if (response.body === null) {
          // A 200 OK with no body is a protocol-level failure: the
          // popup must show an error, NOT a completed empty message.
          // Codex review P2 — without this guard the for-await yielded
          // nothing and `messageEndEvent()` below fired success.
          yield {
            type: "error",
            message: `Ollama error: empty response body from ${url}`,
            retryable: false
          };
          return;
        }
        for await (const line of readNdjsonLines(response.body)) {
          const payload = parseJsonPayload(line);
          // H2 (Phase 4b codex review): proxy/CLI backends emit terminal
          // error chunks as HTTP 200 NDJSON with `{error, done, done_reason}`
          // — Ollama upstream doesn't do this, but the local llm-proxy
          // wraps Codex/Claude stderr into this shape (see
          // scripts/llm-proxy/server.mjs:142-151). Without this check
          // the parser silently drops the line and we emit message_end,
          // resurfacing BUG-AC8-1 for proxy failures.
          if (isRecord(payload)) {
            const errorMessage = readTerminalErrorMessage(payload);
            if (errorMessage !== null) {
              yield {
                type: "error",
                message: `Ollama error: ${errorMessage}`,
                retryable: false
              };
              return;
            }
          }
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
      if (!response.ok) {
        // Same root cause as streamChat: without this check, `readEmbeddings`
        // throws a generic "did not include embeddings" message that hides
        // the actual server diagnostic. The library-crawler's K=3 circuit
        // breaker treats any thrown error as a chunk failure.
        const detail = await readErrorMessage(response);
        throw new Error(`Ollama error: ${detail}`);
      }
      return readEmbeddings(parseJsonPayload(await response.text()));
    }
  };
}
