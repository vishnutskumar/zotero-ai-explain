/**
 * IndexingController — orchestrates the library crawler.
 *
 * Plan reference: `docs/superpowers/plans/2026-05-17-real-product-pipeline.md`
 * AC4 (L685-792) and Interfaces (L1035-1054).
 *
 * State machine (FINDING-6):
 *
 * ```
 * idle ──start()──► running ──complete──► complete
 *                   │                      │
 *                   ├─pause()──► paused    │
 *                   │             │        │
 *                   │             └─resume─┘ (returns to running)
 *                   │             │
 *                   ├─clear()──► idle
 *                   │             ▲
 *                   ├─circuit-breaker──► failed ──clear()──┘
 *                   │
 *                   └─run completes──► complete
 * ```
 *
 * `clear()` ordering by source state (FINDING-6):
 *
 *   - running:  (1) abortController.abort()
 *               (2) await activeRun  (catch + swallow AbortError)
 *               (3) storage.clear()
 *               (4) emit `cleared`
 *   - paused:   skip (1) and (2) — activeRun has already resolved
 *               `{completed: false}`; (3) storage.clear() + (4) cleared.
 *   - complete / failed / idle: no active run — (3) storage.clear() +
 *               (4) cleared.
 *
 * `pause()` does NOT call `abortController.abort()` itself; the
 * crawler's per-chunk pause check (AC3) aborts the in-flight embed and
 * resolves `{completed: false}`. The controller's only job in `pause()`
 * is to flip an internal flag observable to the crawler via
 * `options.isPaused()` and to emit the `paused` reducer action so the
 * UI reflects user intent immediately.
 */

import {
  CURRENT_SCHEMA_VERSION,
  EmbedCircuitBreakerError,
  indexLibrary
} from "./library-crawler.js";
import type { IndexFile, IndexLibraryOptions, LibraryCrawlerDeps } from "./library-crawler.js";
import type { IndexStorage } from "./index-storage.js";
import {
  createInitialIndexingStatus,
  reduceIndexingStatus,
  type IndexingAction,
  type IndexingStatus
} from "./indexing-status.js";

export type IndexingStatusListener = (status: IndexingStatus) => void;

export type IndexingController = {
  readonly getStatus: () => IndexingStatus;
  readonly subscribe: (listener: IndexingStatusListener) => () => void;
  readonly start: () => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly clear: () => Promise<void>;
  /**
   * Read the persisted IndexFile and seed `previouslyIndexed` so the
   * settings UI shows "X already indexed" before the user clicks Index.
   * No-op when there is no persisted file, when the file is empty, or
   * when the indexer is not idle (a live run owns the counters). Safe
   * to invoke multiple times — repeated calls produce no extra IO once
   * the status has been hydrated against a current file.
   *
   * Hydrate is the SOLE caller of `storage.readWithMigration()`: when a
   * one-time index migration is pending it runs `runMigration()` first
   * (or, for the C5 crash case where the rename already completed,
   * clears the stale marker directly).
   */
  readonly hydrate: () => Promise<void>;
  /**
   * Run the one-time atomic index migration: ensure the sidecar marker
   * exists, clear any stale `.tmp` from a previous crash, crawl the
   * library into `<index>.tmp` producing `schemaVersion`-2 chunks, then
   * atomically commit the `.tmp` over the primary. A crash at any point
   * leaves the marker in place so the next launch resumes.
   */
  readonly runMigration: () => Promise<void>;
};

type Logger = {
  readonly debug: (message: string) => void;
};

/**
 * Default scheduler — yields one macrotask between work units so the UI
 * thread is not blocked by a long library scan (FINDING-4). Injectable
 * via deps for deterministic tests.
 */
function defaultScheduler(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Treat an unknown thrown value as an AbortError. The crawler may reject
 * with the DOMException AbortError, a plain Error whose `.name` is
 * "AbortError", or resolve `{completed: false}` instead — every branch
 * is part of the "abort caused this" set.
 */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  if (typeof err === "object" && err !== null && "name" in err) {
    const { name } = err;
    if (name === "AbortError") return true;
  }
  return false;
}

/**
 * Pull a sensible `resumeFromItemKey` out of a persisted IndexFile. The
 * crawler uses it as a `findIndex` cursor against the live library, so
 * any key in the persisted file's items map will land the crawler at
 * an already-indexed item — the crawler then skips it via the
 * "already-present" guard and progresses to the next one.
 *
 * Choice (documented in the implementer record): we pick the LAST key
 * by insertion order from `Object.keys(file.items)`. Crawl order is
 * stable (the AC3 contract uses `Zotero.Items.getAll(libraryID, true)`
 * which returns items in deterministic order), so the last persisted
 * key approximates "where we got to" without storing a separate cursor.
 */
function pickResumeKey(file: IndexFile | null): string | undefined {
  if (file === null) return undefined;
  const keys = Object.keys(file.items);
  if (keys.length === 0) return undefined;
  return keys[keys.length - 1];
}

/**
 * Manages the indexing lifecycle by composing the AC3 crawler. The
 * controller owns at most one in-flight indexLibrary task and one
 * AbortController per active run.
 */
export function createIndexingController(deps: {
  readonly initialStatus?: IndexingStatus;
  readonly logger: Logger;
  readonly zotero: LibraryCrawlerDeps["zotero"];
  readonly provider: LibraryCrawlerDeps["provider"];
  readonly settings: LibraryCrawlerDeps["settings"];
  readonly storage: IndexStorage;
  readonly scheduler?: () => Promise<void>;
}): IndexingController {
  let status: IndexingStatus = deps.initialStatus ?? createInitialIndexingStatus();
  const listeners = new Set<IndexingStatusListener>();
  const scheduler = deps.scheduler ?? defaultScheduler;

  // The in-flight crawler task and its abort controller. Exactly one
  // pair is active at a time; both nullable so we can tell whether
  // `pause()` / `clear()` need to await something.
  let activeRun: Promise<{ readonly completed: boolean }> | null = null;
  let abortController: AbortController | null = null;
  // Pause flag observable to the crawler via `options.isPaused()`.
  let pausedFlag = false;
  // Clear is serialized so concurrent clear() calls do not race
  // `storage.clear()`.
  let activeClear: Promise<void> | null = null;
  // The in-flight migration crawl (AC-5). While non-null a `start()`
  // call is deferred — the migration owns the index and a concurrent
  // crawl writing the primary would race the atomic `.tmp` swap.
  let activeMigration: Promise<void> | null = null;
  // FINDING-4: the abort controller for the active migration crawl, so
  // `clear()` can interrupt a long migration rather than blocking on it.
  let migrationAbortController: AbortController | null = null;
  // FINDING-4: set by `clear()` when it runs while a migration is in
  // flight. The migration checks it immediately before `commitMigration`
  // and skips the atomic swap — a commit after a clear would rename a
  // stale `.tmp` over the (just-cleared) primary, silently undoing the
  // clear. `clear()` still awaits the migration AND removes all four
  // index artefacts afterwards, so this flag is the fast-path belt to
  // the await-then-clear suspenders. Held in a mutable record (not a
  // bare `let`) so the migration's reads survive across `await` points:
  // `clear()` mutates it from a separate closure, which TS's flow
  // narrowing of a captured `let` cannot see.
  const migration: { cancelled: boolean } = { cancelled: false };

  const apply = (action: IndexingAction, label: string): void => {
    status = reduceIndexingStatus(status, action);
    deps.logger.debug(
      `Zotero AI Explain index:${label} -> state=${status.state} indexed=${String(status.indexedItems)}/${String(status.totalItems)} failed=${String(status.failedItems)}`
    );
    for (const listener of listeners) {
      listener(status);
    }
  };

  /**
   * Build the crawler deps for one run. The progress callback bridges
   * the crawler's `(indexed, failed, total)` triple to a reducer action
   * so listeners observe live counts.
   */
  const makeCrawlerDeps = (controller: AbortController): LibraryCrawlerDeps => {
    return {
      zotero: deps.zotero,
      provider: deps.provider,
      settings: deps.settings,
      storage: deps.storage,
      onRunStart: (info) => {
        // Push the run metadata into the reducer once per run so the
        // UI gets `previouslyIndexed` + total from the crawler's
        // canonical view (after it reads storage). Uses `run-info`
        // (not `started`) so an in-flight pause/resume doesn't clobber
        // the accumulating progress counters.
        apply(
          {
            type: "run-info",
            totalItems: info.total,
            previouslyIndexed: info.previouslyIndexed
          },
          "run-info"
        );
      },
      onProgress: (indexed, failed, total, skippedNoText) => {
        apply(
          {
            type: "progress",
            indexedItems: indexed,
            failedItems: failed,
            totalItems: total,
            ...(skippedNoText !== undefined ? { skippedNoText } : {})
          },
          "progress"
        );
      },
      scheduler,
      abortController: controller
    };
  };

  /**
   * Spawn `indexLibrary` and wire its settle handler. Captures
   * `runController` / `runPromise` in the closure so a later `clear()`
   * or `pause()` can await this specific run (not a later one).
   */
  const spawnRun = (resumeFromItemKey: string | undefined): void => {
    const controller = new AbortController();
    abortController = controller;
    const crawlerDeps = makeCrawlerDeps(controller);
    const options: IndexLibraryOptions = {
      signal: controller.signal,
      isPaused: () => pausedFlag,
      ...(resumeFromItemKey !== undefined ? { resumeFromItemKey } : {})
    };
    const runPromise = indexLibrary(crawlerDeps, options);
    activeRun = runPromise;
    runPromise.then(
      (result) => {
        // Only react if this run is still the active one (a `clear()`
        // or a later spawn could have replaced it).
        if (activeRun !== runPromise) return;
        activeRun = null;
        abortController = null;
        if (result.completed) {
          apply({ type: "completed" }, "complete");
        }
        // {completed: false} means we paused — pause() already emitted
        // the `paused` reducer action, so no further transition.
      },
      (err: unknown) => {
        if (activeRun !== runPromise) return;
        activeRun = null;
        abortController = null;
        if (isAbortError(err)) {
          // The clear() / pause() path drove this; the active state
          // transition has already happened (or is in progress on the
          // clear() promise). Nothing to do here.
          return;
        }
        const message =
          err instanceof EmbedCircuitBreakerError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        apply({ type: "failed", errorMessage: message }, "failed");
      }
    );
  };

  /**
   * Whether `clear()` cancelled the in-flight migration. Read through a
   * function (not the bare `migration.cancelled` property) so TS does not
   * narrow it to a constant: `clear()` mutates the flag from a separate
   * closure across an `await` boundary, which the type system's
   * flow-narrowing cannot model.
   */
  const isMigrationCancelled = (): boolean => migration.cancelled;

  /**
   * Run the one-time atomic index migration (AC-5). A fan-in guard
   * makes concurrent calls share the in-flight promise.
   */
  const runMigrationImpl = (): Promise<void> => {
    if (activeMigration !== null) {
      return activeMigration;
    }
    // FINDING-4: reset the cancel flag for this fresh migration. A prior
    // migration may have been cancelled by a `clear()`; the flag must not
    // leak into a later legitimate migration.
    migration.cancelled = false;
    const doMigration = async (): Promise<void> => {
      try {
        // (1) Ensure the sidecar marker exists (idempotent — covers the
        //     C1/C2 crash cases). (2) Clear any stale `.tmp` left by a
        //     previous crashed migration (C3/C4).
        await deps.storage.writeMarker();
        await deps.storage.abandonMigration();

        // Seed an empty schemaVersion-2 `.tmp`. A library with no
        // indexable items would otherwise leave no `.tmp` for
        // `commitMigration` to rename; this guarantees the atomic swap
        // always has a complete file to commit. The crawl's own
        // `writeTmp` calls overwrite it as items are indexed.
        await deps.storage.writeTmp({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          items: {},
          indexedAt: new Date().toISOString()
        });

        // FINDING-4: a `clear()` issued before the crawl even started
        // already flagged cancellation. Bail before doing any embed work.
        if (isMigrationCancelled()) {
          deps.logger.debug("Zotero AI Explain index:migration-cancelled pre-crawl");
          return;
        }
        // (3) Crawl the library into `<index>.tmp`. The crawler's
        //     `storage.read()` returns null here so it produces a full
        //     fresh set of schemaVersion-2 chunks (no resume skip
        //     against the legacy primary), and every `write()` lands in
        //     the `.tmp` via `writeTmp` — the primary is never mutated
        //     in place. The controller is stored on `migrationAbortController`
        //     so a concurrent `clear()` can interrupt the crawl.
        const controller = new AbortController();
        migrationAbortController = controller;
        // AC-23: the migration writes to the legacy single-file `.tmp`
        // so `commitMigration` can atomic-rename it over the primary.
        // The crawler now persists per-item via `writeItem`; the
        // migration adapter accumulates each item in-memory and
        // rewrites the `.tmp` so the final commit captures the full
        // crawl. (Migration crawls are infrequent — once per upgrade —
        // so the rewrite cost is acceptable, unlike the production hot
        // loop the AC-23 directory layout fixes.)
        const migrationAccumulator: IndexFile = {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          items: {},
          indexedAt: new Date().toISOString()
        };
        const migrationStorage: LibraryCrawlerDeps["storage"] = {
          read: () => Promise.resolve(null),
          write: (file) => deps.storage.writeTmp(file),
          async writeItem(itemKey, entry) {
            migrationAccumulator.items[itemKey] = entry;
            (migrationAccumulator as { indexedAt: string }).indexedAt = new Date().toISOString();
            await deps.storage.writeTmp(migrationAccumulator);
          },
          clear: () => Promise.resolve(),
          path: () => deps.storage.path()
        };
        const crawlerDeps: LibraryCrawlerDeps = {
          ...makeCrawlerDeps(controller),
          storage: migrationStorage
        };
        const options: IndexLibraryOptions = {
          signal: controller.signal,
          isPaused: () => false
        };
        deps.logger.debug("Zotero AI Explain index:migration-start");
        const result = await indexLibrary(crawlerDeps, options);
        if (!result.completed) {
          // A non-completed crawl leaves the marker + `.tmp` in place so
          // the next launch retries. Do NOT commit a partial swap.
          deps.logger.debug("Zotero AI Explain index:migration-incomplete");
          return;
        }
        // FINDING-4: a `clear()` issued during the crawl flagged
        // cancellation. Skip the atomic commit — renaming `.tmp` over the
        // primary would silently undo the user's clear. `clear()` itself
        // removes the `.tmp` + marker after it awaits this migration.
        if (isMigrationCancelled()) {
          deps.logger.debug("Zotero AI Explain index:migration-cancelled skip-commit");
          return;
        }
        // (4) Atomic commit: rename `.tmp` over the primary, remove the
        //     marker. After this `readWithMigration` reports
        //     `migrationPending: false`.
        await deps.storage.commitMigration();
        deps.logger.debug("Zotero AI Explain index:migration-complete");
      } catch (err) {
        // Failure leaves the marker in place; the stale `.tmp` is
        // cleaned by `abandonMigration` on the next runMigration call.
        deps.logger.debug(
          `Zotero AI Explain index:migration-error ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      } finally {
        activeMigration = null;
        migrationAbortController = null;
        // AC-14: project the migration's settled state onto the public
        // status. Read-only — touches only `migrationActive`.
        apply({ type: "migration-settled" }, "migration-settled");
      }
    };
    activeMigration = doMigration();
    // AC-14: project the migration's in-flight state onto the public
    // status so the settings UI can disable "Index library" and explain
    // why. Emitted right after `activeMigration` is assigned. Read-only —
    // touches only `migrationActive`, no run-lifecycle field.
    apply({ type: "migration-started" }, "migration-start");
    return activeMigration;
  };

  return {
    getStatus() {
      return status;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      // Silent no-op while a run is in flight so a stray click cannot
      // spawn a second crawler (storage corruption risk D11). A run
      // that already completed (or failed) is restartable — the auto-
      // reindex notifier relies on this to embed newly-imported items
      // after the initial full scan has finished.
      if (status.state === "running" || status.state === "paused") {
        deps.logger.debug(`Zotero AI Explain index:start-ignored state=${status.state}`);
        return;
      }
      // Defer while an AC-5 migration crawl owns the index — a second
      // crawl writing the primary would race the atomic `.tmp` swap.
      // The auto-reindex notifier (and the user) can re-click once the
      // migration completes.
      if (activeMigration !== null) {
        deps.logger.debug("Zotero AI Explain index:start-ignored migration-active");
        return;
      }
      pausedFlag = false;
      apply({ type: "started", totalItems: 0 }, "start");
      // Plan L700-701: `start()` reads storage before spawning the
      // crawler so subsequent `resume()` semantics inherit the
      // persisted file. The crawler also calls `storage.read()` for
      // its own item-skip logic; that's a deliberate redundancy — the
      // controller's read here documents the public contract while the
      // crawler's read keeps the AC3 module self-contained.
      void (async () => {
        const persisted = await deps.storage.read();
        spawnRun(pickResumeKey(persisted));
      })();
    },
    pause() {
      // Reducer only honors `paused` if we are running. Skip otherwise.
      if (status.state !== "running") {
        deps.logger.debug(`Zotero AI Explain index:pause-ignored state=${status.state}`);
        return;
      }
      // Flip the flag observable to the crawler; the crawler's
      // per-chunk pause check is responsible for aborting the
      // in-flight fetch (AC3 contract, plan L711-717).
      pausedFlag = true;
      apply({ type: "paused" }, "pause");
    },
    resume() {
      if (status.state !== "paused") {
        deps.logger.debug(`Zotero AI Explain index:resume-ignored state=${status.state}`);
        return;
      }
      pausedFlag = false;
      apply({ type: "resumed" }, "resume");
      // The previous AbortController was aborted by the crawler when
      // pause hit; create a fresh one and re-spawn with a sensible
      // resumeFromItemKey drawn from the persisted file.
      void (async () => {
        const persisted = await deps.storage.read();
        spawnRun(pickResumeKey(persisted));
      })();
    },
    clear() {
      // Serialize concurrent clear() invocations so storage.clear is
      // called at most once per logical "clear". Reuse the in-flight
      // clear promise (no-op fan-in).
      if (activeClear !== null) {
        return activeClear;
      }
      const sourceState = status.state;
      const runToAwait = activeRun;
      const controllerToAbort = abortController;
      // FINDING-4: capture the in-flight migration (if any). `clear()`
      // must coordinate with it — a `commitMigration` rename completing
      // AFTER `storage.clear()` would resurrect the index the user just
      // removed, and a surviving `.migrating` marker would re-trigger
      // migration on the next launch.
      const migrationToAwait = activeMigration;
      const migrationControllerToAbort = migrationAbortController;

      const doClear = async (): Promise<void> => {
        try {
          if (sourceState === "running" && controllerToAbort !== null && runToAwait !== null) {
            // FINDING-6 ordering: (1) abort, (2) await activeRun,
            // (3) storage.clear, (4) emit `cleared`.
            controllerToAbort.abort();
            try {
              await runToAwait;
            } catch (err) {
              // Swallow AbortError per the plan; surface anything else
              // as a debug log but still proceed to clear storage.
              if (!isAbortError(err)) {
                deps.logger.debug(
                  `Zotero AI Explain index:clear-await-error ${
                    err instanceof Error ? err.message : String(err)
                  }`
                );
              }
            }
          }
          // FINDING-4: coordinate with an in-flight migration. (1) Flag
          // cancellation so the migration skips its `commitMigration`
          // even if its crawl already finished; (2) abort the migration
          // crawl so it settles promptly; (3) AWAIT it fully — by the
          // time it resolves, whatever it did (commit or not) is done,
          // so the `storage.clear()` below is the LAST mutation and the
          // index stays cleared regardless of the migration's outcome.
          if (migrationToAwait !== null) {
            migration.cancelled = true;
            if (migrationControllerToAbort !== null) {
              migrationControllerToAbort.abort();
            }
            try {
              await migrationToAwait;
            } catch (err) {
              if (!isAbortError(err)) {
                deps.logger.debug(
                  `Zotero AI Explain index:clear-migration-await-error ${
                    err instanceof Error ? err.message : String(err)
                  }`
                );
              }
            }
          }
          // Always clear the running-run handles so the controller's
          // settle handler (if it still fires) sees activeRun !== run
          // and short-circuits without overriding the cleared state.
          activeRun = null;
          abortController = null;
          pausedFlag = false;

          try {
            await deps.storage.clear();
          } catch (err) {
            // IndexStorage already swallows ENOENT, but a defensive
            // controller does not crash on a flaky downstream IO layer
            // (D13). Log and proceed to emit `cleared`.
            deps.logger.debug(
              `Zotero AI Explain index:clear-storage-error ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
          apply({ type: "cleared" }, "clear");
        } finally {
          activeClear = null;
        }
      };

      activeClear = doClear();
      return activeClear;
    },
    async hydrate() {
      // Only seed when idle — a running/paused/complete/failed status
      // already reflects the canonical counters from the live run.
      if (status.state !== "idle") {
        deps.logger.debug(`Zotero AI Explain index:hydrate-ignored state=${status.state}`);
        return;
      }
      // AC-5: hydrate is the SOLE caller of `readWithMigration`. Detect
      // a pending one-time index migration and run it before seeding.
      try {
        const probe = await deps.storage.readWithMigration();
        if (probe.migrationPending) {
          const schemaCurrent = (probe.file?.schemaVersion ?? 1) >= CURRENT_SCHEMA_VERSION;
          if (probe.file !== null && schemaCurrent) {
            // C5: the atomic rename already completed (primary is v2)
            // but the marker removal was interrupted. The correct
            // action is to clear the stale marker — NOT a re-crawl.
            deps.logger.debug("Zotero AI Explain index:migration-marker-stale -> removeMarker");
            await deps.storage.removeMarker();
          } else if (probe.file === null && !(await deps.storage.hasMarker())) {
            // Fresh install: no on-disk index and no interrupted
            // migration. There is nothing to migrate — the first user
            // "Index library" run writes a v2 file directly. Skip.
            deps.logger.debug("Zotero AI Explain index:migration-skip fresh-install");
          } else {
            // A legacy (pre-v2) index OR an interrupted migration
            // (marker present) — run the atomic migration to completion.
            await runMigrationImpl();
          }
        }
      } catch (err) {
        deps.logger.debug(
          `Zotero AI Explain index:hydrate-migration-error ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        // Fall through to the seed below — a migration probe failure
        // must not block the UI from showing whatever is on disk.
      }
      // Read the cheap sidecar (a handful of bytes) so a 70 MB+ index
      // doesn't force a sync JSON.parse on the chrome thread at startup.
      let previouslyIndexed: number;
      try {
        previouslyIndexed = await deps.storage.readItemCount();
      } catch (err) {
        deps.logger.debug(
          `Zotero AI Explain index:hydrate-read-error ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }
      if (previouslyIndexed === 0) return;
      apply({ type: "hydrate", previouslyIndexed }, "hydrate");
    },
    runMigration() {
      return runMigrationImpl();
    }
  };
}

/**
 * Format the human-facing status text shown in the settings panel.
 *
 * Two formats are produced:
 *   1. The legacy compact counts ("X / Y indexed, Z failed") which the
 *      e2e harness and existing tests scrape — preserved verbatim for
 *      back-compat.
 *   2. The honest breakdown ("X already indexed, Y new this run,
 *      Z failed, W skipped (no text)") rendered AFTER the legacy line
 *      so resumed runs no longer look like they restarted from 0.
 *      Skipped breakdown is omitted entirely when both counters are
 *      zero so a fresh idle status reads cleanly.
 *
 * When the indexer is in the `failed` state the optional `errorMessage`
 * is appended so the user can see why (FINDING-12).
 */
export function describeIndexingStatus(status: IndexingStatus): string {
  const indexed = String(status.indexedItems);
  const total = String(status.totalItems);
  const prior = status.previouslyIndexed ?? 0;
  const skipped = status.skippedNoText ?? 0;
  const legacyCounts = `${indexed} / ${total} indexed, ${String(status.failedItems)} failed`;
  const honest = describeHonestCounts(status);
  const counts = honest.length > 0 ? `${legacyCounts} (${honest})` : legacyCounts;
  switch (status.state) {
    case "idle":
      // For a hydrated-but-not-started state, lead with the actionable
      // fact ("X items indexed previously") rather than the misleading
      // "0 / 0 indexed" — totalItems is 0 until a run starts and would
      // imply nothing is in the index.
      if (status.indexedItems === 0 && prior > 0) {
        return `${String(prior)} items previously indexed. Click "Index library" to resume.`;
      }
      return counts;
    case "running":
      // AC-14 Fix 3: between the "Index library" click and the first
      // crawler `onRunStart`/`onProgress` event `totalItems` is still 0.
      // The bare "Indexing 0 of 0" reads as a stalled/empty run; surface
      // honest "just started" text instead. Once the crawler reports the
      // library size (`totalItems > 0`) the existing format is unchanged.
      if (status.totalItems === 0) {
        return "Starting… scanning your library.";
      }
      return `Indexing ${indexed} of ${total}. ${counts}`;
    case "paused":
      return `Paused. ${counts}`;
    case "complete":
      // A "no-op" complete run (nothing new this run, everything in
      // initialFile) is the common case after re-clicking Index on an
      // already-indexed library. The bare "0 / 5738 indexed" wording
      // implies the library is empty even though `prior` already holds
      // every indexable item. Surface the honest count instead.
      if (status.indexedItems === 0 && prior > 0) {
        const skipNote = skipped > 0 ? `, ${String(skipped)} had no embeddable text` : "";
        return `Library indexed. ${String(prior)} items in the index (${total} library entries scanned${skipNote}).`;
      }
      return `Indexing complete. ${counts}`;
    case "failed":
      return status.errorMessage !== undefined && status.errorMessage.length > 0
        ? `Indexing failed: ${status.errorMessage}. ${counts}`
        : `Indexing failed. ${counts}`;
  }
}

/**
 * Render the cumulative honest-counter parts. Returns `""` for fresh
 * idle status (no prior runs + no this-run activity) so the legacy
 * format stays clean for first-time users.
 */
function describeHonestCounts(status: IndexingStatus): string {
  const prior = status.previouslyIndexed ?? 0;
  const skipped = status.skippedNoText ?? 0;
  const parts: string[] = [];
  if (prior > 0) {
    parts.push(`${String(prior)} already indexed`);
  }
  // Show "new this run" once anything has happened this run (indexed
  // items, failures, or skips). Avoids the "0 new this run" noise on
  // a never-started idle status.
  const runActive = status.indexedItems > 0 || status.failedItems > 0 || skipped > 0;
  if (runActive || prior > 0) {
    parts.push(`${String(status.indexedItems)} new this run`);
  }
  if (skipped > 0) {
    parts.push(`${String(skipped)} skipped (no text)`);
  }
  return parts.join(" · ");
}
