import type { ChatEvent } from "./provider-types.js";

export function parseSseDataPayloads(text: string): readonly unknown[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((payload) => payload.length > 0 && payload !== "[DONE]")
    .map(parseJsonPayload);
}

export function parseJsonPayload(payload: string): unknown {
  return JSON.parse(payload) as unknown;
}

export function eventFromDelta(text: string): ChatEvent {
  return { type: "delta", text };
}

export function messageEndEvent(): ChatEvent {
  return { type: "message_end" };
}

export function readString(value: unknown, path: readonly string[]): string | null {
  let current: unknown = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        return null;
      }
      const index = Number.parseInt(segment, 10);
      if (index >= current.length) {
        return null;
      }
      current = current[index];
      continue;
    }

    if (!isRecord(current)) {
      return null;
    }
    current = current[segment];
  }

  return typeof current === "string" ? current : null;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read an SSE (Server-Sent Events) body incrementally from a
 * `ReadableStream`, yielding one parsed JSON payload per `data:` line
 * as it arrives.
 *
 * Why this exists: the OpenAI and Anthropic chat adapters used to
 * buffer the entire response via `await response.text()` before
 * parsing, which (a) defeated streaming (the user saw the answer all
 * at once, not as the model produced it) and (b) weakened abort
 * behavior because the await never resolved if the upstream stalled
 * mid-response (M6 fix from Phase 4b codex review).
 *
 * Behavior:
 *
 *   - splits on the SSE event boundary `\n\n` so we yield only after
 *     a complete event has arrived (a partial `data: {"choices` line
 *     mid-chunk is NOT yielded until its terminating newline shows up)
 *   - skips `data: [DONE]` sentinel and empty payloads
 *   - throws SyntaxError on the first malformed JSON `data:` line —
 *     the adapter catches this and yields an in-band `error` event,
 *     so a corrupt upstream stream surfaces as a user-visible failure
 *     instead of a blank successful completion (M7 fix)
 *
 * Tests pass a mock stream backed by an array of chunks; production
 * uses `response.body!.getReader()`.
 */
export async function* readSsePayloads(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<unknown, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  let streamDone = false;
  while (!streamDone) {
    const { value, done } = await reader.read();
    if (value !== undefined) {
      buffer += decoder.decode(value, { stream: true });
    }
    // Process all complete events in the buffer. SSE events end on a
    // blank line (\n\n); a partial event (no trailing blank line) stays
    // in the buffer until the next read appends its terminator.
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const payload of parseEventBlock(event)) {
        yield payload;
      }
      boundary = buffer.indexOf("\n\n");
    }
    if (done) {
      // Flush any trailing partial event (some servers omit the final
      // blank line). Decoder's stream=false call here triggers the
      // BOM/multi-byte tail handling.
      buffer += decoder.decode();
      for (const payload of parseEventBlock(buffer)) {
        yield payload;
      }
      streamDone = true;
    }
  }
}

function parseEventBlock(block: string): readonly unknown[] {
  const payloads: unknown[] = [];
  for (const line of block.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice("data:".length).trim();
    if (raw.length === 0) continue;
    if (raw === "[DONE]") continue;
    // Intentionally NOT guarded with try/catch: a malformed payload
    // raises SyntaxError so the adapter's outer catch surfaces it as
    // an in-band error event (M7).
    payloads.push(JSON.parse(raw));
  }
  return payloads;
}
