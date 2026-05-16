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
