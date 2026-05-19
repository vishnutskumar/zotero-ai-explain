import { describe, expect, it } from "vitest";

import { describeIndexingStatus } from "../../src/indexing/indexing-controller.js";
import {
  createInitialIndexingStatus,
  reduceIndexingStatus
} from "../../src/indexing/indexing-status.js";

describe("indexing status — honest counter fields", () => {
  it("initial status zeros previouslyIndexed and skippedNoText", () => {
    const s = createInitialIndexingStatus();
    expect(s.previouslyIndexed).toBe(0);
    expect(s.skippedNoText).toBe(0);
  });

  it("`started` action carries previouslyIndexed when supplied", () => {
    const next = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "started",
      totalItems: 42,
      previouslyIndexed: 7
    });
    expect(next.state).toBe("running");
    expect(next.totalItems).toBe(42);
    expect(next.previouslyIndexed).toBe(7);
  });

  it("`started` without previouslyIndexed defaults to 0", () => {
    const next = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "started",
      totalItems: 5
    });
    expect(next.previouslyIndexed).toBe(0);
  });

  it("`run-info` updates previouslyIndexed and totalItems without resetting counters", () => {
    let s = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "started",
      totalItems: 0
    });
    s = reduceIndexingStatus(s, {
      type: "progress",
      indexedItems: 3,
      failedItems: 1,
      skippedNoText: 2
    });
    s = reduceIndexingStatus(s, {
      type: "run-info",
      previouslyIndexed: 10,
      totalItems: 100
    });
    expect(s.previouslyIndexed).toBe(10);
    expect(s.totalItems).toBe(100);
    // Counters survive — pause/resume cycles can fire run-info repeatedly
    // and must NOT clobber the in-flight accumulator.
    expect(s.indexedItems).toBe(3);
    expect(s.failedItems).toBe(1);
    expect(s.skippedNoText).toBe(2);
  });

  it("`progress` action accepts an optional skippedNoText update", () => {
    let s = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "started",
      totalItems: 10
    });
    s = reduceIndexingStatus(s, {
      type: "progress",
      indexedItems: 1,
      failedItems: 0,
      skippedNoText: 4
    });
    expect(s.skippedNoText).toBe(4);
    expect(s.indexedItems).toBe(1);
  });

  it("`cleared` resets honest-counter fields to zero", () => {
    let s = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "started",
      totalItems: 3,
      previouslyIndexed: 2
    });
    s = reduceIndexingStatus(s, {
      type: "progress",
      indexedItems: 1,
      failedItems: 0,
      skippedNoText: 1
    });
    const cleared = reduceIndexingStatus(s, { type: "cleared" });
    expect(cleared.previouslyIndexed).toBe(0);
    expect(cleared.skippedNoText).toBe(0);
  });
});

describe("describeIndexingStatus — honest copy", () => {
  it("idle with no prior runs shows only the legacy counts (no parenthetical)", () => {
    const text = describeIndexingStatus({
      state: "idle",
      totalItems: 0,
      indexedItems: 0,
      failedItems: 0,
      previouslyIndexed: 0,
      skippedNoText: 0
    });
    expect(text).toBe("0 / 0 indexed, 0 failed");
    expect(text).not.toContain("already indexed");
  });

  it("complete with zero new items and a prior index does NOT show '0 / N indexed'", () => {
    // Real-world case: the user clicks Index on a library that's
    // already fully indexed. The crawler completes after iterating
    // 5738 items (top-level + attachments + notes) but indexes 0 new
    // ones because the 222 indexable parents are all in initialFile.
    // The bare "0 / 5738 indexed" would tell the user nothing is in
    // the index — the opposite of the truth.
    const text = describeIndexingStatus({
      state: "complete",
      totalItems: 5738,
      indexedItems: 0,
      failedItems: 0,
      previouslyIndexed: 222,
      skippedNoText: 13
    });
    expect(text).toMatch(/Library indexed/u);
    expect(text).toContain("222");
    expect(text).not.toContain("0 / 5738 indexed");
  });

  it("idle with a prior run surfaces the actionable previously-indexed count", () => {
    const text = describeIndexingStatus({
      state: "idle",
      totalItems: 100,
      indexedItems: 0,
      failedItems: 0,
      previouslyIndexed: 42,
      skippedNoText: 0
    });
    expect(text).toContain("42");
    expect(text).toMatch(/previously indexed/iu);
    // The bare "0 / 100 indexed" string would imply the index is empty
    // — the user must not see that when 42 items are already indexed.
    expect(text).not.toContain("0 / 100 indexed");
  });

  it("running with a prior run shows both counters", () => {
    const text = describeIndexingStatus({
      state: "running",
      totalItems: 100,
      indexedItems: 5,
      failedItems: 1,
      previouslyIndexed: 42,
      skippedNoText: 3
    });
    expect(text).toContain("42 already indexed");
    expect(text).toContain("5 new this run");
    expect(text).toContain("3 skipped (no text)");
    expect(text).toMatch(/Indexing/u);
  });

  it("preserves the legacy 'X / Y indexed, Z failed' substring (the e2e harness scrapes it)", () => {
    const text = describeIndexingStatus({
      state: "running",
      totalItems: 50,
      indexedItems: 10,
      failedItems: 2,
      previouslyIndexed: 0,
      skippedNoText: 0
    });
    expect(text).toContain("10 / 50 indexed, 2 failed");
  });

  it("never produces '0 new this run' on a never-started fresh status (would be noise)", () => {
    const text = describeIndexingStatus({
      state: "idle",
      totalItems: 0,
      indexedItems: 0,
      failedItems: 0,
      previouslyIndexed: 0,
      skippedNoText: 0
    });
    expect(text).not.toContain("0 new this run");
  });

  it("status without optional fields (legacy callers) renders without throwing", () => {
    // Some tests construct IndexingStatus literals with only the
    // legacy fields. The describer must tolerate undefined for the
    // new fields without crashing.
    const text = describeIndexingStatus({
      state: "running",
      totalItems: 3,
      indexedItems: 1,
      failedItems: 0
    });
    expect(text).toContain("1 / 3 indexed");
  });
});
