/* @vitest-environment jsdom */

/**
 * Adversarial tests for AC-14 — indexing UX-feedback fixes:
 *   Fix 1  no-op click feedback (disabled buttons + reason fragment),
 *   Fix 2  destructive-Clear two-stage in-view confirm,
 *   Fix 3  honest startup progress ("Starting… scanning your library.").
 *
 * Plan: `docs/superpowers/plans/2026-05-19-pdf-context-features.md`
 *   AC-14 description          L775-895 (Adv-1 .. Adv-8)
 *   AC-14 interface contract   L1242-1309
 *
 * --------------------------------------------------------------------
 * Fault Localization (Template 4 — AC-14 UX feedback)
 * --------------------------------------------------------------------
 *
 * 1. Spec semantics (premises):
 *    P1.  `IndexingStatus` gains an OPTIONAL read-only `migrationActive?:
 *         boolean` (mirrors `previouslyIndexed`). `createInitialIndexing
 *         Status()` seeds `migrationActive: false`. The reducer always
 *         emits a concrete boolean.
 *    P2.  Two NEW reducer actions, `migration-started` and
 *         `migration-settled`. Their cases return
 *         `{ ...status, migrationActive: <bool> }` and touch NO other
 *         field — `state`, `totalItems`, `indexedItems`, `failedItems`
 *         are byte-for-byte unchanged.
 *    P3.  `describeIndexingStatus` `running` branch: when
 *         `status.totalItems === 0` it returns
 *         "Starting… scanning your library." instead of
 *         "Indexing 0 of 0. …". Once `totalItems > 0` the existing
 *         "Indexing <indexed> of <total>" text is unchanged. All other
 *         branches are byte-for-byte unchanged.
 *    P4.  `renderIndexControls` / `attachIndexControls` make the
 *         "Index library" (`start-index`) button `disabled` whenever a
 *         click cannot start a run: `status.state` ∈ {running, paused}
 *         OR `status.migrationActive` is true.
 *    P5.  Symmetric: `pause-index` disabled unless `state === running`;
 *         `resume-index` disabled unless `state === paused`;
 *         `clear-index` disabled while `migrationActive` is true.
 *    P6.  The status summary carries a short reason fragment:
 *         "Already indexing…" (running), "Paused — use Resume to
 *         continue." (paused), "Migrating the index — please wait…"
 *         (migrationActive).
 *    P7.  Clear is a two-stage in-view confirm. The FIRST click on
 *         `clear-index` does NOT call `controller.clear()` — it relabels
 *         the button to "Confirm clear" and writes a consequence line
 *         containing "deletes all N embedded items" (N =
 *         `previouslyIndexed ?? 0`, lower-bounded by `indexedItems`).
 *         A SECOND click calls `controller.clear()`.
 *    P8.  Clicking any other control (start/pause/resume) OR a
 *         controller status change cancels the pending confirm — the
 *         button reverts to "Clear index", the consequence line clears.
 *    P9.  The confirm state is VIEW-LOCAL (a closure flag) — the
 *         controller never learns about a pending confirm.
 *
 * 2. Code path trace (against the contract — bodies NOT inspected):
 *    - `attachIndexControls` subscribes to the controller; a
 *      `refreshControls()` helper recomputes each button's `disabled`
 *      flag + the reason fragment on every status change.
 *    - `runMigrationImpl` emits `migration-started` right after
 *      `activeMigration` is assigned and `migration-settled` in its
 *      `finally` block.
 *
 * 3. Divergence analysis (likely bugs the tests target):
 *    D1 [HIGH]   `start-index` stays clickable while running/paused/
 *                migrating → the silent-no-op confusion is NOT fixed.
 *    D2 [HIGH]   the new reducer actions mutate `state`/`totalItems`/
 *                `indexedItems`/`failedItems` — a logic change smuggled
 *                in under an "observability" addition (Adv-4).
 *    D3 [HIGH]   the first `clear-index` click calls `clear()`
 *                immediately — no confirm (the destructive footgun).
 *    D4 [HIGH]   the pre-`onRunStart` window still shows "Indexing 0 of
 *                0" dead-air instead of "Starting…".
 *    D5 [MEDIUM] the confirm is latched — clicking another control does
 *                NOT cancel it, so a later single click clears.
 *    D6 [MEDIUM] `migrationActive` is not surfaced on the status →
 *                the UI cannot disable `start` during a migration.
 *    D7 [MEDIUM] the consequence line understates N (uses 0 / the
 *                smaller of previouslyIndexed and indexedItems).
 *    D8 [LOW]    `describeIndexingStatus` changes a NON-running branch.
 *
 * 4. Test targets (ranked): D2 (reducer purity) > D1 (start disabled) >
 *    D3 (clear confirm) > D4 (honest startup) > D6 (migrationActive
 *    surfaced) > D5 (confirm cancellable) > D7 (N never understated).
 *
 * --------------------------------------------------------------------
 * COMPILE NOTE: this file depends on the AC-14 widening of
 * `IndexingStatus` (`migrationActive?: boolean`) and `IndexingAction`
 * (`migration-started` / `migration-settled`). Until the implementer
 * lands these the file fails to COMPILE. The test SOURCE is the
 * authority on the contract (plan L1242-1309).
 * --------------------------------------------------------------------
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  IndexFile,
  IndexLibraryOptions,
  LibraryCrawlerDeps
} from "../../src/indexing/library-crawler.js";
import {
  createInitialIndexingStatus,
  reduceIndexingStatus,
  type IndexingAction,
  type IndexingStatus
} from "../../src/indexing/indexing-status.js";

// ----------------------------------------------------------------------
// vi.mock: replace `indexLibrary` with a controllable fake so the
// migration crawl can be held PENDING — that keeps `runMigration` in
// flight and `migrationActive` observably true. `vi.mock` is file-scoped,
// hence this dedicated file (the existing index-controls-view.test.ts
// must keep its un-mocked crawler).
// ----------------------------------------------------------------------

type IndexLibraryCall = {
  readonly deps: LibraryCrawlerDeps;
  readonly options: IndexLibraryOptions;
  readonly resolve: (value: { readonly completed: boolean }) => void;
  readonly reject: (err: unknown) => void;
};

const crawlerCalls: IndexLibraryCall[] = [];

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
        crawlerCalls.push({ deps, options, resolve, reject });
        return promise;
      })
  };
});

// Import AFTER vi.mock so the controller's `import { indexLibrary }`
// binds to the mocked symbol.
import {
  createIndexingController,
  type IndexingController
} from "../../src/indexing/indexing-controller.js";
import { attachIndexControls, renderIndexControls } from "../../src/ui/index-controls-view.js";

/** Microtask drain. */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  crawlerCalls.length = 0;
});

afterEach(() => {
  crawlerCalls.length = 0;
});

// ====================================================================
// Adv-4 — `migrationActive` is read-only: the two new reducer actions
// touch ONLY `migrationActive`, never the run counters or state.
// ====================================================================

describe("AC-14 Adv-4 — migration-started / migration-settled are read-only", () => {
  /** The four fields the new actions must NOT touch. */
  function runCounters(status: IndexingStatus): {
    state: IndexingStatus["state"];
    totalItems: number;
    indexedItems: number;
    failedItems: number;
  } {
    return {
      state: status.state,
      totalItems: status.totalItems,
      indexedItems: status.indexedItems,
      failedItems: status.failedItems
    };
  }

  it("createInitialIndexingStatus seeds migrationActive: false", () => {
    expect(createInitialIndexingStatus().migrationActive).toBe(false);
  });

  it("`migration-started` sets migrationActive true and changes NOTHING else", () => {
    // A non-trivial mid-run status so a smuggled mutation is visible.
    const before: IndexingStatus = {
      state: "running",
      totalItems: 120,
      indexedItems: 37,
      failedItems: 4,
      previouslyIndexed: 30,
      skippedNoText: 2,
      migrationActive: false
    };
    const after = reduceIndexingStatus(before, { type: "migration-started" });
    expect(after.migrationActive).toBe(true);
    // D2: byte-for-byte equality on the run counters + state.
    expect(runCounters(after)).toEqual(runCounters(before));
    // The other observability fields are also untouched.
    expect(after.previouslyIndexed).toBe(before.previouslyIndexed);
    expect(after.skippedNoText).toBe(before.skippedNoText);
  });

  it("`migration-settled` sets migrationActive false and changes NOTHING else", () => {
    const before: IndexingStatus = {
      state: "complete",
      totalItems: 99,
      indexedItems: 99,
      failedItems: 0,
      previouslyIndexed: 90,
      skippedNoText: 1,
      migrationActive: true
    };
    const after = reduceIndexingStatus(before, { type: "migration-settled" });
    expect(after.migrationActive).toBe(false);
    expect(runCounters(after)).toEqual(runCounters(before));
    expect(after.previouslyIndexed).toBe(before.previouslyIndexed);
    expect(after.skippedNoText).toBe(before.skippedNoText);
  });

  it("a full migration-started → migration-settled cycle only ever moves migrationActive", () => {
    // Snapshot the run counters before each action and diff: the ONLY
    // delta attributable to the two new actions must be migrationActive.
    let status: IndexingStatus = {
      state: "running",
      totalItems: 50,
      indexedItems: 12,
      failedItems: 1,
      previouslyIndexed: 8,
      skippedNoText: 0,
      migrationActive: false
    };
    const countersAtStart = runCounters(status);

    status = reduceIndexingStatus(status, { type: "migration-started" });
    expect(runCounters(status)).toEqual(countersAtStart);
    expect(status.migrationActive).toBe(true);

    status = reduceIndexingStatus(status, { type: "migration-settled" });
    expect(runCounters(status)).toEqual(countersAtStart);
    expect(status.migrationActive).toBe(false);
  });

  it("the new actions do not disturb a `started`/`progress`-driven status", () => {
    // Drive a realistic reducer sequence, bracket it with the migration
    // actions, and assert the run-lifecycle fields are exactly what the
    // lifecycle actions produced.
    let status = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "started",
      totalItems: 200,
      previouslyIndexed: 50
    });
    status = reduceIndexingStatus(status, { type: "migration-started" });
    status = reduceIndexingStatus(status, {
      type: "progress",
      indexedItems: 70,
      failedItems: 3,
      totalItems: 200
    });
    status = reduceIndexingStatus(status, { type: "migration-settled" });

    expect(status.state).toBe("running");
    expect(status.totalItems).toBe(200);
    expect(status.indexedItems).toBe(70);
    expect(status.failedItems).toBe(3);
    expect(status.migrationActive).toBe(false);
  });

  it("`migration-started` is idempotent — re-applying does not corrupt counters", () => {
    const before: IndexingStatus = {
      state: "idle",
      totalItems: 0,
      indexedItems: 0,
      failedItems: 0,
      migrationActive: true
    };
    const after = reduceIndexingStatus(before, { type: "migration-started" });
    expect(after.migrationActive).toBe(true);
    expect(after.state).toBe("idle");
    expect(after.totalItems).toBe(0);
  });

  it("rejects compile-time: the new actions are part of the IndexingAction union", () => {
    // Pure type-level assertion — both literals must be assignable to
    // IndexingAction. A regression that drops one fails to compile here.
    const started: IndexingAction = { type: "migration-started" };
    const settled: IndexingAction = { type: "migration-settled" };
    expect(started.type).toBe("migration-started");
    expect(settled.type).toBe("migration-settled");
  });
});

// ====================================================================
// Fix 3 — honest startup text in describeIndexingStatus
// ====================================================================

// `describeIndexingStatus` is exercised indirectly through the rendered
// summary in the UI tests below (Adv-8). Direct describe coverage keeps
// the boundary tight.
import { describeIndexingStatus } from "../../src/indexing/indexing-controller.js";

describe("AC-14 Fix 3 — describeIndexingStatus honest startup text", () => {
  it("running with totalItems 0 returns 'Starting… scanning your library.' (no '0 of 0')", () => {
    const text = describeIndexingStatus({
      state: "running",
      totalItems: 0,
      indexedItems: 0,
      failedItems: 0
    });
    expect(text).toContain("Starting");
    expect(text).toContain("scanning your library");
    // D4: the dead-air "Indexing 0 of 0" string must be gone.
    expect(text).not.toContain("Indexing 0 of 0");
  });

  it("running with totalItems > 0 keeps the existing 'Indexing <n> of <total>' text", () => {
    const text = describeIndexingStatus({
      state: "running",
      totalItems: 200,
      indexedItems: 40,
      failedItems: 2
    });
    expect(text).toContain("Indexing 40 of 200");
    expect(text).not.toContain("Starting");
  });

  it("D8: non-running branches are unchanged — idle '0 / 0 indexed' is preserved", () => {
    const idle = describeIndexingStatus({
      state: "idle",
      totalItems: 0,
      indexedItems: 0,
      failedItems: 0
    });
    expect(idle).toContain("0 / 0 indexed");
    expect(idle).not.toContain("Starting");
  });

  it("D8: a paused status is unchanged — still leads with 'Paused.'", () => {
    const paused = describeIndexingStatus({
      state: "paused",
      totalItems: 0,
      indexedItems: 0,
      failedItems: 0
    });
    expect(paused).toContain("Paused");
    expect(paused).not.toContain("Starting");
  });
});

// ====================================================================
// UI tests — a real controller wired to a stub storage. The stub
// storage never resolves a migration on its own, so for Fix-1/Fix-2/
// Fix-3 we drive the controller directly. The migration-active path
// (Adv-3) uses the migration-aware storage + the mocked crawler.
// ====================================================================

/** A minimal IndexStorage stub — no migration pending, empty index. */
function plainStorage(): import("../../src/indexing/index-storage.js").IndexStorage {
  let stored: IndexFile | null = null;
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async read() {
      return stored;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async readWithMigration() {
      return { file: stored, migrationPending: false };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async readItemCount() {
      return stored === null ? 0 : Object.keys(stored.items).length;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async write(file) {
      stored = file;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async writeItem(itemKey, entry) {
      stored = stored ?? {
        schemaVersion: 2,
        items: {},
        indexedAt: new Date(0).toISOString()
      };
      stored = {
        ...stored,
        items: { ...stored.items, [itemKey]: entry },
        indexedAt: new Date().toISOString()
      };
    },
    async writeTmp() {
      /* unused */
    },
    async commitMigration() {
      /* unused */
    },
    async abandonMigration() {
      /* unused */
    },
    async writeMarker() {
      /* unused */
    },
    async removeMarker() {
      /* unused */
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async hasMarker() {
      return false;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async clear() {
      stored = null;
    },
    path() {
      return "/var/test-fixture/zotero-ai-explain-index.json";
    }
  };
}

function makeController(
  storage: import("../../src/indexing/index-storage.js").IndexStorage,
  initialStatus?: IndexingStatus
): IndexingController {
  const opts = {
    logger: { debug: (): void => undefined },
    zotero: {
      Libraries: { userLibraryID: 1 },
      Items: {
        // eslint-disable-next-line @typescript-eslint/require-await
        getAll: async () => [] as const,
        get: () => null
      }
    },
    provider: {
      // eslint-disable-next-line @typescript-eslint/require-await
      embedTexts: async () => [[0.1]] as const
    },
    settings: { baseUrl: "http://localhost:11434", embeddingModel: "nomic-embed-text" },
    storage,
    scheduler: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...(initialStatus !== undefined ? { initialStatus } : {})
  } as unknown as Parameters<typeof createIndexingController>[0];
  return createIndexingController(opts);
}

function mount(controller: IndexingController): {
  view: HTMLElement;
  summary: HTMLElement | null;
  detach: () => void;
  btn(action: string): HTMLButtonElement | null;
} {
  const view = renderIndexControls(controller.getStatus());
  document.body.append(view);
  const detach = attachIndexControls(view, controller);
  return {
    view,
    summary: view.querySelector<HTMLElement>(".zotero-ai-index-controls__summary"),
    detach,
    btn: (action) => view.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
  };
}

// --------------------------------------------------------------------
// Adv-1 — start disabled while running
// --------------------------------------------------------------------

describe("AC-14 Adv-1 — start disabled while running", () => {
  it("after a start-index click the start button is disabled and the summary explains why", async () => {
    const controller = makeController(plainStorage());
    const ui = mount(controller);

    ui.btn("start-index")?.click();
    await flush();

    // D1: start must not be actionable — a second click is a silent
    // no-op the user would not understand. Button-clutter cleanup
    // hides irrelevant buttons rather than greying them out; check
    // `hidden` instead of `disabled`.
    expect(ui.btn("start-index")?.hidden).toBe(true);
    expect(ui.summary?.textContent ?? "").toContain("Already indexing");

    ui.detach();
    ui.view.remove();
  });

  it("a running-state initial render hides start-index", () => {
    // renderIndexControls must set the initial hidden flag — not only
    // attachIndexControls' refresh.
    const view = renderIndexControls({
      state: "running",
      totalItems: 10,
      indexedItems: 3,
      failedItems: 0
    });
    expect(view.querySelector<HTMLButtonElement>('[data-action="start-index"]')?.hidden).toBe(true);
  });
});

// --------------------------------------------------------------------
// Adv-2 — start disabled while paused; resume is the only enabled
// lifecycle button.
// --------------------------------------------------------------------

describe("AC-14 Adv-2 — start disabled while paused", () => {
  it("start -> pause: start-index is disabled, summary steers to Resume, resume-index enabled", async () => {
    const controller = makeController(plainStorage());
    const ui = mount(controller);

    ui.btn("start-index")?.click();
    await flush();
    ui.btn("pause-index")?.click();
    await flush();

    expect(controller.getStatus().state).toBe("paused");
    // Hidden-instead-of-disabled UX: start/pause not actionable from
    // paused state; resume is the steering action and remains visible.
    expect(ui.btn("start-index")?.hidden).toBe(true);
    expect(ui.summary?.textContent ?? "").toContain("Paused");
    expect(ui.summary?.textContent ?? "").toMatch(/use Resume to continue/u);
    expect(ui.btn("resume-index")?.hidden).toBe(false);
    expect(ui.btn("resume-index")?.disabled).toBe(false);
    expect(ui.btn("pause-index")?.hidden).toBe(true);

    ui.detach();
    ui.view.remove();
  });

  it("pause and resume are hidden at idle (symmetric guards)", () => {
    const view = renderIndexControls({
      state: "idle",
      totalItems: 0,
      indexedItems: 0,
      failedItems: 0
    });
    expect(view.querySelector<HTMLButtonElement>('[data-action="pause-index"]')?.hidden).toBe(true);
    expect(view.querySelector<HTMLButtonElement>('[data-action="resume-index"]')?.hidden).toBe(
      true
    );
  });

  it("start-index re-enables once the run returns to a startable state", async () => {
    // idle/complete/failed with no migration → start is clickable again.
    const controller = makeController(plainStorage());
    const ui = mount(controller);
    ui.btn("start-index")?.click();
    await flush();
    expect(ui.btn("start-index")?.hidden).toBe(true);

    // Drive the controller to `complete` — start must re-appear.
    crawlerCalls[crawlerCalls.length - 1]?.resolve({ completed: true });
    await flush();
    expect(controller.getStatus().state).toBe("complete");
    expect(ui.btn("start-index")?.hidden).toBe(false);
    expect(ui.btn("start-index")?.disabled).toBe(false);

    ui.detach();
    ui.view.remove();
  });
});

// --------------------------------------------------------------------
// Adv-3 — start disabled + reason while a migration is active.
// Drives the controller through `runMigration()` with a never-settling
// migration crawl so `migrationActive` is observably true end-to-end.
// --------------------------------------------------------------------

/** Migration-aware storage holding a legacy (v1) primary so hydrate() runs a migration. */
function migrationStorage(): import("../../src/indexing/index-storage.js").IndexStorage {
  const state: { primary: IndexFile | null; tmp: IndexFile | null; marker: boolean } = {
    primary: {
      items: { LEG1: { title: "Legacy", chunks: [] } },
      indexedAt: "2026-05-01T00:00:00.000Z"
    } as unknown as IndexFile,
    tmp: null,
    marker: false
  };
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async read() {
      return state.primary;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async readWithMigration() {
      const schemaVersion = state.primary?.schemaVersion ?? 1;
      return { file: state.primary, migrationPending: state.marker || schemaVersion < 2 };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async readItemCount() {
      return state.primary === null ? 0 : Object.keys(state.primary.items).length;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async write(file) {
      state.primary = file;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async writeItem(itemKey, entry) {
      const base: IndexFile = state.primary ?? {
        schemaVersion: 2,
        items: {},
        indexedAt: new Date(0).toISOString()
      };
      state.primary = {
        ...base,
        items: { ...base.items, [itemKey]: entry },
        indexedAt: new Date().toISOString()
      };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async writeTmp(file) {
      state.tmp = file;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async commitMigration() {
      if (state.tmp === null) throw new Error("no .tmp to commit");
      state.primary = state.tmp;
      state.tmp = null;
      state.marker = false;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async abandonMigration() {
      state.tmp = null;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async writeMarker() {
      state.marker = true;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async removeMarker() {
      state.marker = false;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async hasMarker() {
      return state.marker;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async clear() {
      state.primary = null;
      state.tmp = null;
      state.marker = false;
    },
    path() {
      return "/var/test-fixture/zotero-ai-explain-index.json";
    }
  };
}

describe("AC-14 Adv-3 — start disabled + reason while a migration is active", () => {
  it("getStatus().migrationActive is true while runMigration's crawl is in flight", async () => {
    const controller = makeController(migrationStorage());

    // hydrate() detects the legacy file → runs the migration. The mocked
    // `indexLibrary` (the migration crawl) is held PENDING.
    const hydratePromise = controller.hydrate();
    await flush();

    expect(crawlerCalls.length).toBeGreaterThanOrEqual(1);
    // The new read-only field is true for the lifetime of the crawl.
    expect(controller.getStatus().migrationActive).toBe(true);

    // Settle the crawl so the controller can finish the migration.
    crawlerCalls[crawlerCalls.length - 1]?.resolve({ completed: true });
    await hydratePromise;
    await flush();

    // After the migration settles, the field flips back to false.
    expect(controller.getStatus().migrationActive).toBe(false);
  });

  it("the rendered start-index button is disabled and the summary names the migration reason", async () => {
    const controller = makeController(migrationStorage());
    const ui = mount(controller);

    const hydratePromise = controller.hydrate();
    await flush();

    // D6: while migrationActive the start button is hidden (not
    // actionable) and the summary carries the migration reason fragment.
    expect(controller.getStatus().migrationActive).toBe(true);
    expect(ui.btn("start-index")?.hidden).toBe(true);
    expect(ui.summary?.textContent ?? "").toMatch(/Migrating the index/u);

    // Clear stays visible but disabled mid-migration (confirm would
    // be confusing).
    expect(ui.btn("clear-index")?.hidden).toBe(false);
    expect(ui.btn("clear-index")?.disabled).toBe(true);

    // After the migration settles start re-appears and the fragment clears.
    crawlerCalls[crawlerCalls.length - 1]?.resolve({ completed: true });
    await hydratePromise;
    await flush();
    expect(controller.getStatus().migrationActive).toBe(false);
    expect(ui.btn("start-index")?.hidden).toBe(false);
    expect(ui.btn("start-index")?.disabled).toBe(false);
    expect(ui.summary?.textContent ?? "").not.toMatch(/Migrating the index/u);

    ui.detach();
    ui.view.remove();
  });
});

// --------------------------------------------------------------------
// Adv-5 — Clear requires two clicks; the consequence line shows N.
// --------------------------------------------------------------------

describe("AC-14 Adv-5 — destructive-Clear two-stage confirm", () => {
  it("one clear-index click does NOT clear — it relabels and shows the N-item consequence", async () => {
    // A status carrying previouslyIndexed: 5738 so the consequence line
    // can quote a concrete count.
    const controller = makeController(plainStorage(), {
      state: "idle",
      totalItems: 0,
      indexedItems: 0,
      failedItems: 0,
      previouslyIndexed: 5738
    });
    const ui = mount(controller);

    const clearBtn = ui.btn("clear-index");
    clearBtn?.click();
    await flush();

    // D3: the FIRST click must NOT have cleared — the controller stays
    // idle (a real clear() also lands idle, so we additionally assert
    // the relabel + consequence line, which a no-op-then-clear lacks).
    expect(controller.getStatus().state).toBe("idle");
    expect(clearBtn?.textContent ?? "").toMatch(/Confirm clear/u);
    expect(ui.summary?.textContent ?? "").toContain("deletes all 5738 embedded items");

    ui.detach();
    ui.view.remove();
  });

  it("a SECOND click on the relabelled button calls controller.clear()", async () => {
    const storage = plainStorage();
    const clearSpy = vi.spyOn(storage, "clear");
    const controller = makeController(storage, {
      state: "complete",
      totalItems: 10,
      indexedItems: 10,
      failedItems: 0,
      previouslyIndexed: 10
    });
    const ui = mount(controller);

    const clearBtn = ui.btn("clear-index");
    clearBtn?.click(); // arm
    await flush();
    clearBtn?.click(); // confirm
    await flush();

    // The second click drove the real clear.
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(controller.getStatus().state).toBe("idle");

    ui.detach();
    ui.view.remove();
  });

  it("D7: the consequence-line N is never understated — uses the larger of previouslyIndexed/indexedItems", async () => {
    // A live run where indexedItems (this run) exceeds previouslyIndexed.
    const controller = makeController(plainStorage(), {
      state: "running",
      totalItems: 900,
      indexedItems: 812,
      failedItems: 0,
      previouslyIndexed: 100
    });
    const ui = mount(controller);

    ui.btn("clear-index")?.click();
    await flush();
    const summaryText = ui.summary?.textContent ?? "";
    // N = max(previouslyIndexed ?? 0, indexedItems) — never the smaller.
    expect(summaryText).toContain("812");
    expect(summaryText).not.toContain("deletes all 100 embedded items");

    ui.detach();
    ui.view.remove();
  });
});

// --------------------------------------------------------------------
// Adv-6 — the clear confirm is cancellable (not a latched footgun).
// --------------------------------------------------------------------

describe("AC-14 Adv-6 — clear confirm is cancellable", () => {
  it("arming the confirm then clicking start-index reverts the button and clears the consequence", async () => {
    const storage = plainStorage();
    const clearSpy = vi.spyOn(storage, "clear");
    const controller = makeController(storage, {
      state: "idle",
      totalItems: 0,
      indexedItems: 0,
      failedItems: 0,
      previouslyIndexed: 42
    });
    const ui = mount(controller);

    const clearBtn = ui.btn("clear-index");
    clearBtn?.click(); // arm the confirm
    await flush();
    expect(clearBtn?.textContent ?? "").toMatch(/Confirm clear/u);

    // Click another control — cancels the pending confirm.
    ui.btn("start-index")?.click();
    await flush();

    // The button reverted to "Clear index" and the consequence is gone.
    expect(clearBtn?.textContent ?? "").toMatch(/Clear index/u);
    expect(ui.summary?.textContent ?? "").not.toContain("embedded items");
    // D5: clear() was never called by the cancelled confirm.
    expect(clearSpy).not.toHaveBeenCalled();

    ui.detach();
    ui.view.remove();
  });

  it("after a cancelled confirm, a single clear-index click only re-arms (does NOT clear)", async () => {
    const storage = plainStorage();
    const clearSpy = vi.spyOn(storage, "clear");
    const controller = makeController(storage, {
      state: "idle",
      totalItems: 0,
      indexedItems: 0,
      failedItems: 0,
      previouslyIndexed: 7
    });
    const ui = mount(controller);

    const clearBtn = ui.btn("clear-index");
    clearBtn?.click(); // arm
    await flush();
    ui.btn("start-index")?.click(); // cancel
    await flush();

    // A fresh single click must only re-arm — not clear.
    clearBtn?.click();
    await flush();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(clearBtn?.textContent ?? "").toMatch(/Confirm clear/u);

    ui.detach();
    ui.view.remove();
  });
});

// --------------------------------------------------------------------
// Adv-8 — honest startup text in the rendered summary: no "0 of 0"
// dead air immediately after a start-index click.
// --------------------------------------------------------------------

describe("AC-14 Adv-8 — honest startup text, no '0 of 0' dead air", () => {
  it("immediately after a start-index click the summary shows 'Starting… scanning your library.'", async () => {
    const controller = makeController(plainStorage());
    const ui = mount(controller);

    ui.btn("start-index")?.click();
    await flush();

    // The crawler is held pending (no progress / onRunStart yet) — the
    // pre-progress window must read "Starting…", not "Indexing 0 of 0".
    const summaryText = ui.summary?.textContent ?? "";
    expect(summaryText).toContain("Starting");
    expect(summaryText).not.toContain("Indexing 0 of 0");

    ui.detach();
    ui.view.remove();
  });

  it("once a progress action lands totalItems > 0 the summary switches to 'Indexing <n> of <total>'", async () => {
    const controller = makeController(plainStorage());
    const ui = mount(controller);

    ui.btn("start-index")?.click();
    await flush();
    expect(ui.summary?.textContent ?? "").toContain("Starting");

    // The mocked crawler receives an `onProgress` callback in its deps;
    // firing it with a real library size flips the text. The crawler's
    // onProgress is positional: (indexed, failed, total, skippedNoText?).
    const call = crawlerCalls[crawlerCalls.length - 1];
    expect(call).toBeDefined();
    call?.deps.onProgress(3, 0, 150);
    await flush();

    const summaryText = ui.summary?.textContent ?? "";
    expect(summaryText).toContain("Indexing 3 of 150");
    expect(summaryText).not.toContain("Starting");

    ui.detach();
    ui.view.remove();
  });
});
