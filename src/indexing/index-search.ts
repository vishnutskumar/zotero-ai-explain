/**
 * Pure retrieval over the persisted `IndexFile`.
 *
 * Three exports:
 *
 *   - `loadIndex(storage)` — thin wrapper around `IndexStorage.read()`.
 *     Exists so callers in the runtime can depend on a narrow function
 *     surface rather than the storage object, which keeps test wiring
 *     straightforward.
 *   - `cosineSimilarity(a, b)` — pure cosine of two numeric vectors.
 *     Throws `EmbeddingDimensionMismatchError` when lengths differ; a
 *     dimension mismatch always indicates the user re-indexed under one
 *     embedding model and then switched to another, so surfacing it as
 *     an error (rather than silently producing wrong scores) is the
 *     hard-rule behavior the plan calls for.
 *   - `topKChunks(indexFile, queryEmbedding, k)` — rank every chunk in
 *     the file by cosine similarity to the query, return the top K. The
 *     returned shape includes the source `itemKey` and `title` so the
 *     prompt builder can render `[itemKey] <text>` excerpts and the
 *     citation renderer can map clicks back to a Zotero item.
 */

import type { IndexFile } from "./library-crawler.js";
import type { IndexStorage } from "./index-storage.js";

export type RetrievedChunk = {
  readonly itemKey: string;
  readonly title: string;
  readonly text: string;
  readonly score: number;
  /** Position of this chunk within the retrieved-chunks list. */
  readonly chunkIndex?: number;
  /** Source page (PDF chunks only); 0-indexed. `undefined`-absent. */
  readonly pageIndex?: number;
  /** Source attachment key (PDF/EPUB/snapshot/attachment chunks). */
  readonly attachmentKey?: string;
  /** Descriptive provenance of the chunk's text. */
  readonly sourceKind?: "pdf-page" | "metadata" | "note" | "epub" | "snapshot" | "attachment";
};

/**
 * Optional retrieval scoping. When `scopedItemKey` is set, only chunks of
 * that item are eligible — used by the in-PDF RAG popup. Omitted (or with
 * an explicit `undefined` `scopedItemKey`) ⇒ library-wide retrieval — both
 * absence representations are accepted so callers can forward an optional
 * field without conditionally spreading it.
 */
export type TopKChunksOptions = {
  readonly scopedItemKey?: string | undefined;
};

export class EmbeddingDimensionMismatchError extends Error {
  public override readonly name = "EmbeddingDimensionMismatchError";

  public constructor(queryDim: number, chunkDim: number) {
    super(
      `Embedding dimension mismatch: query has ${String(queryDim)}, index has ${String(chunkDim)}. ` +
        "This usually means the embedding provider changed since you last indexed the library. " +
        "Re-index to fix."
    );
  }
}

export function loadIndex(storage: IndexStorage): Promise<IndexFile | null> {
  return storage.read();
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new EmbeddingDimensionMismatchError(a.length, b.length);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) {
    // A zero vector has an undefined cosine (0/0). Returning 0 is the
    // standard practical choice: the chunk is treated as "no signal"
    // and falls to the bottom of the ranking without producing NaN.
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function topKChunks(
  indexFile: IndexFile,
  queryEmbedding: readonly number[],
  k: number,
  options?: TopKChunksOptions
): readonly RetrievedChunk[] {
  if (k <= 0) return [];
  const scopedItemKey = options?.scopedItemKey;
  const scored: RetrievedChunk[] = [];
  for (const [itemKey, item] of Object.entries(indexFile.items)) {
    // AC-3 scope filter: when a scope is set, only chunks of that item
    // are eligible. Skipping the whole item BEFORE `cosineSimilarity`
    // means a dimension mismatch on an out-of-scope item never surfaces.
    if (scopedItemKey !== undefined && itemKey !== scopedItemKey) {
      continue;
    }
    for (const chunk of item.chunks) {
      // Eager dim-mismatch detection: surface the first encountered
      // mismatch as an error so the UI can render a clear "re-index"
      // message instead of returning silently-wrong scores.
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      scored.push({
        itemKey,
        title: item.title,
        text: chunk.text,
        score,
        // Provenance carried verbatim from the index chunk. `sourceKind`
        // is always present (required on `IndexedItemChunk`); `pageIndex`/
        // `attachmentKey` are optional, attached only when supplied.
        // `pageIndex: 0` is preserved — only attach when it is a number.
        sourceKind: chunk.sourceKind,
        ...(typeof chunk.pageIndex === "number" ? { pageIndex: chunk.pageIndex } : {}),
        ...(chunk.attachmentKey !== undefined ? { attachmentKey: chunk.attachmentKey } : {})
      });
    }
  }
  scored.sort((x, y) => y.score - x.score);
  // Stamp `chunkIndex` as the post-sort position in the retrieval result.
  return scored.slice(0, k).map((chunk, index) => ({ ...chunk, chunkIndex: index }));
}
