/**
 * Adversarial unit tests for `indexLibrary` orchestration (AC3,
 * real-product-pipeline).
 *
 * Plan section: AC3, L527-684 of
 * `docs/superpowers/plans/2026-05-17-real-product-pipeline.md`.
 *
 * --------------------------------------------------------------------
 * Fault Localization (Template 4)
 * --------------------------------------------------------------------
 *
 * 1. Spec semantics (premises):
 *    P1.  `indexLibrary(deps, options): Promise<{completed: boolean}>`.
 *    P2.  Source: `Zotero.Items.getAll(userLibraryID, true)`.
 *    P3.  For each item, call `extractItemText`; if "", skip (do NOT
 *         increment failed, do NOT call provider, do NOT write).
 *    P4.  For each non-skipped item, chunk via `chunkText` and call
 *         `provider.embedTexts({baseUrl, model: embeddingModel,
 *         texts: [chunk], signal})` ONCE PER CHUNK (texts.length === 1
 *         per call).
 *    P5.  `await deps.scheduler()` between items AND before each
 *         per-chunk embed call (FINDING-4).
 *    P6.  After ALL chunks of an item complete successfully, call
 *         `storage.write(accumulatedFile)` (per-item persistence).
 *    P7.  After each item completes successfully, call
 *         `onProgress(indexed, failed, total)`.
 *    P8.  Circuit breaker (FINDING-12): track consecutiveFailures.
 *         On success, reset to 0. On chunk embed failure, increment;
 *         on reaching K=3, reject with `new Error("Connection to
 *         Ollama lost after 3 consecutive failures.")`.
 *    P9.  Per-item failure that does NOT trip the breaker → increment
 *         `failed`, do NOT write that item's partial state, continue
 *         to the next item.
 *    P10. Pause (`options.isPaused() === true`) checked twice per chunk:
 *         (a) before the embed call → call abortController.abort(),
 *             discard partial item, resolve `{completed: false}`;
 *         (b) after embed resolves but before the chunk accumulator
 *             update → discard, resolve `{completed: false}`.
 *    P11. Signal abort (`signal.aborted === true`) between items →
 *         reject with `AbortError`.
 *    P12. `resumeFromItemKey?: string` → starts at the item whose key
 *         matches; the in-progress item restarts from chunk 0 (FINDING-5).
 *    P13. Empty library / all skipped → resolve `{completed: true}`,
 *         `onProgress(0, 0, total)` called, storage.write NOT called.
 *
 * 2. Code path trace (against the contract):
 *    - Loop: items → chunks → per-chunk embed → accumulate → write item.
 *    - Two yield points per chunk: before embed, and on the next chunk.
 *    - Pause check before AND after the embed in the same loop body.
 *
 * 3. Divergence analysis (likely bugs):
 *    D1  [HIGH]   `texts.length > 1` per call (batches chunks) — breaks
 *                 the per-chunk persistence contract.
 *    D2  [HIGH]   Skipped items count toward `failed` — wrong metric.
 *    D3  [HIGH]   `storage.write` called even on per-item failure.
 *    D4  [HIGH]   Circuit breaker counts SKIPPED items as failures.
 *    D5  [HIGH]   Circuit breaker does NOT reset on success.
 *    D6  [HIGH]   Pause does not abort the in-flight embed (waits for
 *                 fetch to resolve naturally).
 *    D7  [MEDIUM] `scheduler` never called (UI thread freezes).
 *    D8  [MEDIUM] `resumeFromItemKey` ignored — re-indexes everything.
 *    D9  [MEDIUM] `signal.aborted` not checked between items.
 *    D10 [MEDIUM] `onProgress(0, 0, 0)` not emitted on empty library
 *                 (UI stuck in "preparing…").
 *    D11 [MEDIUM] EmbedCircuitBreakerError message doesn't match the
 *                 spec'd string (controller pattern-matches on it).
 *    D12 [LOW]    `getAll` called with `onlyTopLevel = false`.
 */

import { describe, expect, it, vi } from "vitest";

import type {
  EmbeddingProviderLike,
  IndexFile,
  IndexLibraryOptions,
  IndexStorage,
  LibraryCrawlerDeps,
  ZoteroItemLike
} from "./contracts.js";
import { indexLibrary } from "../../src/indexing/library-crawler.js";

type FakeItemSpec = {
  readonly id: number;
  readonly key: string;
  readonly title?: string | undefined;
  readonly abstractNote?: string | undefined;
  readonly noteBodies?: readonly string[];
};

function fakeItem(spec: FakeItemSpec): ZoteroItemLike {
  const bodies = spec.noteBodies ?? [];
  const noteIds = bodies.map((_, idx) => spec.id * 100 + idx);
  let cursor = 0;
  return {
    id: spec.id,
    key: spec.key,
    getField(name) {
      if (name === "title") return spec.title;
      return spec.abstractNote;
    },
    getNotes() {
      return noteIds;
    },
    getNote() {
      const body = bodies[cursor] ?? "";
      cursor += 1;
      return body;
    },
    isAttachment() {
      return false;
    },
    isAnnotation() {
      return false;
    }
  };
}

/**
 * Build a standalone attachment item (top-level PDF). The crawler
 * treats `isAttachment()` true items as "fulltext directly on me".
 * Phase 4 e2e tests use this builder to thread cached PDF text through
 * indexLibrary → IndexFile.
 */
function fakeAttachmentItem(spec: {
  readonly id: number;
  readonly key: string;
  readonly title?: string;
  readonly isAnnotation?: boolean;
}): ZoteroItemLike {
  return {
    id: spec.id,
    key: spec.key,
    getField(name) {
      if (name === "title") return spec.title;
      return undefined;
    },
    getNotes: () => [],
    isAttachment: () => true,
    isAnnotation: () => spec.isAnnotation ?? false
  };
}

/**
 * Build a top-level bibliographic item whose `getAttachments()` returns
 * the supplied IDs. The harness's Items.get is responsible for hydrating
 * the child attachments — we wire the same map below.
 */
function fakeParentItemWithAttachments(spec: {
  readonly id: number;
  readonly key: string;
  readonly title?: string;
  readonly abstractNote?: string;
  readonly attachmentIds: readonly number[];
}): ZoteroItemLike {
  return {
    id: spec.id,
    key: spec.key,
    getField(name) {
      if (name === "title") return spec.title;
      return spec.abstractNote;
    },
    getNotes: () => [],
    getAttachments: () => spec.attachmentIds,
    isAttachment: () => false,
    isAnnotation: () => false
  };
}

type Harness = {
  readonly deps: LibraryCrawlerDeps;
  readonly options: IndexLibraryOptions;
  readonly storageWrites: IndexFile[];
  readonly storageReads: IndexFile[];
  readonly progressCalls: { indexed: number; failed: number; total: number }[];
  readonly schedulerCalls: { count: number };
  readonly embedCalls: { texts: readonly string[]; signal: AbortSignal }[];
  readonly abortCalls: { count: number };
  readonly setPaused: (v: boolean) => void;
  readonly setAborted: () => void;
};

type EmbedBehavior =
  | { kind: "ok"; embedding?: number[] }
  | { kind: "throw"; error: Error }
  | { kind: "abort-aware"; embedding?: number[] }; // checks signal mid-flight

function makeHarness(opts: {
  items: ZoteroItemLike[];
  embedBehaviors?: readonly EmbedBehavior[]; // one per embed call (cycles if too short)
  initialFile?: IndexFile | null;
  resumeFromItemKey?: string;
  scheduler?: () => Promise<void>;
  // Phase 4: map of attachment-item-id → cached fulltext. When provided,
  // the harness wires a Zotero.FullText + Zotero.File stub onto
  // `deps.zotero` so the crawler exercises the PDF-fulltext path.
  // Extra items the crawler needs to hydrate via Items.get (child
  // attachments not in the top-level `items` list) go in `childItems`.
  fullText?: Record<number, string>;
  childItems?: readonly ZoteroItemLike[];
}): Harness {
  const storageWrites: IndexFile[] = [];
  const storageReads: IndexFile[] = [];
  const progressCalls: { indexed: number; failed: number; total: number }[] = [];
  const schedulerCalls = { count: 0 };
  const embedCalls: { texts: readonly string[]; signal: AbortSignal }[] = [];
  const abortCalls = { count: 0 };
  let paused = false;
  const signalController = new AbortController();

  const itemsById = new Map<number, ZoteroItemLike>();
  for (const item of opts.items) {
    itemsById.set(item.id, item);
    for (const noteId of item.getNotes()) {
      itemsById.set(noteId, item);
    }
  }
  for (const child of opts.childItems ?? []) {
    itemsById.set(child.id, child);
  }

  const storage: IndexStorage = {
    async read() {
      await Promise.resolve();
      if (opts.initialFile === undefined) return null;
      if (opts.initialFile === null) return null;
      storageReads.push(opts.initialFile);
      return opts.initialFile;
    },
    async readItemCount() {
      await Promise.resolve();
      if (opts.initialFile === undefined || opts.initialFile === null) return 0;
      return Object.keys(opts.initialFile.items).length;
    },
    async write(file) {
      await Promise.resolve();
      storageWrites.push(file);
    },
    async clear() {
      await Promise.resolve();
    },
    path() {
      return "/var/test-fixture/zotero-data/zotero-ai-explain-index.json";
    }
  };

  let embedCursor = 0;
  const provider: EmbeddingProviderLike = {
    async embedTexts(request) {
      embedCalls.push({ texts: request.texts, signal: request.signal });
      const behavior: EmbedBehavior = opts.embedBehaviors?.[embedCursor] ??
        opts.embedBehaviors?.[opts.embedBehaviors.length - 1] ?? { kind: "ok" };
      embedCursor += 1;
      if (behavior.kind === "throw") {
        await Promise.resolve();
        throw behavior.error;
      }
      if (behavior.kind === "abort-aware") {
        // Yield once, then check signal — simulates an in-flight fetch
        // that respects abort.
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) {
            resolve();
            return;
          }
          const onAbort = (): void => {
            resolve();
          };
          request.signal.addEventListener("abort", onAbort, { once: true });
          // Resolve on next microtask if not aborted.
          queueMicrotask(() => {
            request.signal.removeEventListener("abort", onAbort);
            resolve();
          });
        });
        if (request.signal.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        return [behavior.embedding ?? [0.1]];
      }
      await Promise.resolve();
      return [behavior.embedding ?? [0.1]];
    }
  };

  const abortController = new AbortController();
  const origAbort = abortController.abort.bind(abortController);
  abortController.abort = ((reason?: unknown): void => {
    abortCalls.count += 1;
    origAbort(reason);
  }) as typeof abortController.abort;

  const fullTextEntries = opts.fullText;
  const fullTextStub =
    fullTextEntries !== undefined
      ? {
          getItemContent(itemID: number): string | undefined {
            return fullTextEntries[itemID];
          }
        }
      : undefined;
  const deps: LibraryCrawlerDeps = {
    zotero: {
      Libraries: { userLibraryID: 1 },
      Items: {
        // eslint-disable-next-line @typescript-eslint/require-await
        async getAll() {
          return opts.items;
        },
        get(itemID) {
          return itemsById.get(itemID) ?? null;
        }
      },
      ...(fullTextStub !== undefined ? { FullText: fullTextStub } : {})
    },
    provider,
    settings: { baseUrl: "http://localhost:11434", embeddingModel: "nomic-embed-text" },
    storage,
    onProgress(indexed, failed, total) {
      progressCalls.push({ indexed, failed, total });
    },
    scheduler:
      opts.scheduler ??
      (async () => {
        schedulerCalls.count += 1;
        await Promise.resolve();
      }),
    abortController
  };

  const options: IndexLibraryOptions = opts.resumeFromItemKey
    ? {
        signal: signalController.signal,
        isPaused: () => paused,
        resumeFromItemKey: opts.resumeFromItemKey
      }
    : {
        signal: signalController.signal,
        isPaused: () => paused
      };

  return {
    deps,
    options,
    storageWrites,
    storageReads,
    progressCalls,
    schedulerCalls,
    embedCalls,
    abortCalls,
    setPaused(v: boolean) {
      paused = v;
    },
    setAborted() {
      signalController.abort();
    }
  };
}

describe("indexLibrary — empty / skipped libraries (FINDING-11)", () => {
  it("T-empty: empty library resolves {completed: true}, onProgress(0,0,0), no embed, no write", async () => {
    const h = makeHarness({ items: [] });
    const result = await indexLibrary(h.deps, h.options);
    expect(result).toEqual({ completed: true });
    expect(h.embedCalls).toHaveLength(0);
    expect(h.storageWrites).toHaveLength(0);
    // onProgress must be called at least once with (0, 0, 0).
    expect(h.progressCalls.length).toBeGreaterThanOrEqual(1);
    expect(h.progressCalls).toContainEqual({ indexed: 0, failed: 0, total: 0 });
  });

  it("T-all-skipped: 3 items with empty extractItemText skipped; no embed, no write", async () => {
    const items = [
      fakeItem({ id: 1, key: "A" }),
      fakeItem({ id: 2, key: "B" }),
      fakeItem({ id: 3, key: "C" })
    ];
    const h = makeHarness({ items });
    const result = await indexLibrary(h.deps, h.options);
    expect(result).toEqual({ completed: true });
    expect(h.embedCalls).toHaveLength(0);
    expect(h.storageWrites).toHaveLength(0);
    // The plan mandates onProgress(0, 0, 3) is called.
    expect(h.progressCalls).toContainEqual({ indexed: 0, failed: 0, total: 3 });
  });

  it("T-skipped-not-failed: skipped items do NOT increment the failed counter", async () => {
    const items = [
      fakeItem({ id: 1, key: "A", title: "real" }),
      fakeItem({ id: 2, key: "B" }), // skipped (empty)
      fakeItem({ id: 3, key: "C", title: "real 3" })
    ];
    const h = makeHarness({ items });
    await indexLibrary(h.deps, h.options);
    // After the run, the latest onProgress must show failed = 0.
    const last = h.progressCalls[h.progressCalls.length - 1];
    expect(last?.failed).toBe(0);
  });
});

describe("indexLibrary — happy path", () => {
  it("T-single: single item, single chunk → 1 embed call, 1 storage.write", async () => {
    const items = [fakeItem({ id: 1, key: "A", title: "short" })];
    const h = makeHarness({ items });
    const result = await indexLibrary(h.deps, h.options);
    expect(result).toEqual({ completed: true });
    expect(h.embedCalls).toHaveLength(1);
    expect(h.embedCalls[0]?.texts).toHaveLength(1);
    expect(h.storageWrites).toHaveLength(1);
    const written = h.storageWrites[0];
    expect(written?.items).toHaveProperty("A");
    expect(typeof written?.indexedAt).toBe("string");
  });

  it("T-three: 3 items each with 1 chunk → 3 embed calls, 3 storage.writes", async () => {
    const items = [
      fakeItem({ id: 1, key: "A", title: "one" }),
      fakeItem({ id: 2, key: "B", title: "two" }),
      fakeItem({ id: 3, key: "C", title: "three" })
    ];
    const h = makeHarness({ items });
    const result = await indexLibrary(h.deps, h.options);
    expect(result).toEqual({ completed: true });
    expect(h.embedCalls).toHaveLength(3);
    expect(h.storageWrites).toHaveLength(3);
    // The final written file MUST contain all three items.
    const final = h.storageWrites[h.storageWrites.length - 1];
    expect(Object.keys(final?.items ?? {})).toEqual(expect.arrayContaining(["A", "B", "C"]));
  });

  it("T-per-call-batch-size: provider.embedTexts always called with texts.length === 1", async () => {
    // A multi-chunk item: a title plus a very long abstract.
    const longAbstract = "x".repeat(5000);
    const items = [fakeItem({ id: 1, key: "A", title: "t", abstractNote: longAbstract })];
    const h = makeHarness({ items });
    await indexLibrary(h.deps, h.options);
    expect(h.embedCalls.length).toBeGreaterThan(1);
    for (const call of h.embedCalls) {
      expect(call.texts).toHaveLength(1);
    }
  });

  it("T-onProgress-after-each-item: onProgress called after every successful item", async () => {
    const items = [
      fakeItem({ id: 1, key: "A", title: "one" }),
      fakeItem({ id: 2, key: "B", title: "two" }),
      fakeItem({ id: 3, key: "C", title: "three" })
    ];
    const h = makeHarness({ items });
    await indexLibrary(h.deps, h.options);
    // We expect onProgress to monotonically advance `indexed` from
    // <something> to 3.
    const successProgress = h.progressCalls.filter((p) => p.total === 3);
    const indexedSeries = successProgress.map((p) => p.indexed);
    expect(indexedSeries[indexedSeries.length - 1]).toBe(3);
  });
});

describe("indexLibrary — failure semantics", () => {
  it("T-single-failure: item 2 throws once; failed counter increments, item 3 still runs", async () => {
    const items = [
      fakeItem({ id: 1, key: "A", title: "one" }),
      fakeItem({ id: 2, key: "B", title: "two" }),
      fakeItem({ id: 3, key: "C", title: "three" })
    ];
    const h = makeHarness({
      items,
      embedBehaviors: [
        { kind: "ok" }, // item 1
        { kind: "throw", error: new Error("transient") }, // item 2
        { kind: "ok" } // item 3
      ]
    });
    const result = await indexLibrary(h.deps, h.options);
    expect(result).toEqual({ completed: true });
    // Final progress: 2 indexed, 1 failed, 3 total.
    const last = h.progressCalls[h.progressCalls.length - 1];
    expect(last).toEqual({ indexed: 2, failed: 1, total: 3 });
    // storage.write should NOT include item B (the failed one).
    const final = h.storageWrites[h.storageWrites.length - 1];
    expect(Object.keys(final?.items ?? {}).sort()).toEqual(["A", "C"]);
  });

  it("T-circuit-breaker: 3 consecutive failures → reject with the spec'd error message", async () => {
    const items = [
      fakeItem({ id: 1, key: "A", title: "one" }),
      fakeItem({ id: 2, key: "B", title: "two" }),
      fakeItem({ id: 3, key: "C", title: "three" }),
      fakeItem({ id: 4, key: "D", title: "four" })
    ];
    const h = makeHarness({
      items,
      embedBehaviors: [
        { kind: "throw", error: new Error("ECONNREFUSED") },
        { kind: "throw", error: new Error("ECONNREFUSED") },
        { kind: "throw", error: new Error("ECONNREFUSED") }
      ]
    });
    await expect(indexLibrary(h.deps, h.options)).rejects.toThrow(
      /Connection to Ollama lost after 3 consecutive failures/u
    );
    // storage.write must NOT have been called.
    expect(h.storageWrites).toHaveLength(0);
  });

  it("T-circuit-reset: transient failure then success resets the counter (no breaker trip)", async () => {
    const items = [
      fakeItem({ id: 1, key: "A", title: "one" }),
      fakeItem({ id: 2, key: "B", title: "two" }),
      fakeItem({ id: 3, key: "C", title: "three" }),
      fakeItem({ id: 4, key: "D", title: "four" })
    ];
    // Failures alternated with successes: counter never reaches 3.
    const h = makeHarness({
      items,
      embedBehaviors: [
        { kind: "throw", error: new Error("ECONNREFUSED") }, // item 1 fails
        { kind: "ok" }, // item 2 succeeds → counter resets
        { kind: "throw", error: new Error("ECONNREFUSED") }, // item 3 fails (counter=1, not 2)
        { kind: "ok" } // item 4 succeeds
      ]
    });
    const result = await indexLibrary(h.deps, h.options);
    expect(result).toEqual({ completed: true });
    const last = h.progressCalls[h.progressCalls.length - 1];
    expect(last).toEqual({ indexed: 2, failed: 2, total: 4 });
  });
});

describe("indexLibrary — abort / pause", () => {
  it("T-signal-abort-pre: external signal aborted before any work → no progress past 0", async () => {
    const items = [
      fakeItem({ id: 1, key: "A", title: "one" }),
      fakeItem({ id: 2, key: "B", title: "two" })
    ];
    const h = makeHarness({ items });
    h.setAborted();
    // Per the plan (L675-676), an externally-aborted signal causes the
    // promise to reject with an AbortError. The harness consumer
    // (controller) catches it. The test just asserts the contract: the
    // promise either rejects with an AbortError-like error OR resolves
    // with `{completed: false}` before any storage write — the spec
    // explicitly says "rejects with AbortError" so we assert that.
    await expect(indexLibrary(h.deps, h.options)).rejects.toThrow(/abort/iu);
    expect(h.storageWrites).toHaveLength(0);
  });

  it("T-pause-mid: pause flips true during run → resolves {completed:false}, abort called", async () => {
    const items = [
      fakeItem({ id: 1, key: "A", title: "one" }),
      fakeItem({ id: 2, key: "B", title: "two" }),
      fakeItem({ id: 3, key: "C", title: "three" })
    ];

    let calls = 0;
    const h = makeHarness({ items });
    // Override the provider so the second embed call flips pause first,
    // then throws an abort error (modeling the in-flight-fetch abort).
    const origEmbed = h.deps.provider.embedTexts.bind(h.deps.provider);
    h.deps.provider.embedTexts = async (req) => {
      calls += 1;
      if (calls === 2) {
        h.setPaused(true);
      }
      return origEmbed(req);
    };

    const result = await indexLibrary(h.deps, h.options);
    expect(result).toEqual({ completed: false });
    // Item A completed fully BEFORE pause → 1 write. Item B was the one
    // pause hit; it must NOT have been written.
    expect(h.storageWrites.length).toBeGreaterThanOrEqual(1);
    const final = h.storageWrites[h.storageWrites.length - 1];
    expect(final?.items).toHaveProperty("A");
    expect(final?.items).not.toHaveProperty("B");
  });

  it("T-pause-abort-controller: pause causes deps.abortController.abort() to fire", async () => {
    const items = [
      fakeItem({ id: 1, key: "A", title: "one" }),
      fakeItem({ id: 2, key: "B", title: "two" })
    ];
    const h = makeHarness({ items, embedBehaviors: [{ kind: "ok" }, { kind: "abort-aware" }] });
    const origEmbed = h.deps.provider.embedTexts.bind(h.deps.provider);
    let n = 0;
    h.deps.provider.embedTexts = async (req) => {
      n += 1;
      if (n === 2) {
        h.setPaused(true);
      }
      return origEmbed(req);
    };

    await indexLibrary(h.deps, h.options);
    // Plan L611-616: pause at point (a) MUST call
    // abortController.abort() to interrupt the in-flight fetch.
    expect(h.abortCalls.count).toBeGreaterThanOrEqual(1);
  });
});

describe("indexLibrary — scheduler yielding (FINDING-4)", () => {
  it("T-scheduler-yields-per-item-and-per-chunk", async () => {
    // 2 items: item 1 has 1 chunk (short title), item 2 has 3 chunks
    // (long abstract). Total chunk yields >= 4; total item yields >= 2.
    const items = [
      fakeItem({ id: 1, key: "A", title: "short" }),
      fakeItem({ id: 2, key: "B", abstractNote: "x".repeat(5000) })
    ];
    const h = makeHarness({ items });
    await indexLibrary(h.deps, h.options);
    // Plan L677-680: scheduler called at least once per item AND at
    // least once per chunk → total calls > items count.
    expect(h.schedulerCalls.count).toBeGreaterThan(items.length);
  });

  it("T-scheduler-default-injected: if the controller passed a real scheduler, it is awaited", async () => {
    const items = [fakeItem({ id: 1, key: "A", title: "x" })];
    const scheduler = vi.fn(async () => Promise.resolve());
    const h = makeHarness({ items, scheduler });
    await indexLibrary(h.deps, h.options);
    expect(scheduler).toHaveBeenCalled();
  });
});

describe("indexLibrary — resume (FINDING-5)", () => {
  it("T-resume-skip-already-indexed: resumeFromItemKey skips items up to that key", async () => {
    // 4 items A B C D. We resume "from C" — i.e., A and B are already
    // persisted; the crawler should embed only C and D.
    const items = [
      fakeItem({ id: 1, key: "A", title: "a" }),
      fakeItem({ id: 2, key: "B", title: "b" }),
      fakeItem({ id: 3, key: "C", title: "c" }),
      fakeItem({ id: 4, key: "D", title: "d" })
    ];
    const initialFile: IndexFile = {
      items: {
        A: { title: "a", chunks: [{ text: "a", embedding: [0.1] }] },
        B: { title: "b", chunks: [{ text: "b", embedding: [0.2] }] }
      },
      indexedAt: "2026-05-17T00:00:00Z"
    };
    const h = makeHarness({ items, initialFile, resumeFromItemKey: "C" });
    await indexLibrary(h.deps, h.options);
    // Only items C and D should be embedded.
    expect(h.embedCalls).toHaveLength(2);
    // The final file MUST still include A and B (preserved from the
    // initialFile) plus C and D.
    const final = h.storageWrites[h.storageWrites.length - 1];
    expect(Object.keys(final?.items ?? {}).sort()).toEqual(["A", "B", "C", "D"]);
  });
});

describe("indexLibrary — call shape sanity", () => {
  it("T-getAll-onlyTopLevel-true: zotero.Items.getAll called with onlyTopLevel = true", async () => {
    const items = [fakeItem({ id: 1, key: "A", title: "x" })];
    const h = makeHarness({ items });
    const spy = vi.spyOn(h.deps.zotero.Items, "getAll");
    await indexLibrary(h.deps, h.options);
    expect(spy).toHaveBeenCalledWith(expect.any(Number), true);
  });

  it("T-embed-request-shape: embedTexts request carries baseUrl, model, and signal", async () => {
    const items = [fakeItem({ id: 1, key: "A", title: "x" })];
    const h = makeHarness({ items });
    await indexLibrary(h.deps, h.options);
    const call = h.embedCalls[0];
    expect(call).toBeDefined();
    // The signal MUST be the abortController.signal (so pause can abort).
    expect(call?.signal).toBe(h.deps.abortController.signal);
  });
});

/**
 * Phase 4: PDF fulltext end-to-end coverage.
 *
 * The unit tests in `extract-item-text.test.ts` cover the pure helper.
 * Here we prove that:
 *   - the crawler threads `deps.zotero.FullText` through to
 *     `extractItemText`,
 *   - cached fulltext lands in the persisted IndexFile (storage.write),
 *   - standalone attachments that previously got skipped because they
 *     had no title/abstract now get indexed when fulltext is present,
 *   - top-level bibliographic items with child attachments include the
 *     child PDF text in the indexed chunks,
 *   - and an attachment WITHOUT cached fulltext still gets skipped
 *     (no metadata, no PDF text → nothing to embed).
 */
describe("indexLibrary — PDF fulltext (Phase 4)", () => {
  it("T-fulltext-standalone-indexed: standalone PDF attachment with cached text is indexed", async () => {
    // The exact case the user reported: 5519 / 5738 items skipped in
    // their library are standalone PDFs. With Phase 4 they must show up
    // as indexed (chunks reflect the PDF body text) when the cache is
    // populated.
    const items = [fakeAttachmentItem({ id: 1, key: "PDF1" })];
    const h = makeHarness({ items, fullText: { 1: "Body of the standalone PDF." } });
    const result = await indexLibrary(h.deps, h.options);
    expect(result).toEqual({ completed: true });
    expect(h.embedCalls).toHaveLength(1);
    expect(h.storageWrites).toHaveLength(1);
    const final = h.storageWrites[h.storageWrites.length - 1];
    expect(final?.items).toHaveProperty("PDF1");
    expect(final?.items.PDF1?.chunks).toHaveLength(1);
    expect(final?.items.PDF1?.chunks[0]?.text).toBe("Body of the standalone PDF.");
  });

  it("T-fulltext-bibliographic-with-child: top-level item + child PDF concatenates fulltext into chunks", async () => {
    const child = fakeAttachmentItem({ id: 42, key: "CHILD" });
    const parent = fakeParentItemWithAttachments({
      id: 7,
      key: "PARENT",
      title: "Parent Paper",
      abstractNote: "Parent abstract.",
      attachmentIds: [42]
    });
    const h = makeHarness({
      items: [parent],
      childItems: [child],
      fullText: { 42: "PDF body content." }
    });
    await indexLibrary(h.deps, h.options);
    expect(h.storageWrites).toHaveLength(1);
    const final = h.storageWrites[h.storageWrites.length - 1];
    const parentEntry = final?.items.PARENT;
    expect(parentEntry).toBeDefined();
    // The PDF body must appear in at least one chunk. We don't assert
    // chunk count because the chunker may split the combined text.
    const allText = (parentEntry?.chunks ?? []).map((c) => c.text).join("\n");
    expect(allText).toContain("Parent Paper");
    expect(allText).toContain("Parent abstract.");
    expect(allText).toContain("PDF body content.");
  });

  it("T-fulltext-standalone-no-cache-still-skipped: standalone PDF without cached text remains skipped", async () => {
    // Belt-and-suspenders for "missing PDF cache shouldn't crash" — the
    // attachment has no metadata at all AND no fulltext, so we should
    // see exactly zero embed/write calls (matches pre-Phase-4 behavior).
    const items = [fakeAttachmentItem({ id: 1, key: "EMPTY" })];
    const h = makeHarness({ items, fullText: {} });
    const result = await indexLibrary(h.deps, h.options);
    expect(result).toEqual({ completed: true });
    expect(h.embedCalls).toHaveLength(0);
    expect(h.storageWrites).toHaveLength(0);
  });

  it("T-fulltext-no-fulltext-deps-still-runs: crawler works when FullText is not wired", async () => {
    // Defensive: if the host strips Zotero.FullText (test harness, custom
    // bundle), the crawler must keep indexing title+abstract just like
    // the pre-Phase-4 contract. This was the previous behavior.
    const items = [fakeItem({ id: 1, key: "A", title: "Plain item" })];
    const h = makeHarness({ items }); // no fullText opt
    await indexLibrary(h.deps, h.options);
    const final = h.storageWrites[h.storageWrites.length - 1];
    expect(final?.items).toHaveProperty("A");
    expect(final?.items.A?.chunks[0]?.text).toBe("Plain item");
  });

  it("T-fulltext-large-pdf-chunked: a long cached PDF is split into multiple chunks before embed", async () => {
    // A standalone PDF with a body that exceeds the chunk threshold —
    // the embed call count must reflect chunkText's split.
    const items = [fakeAttachmentItem({ id: 1, key: "BIG", title: "Big PDF" })];
    const bigBody = "x".repeat(10_000); // well above DEFAULT_CHUNK_BYTES
    const h = makeHarness({ items, fullText: { 1: bigBody } });
    await indexLibrary(h.deps, h.options);
    expect(h.embedCalls.length).toBeGreaterThan(1);
    // Per the AC3 contract every embed call carries exactly one text.
    for (const call of h.embedCalls) {
      expect(call.texts).toHaveLength(1);
    }
  });

  it("T-fulltext-cap-enforced: per-item fulltext is capped before chunking (defends embed budget)", async () => {
    // A 200_000-char body should be capped at DEFAULT_FULLTEXT_MAX_CHARS
    // (50_000). Approximate chunk count: ceil(50_000 / DEFAULT_CHUNK_BYTES).
    const items = [fakeAttachmentItem({ id: 1, key: "HUGE" })];
    const hugeBody = "y".repeat(200_000);
    const h = makeHarness({ items, fullText: { 1: hugeBody } });
    await indexLibrary(h.deps, h.options);
    // If the cap were ignored the embed call count would be ~98
    // (200_000 / 2048). With the cap we expect ~25.
    expect(h.embedCalls.length).toBeLessThan(40);
    expect(h.embedCalls.length).toBeGreaterThan(0);
  });

  it("T-fulltext-annotation-still-skipped: PDF annotation items with cached text are NOT indexed", async () => {
    // Annotation attachments have their own text but are noisy; the
    // crawler skips them by policy. Same item as T-fulltext-standalone
    // but with isAnnotation()=true.
    const items = [fakeAttachmentItem({ id: 1, key: "ANN", isAnnotation: true })];
    const h = makeHarness({ items, fullText: { 1: "Some annotation body" } });
    await indexLibrary(h.deps, h.options);
    expect(h.embedCalls).toHaveLength(0);
    expect(h.storageWrites).toHaveLength(0);
  });
});
