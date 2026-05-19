/**
 * Direct OpenAI embeddings adapter (Phase 4 direct-API).
 *
 * Hits `https://api.openai.com/v1/embeddings` and decodes
 *   { data: [ { embedding: number[], index: 0 }, ... ] }
 *
 * Distinguishing per-model dimensions (text-embedding-3-large = 3072,
 * text-embedding-3-small = 1536) is the CALLER's responsibility — we
 * cross-check the returned length matches `expectedDimensions` when
 * supplied so a typo in settings ("3-large" vs "3-small") surfaces as
 * a dimension-mismatch error rather than silently corrupting the
 * persisted index.
 */

import { isRecord } from "../stream-events.js";
import type { EmbeddingProvider } from "../provider-types.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const ENDPOINT = "https://api.openai.com/v1/embeddings";

export type OpenAIEmbedDeps = {
  readonly fetch: FetchLike;
  readonly getApiKey: () => string | null;
  /**
   * Optional cross-check: when supplied the adapter asserts every
   * returned embedding vector has this length and throws otherwise.
   * Callers wire the value from the user's chosen model
   * (text-embedding-3-large → 3072, text-embedding-3-small → 1536).
   */
  readonly expectedDimensions?: number;
};

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
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("OpenAI embedding response did not include `data`.");
  }
  return payload.data.map((entry: unknown, idx: number) => {
    if (!isRecord(entry) || !Array.isArray(entry.embedding)) {
      throw new Error(`OpenAI embedding response entry ${String(idx)} missing 'embedding'.`);
    }
    const vector = entry.embedding;
    for (const value of vector) {
      if (typeof value !== "number") {
        throw new Error(
          `OpenAI embedding response entry ${String(idx)} contains non-numeric values.`
        );
      }
    }
    return vector as readonly number[];
  });
}

export function createOpenAIEmbedProvider(deps: OpenAIEmbedDeps): EmbeddingProvider {
  return {
    async embedTexts(request) {
      const apiKey = deps.getApiKey();
      if (apiKey === null || apiKey.length === 0) {
        throw new Error("OpenAI API key is not configured. Add it in Settings.");
      }
      if (request.texts.length === 0) {
        // The OpenAI API returns 400 on an empty `input`; short-circuit.
        return [];
      }

      const response = await deps.fetch(ENDPOINT, {
        method: "POST",
        signal: request.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: request.model,
          input: request.texts
        })
      });

      if (!response.ok) {
        const detail = await readErrorMessage(response);
        throw new Error(`OpenAI embed error (${String(response.status)}): ${detail}`);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(await response.text());
      } catch (err) {
        throw new Error(
          `OpenAI embed response was not JSON: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const vectors = readEmbeddings(payload);

      if (deps.expectedDimensions !== undefined) {
        for (let i = 0; i < vectors.length; i += 1) {
          const v = vectors[i];
          if (v?.length !== deps.expectedDimensions) {
            throw new Error(
              `OpenAI embed dimension mismatch: expected ${String(deps.expectedDimensions)} but got ${String(v?.length ?? 0)} for entry ${String(i)}.`
            );
          }
        }
      }

      return vectors;
    }
  };
}

/** Dimension constants for the supported models. Exported so callers
 *  don't sprinkle magic numbers. */
export const OPENAI_EMBED_DIMENSIONS: Readonly<Record<string, number>> = {
  "text-embedding-3-large": 3072,
  "text-embedding-3-small": 1536,
  "text-embedding-ada-002": 1536
};
