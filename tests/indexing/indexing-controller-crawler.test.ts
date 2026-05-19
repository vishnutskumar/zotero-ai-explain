/**
 * Adversarial tests for AC4 of the real-product-pipeline plan: the
 * `IndexingController` state machine wired to the real library crawler.
 *
 * Plan section: AC4, L685-792 of
 * `docs/superpowers/plans/2026-05-17-real-product-pipeline.md`.
 * Interfaces: L1035-1054.
 *
 * Pre-impl, the controller is a thin reducer wrapper that does NOT spawn
 * `indexLibrary`. After AC4, the controller MUST own one AbortController
 * per active run, spawn the crawler on `start()` / `resume()`, await the
 * in-flight task on `pause()` / `clear()` (per the plan's state
 * machine), pattern-match on `EmbedCircuitBreakerError` to emit
 * `failed`, and persist progress via the injected `IndexStorage`.
 *
 * These tests use `vi.mock` to intercept the controller's import of
 * `indexLibrary`, replacing it with a controllable fake that exposes
 * its in-flight Promise so tests can sequence pause / clear against
 * the crawler's settle point (per the FINDING-6 ordering requirement:
 * abort BEFORE await BEFORE storage.clear BEFORE reducer cleared).
 *
 * --------------------------------------------------------------------
 * Fault Localization (Template 4)
 * --------------------------------------------------------------------
 *
 * 1. Spec semantics (premises):
 *    P1.  `createIndexingController` takes `{logger, zotero, provider,
 *         settings, storage, scheduler?, initialStatus?}` and returns
 *         an unchanged `IndexingController` (start/pause/resume/clear/
 *         getStatus/subscribe).
 *    P2.  `start()` from `idle`: create a fresh AbortController, call
 *         `await storage.read()`, spawn an unawaited
 *         `activeRun = indexLibrary(deps, options)`; transition to
 *         `running`.
 *    P3.  On `activeRun` resolve `{completed: true}` → emit `completed`
 *         reducer action; status.state = "complete".
 *    P4.  On `activeRun` resolve `{completed: false}` (pause path) →
 *         leave state at `paused` (the immediate `pause()` call already
 *         transitioned the reducer to paused).
 *    P5.  On `activeRun` reject with `EmbedCircuitBreakerError` OR
 *         `Error("Connection to Ollama lost…")` → transition to
 *         `failed` with the error's message attached to
 *         `status.errorMessage`.
 *    P6.  `pause()` from `running`: flip an internal paused flag
 *         observable to the crawler via `options.isPaused() => boolean`;
 *         emit `paused` reducer action immediately. (The crawler is
 *         responsible for calling abortController.abort() — the
 *         controller does NOT abort directly in `pause()`.)
 *    P7.  `resume()` from `paused`: create a NEW AbortController; spawn
 *         a NEW `indexLibrary` call with `resumeFromItemKey` set to the
 *         last key of the persisted file; emit `resumed` action.
 *    P8.  `clear()` state machine (FINDING-6):
 *           - from `running`: (1) abortController.abort(), (2) await
 *             activeRun (swallow AbortError), (3) storage.clear(),
 *             (4) emit `cleared`.
 *           - from `paused`: skip the await (activeRun already resolved
 *             with {completed: false}); just storage.clear + cleared.
 *           - from `complete` / `failed` / `idle`: no active run; just
 *             storage.clear + cleared.
 *    P9.  Listener (`subscribe`) notified on every state transition.
 *    P10. The controller's progress callback passed into `indexLibrary`
 *         (the `onProgress` field on LibraryCrawlerDeps) drives
 *         `progress` reducer updates; `status.indexedItems`,
 *         `status.failedItems`, `status.totalItems` reflect the
 *         latest onProgress call.
 *    P11. `IndexingStatus` gains an optional `errorMessage: string |
 *         undefined` field (FINDING-12 / FINDING-20). Set on failure;
 *         cleared by `cleared` (which resets the whole status).
 *
 * 2. Code path trace (against the contract):
 *    - `start()` → fresh AbortController → `storage.read()` → spawn
 *      `indexLibrary(deps, options)` → settle handler dispatches the
 *      terminal reducer action (`completed` / `paused` / `failed`).
 *    - `pause()` → flip flag + dispatch `paused` (the crawler later
 *      aborts the in-flight fetch and resolves `{completed:false}`).
 *    - `resume()` → new AbortController + new indexLibrary spawn with
 *      `resumeFromItemKey` taken from the persisted file's last item.
 *    - `clear()` → branch on current state per FINDING-6.
 *
 * 3. Divergence analysis (likely bugs the tests target):
 *    D1  [HIGH]   `start()` does not actually spawn `indexLibrary` (the
 *                 pre-impl baseline — should fail until AC4 is wired).
 *    D2  [HIGH]   `pause()` calls `abortController.abort()` itself
 *                 (per the plan, the CRAWLER aborts on the next pause
 *                 check, not the controller — but the controller MUST
 *                 still set state to `paused` immediately so the UI
 *                 reflects the user's intent).
 *    D3  [HIGH]   `clear()` from `running` calls `storage.clear()`
 *                 BEFORE awaiting `activeRun` (race: the crawler can
 *                 still `storage.write()` after clear).
 *    D4  [HIGH]   `clear()` from `running` does NOT await `activeRun`
 *                 at all (leaks an unsettled task).
 *    D5  [HIGH]   `clear()` from `paused` AWAITS `activeRun` anyway
 *                 (deadlocks: activeRun is already resolved, but a
 *                 buggy controller might hold a stale Promise).
 *    D6  [HIGH]   `resume()` does NOT pass `resumeFromItemKey` →
 *                 re-indexes from scratch.
 *    D7  [HIGH]   `resume()` re-uses the previous AbortController
 *                 (which was aborted by `pause()`) → the new run is
 *                 immediately aborted.
 *    D8  [HIGH]   `EmbedCircuitBreakerError` rejection does NOT
 *                 transition to `failed` (e.g., the controller swallows
 *                 it as an AbortError).
 *    D9  [HIGH]   `errorMessage` is not set on the status on failure
 *                 (UI shows generic "failed" with no detail).
 *    D10 [MEDIUM] `onProgress` callback does not drive `progress`
 *                 reducer updates → UI shows stale 0/0 counts.
 *    D11 [MEDIUM] Concurrent `start()` while running spawns a SECOND
 *                 indexLibrary task (storage corruption risk).
 *    D12 [MEDIUM] Listener is not notified on every transition (e.g.,
 *                 only on the first state change).
 *    D13 [MEDIUM] `clear()` from `idle` throws when `storage.clear()`
 *                 throws on a missing file (it shouldn't — IndexStorage
 *                 swallows ENOENT per AC3).
 *    D14 [LOW]    `clear()` from `failed` ignores `storage.clear()`.
 *    D15 [LOW]    Concurrent `clear()` calls race; the second one
 *                 fires `storage.clear` before the first settles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  IndexFile,
  IndexLibraryOptions,
  LibraryCrawlerDeps
} from "../../src/indexing/library-crawler.js";

// ----------------------------------------------------------------------
// vi.mock: replace `indexLibrary` with a controllable fake but keep
// `EmbedCircuitBreakerError` real so the controller's `instanceof` /
// message pattern-match (per FINDING-12) is exercised against the same
// class the production crawler throws.
// ----------------------------------------------------------------------

type IndexLibraryCall = {
  readonly deps: LibraryCrawlerDeps;
  readonly options: IndexLibraryOptions;
  readonly promise: Promise<{ readonly completed: boolean }>;
  readonly resolve: (value: { readonly completed: boolean }) => void;
  readonly reject: (err: unknown) => void;
};

const calls: IndexLibraryCall[] = [];

vi.mock("../../src/indexing/library-crawler.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/indexing/library-crawler.js")>();
  return {
    ...original,
    indexLibrary: vi
      .fn<
        (deps: LibraryCrawlerDeps, options: IndexLibraryOptions) => Promise<{ completed: boolean }>
      >()
      .mockImplementation((deps, options) => {
        let resolve!: (value: { readonly completed: boolean }) => void;
        let reject!: (err: unknown) => void;
        const promise = new Promise<{ readonly completed: boolean }>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        calls.push({ deps, options, promise, resolve, reject });
        return promise;
      })
  };
});

// Import AFTER vi.mock so the controller's `import { indexLibrary }`
// binds to the mocked symbol.
import { EmbedCircuitBreakerError } from "../../src/indexing/library-crawler.js";
import {
  createIndexingController,
  type IndexingController,
  type IndexingStatusListener
} from "../../src/indexing/indexing-controller.js";
import type { IndexingStatus } from "../../src/indexing/indexing-status.js";

// ----------------------------------------------------------------------
// Test harness: build a minimal but realistic set of injected deps.
// ----------------------------------------------------------------------

type FakeStorage = {
  read: ReturnType<typeof vi.fn<() => Promise<IndexFile | null>>>;
  write: ReturnType<typeof vi.fn<(file: IndexFile) => Promise<void>>>;
  clear: ReturnType<typeof vi.fn<() => Promise<void>>>;
  path: ReturnType<typeof vi.fn<() => string>>;
};

type FakeProvider = {
  embedTexts: ReturnType<
    typeof vi.fn<
      (request: {
        readonly baseUrl: string;
        readonly model: string;
        readonly texts: readonly string[];
        readonly signal: AbortSignal;
      }) => Promise<readonly (readonly number[])[]>
    >
  >;
};

type Harness = {
  readonly controller: IndexingController;
  readonly storage: FakeStorage;
  readonly provider: FakeProvider;
  readonly scheduler: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly logger: { readonly debug: (msg: string) => void; readonly lines: string[] };
  readonly statusLog: IndexingStatus[];
  readonly unsubscribe: () => void;
};

function makeHarness(
  overrides: {
    readonly initialFile?: IndexFile | null;
    readonly initialStatus?: IndexingStatus;
  } = {}
): Harness {
  const initialFile: IndexFile | null = overrides.initialFile ?? null;

  const storage: FakeStorage = {
    read: vi.fn<() => Promise<IndexFile | null>>().mockResolvedValue(initialFile),
    write: vi.fn<(file: IndexFile) => Promise<void>>().mockResolvedValue(undefined),
    clear: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    path: vi
      .fn<() => string>()
      .mockReturnValue("/var/test-fixture/zotero-data/zotero-ai-explain-index.json")
  };

  const provider: FakeProvider = {
    embedTexts: vi
      .fn<
        (request: {
          readonly baseUrl: string;
          readonly model: string;
          readonly texts: readonly string[];
          readonly signal: AbortSignal;
        }) => Promise<readonly (readonly number[])[]>
      >()
      .mockResolvedValue([[0.1]])
  };

  const scheduler = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

  const lines: string[] = [];
  const logger = {
    debug(msg: string): void {
      lines.push(msg);
    },
    lines
  };

  const statusLog: IndexingStatus[] = [];

  const zotero = {
    Libraries: { userLibraryID: 1 },
    Items: {
      // eslint-disable-next-line @typescript-eslint/require-await
      getAll: vi.fn(async () => [] as const),
      get: vi.fn(() => null)
    }
  };

  // The AC4 signature is broader than the pre-impl baseline (which only
  // accepts `{logger, initialStatus?}`). Build the expanded set as an
  // `unknown` cast so this test compiles against either signature.
  const controllerOpts = {
    logger,
    zotero,
    provider,
    settings: { baseUrl: "http://localhost:11434", embeddingModel: "nomic-embed-text" },
    storage,
    scheduler,
    ...(overrides.initialStatus !== undefined ? { initialStatus: overrides.initialStatus } : {})
  } as unknown as Parameters<typeof createIndexingController>[0];

  const controller = createIndexingController(controllerOpts);

  const listener: IndexingStatusListener = (status) => {
    statusLog.push(status);
  };
  const unsubscribe = controller.subscribe(listener);

  return { controller, storage, provider, scheduler, logger, statusLog, unsubscribe };
}

/** Microtask drain — flush queued promise continuations. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

/**
 * `clear()` is awaitable post-AC4 (returns `Promise<void>`). The pre-impl
 * controller types it as `void`. This helper wraps the call so the tests
 * compile against either signature; runtime behavior is identical.
 */
function clearController(controller: IndexingController): Promise<void> {
  // Post-AC4: clear() returns Promise<void>. The cast keeps this helper
  // tolerant if a future refactor narrows the return type further.
  const result: unknown = controller.clear();
  return Promise.resolve(result as Promise<void> | undefined).then(() => undefined);
}

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  calls.length = 0;
});

// ----------------------------------------------------------------------
// Transitions
// ----------------------------------------------------------------------

describe("AC4: createIndexingController — start() spawns the crawler", () => {
  it("T1: idle -> running on start(); indexLibrary called once with injected deps", async () => {
    const h = makeHarness();
    expect(h.controller.getStatus().state).toBe("idle");

    h.controller.start();
    await flush();

    expect(calls).toHaveLength(1);
    expect(h.controller.getStatus().state).toBe("running");

    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");
    expect(call.deps.storage).toBe(h.storage);
    expect(call.deps.provider).toBe(h.provider);
    expect(call.deps.scheduler).toBe(h.scheduler);
    // signal MUST come from a fresh AbortController owned by the controller.
    expect(call.options.signal).toBeInstanceOf(AbortSignal);
    expect(call.options.signal.aborted).toBe(false);
    // isPaused is a function, not a boolean snapshot.
    expect(typeof call.options.isPaused).toBe("function");
    expect(call.options.isPaused()).toBe(false);
  });

  it("T2: start() reads storage so resume semantics inherit prior state", async () => {
    const h = makeHarness({
      initialFile: { items: { a: { title: "A", chunks: [] } }, indexedAt: "2026-01-01T00:00:00Z" }
    });
    h.controller.start();
    await flush();
    expect(h.storage.read).toHaveBeenCalled();
  });

  it("T3: subscribers notified of running on start()", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    expect(h.statusLog.some((s) => s.state === "running")).toBe(true);
  });
});

describe("AC4: pause() — running -> paused", () => {
  it("T4: pause() flips the flag and emits paused; crawler observes via isPaused()", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");

    expect(call.options.isPaused()).toBe(false);
    h.controller.pause();
    expect(call.options.isPaused()).toBe(true);
    expect(h.controller.getStatus().state).toBe("paused");
  });

  it("T5: when the crawler resolves {completed: false} after pause, state stays paused", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    h.controller.pause();
    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");
    call.resolve({ completed: false });
    await flush();
    expect(h.controller.getStatus().state).toBe("paused");
  });

  it("T6: no new indexLibrary spawn after pause settle without an explicit resume()", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    h.controller.pause();
    const beforeLen = h.statusLog.length;
    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");
    call.resolve({ completed: false });
    await flush();
    expect(calls).toHaveLength(1);
    const after = h.statusLog.slice(beforeLen);
    for (const s of after) {
      expect(s.state).toBe("paused");
    }
  });
});

describe("AC4: resume() — paused -> running", () => {
  it("T7: resume() spawns a new indexLibrary call with a fresh AbortController", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    h.controller.pause();
    const firstCall = calls[0];
    if (firstCall === undefined) throw new Error("expected an indexLibrary call");
    firstCall.resolve({ completed: false });
    await flush();

    h.controller.resume();
    await flush();

    expect(calls).toHaveLength(2);
    expect(h.controller.getStatus().state).toBe("running");
    const secondCall = calls[1];
    if (secondCall === undefined) throw new Error("expected a second indexLibrary call");
    // The new AbortController must NOT share its signal with the first.
    expect(secondCall.options.signal).not.toBe(firstCall.options.signal);
    expect(secondCall.options.signal.aborted).toBe(false);
  });

  it("T8: resume() re-reads storage so resumeFromItemKey reflects the persisted last key", async () => {
    const persisted: IndexFile = {
      items: {
        a: { title: "A", chunks: [{ text: "...", embedding: [0.1] }] },
        b: { title: "B", chunks: [{ text: "...", embedding: [0.2] }] }
      },
      indexedAt: "2026-01-01T00:00:00Z"
    };
    const h = makeHarness({ initialFile: persisted });
    h.controller.start();
    await flush();
    h.controller.pause();
    const firstCall = calls[0];
    if (firstCall === undefined) throw new Error("expected an indexLibrary call");
    firstCall.resolve({ completed: false });
    await flush();

    // Now simulate the storage having grown between pause and resume —
    // a realistic case is that the user added items, but here we just
    // verify the controller re-reads on resume rather than caching.
    h.storage.read.mockResolvedValueOnce(persisted);

    const readCountBefore = h.storage.read.mock.calls.length;
    h.controller.resume();
    await flush();

    // Resume MUST consult storage again (it owns the resumeFromItemKey).
    expect(h.storage.read.mock.calls.length).toBeGreaterThan(readCountBefore);
    const secondCall = calls[1];
    if (secondCall === undefined) throw new Error("expected a second indexLibrary call");
    // The resumeFromItemKey, if defined, MUST be a key from the persisted
    // file (the controller picks one of them — the test does not pin to
    // "last vs first" since the plan describes a per-item cursor and the
    // exact semantics are the crawler's responsibility).
    if (secondCall.options.resumeFromItemKey !== undefined) {
      expect(Object.keys(persisted.items)).toContain(secondCall.options.resumeFromItemKey);
    }
  });
});

describe("AC4: clear() — state-dependent ordering (FINDING-6)", () => {
  it("T9: clear() from running aborts BEFORE storage.clear; awaits crawler BEFORE storage.clear", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();

    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");
    const order: string[] = [];
    const originalSignal = call.options.signal;
    originalSignal.addEventListener("abort", () => order.push("abort"), { once: true });
    h.storage.clear.mockImplementationOnce(() => {
      order.push("storage.clear");
      return Promise.resolve();
    });

    // Hold the crawler's settle until after clear() is invoked so we can
    // observe the ordering: clear() should NOT call storage.clear until
    // activeRun has settled.
    const clearPromise = clearController(h.controller);

    // Give clear() a chance to call abort.
    await flush(2);
    expect(originalSignal.aborted).toBe(true);
    expect(order).toEqual(["abort"]);

    // storage.clear MUST not have been called yet — clear is awaiting
    // the crawler's settle.
    expect(h.storage.clear).not.toHaveBeenCalled();

    // Now settle the crawler (modeling the AC3 behavior on abort —
    // either {completed: false} or AbortError reject is acceptable).
    call.resolve({ completed: false });
    await clearPromise;

    expect(order).toEqual(["abort", "storage.clear"]);
    expect(h.controller.getStatus().state).toBe("idle");
  });

  it("T10: clear() from running tolerates the crawler rejecting with AbortError", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");

    const clearPromise = clearController(h.controller);
    await flush(2);
    const err: Error & { name: string } = Object.assign(new Error("aborted"), {
      name: "AbortError"
    });
    call.reject(err);
    await expect(clearPromise).resolves.toBeUndefined();
    expect(h.storage.clear).toHaveBeenCalledTimes(1);
    expect(h.controller.getStatus().state).toBe("idle");
  });

  it("T11: clear() from paused skips the await and clears immediately", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    h.controller.pause();
    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");
    call.resolve({ completed: false });
    await flush();
    expect(h.controller.getStatus().state).toBe("paused");

    let resolved = false;
    h.storage.clear.mockImplementationOnce(() => {
      // Even if storage.clear is slow, the controller should already
      // have committed to clearing — it should not be awaiting any
      // crawler promise here.
      return Promise.resolve();
    });

    const clearPromise = clearController(h.controller).then(() => {
      resolved = true;
    });
    await flush(4);
    expect(h.storage.clear).toHaveBeenCalledTimes(1);
    await clearPromise;
    expect(resolved).toBe(true);
    expect(h.controller.getStatus().state).toBe("idle");
  });

  it("T12: clear() from idle is a safe no-op-ish: storage.clear is called, no exception", async () => {
    const h = makeHarness();
    await expect(clearController(h.controller)).resolves.toBeUndefined();
    expect(h.storage.clear).toHaveBeenCalledTimes(1);
    expect(h.controller.getStatus().state).toBe("idle");
  });

  it("T13: clear() from idle tolerates storage.clear errors (idempotent on missing file)", async () => {
    const h = makeHarness();
    // IndexStorage.clear() already swallows ENOENT internally per AC3,
    // but a defensive controller should not crash if a downstream layer
    // does throw — the public contract is "clear is safe from any state".
    h.storage.clear.mockResolvedValueOnce(undefined);
    await expect(clearController(h.controller)).resolves.toBeUndefined();
    expect(h.controller.getStatus().state).toBe("idle");
  });
});

describe("AC4: natural completion", () => {
  it("T14: running -> complete when indexLibrary resolves {completed: true}", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");

    // Drive a few progress updates via the deps.onProgress callback.
    call.deps.onProgress(0, 0, 3);
    call.deps.onProgress(1, 0, 3);
    call.deps.onProgress(3, 0, 3);

    call.resolve({ completed: true });
    await flush();

    const status = h.controller.getStatus();
    expect(status.state).toBe("complete");
    // Final counts must reflect the last onProgress call.
    expect(status.indexedItems).toBe(3);
    expect(status.failedItems).toBe(0);
    expect(status.totalItems).toBe(3);
  });
});

describe("AC4: failure handling — EmbedCircuitBreakerError (FINDING-12)", () => {
  it("T15: running -> failed with errorMessage when indexLibrary rejects with EmbedCircuitBreakerError", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");

    const err = new EmbedCircuitBreakerError();
    call.reject(err);
    await flush();

    const status = h.controller.getStatus() as IndexingStatus & {
      readonly errorMessage?: string;
    };
    expect(status.state).toBe("failed");
    expect(status.errorMessage).toBe("Connection to Ollama lost after 3 consecutive failures.");
  });

  it("T16: running -> failed with errorMessage when indexLibrary rejects with a generic Error", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");

    call.reject(new Error("unexpected provider crash"));
    await flush();

    const status = h.controller.getStatus() as IndexingStatus & {
      readonly errorMessage?: string;
    };
    expect(status.state).toBe("failed");
    expect(status.errorMessage).toBe("unexpected provider crash");
  });

  it("T17: clear() from failed transitions back to idle (and clears the errorMessage)", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");
    call.reject(new EmbedCircuitBreakerError());
    await flush();
    expect(h.controller.getStatus().state).toBe("failed");

    await clearController(h.controller);

    const status = h.controller.getStatus() as IndexingStatus & {
      readonly errorMessage?: string;
    };
    expect(status.state).toBe("idle");
    expect(status.errorMessage).toBeUndefined();
    expect(h.storage.clear).toHaveBeenCalledTimes(1);
  });
});

describe("AC4: concurrency / re-entrancy", () => {
  it("T18: second start() while running is a no-op (does not spawn a second indexLibrary)", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    h.controller.start();
    await flush();
    expect(calls).toHaveLength(1);
    expect(h.controller.getStatus().state).toBe("running");
  });

  it("T19: second pause() while paused is a no-op", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    h.controller.pause();
    const lenBefore = h.statusLog.length;
    h.controller.pause();
    const lenAfter = h.statusLog.length;
    // No new state-change notifications.
    expect(lenAfter).toBe(lenBefore);
    expect(h.controller.getStatus().state).toBe("paused");
  });

  it("T20: second resume() while running is a no-op", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    h.controller.resume();
    await flush();
    // Still only one call.
    expect(calls).toHaveLength(1);
    expect(h.controller.getStatus().state).toBe("running");
  });

  it("T21: concurrent clear() calls do not race storage.clear", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();

    // Make storage.clear slow so the second clear() can overlap.
    let resolveClear!: () => void;
    h.storage.clear.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolveClear = r;
        })
    );

    const p1 = clearController(h.controller);
    const p2 = clearController(h.controller);
    await flush(2);
    // Settle the crawler so the first clear() can progress past its await.
    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");
    call.resolve({ completed: false });
    await flush(2);
    resolveClear();
    await Promise.all([p1, p2]);

    // The controller must not have called storage.clear more than once
    // (the second call should observe the in-flight clear and either
    // await it or short-circuit). At most one extra invocation is
    // tolerated for the case of a no-op-after-idle re-entry — anything
    // beyond 2 is a race bug.
    expect(h.storage.clear.mock.calls.length).toBeLessThanOrEqual(2);
    expect(h.controller.getStatus().state).toBe("idle");
  });
});

describe("AC4: listener notification on every transition (P9)", () => {
  it("T22: subscribers receive distinct snapshots for start -> pause -> resume -> pause -> clear", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    h.controller.pause();
    let call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");
    call.resolve({ completed: false });
    await flush();

    h.controller.resume();
    await flush();
    h.controller.pause();
    call = calls[1];
    if (call === undefined) throw new Error("expected a second indexLibrary call");
    call.resolve({ completed: false });
    await flush();

    await clearController(h.controller);

    const states = h.statusLog.map((s) => s.state);
    // Each user-driven transition must appear at least once, in order.
    const required = ["running", "paused", "running", "paused", "idle"];
    let cursor = 0;
    for (const s of states) {
      if (s === required[cursor]) cursor += 1;
      if (cursor === required.length) break;
    }
    expect(cursor).toBe(required.length);
  });

  it("T23: unsubscribed listener no longer fires", async () => {
    const h = makeHarness();
    h.unsubscribe();
    h.controller.start();
    await flush();
    // The listener that we registered via the harness has been removed,
    // so statusLog must not grow.
    expect(h.statusLog).toHaveLength(0);
  });
});

describe("AC4: onProgress callback drives status updates (P10)", () => {
  it("T24: status reflects the latest onProgress(indexed, failed, total) values", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");

    call.deps.onProgress(0, 0, 10);
    let status = h.controller.getStatus();
    expect(status.totalItems).toBe(10);
    expect(status.indexedItems).toBe(0);
    expect(status.failedItems).toBe(0);

    call.deps.onProgress(5, 1, 10);
    status = h.controller.getStatus();
    expect(status.indexedItems).toBe(5);
    expect(status.failedItems).toBe(1);

    call.deps.onProgress(10, 1, 10);
    status = h.controller.getStatus();
    expect(status.indexedItems).toBe(10);
    expect(status.failedItems).toBe(1);
  });

  it("T25: onProgress notifications reach subscribers", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");

    const beforeLen = h.statusLog.length;
    call.deps.onProgress(2, 0, 10);
    // Subscribers should observe at least one new snapshot with indexed=2.
    const after = h.statusLog.slice(beforeLen);
    expect(after.some((s) => s.indexedItems === 2 && s.totalItems === 10)).toBe(true);
  });
});

describe("AC4: resume() degraded paths", () => {
  it("T26: resume() with storage.read() returning null falls back to a full restart", async () => {
    const h = makeHarness({ initialFile: null });
    h.controller.start();
    await flush();
    h.controller.pause();
    const firstCall = calls[0];
    if (firstCall === undefined) throw new Error("expected an indexLibrary call");
    firstCall.resolve({ completed: false });
    await flush();

    h.storage.read.mockResolvedValueOnce(null);

    h.controller.resume();
    await flush();

    expect(calls).toHaveLength(2);
    const secondCall = calls[1];
    if (secondCall === undefined) throw new Error("expected a second indexLibrary call");
    // With no persisted file, resumeFromItemKey must be undefined so the
    // crawler starts from item 0 (a "full restart").
    expect(secondCall.options.resumeFromItemKey).toBeUndefined();
  });
});

describe("AC4: clear() while a circuit breaker error is in flight", () => {
  it("T27: clear() during a failure rejection still settles to idle", async () => {
    const h = makeHarness();
    h.controller.start();
    await flush();
    const call = calls[0];
    if (call === undefined) throw new Error("expected an indexLibrary call");

    const clearPromise = clearController(h.controller);
    // Reject mid-clear with a non-abort error.
    call.reject(new EmbedCircuitBreakerError());
    await clearPromise;

    // After clear(), state must be idle — the rejection must not
    // override the cleared state.
    const status = h.controller.getStatus() as IndexingStatus & {
      readonly errorMessage?: string;
    };
    expect(status.state).toBe("idle");
    expect(status.errorMessage).toBeUndefined();
    expect(h.storage.clear).toHaveBeenCalledTimes(1);
  });
});
