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

  it("`failed` action carries an errorMessage when supplied", () => {
    const started = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "started",
      totalItems: 3
    });
    const failed = reduceIndexingStatus(started, {
      type: "failed",
      errorMessage: "Connection to Ollama lost after 3 consecutive failures."
    });
    expect(failed.state).toBe("failed");
    expect(failed.errorMessage).toBe("Connection to Ollama lost after 3 consecutive failures.");
  });

  it("`failed` action without an errorMessage leaves the field undefined", () => {
    const started = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "started",
      totalItems: 3
    });
    const failed = reduceIndexingStatus(started, { type: "failed" });
    expect(failed.state).toBe("failed");
    expect(failed.errorMessage).toBeUndefined();
  });

  it("`cleared` action resets `errorMessage` to undefined", () => {
    const started = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "started",
      totalItems: 3
    });
    const failed = reduceIndexingStatus(started, {
      type: "failed",
      errorMessage: "boom"
    });
    const cleared = reduceIndexingStatus(failed, { type: "cleared" });
    expect(cleared.state).toBe("idle");
    expect(cleared.errorMessage).toBeUndefined();
  });

  it("`progress` action accepts an optional totalItems update", () => {
    const started = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "started",
      totalItems: 0
    });
    const progress = reduceIndexingStatus(started, {
      type: "progress",
      indexedItems: 2,
      failedItems: 1,
      totalItems: 5
    });
    expect(progress.indexedItems).toBe(2);
    expect(progress.failedItems).toBe(1);
    expect(progress.totalItems).toBe(5);
  });

  it("`progress` action without totalItems preserves the existing totalItems value", () => {
    const started = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "started",
      totalItems: 7
    });
    const progress = reduceIndexingStatus(started, {
      type: "progress",
      indexedItems: 3,
      failedItems: 0
    });
    expect(progress.totalItems).toBe(7);
    expect(progress.indexedItems).toBe(3);
  });

  it("`hydrate` action seeds previouslyIndexed when the indexer is idle", () => {
    const hydrated = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "hydrate",
      previouslyIndexed: 42
    });
    expect(hydrated.state).toBe("idle");
    expect(hydrated.previouslyIndexed).toBe(42);
    // Other counters left untouched so the legacy "0 / 0 indexed" line
    // still reads correctly for never-started installs.
    expect(hydrated.totalItems).toBe(0);
    expect(hydrated.indexedItems).toBe(0);
    expect(hydrated.failedItems).toBe(0);
    expect(hydrated.skippedNoText).toBe(0);
  });

  it("`hydrate` is a no-op once a run has started", () => {
    // A live run owns the counters; replaying hydrate after the crawler
    // has dispatched its canonical previouslyIndexed via `run-info` must
    // NOT clobber the in-flight progress (D11: storage-corruption parallel).
    const running = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "started",
      totalItems: 100,
      previouslyIndexed: 70
    });
    const afterHydrate = reduceIndexingStatus(running, {
      type: "hydrate",
      previouslyIndexed: 5
    });
    expect(afterHydrate).toBe(running);
  });
});
