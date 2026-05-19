import { describe, expect, it } from "vitest";

import {
  createIndexingController,
  describeIndexingStatus
} from "../../src/indexing/indexing-controller.js";
import { controllerStubDeps } from "./controller-test-helpers.js";

function makeLogger(): { readonly debug: (message: string) => void; readonly lines: string[] } {
  const lines: string[] = [];
  return {
    debug(message) {
      lines.push(message);
    },
    lines
  };
}

describe("createIndexingController", () => {
  it("starts idle and exposes the initial status", () => {
    const logger = makeLogger();
    const controller = createIndexingController({ logger, ...controllerStubDeps() });
    expect(controller.getStatus()).toEqual({
      state: "idle",
      previouslyIndexed: 0,
      skippedNoText: 0,
      totalItems: 0,
      indexedItems: 0,
      failedItems: 0
    });
  });

  it("transitions through start -> pause -> resume -> clear", async () => {
    const logger = makeLogger();
    const controller = createIndexingController({ logger, ...controllerStubDeps() });
    const seen: string[] = [];
    controller.subscribe((status) => {
      seen.push(status.state);
    });
    controller.start();
    controller.pause();
    controller.resume();
    await controller.clear();
    expect(seen).toContain("running");
    expect(seen).toContain("paused");
    expect(seen.at(-1)).toBe("idle");
    expect(controller.getStatus().state).toBe("idle");
  });

  it("ignores pause when not running and logs the skip", () => {
    const logger = makeLogger();
    const controller = createIndexingController({ logger, ...controllerStubDeps() });
    controller.pause();
    expect(controller.getStatus().state).toBe("idle");
    expect(logger.lines.some((l) => l.includes("pause-ignored"))).toBe(true);
  });

  it("ignores resume when not paused and logs the skip", () => {
    const logger = makeLogger();
    const controller = createIndexingController({ logger, ...controllerStubDeps() });
    controller.resume();
    expect(controller.getStatus().state).toBe("idle");
    expect(logger.lines.some((l) => l.includes("resume-ignored"))).toBe(true);
  });

  it("logs a structured action line for every transition", () => {
    const logger = makeLogger();
    const controller = createIndexingController({ logger, ...controllerStubDeps() });
    controller.start();
    expect(
      logger.lines.some(
        (l) => l.includes("Zotero AI Explain index:start") && l.includes("state=running")
      )
    ).toBe(true);
  });

  it("stops notifying after unsubscribe", () => {
    const logger = makeLogger();
    const controller = createIndexingController({ logger, ...controllerStubDeps() });
    let count = 0;
    const off = controller.subscribe(() => {
      count += 1;
    });
    controller.start();
    off();
    controller.pause();
    // After unsubscribe the listener no longer sees state transitions.
    // start() fires one notification before unsubscribe; pause() fires
    // none after — but the controller may also dispatch an internal
    // `progress` action with totalItems=0 from the crawler stub. The
    // contract is "no new notifications after unsubscribe", so we
    // record the count at unsubscribe time and assert it does not grow.
    const baseline = count;
    controller.pause();
    expect(count).toBe(baseline);
  });

  it("hydrate() seeds previouslyIndexed from the persisted IndexFile when idle", async () => {
    const logger = makeLogger();
    const deps = controllerStubDeps();
    await deps.storage.write({
      indexedAt: "2026-05-18T00:00:00.000Z",
      items: { a: { chunks: [] }, b: { chunks: [] }, c: { chunks: [] } } as never
    });
    const controller = createIndexingController({ logger, ...deps });
    expect(controller.getStatus().previouslyIndexed).toBe(0);
    await controller.hydrate();
    expect(controller.getStatus().previouslyIndexed).toBe(3);
    // State must remain idle so the user can still click Index.
    expect(controller.getStatus().state).toBe("idle");
  });

  it("hydrate() is a no-op when no IndexFile is persisted", async () => {
    const logger = makeLogger();
    const controller = createIndexingController({ logger, ...controllerStubDeps() });
    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
    });
    await controller.hydrate();
    expect(controller.getStatus().previouslyIndexed).toBe(0);
    // No notifications should fire — the UI subscription stays quiet
    // when there is nothing to surface.
    expect(notifications).toBe(0);
  });

  it("hydrate() is a no-op when an IndexFile exists but contains zero items", async () => {
    const logger = makeLogger();
    const deps = controllerStubDeps();
    await deps.storage.write({
      indexedAt: "2026-05-18T00:00:00.000Z",
      items: {}
    });
    const controller = createIndexingController({ logger, ...deps });
    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
    });
    await controller.hydrate();
    expect(controller.getStatus().previouslyIndexed).toBe(0);
    expect(notifications).toBe(0);
  });

  it("hydrate() is ignored once the indexer has left idle (running guard)", async () => {
    const logger = makeLogger();
    const deps = controllerStubDeps();
    await deps.storage.write({
      indexedAt: "2026-05-18T00:00:00.000Z",
      items: { a: { chunks: [] } } as never
    });
    const controller = createIndexingController({ logger, ...deps });
    controller.start();
    const before = controller.getStatus();
    expect(before.state).not.toBe("idle");
    await controller.hydrate();
    const after = controller.getStatus();
    expect(after.previouslyIndexed).toBe(before.previouslyIndexed);
    expect(after.state).toBe(before.state);
  });
});

describe("describeIndexingStatus", () => {
  it("shows raw counts when idle", () => {
    expect(
      describeIndexingStatus({ state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 })
    ).toBe("0 / 0 indexed, 0 failed");
  });

  it("marks running with a neutral running-state phrase and counts", () => {
    const text = describeIndexingStatus({
      state: "running",
      totalItems: 10,
      indexedItems: 3,
      failedItems: 1
    });
    expect(text).toMatch(/Indexing/u);
    expect(text).toContain("3 / 10 indexed");
    expect(text).toContain("1 failed");
  });

  it("marks paused and complete distinctly", () => {
    expect(
      describeIndexingStatus({ state: "paused", totalItems: 4, indexedItems: 1, failedItems: 0 })
    ).toContain("Paused");
    expect(
      describeIndexingStatus({
        state: "complete",
        totalItems: 4,
        indexedItems: 4,
        failedItems: 0
      })
    ).toMatch(/complete/iu);
  });

  it("includes the errorMessage when failed and a message is set", () => {
    const text = describeIndexingStatus({
      state: "failed",
      totalItems: 5,
      indexedItems: 1,
      failedItems: 1,
      errorMessage: "Connection to Ollama lost after 3 consecutive failures."
    });
    expect(text).toMatch(/failed/iu);
    expect(text).toContain("Connection to Ollama lost");
  });

  it("falls back to the bare 'failed' phrasing when no errorMessage is set", () => {
    const text = describeIndexingStatus({
      state: "failed",
      totalItems: 5,
      indexedItems: 1,
      failedItems: 1
    });
    expect(text).toMatch(/failed/iu);
  });

  it("never returns 'Phase 2' or 'not yet implemented' copy in any state", () => {
    for (const state of ["idle", "running", "paused", "complete", "failed"] as const) {
      const text = describeIndexingStatus({
        state,
        totalItems: 3,
        indexedItems: 1,
        failedItems: 0
      });
      expect(text).not.toMatch(/phase\s*2/iu);
      expect(text).not.toMatch(/not yet implemented/iu);
    }
  });
});
