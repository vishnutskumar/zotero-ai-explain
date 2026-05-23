/**
 * Direct Google Gemini embeddings adapter (Phase 4 direct-API).
 *
 * Gemini exposes per-text and batch endpoints:
 *   POST /v1beta/models/{model}:embedContent?key={key}    (one text)
 *   POST /v1beta/models/{model}:batchEmbedContents?key=...  (many)
 *
 * We always use the batch endpoint because the crawler batches chunks
 * to amortize round-trip latency. Schema:
 *
 *   request:  { requests: [{ model, content: { parts: [{ text }] } }, ...] }
 *   response: { embeddings: [{ values: number[] }, ...] }
 *
 * The model name must include the `models/` prefix in the body even
 * though it is also part of the URL — Gemini rejects requests without
 * the prefix with a 400. We normalize the caller's value so a settings
 * field like `text-embedding-004` works without manual prefixing.
 *
 * text-embedding-004 returns 768-dimensional vectors.
 */

import { isRecord } from "../stream-events.js";
import type { EmbeddingProvider } from "../provider-types.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const ENDPOINT_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiEmbedDeps = {
  readonly fetch: FetchLike;
  readonly getApiKey: () => string | null;
  readonly expectedDimensions?: number;
};

function withModelsPrefix(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

async function readErrorMessage(response: Response): Promise<string> {
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    // fall through
  }
  const trimmed = raw.trim();
  if (trimmed.length > 0) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      // Gemini error shape: {"error": {"code": N, "message": "...", "status": "..."}}
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

function readEmbeddings(payload: unknown): readonly (readonly number[])[] {
  if (!isRecord(payload) || !Array.isArray(payload.embeddings)) {
    throw new Error("Gemini embedding response did not include `embeddings`.");
  }
  return payload.embeddings.map((entry: unknown, idx: number) => {
    if (!isRecord(entry) || !Array.isArray(entry.values)) {
      throw new Error(`Gemini embedding entry ${String(idx)} missing 'values'.`);
    }
    for (const value of entry.values) {
      if (typeof value !== "number") {
        throw new Error(`Gemini embedding entry ${String(idx)} contains non-numeric values.`);
      }
    }
    return entry.values as readonly number[];
  });
}

export function createGeminiEmbedProvider(deps: GeminiEmbedDeps): EmbeddingProvider {
  return {
    async embedTexts(request) {
      const apiKey = deps.getApiKey();
      if (apiKey === null || apiKey.length === 0) {
        throw new Error("Gemini API key is not configured. Add it in Settings.");
      }
      if (request.texts.length === 0) {
        return [];
      }
      const model = withModelsPrefix(request.model);
      const url = `${ENDPOINT_BASE}/${encodeURIComponent(request.model)}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
      const body = {
        requests: request.texts.map((text) => ({
          model,
          content: { parts: [{ text }] }
        }))
      };

      const response = await deps.fetch(url, {
        method: "POST",
        signal: request.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const detail = await readErrorMessage(response);
        throw new Error(`Gemini embed error (${String(response.status)}): ${detail}`);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await response.text());
      } catch (err) {
        throw new Error(
          `Gemini embed response was not JSON: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const vectors = readEmbeddings(payload);

      if (deps.expectedDimensions !== undefined) {
        for (let i = 0; i < vectors.length; i += 1) {
          const v = vectors[i];
          if (v?.length !== deps.expectedDimensions) {
            throw new Error(
              `Gemini embed dimension mismatch: expected ${String(deps.expectedDimensions)} but got ${String(v?.length ?? 0)} for entry ${String(i)}.`
            );
          }
        }
      }

      return vectors;
    }
  };
}

/** Dimension constants for the supported Gemini embedding models. */
export const GEMINI_EMBED_DIMENSIONS: Readonly<Record<string, number>> = {
  "text-embedding-004": 768,
  "embedding-001": 768
};
