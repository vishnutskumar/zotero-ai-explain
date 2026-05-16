export type IndexingState = "idle" | "running" | "paused" | "complete" | "failed";

export type IndexingStatus = {
  readonly state: IndexingState;
  readonly totalItems: number;
  readonly indexedItems: number;
  readonly failedItems: number;
};

export type IndexingAction =
  | { readonly type: "started"; readonly totalItems: number }
  | { readonly type: "progress"; readonly indexedItems: number; readonly failedItems: number }
  | { readonly type: "paused" }
  | { readonly type: "resumed" }
  | { readonly type: "completed" }
  | { readonly type: "failed" }
  | { readonly type: "cleared" };

export function createInitialIndexingStatus(): IndexingStatus {
  return { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 };
}

export function reduceIndexingStatus(
  status: IndexingStatus,
  action: IndexingAction
): IndexingStatus {
  switch (action.type) {
    case "started":
      return { state: "running", totalItems: action.totalItems, indexedItems: 0, failedItems: 0 };
    case "progress":
      return { ...status, indexedItems: action.indexedItems, failedItems: action.failedItems };
    case "paused":
      return { ...status, state: "paused" };
    case "resumed":
      return { ...status, state: "running" };
    case "completed":
      return { ...status, state: "complete" };
    case "failed":
      return { ...status, state: "failed" };
    case "cleared":
      return createInitialIndexingStatus();
  }
}
