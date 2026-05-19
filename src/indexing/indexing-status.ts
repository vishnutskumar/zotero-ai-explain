export type IndexingState = "idle" | "running" | "paused" | "complete" | "failed";

/**
 * Snapshot of the indexer's externally observable status.
 *
 * `errorMessage` is set only when `state === "failed"` (per FINDING-12 /
 * FINDING-20 of the real-product-pipeline plan) so the settings UI can
 * surface "Indexing failed: <reason>" instead of a bare "failed" label.
 * The `cleared` action resets the entire status to its initial value,
 * which also drops the `errorMessage`.
 *
 * Phase 4 settings-UX cleanup adds two cumulative counters so the
 * settings dialog can report progress honestly across resumed runs:
 *
 *   - `previouslyIndexed` — count of items already present in the
 *     persisted IndexFile at the moment the current run started. The
 *     crawler reports this once (with the `started` action) so the UI
 *     can show "X already indexed" before any new embeddings happen.
 *     Resume runs land with previouslyIndexed > 0; first-time runs
 *     start at 0.
 *
 *   - `skippedNoText` — count of items the crawler skipped this run
 *     because they had no embeddable text (no title/abstract and no
 *     cached fulltext). Surfaced in the UI so a user wondering why
 *     coverage is lower than the library size sees the breakdown.
 *
 * Both default to 0 so the legacy shape (state/totalItems/indexedItems/
 * failedItems) remains a structural subset — existing consumers that
 * don't read the new fields are unaffected.
 */
export type IndexingStatus = {
  readonly state: IndexingState;
  readonly totalItems: number;
  readonly indexedItems: number;
  readonly failedItems: number;
  readonly errorMessage?: string;
  /**
   * Optional in the type so legacy callers / tests passing the
   * pre-Phase-4 shape still type-check. The reducer always emits a
   * numeric value (0 when no prior runs); the optionality is purely
   * a back-compat affordance for external code constructing literals.
   */
  readonly previouslyIndexed?: number;
  readonly skippedNoText?: number;
};

export type IndexingAction =
  | {
      readonly type: "started";
      readonly totalItems: number;
      /** Items already in the persisted IndexFile at run-start. */
      readonly previouslyIndexed?: number;
    }
  | {
      readonly type: "progress";
      readonly indexedItems: number;
      readonly failedItems: number;
      // FINDING-4 / AC4: the controller's `onProgress` callback drives
      // total updates too (the crawler discovers the library size
      // asynchronously). Optional so callers that only update
      // indexed/failed counts continue to compile.
      readonly totalItems?: number;
      /** Cumulative skip count this run. Optional for back-compat. */
      readonly skippedNoText?: number;
    }
  /**
   * Mid-run metadata update. Used by the crawler's one-shot
   * `onRunStart` callback to seed `previouslyIndexed` (and refresh
   * `totalItems`) without resetting the indexed/failed/skipped counts
   * the way `started` does. Fires AFTER `started` so a pause→resume
   * cycle does not destroy the in-flight accumulator.
   */
  | {
      readonly type: "run-info";
      readonly previouslyIndexed: number;
      readonly totalItems: number;
    }
  /**
   * Pre-run seed from the persisted IndexFile. Dispatched once at
   * startup so the settings UI can show "X already indexed" before the
   * user clicks Index. Updates only `previouslyIndexed`; the run state,
   * totals, and accumulators are untouched. No-op unless the indexer is
   * `idle` (a live run owns the counters and must not be clobbered).
   */
  | {
      readonly type: "hydrate";
      readonly previouslyIndexed: number;
    }
  | { readonly type: "paused" }
  | { readonly type: "resumed" }
  | { readonly type: "completed" }
  | { readonly type: "failed"; readonly errorMessage?: string }
  | { readonly type: "cleared" };

export function createInitialIndexingStatus(): IndexingStatus {
  return {
    state: "idle",
    totalItems: 0,
    indexedItems: 0,
    failedItems: 0,
    previouslyIndexed: 0,
    skippedNoText: 0
  };
}

export function reduceIndexingStatus(
  status: IndexingStatus,
  action: IndexingAction
): IndexingStatus {
  switch (action.type) {
    case "started":
      return {
        state: "running",
        totalItems: action.totalItems,
        indexedItems: 0,
        failedItems: 0,
        previouslyIndexed: action.previouslyIndexed ?? 0,
        skippedNoText: 0
      };
    case "progress":
      return {
        ...status,
        indexedItems: action.indexedItems,
        failedItems: action.failedItems,
        ...(action.totalItems !== undefined ? { totalItems: action.totalItems } : {}),
        ...(action.skippedNoText !== undefined ? { skippedNoText: action.skippedNoText } : {})
      };
    case "run-info":
      return {
        ...status,
        totalItems: action.totalItems,
        previouslyIndexed: action.previouslyIndexed
      };
    case "hydrate":
      if (status.state !== "idle") return status;
      if (status.previouslyIndexed === action.previouslyIndexed) return status;
      return {
        ...status,
        previouslyIndexed: action.previouslyIndexed
      };
    case "paused":
      return { ...status, state: "paused" };
    case "resumed":
      return { ...status, state: "running" };
    case "completed":
      return { ...status, state: "complete" };
    case "failed":
      return {
        ...status,
        state: "failed",
        ...(action.errorMessage !== undefined ? { errorMessage: action.errorMessage } : {})
      };
    case "cleared":
      // Returning the initial status drops `errorMessage` because the
      // initial value never carries one (FINDING-20).
      return createInitialIndexingStatus();
  }
}
