import { describe, expect, it } from "vitest";

import {
  createInitialIndexingStatus,
  reduceIndexingStatus
} from "../../src/indexing/indexing-status.js";

describe("indexing status", () => {
  it("tracks start, pause, resume, and clear", () => {
    const started = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "started",
      totalItems: 10
    });
    expect(started).toMatchObject({ state: "running", totalItems: 10, indexedItems: 0 });

    const paused = reduceIndexingStatus(started, { type: "paused" });
    expect(paused.state).toBe("paused");

    const resumed = reduceIndexingStatus(paused, { type: "resumed" });
    expect(resumed.state).toBe("running");

    const cleared = reduceIndexingStatus(resumed, { type: "cleared" });
    expect(cleared).toEqual(createInitialIndexingStatus());
  });
});
