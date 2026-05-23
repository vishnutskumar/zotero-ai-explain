import type { ConversationStore } from "../conversation/conversation-store.js";
import type { EmbedProviderKind } from "../indexing/index-path.js";
import { createIndexStorage, type CreateIndexStorageDeps } from "../indexing/index-storage.js";
import {
  createIndexingController,
  type IndexingController
} from "../indexing/indexing-controller.js";
import type { IndexFile, LibraryCrawlerDeps } from "../indexing/library-crawler.js";
import type { OllamaSettings, StringPrefReader } from "../preferences/ollama-profile.js";
import type { ProviderProfile } from "../providers/provider-types.js";
import type { SelectionContext } from "../selection/selection-context.js";
import { openCitationInReader } from "./citation-open.js";
import type { RetrievedChunk } from "../indexing/index-search.js";
import { renderAnchoredPopup } from "../ui/anchored-popup-view.js";
import { buildCitationLookup, type CitationLookup } from "../ui/citation-lookup.js";
import { attachIndexControls } from "../ui/index-controls-view.js";
import {
  buildLibraryPrompt,
  renderLibraryChatView,
  wireLibraryChatView,
  type CitationClick
} from "../ui/library-chat-view.js";
import type { PopupController } from "../ui/popup-controller.js";
import { renderSettingsView } from "../ui/settings-view.js";
import type { SidebarController } from "../ui/sidebar-controller.js";
import { renderSidebarConversation } from "../ui/sidebar-view.js";
import type { ZoteroGlobal } from "./zotero-ui-adapter.js";
import type { Unsubscribe, ZoteroUiAdapter } from "./zotero-ui-types.js";

/**
 * Diagnostic driver that exercises the plugin's UI flows from inside the
 * running chrome process. Gated entirely on the
 * `extensions.zotero-ai-explain.e2e-trigger` preference; when the pref is
 * absent (the production case), this function returns immediately without
 * touching the DOM.
 *
 * Trigger vocabulary:
 *   - `"all"` (default when set) — run every flow in sequence and emit a
 *     `e2e:done` line so the harness can wait for completion.
 *   - any other non-empty value is treated as a single phase token (e.g.
 *     `"explain"`) for finer-grained tests.
 *
 * Every observable event is logged as `e2e:<key>=<value>` via
 * `Zotero.debug`. The vitest harness scrapes those lines from the log
 * buffer instead of poking the live DOM, which keeps the test stable
 * across XUL chrome quirks.
 *
 * AC2 rewrite: the adversarial phases now dispatch through the production
 * `Zotero.Reader._dispatchEvent` against a REAL iframe document obtained
 * from `Zotero.Reader.open` on an imported sample PDF. The synthetic
 * chrome-document shortcuts have been retired (plan
 * `docs/superpowers/plans/2026-05-17-real-product-pipeline.md` AC2,
 * "Removal targets" L1248-1275).
 *
 * This file is production code — it ships in the XPI — but it is small,
 * pref-gated, and has no side effects when the pref is unset.
 */

export type E2eDriverDeps = {
  readonly zotero: ZoteroGlobal;
  readonly prefs: StringPrefReader;
  readonly ui: ZoteroUiAdapter;
  readonly store: ConversationStore;
  readonly profile: () => ProviderProfile;
  readonly settings: OllamaSettings;
  readonly popupController: PopupController;
  readonly sidebarController: SidebarController;
  readonly indexingController: IndexingController;
  readonly disclosure: () => string;
  /**
   * AC-5 migration-resume harness wiring. Optional — only the
   * `migration-resume` driver flow consumes it. Bootstrap supplies the
   * raw pieces so the flow can build a fresh `IndexStorage` +
   * `IndexingController` on a SPY io adapter and observe whether the
   * primary index file is ever written in place during a migration.
   * Absent in production / older harness builds (the flow then skips).
   */
  readonly migrationHarness?: {
    readonly io: CreateIndexStorageDeps["io"];
    readonly dataDir: string;
    readonly embedProvider: { readonly kind: EmbedProviderKind; readonly model: string };
    readonly crawlerZotero: LibraryCrawlerDeps["zotero"];
    readonly crawlerProvider: LibraryCrawlerDeps["provider"];
    readonly crawlerSettings: LibraryCrawlerDeps["settings"];
  };
};

const TRIGGER_PREF = "extensions.zotero-ai-explain.e2e-trigger";
const SAMPLE_PDF_PREF = "extensions.zotero-ai-explain.e2e-sample-pdf";
// Optional multi-page PDF fixture path. The `pdfworker-smoke` flow imports
// it (when set) to exercise the `\f` page-boundary split on a PDF with
// `totalPages > 1`. Absent in the production case and in flows that only
// need the single-page `sample.pdf`.
const MULTIPAGE_PDF_PREF = "extensions.zotero-ai-explain.e2e-multipage-pdf";
// Optional corrupt/non-PDF fixture path. The `pdfworker-smoke` flow imports
// it (when set) and asserts `Zotero.PDFWorker.getFullText` REJECTS — the
// adversarial case that proves the failure is surfaced, not swallowed.
const CORRUPT_PDF_PREF = "extensions.zotero-ai-explain.e2e-corrupt-pdf";

// ---------------------------------------------------------------------------
// Module-scope state. The real-pdf-setup prelude populates these; downstream
// phases read them. Cleared by the teardown phase.
// ---------------------------------------------------------------------------

let currentReaderIframeDoc: Document | null = null;
let currentReaderInstance: ZoteroReaderInstance | null = null;
let currentReaderAttachmentItemID: number | null = null;
let driverExplainContext: { conversationId: string; selection: SelectionContext } | null = null;

// ---------------------------------------------------------------------------
// Minimal shape of the chrome-side Zotero APIs the driver consumes. We
// deliberately keep this narrow and local; the production code paths use
// `ZoteroGlobal` from `zotero-ui-adapter.ts`. These types describe the
// runtime surface only the diagnostic driver depends on.
// ---------------------------------------------------------------------------

type ZoteroItemInstance = {
  readonly id: number;
  setField(name: string, value: string): void;
  saveTx(): Promise<number>;
};

type ZoteroAttachmentRecord = { readonly id: number };

type ZoteroReaderInstance = {
  readonly itemID: number;
  readonly tabID?: string;
  readonly _internalReader?: unknown;
  readonly _iframeWindow?: Window & typeof globalThis;
  // Chrome-side XUL <browser> hosting the reader (xpcom/reader.js:1812).
  // Its bounding rect maps reader-iframe-local coords to chrome-window coords;
  // mirrors Zotero's own popup positioning (xpcom/reader.js:1244-1247).
  readonly _iframe?: { getBoundingClientRect(): DOMRect };
  close?(): void | Promise<void>;
};

type ZoteroFile = unknown;

type ZoteroLibraryInstance = {
  waitForDataLoad(objectType: string): Promise<void>;
};

type ZoteroGlobalWithApis = ZoteroGlobal & {
  readonly Item: new (itemType: string) => ZoteroItemInstance;
  readonly File: { pathToFile(path: string): ZoteroFile };
  readonly Items: {
    getAsync(itemID: number | readonly number[]): Promise<unknown>;
  };
  readonly Libraries: {
    readonly userLibraryID: number;
    get(libraryID: number): ZoteroLibraryInstance;
  };
  readonly Attachments: {
    importFromFile(args: {
      readonly file: ZoteroFile;
      readonly parentItemID: number;
      readonly title?: string;
    }): Promise<ZoteroAttachmentRecord>;
  };
  readonly Reader: {
    open(itemID: number): Promise<unknown>;
    readonly _readers: readonly ZoteroReaderInstance[];
    _dispatchEvent(event: unknown): void;
    close?(itemID: number): Promise<void> | void;
  };
  readonly Zotero_Tabs?: { close(tabID: string): void };
  // Chrome-side PDF.js worker bridge (omni.ja
  // `chrome/content/zotero/xpcom/pdfWorker/manager.js:644-680`). `getFullText`
  // resolves to `{text, extractedPages, totalPages}`; page boundaries in
  // `text` are `\f` characters (worker.js:107407-107419 — `\f` is pushed
  // between pages, never after the final page, so an N-page PDF has N-1
  // form-feeds). Rejects with an Error when the attachment is not a PDF or
  // the worker fails to parse it (corrupt/encrypted file).
  readonly PDFWorker?: {
    getFullText(
      itemID: number,
      maxPages?: number | readonly number[],
      isPriority?: boolean,
      password?: string
    ): Promise<{
      readonly text: string;
      readonly extractedPages: number;
      readonly totalPages: number;
    }>;
  };
};

type Logger = (key: string, value: string) => void;

export async function runE2eDriver(deps: E2eDriverDeps): Promise<void> {
  const trigger = deps.prefs.get(TRIGGER_PREF)?.trim();
  if (trigger === undefined || trigger === "") {
    return;
  }

  const log = (key: string, value: string): void => {
    deps.zotero.debug(`e2e:${key}=${value}`);
  };

  log("trigger", trigger);

  try {
    // AC2 prelude — open a real PDF reader before any adversarial phase.
    // Also runs for `pdfworker-smoke`: the smoke flow reuses the
    // single-page attachment this prelude imports.
    let preludeReady = true;
    if (trigger === "all" || trigger === "real-pdf-setup" || trigger === "pdfworker-smoke") {
      const { readyOk } = await runRealPdfSetupFlow(deps, log);
      preludeReady = readyOk;
    }
    if (!preludeReady) {
      // FINDING-9: fail fast so the Vitest harness sees a diagnostic
      // immediately instead of waiting on the 180-s suite timeout.
      log("done", "error");
      return;
    }

    // AC-0 planner gate — PDF.js entry-point smoke test. Runs in its own
    // `pdfworker-smoke` phase (and as part of `all`) so AC-4 can rely on
    // `Zotero.PDFWorker.getFullText` being reachable and correctly shaped.
    if (trigger === "all" || trigger === "pdfworker-smoke") {
      await runPdfWorkerSmokeFlow(deps, log);
    }

    // AC-5 silent index migration. Its own `migration-resume` phase: the
    // flow seeds a legacy (pre-v2) index, runs `hydrate()`, and verifies
    // the atomic write-new-then-swap completes without an in-place
    // mutation of the primary file.
    if (trigger === "all" || trigger === "migration-resume") {
      await runMigrationResumeFlow(deps, log);
    }

    if (trigger === "all" || trigger === "settings") {
      runSettingsFlow(deps, log);
    }
    if (trigger === "all" || trigger === "index-start") {
      await runIndexFlow(deps, log);
    }
    if (trigger === "all" || trigger === "explain") {
      await runExplainFlow(deps, log);
    }
    if (trigger === "all" || trigger === "ask-question") {
      await runAskQuestionFlow(deps, log);
    }
    if (trigger === "all" || trigger === "citation-jump") {
      await runCitationJumpFlow(deps, log);
    }
    if (trigger === "all" || trigger === "sidebar-followup") {
      await runSidebarFlow(deps, log);
    }
    if (trigger === "all" || trigger === "anchored") {
      await runAnchoredExplainFlow(deps, log);
    }
    if (trigger === "all" || trigger === "close") {
      await runCloseAffordanceFlow(deps, log);
    }
    if (trigger === "all" || trigger === "scroll") {
      await runScrollFlow(deps, log);
    }
    if (trigger === "all" || trigger === "loading") {
      await runLoadingFlow(deps, log);
    }
    if (trigger === "all" || trigger === "popup-followup") {
      await runPopupFollowUpFlow(deps, log);
    }
    if (trigger === "all" || trigger === "honest-indexing") {
      runHonestIndexingFlow(deps, log);
    }
    if (trigger === "all" || trigger === "click-feedback") {
      await runClickFeedbackFlow(deps, log);
    }
    if (trigger === "all" || trigger === "real-pdf-teardown") {
      await runRealPdfTeardownFlow(deps, log);
    }
    log("done", "ok");
  } catch (err) {
    log("error", err instanceof Error ? err.message : String(err));
    log("done", "error");
  }
}

// ---------------------------------------------------------------------------
// Real-PDF setup prelude (AC2). Opens the sample PDF in the Zotero reader and
// captures the iframe document. FINDING-8 two-condition probe ensures the
// iframe is paintable before downstream phases dispatch reader events.
// ---------------------------------------------------------------------------

async function runRealPdfSetupFlow(
  deps: E2eDriverDeps,
  log: Logger
): Promise<{ readonly readyOk: boolean }> {
  log("phase", "real-pdf-setup:start");
  const pdfPath = deps.prefs.get(SAMPLE_PDF_PREF)?.trim();
  if (pdfPath === undefined || pdfPath.length === 0) {
    log("real-pdf-setup:error", "no-sample-pdf-pref");
    log("error", "no-sample-pdf-pref");
    log("phase", "real-pdf-setup:done");
    return { readyOk: false };
  }
  const zotero = deps.zotero as ZoteroGlobalWithApis;
  try {
    await zotero.initializationPromise;
    await zotero.uiReadyPromise;
  } catch (err) {
    log("real-pdf-setup:error", err instanceof Error ? err.message : String(err));
    log("error", "init-promise-failed");
    log("phase", "real-pdf-setup:done");
    return { readyOk: false };
  }

  // 0) Force the user library to fully load its items BEFORE we create
  // any. In production, the library is data-loaded long before the user
  // takes an action; in our e2e harness the trigger pref runs the driver
  // immediately after startup, so the data loader has not yet been
  // invoked. If we skip this step and the freshly-saved attachment is
  // not yet registered into `_objectCache` when `Reader.open` triggers
  // `library.waitForDataLoad('item')`, `_loadChildItems` throws
  // "Item <N> not loaded" (xpcom/data/items.js:793). Pre-loading the
  // library makes the cache state match the production happy path.
  try {
    const userLibrary = zotero.Libraries.get(zotero.Libraries.userLibraryID);
    await userLibrary.waitForDataLoad("item");
  } catch (err) {
    log("real-pdf-setup:error", err instanceof Error ? err.message : String(err));
    log("error", "library-data-load-failed");
    log("phase", "real-pdf-setup:done");
    return { readyOk: false };
  }

  // 1) Create the parent item.
  const parent = new zotero.Item("book");
  parent.setField("title", "E2E Sample PDF");
  const parentID = await parent.saveTx();
  log("real-pdf-setup:item-id", String(parentID));

  // 2) Attach the sample PDF.
  const attachment = await zotero.Attachments.importFromFile({
    file: zotero.File.pathToFile(pdfPath),
    parentItemID: parentID,
    title: "sample.pdf"
  });
  currentReaderAttachmentItemID = attachment.id;
  log("real-pdf-setup:attachment-id", String(attachment.id));

  // 3) Open the reader.
  try {
    await zotero.Reader.open(attachment.id);
  } catch (err) {
    log("real-pdf-setup:error", err instanceof Error ? err.message : String(err));
    log("error", "reader-open-threw");
    log("phase", "real-pdf-setup:done");
    return { readyOk: false };
  }

  // 4) Poll for iframe readiness — FINDING-8 verified two-condition probe.
  const readyOk = await waitForReaderIframe(zotero, attachment.id, 10_000);
  log("real-pdf-setup:iframe-ready", String(readyOk));
  if (!readyOk) {
    // FINDING-9: emit a structured error so the Vitest test surfaces the
    // failure mode unambiguously instead of waiting on the suite timeout.
    log("error", "reader-open-timeout");
    log("phase", "real-pdf-setup:done");
    return { readyOk: false };
  }
  const inst = zotero.Reader._readers.find((r) => r.itemID === attachment.id);
  currentReaderIframeDoc = inst?._iframeWindow?.document ?? null;
  currentReaderInstance = inst ?? null;
  log("phase", "real-pdf-setup:done");
  return { readyOk: true };
}

async function waitForReaderIframe(
  zotero: ZoteroGlobalWithApis,
  attachmentID: number,
  timeoutMs: number
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const inst = zotero.Reader._readers.find((r) => r.itemID === attachmentID);
    const win = inst?._iframeWindow;
    const doc = win?.document;
    // FINDING-8: verified two-condition probe.
    // (a) Chrome-side: `inst._internalReader` is non-null once
    //     `xpcom/reader.js:220` resolves (the createReader IIFE).
    // (b) Iframe-side: the React root has mounted a `<div class="toolbar">`
    //     (the reader bundle ships this stable class name; no
    //     `data-testid` attribute exists in the bundle).
    const internalReaderReady =
      inst?._internalReader !== null && inst?._internalReader !== undefined;
    if (
      win !== undefined &&
      doc?.readyState === "complete" &&
      internalReaderReady &&
      doc.querySelector(".toolbar") !== null
    ) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// ---------------------------------------------------------------------------
// AC-0 PDF.js entry-point smoke test (planner gate before AC-4).
//
// Proves `Zotero.PDFWorker.getFullText(attachmentID)` is reachable from the
// chrome process and returns the shape the plan's AC-4 work depends on:
// `{text, extractedPages, totalPages}` with page boundaries delimited by
// `\f` (omni.ja `pdfWorker/worker.js:107407-107419` — `\f` is pushed
// between pages, never after the final page, so an N-page PDF has exactly
// N-1 form-feeds and `text.split('\f').length === totalPages`).
//
// Emits, for the single-page `sample.pdf` imported by the prelude:
//   e2e:pdfworker:totalPages=<N>
//   e2e:pdfworker:extractedPages=<N>
//   e2e:pdfworker:formFeedCount=<count of '\f'>
//   e2e:pdfworker:splitLength=<text.split('\f').length>
//   e2e:pdfworker:firstPagePrefix=<first 20 chars of text.split('\f')[0]>
//   e2e:pdfworker:lastPagePrefix=<first 20 chars of the last page>
// Adversarial coverage:
//   - multi-page fixture (MULTIPAGE_PDF_PREF) → e2e:pdfworker:multipage:*
//   - corrupt/non-PDF fixture (CORRUPT_PDF_PREF) → e2e:pdfworker:corrupt:rejected
//
// A `getFullText` rejection on the primary fixture is surfaced as
// `e2e:pdfworker:error=<message>` rather than swallowed.
// ---------------------------------------------------------------------------

/** First 20 chars of a string, stripped of newlines/form-feeds so the value
 *  survives a single `e2e:<key>=<value>` log line cleanly. */
function pdfPrefix(text: string): string {
  return text.slice(0, 20).replace(/[\n\r\f]/gu, " ");
}

async function importPdfAttachment(
  zotero: ZoteroGlobalWithApis,
  path: string,
  title: string
): Promise<number> {
  const parent = new zotero.Item("book");
  parent.setField("title", `E2E ${title} parent`);
  const parentID = await parent.saveTx();
  const attachment = await zotero.Attachments.importFromFile({
    file: zotero.File.pathToFile(path),
    parentItemID: parentID,
    title
  });
  return attachment.id;
}

/**
 * Extract a PDF's full text and emit the AC-0 signal keys under `keyPrefix`
 * (`pdfworker` for the primary fixture, `pdfworker:multipage` for the
 * multi-page one). `formFeedCount` and `splitLength` are cross-emitted on
 * purpose: the test asserts both against `totalPages`, catching any
 * `split('\f')` / form-feed-count discrepancy in this gate.
 */
async function logPdfFullText(
  pdfWorker: NonNullable<ZoteroGlobalWithApis["PDFWorker"]>,
  attachmentID: number,
  keyPrefix: string,
  log: Logger
): Promise<void> {
  const result = await pdfWorker.getFullText(attachmentID);
  const pages = result.text.split("\f");
  log(`${keyPrefix}:totalPages`, String(result.totalPages));
  log(`${keyPrefix}:extractedPages`, String(result.extractedPages));
  log(`${keyPrefix}:formFeedCount`, String((result.text.match(/\f/gu) ?? []).length));
  log(`${keyPrefix}:splitLength`, String(pages.length));
  log(`${keyPrefix}:firstPagePrefix`, pdfPrefix(pages[0] ?? ""));
  log(`${keyPrefix}:lastPagePrefix`, pdfPrefix(pages.at(-1) ?? ""));
}

async function runPdfWorkerSmokeFlow(deps: E2eDriverDeps, log: Logger): Promise<void> {
  log("phase", "pdfworker-smoke:start");
  const zotero = deps.zotero as ZoteroGlobalWithApis;
  const pdfWorker = zotero.PDFWorker;
  if (pdfWorker === undefined || typeof pdfWorker.getFullText !== "function") {
    // The planner gate fails hard: `Zotero.PDFWorker.getFullText` is the
    // entire premise of AC-4. Surface it unambiguously.
    log("pdfworker:error", "no-pdfworker-getfulltext-api");
    log("phase", "pdfworker-smoke:done");
    return;
  }

  // --- Primary case: single-page sample.pdf imported by the prelude. ---
  const attachmentID = currentReaderAttachmentItemID;
  if (attachmentID === null) {
    log("pdfworker:error", "no-sample-attachment");
    log("phase", "pdfworker-smoke:done");
    return;
  }
  try {
    await logPdfFullText(pdfWorker, attachmentID, "pdfworker", log);
  } catch (err) {
    // Surface the rejection — never swallow it.
    log("pdfworker:error", err instanceof Error ? err.message : String(err));
    log("phase", "pdfworker-smoke:done");
    return;
  }

  // --- Adversarial: multi-page PDF exercises the `\f` page split. ---
  const multipagePath = deps.prefs.get(MULTIPAGE_PDF_PREF)?.trim();
  if (multipagePath !== undefined && multipagePath.length > 0) {
    try {
      const id = await importPdfAttachment(zotero, multipagePath, "multipage.pdf");
      await logPdfFullText(pdfWorker, id, "pdfworker:multipage", log);
    } catch (err) {
      log("pdfworker:multipage:error", err instanceof Error ? err.message : String(err));
    }
  }

  // --- Adversarial: corrupt/non-PDF fixture MUST make getFullText reject. ---
  const corruptPath = deps.prefs.get(CORRUPT_PDF_PREF)?.trim();
  if (corruptPath !== undefined && corruptPath.length > 0) {
    try {
      const id = await importPdfAttachment(zotero, corruptPath, "corrupt.pdf");
      const result = await pdfWorker.getFullText(id);
      // Reaching here means a corrupt PDF did NOT reject — a real defect.
      log("pdfworker:corrupt:rejected", "false");
      log("pdfworker:corrupt:unexpected-totalPages", String(result.totalPages));
    } catch (err) {
      log("pdfworker:corrupt:rejected", "true");
      log("pdfworker:corrupt:error", err instanceof Error ? err.message : String(err));
    }
  }

  log("phase", "pdfworker-smoke:done");
}

// ---------------------------------------------------------------------------
// AC-5 silent index migration (migration-resume flow). Seeds a legacy (pre-v2)
// index, runs the canonical `hydrate()` entry point, and asserts the atomic
// write-new-then-swap completes without an in-place mutation of the primary.
//
// Log-key contract (scraped by tests/e2e/migration-resume.e2e.test.ts):
//   e2e:migration:pending-before / schema-before / ran / schema-after /
//   marker-after / pending-after / primary-mutated-in-place
//   e2e:phase=migration-resume:start | migration-resume:done
// ---------------------------------------------------------------------------

/** A legacy (pre-v2) IndexFile — deliberately omits `schemaVersion`. */
function legacyMigrationFixture(): IndexFile {
  return {
    items: {
      LEGACYE2E: {
        title: "Legacy E2E Paper",
        chunks: [{ text: "legacy chunk body", embedding: [0.1, 0.2, 0.3] }]
      }
    },
    indexedAt: "2026-05-01T00:00:00.000Z"
  } as unknown as IndexFile;
}

async function runMigrationResumeFlow(deps: E2eDriverDeps, log: Logger): Promise<void> {
  log("phase", "migration-resume:start");
  const harness = deps.migrationHarness;
  if (harness === undefined) {
    // Older bootstrap build without the migration harness wiring. The
    // C1-C5 crash machine is covered by tests/indexing/migration.test.ts;
    // the e2e suite skips this flow rather than fail.
    log("migration:error", "no-migration-harness");
    log("phase", "migration-resume:done");
    return;
  }

  // Wrap the io adapter so we can observe whether ANY write targets the
  // primary index path directly — the atomic-migration invariant is
  // that only `rename` ever mutates the primary.
  let primaryWritePath: string | null = null;
  let seedComplete = false;
  let primaryWrittenInPlace = false;
  const spyIo: CreateIndexStorageDeps["io"] = {
    readString: (p) => harness.io.readString(p),
    async writeString(p, contents) {
      if (seedComplete && p === primaryWritePath) {
        // A direct write to the primary AFTER the seed would violate
        // the write-new-then-swap invariant.
        primaryWrittenInPlace = true;
      }
      await harness.io.writeString(p, contents);
    },
    remove: (p) => harness.io.remove(p),
    exists: (p) => harness.io.exists(p),
    rename: (src, dst) => harness.io.rename(src, dst),
    // AC-12: forward `stat` to the harness io adapter so the in-memory
    // index cache's fingerprint works under the e2e harness.
    stat: (p) => harness.io.stat(p)
  };

  const storage = createIndexStorage({
    zotero: { DataDirectory: { dir: harness.dataDir } },
    io: spyIo,
    embedProvider: harness.embedProvider
  });
  primaryWritePath = storage.path();

  try {
    // (a) Seed a legacy v1 index at the active path — simulates an
    //     index left by a v0.2.0 install.
    await storage.write(legacyMigrationFixture());
    seedComplete = true;

    // Probe BEFORE: a legacy file (no schemaVersion) is migration-pending.
    const before = await storage.readWithMigration();
    log("migration:pending-before", String(before.migrationPending));
    log("migration:schema-before", String(before.file?.schemaVersion ?? "legacy"));

    // (c) Build a controller on this storage and invoke `hydrate()` —
    //     the canonical migration entry point. (d) `hydrate()` awaits
    //     `runMigration()` internally.
    const controller = createIndexingController({
      logger: deps.zotero,
      zotero: harness.crawlerZotero,
      provider: harness.crawlerProvider,
      settings: harness.crawlerSettings,
      storage
    });
    await controller.hydrate();
    log("migration:ran", String(before.migrationPending));

    // Probe AFTER: the primary must be at the current schema version,
    // the marker gone, and a fresh probe must NOT re-fire (Adv-2).
    const after = await storage.readWithMigration();
    log("migration:schema-after", String(after.file?.schemaVersion ?? "missing"));
    log("migration:marker-after", String(await storage.hasMarker()));
    log("migration:pending-after", String(after.migrationPending));
    log("migration:primary-mutated-in-place", String(primaryWrittenInPlace));
  } catch (err) {
    log("migration:error", err instanceof Error ? err.message : String(err));
  }
  log("phase", "migration-resume:done");
}

// ---------------------------------------------------------------------------
// Real-PDF teardown (FINDING-17). Closes the reader tab so the next test run
// starts with a clean profile (even though the profile is wiped on afterAll).
// ---------------------------------------------------------------------------

async function runRealPdfTeardownFlow(deps: E2eDriverDeps, log: Logger): Promise<void> {
  log("phase", "real-pdf-teardown:start");
  const id = currentReaderAttachmentItemID;
  if (id === null) {
    log("real-pdf-teardown:closed", "false");
    log("phase", "real-pdf-teardown:done");
    return;
  }
  const zotero = deps.zotero as ZoteroGlobalWithApis;
  try {
    // `Zotero.Reader.close(id)` is not part of the Reader manager class in
    // Zotero 9 — `close()` is an instance method. Prefer the instance
    // method; fall back to `Zotero_Tabs.close(tabID)` if the instance is
    // gone for any reason.
    const inst = zotero.Reader._readers.find((r) => r.itemID === id);
    if (inst !== undefined && typeof inst.close === "function") {
      await inst.close();
    } else if (typeof zotero.Reader.close === "function") {
      await zotero.Reader.close(id);
    } else if (inst?.tabID !== undefined && zotero.Zotero_Tabs?.close !== undefined) {
      zotero.Zotero_Tabs.close(inst.tabID);
    } else {
      log("real-pdf-teardown:closed", "false");
      log("real-pdf-teardown:error", "no-close-api-available");
      log("phase", "real-pdf-teardown:done");
      return;
    }
    log("real-pdf-teardown:closed", "true");
  } catch (err) {
    log("real-pdf-teardown:closed", "false");
    log("real-pdf-teardown:error", err instanceof Error ? err.message : String(err));
  }
  currentReaderIframeDoc = null;
  currentReaderInstance = null;
  currentReaderAttachmentItemID = null;
  log("phase", "real-pdf-teardown:done");
}

// ---------------------------------------------------------------------------
// Settings + index flows (legacy non-adversarial flows; kept with mild
// adjustments so the new test's migration-window key shims still pass).
// ---------------------------------------------------------------------------

function runSettingsFlow(deps: E2eDriverDeps, log: Logger): void {
  log("phase", "settings:start");
  log("settings:base-url", deps.settings.baseUrl);
  const view = renderSettingsView({
    settings: deps.settings,
    indexStatus: deps.indexingController.getStatus()
  });
  const detach = attachIndexControls(view, deps.indexingController);
  const dialogHandle = deps.ui.openDialog("Zotero AI Explain", view);
  const document = getDocument(deps.zotero);
  // The backdrop element is not reachable from `view` (it is a sibling
  // of the dialog created by `openDialog`), so it stays a document-level
  // query. The dialog-content checks below scope to `view` — the live
  // element this flow mounted — so an un-closed prior dialog can never
  // satisfy them.
  const backdrop = document?.querySelector(".zotero-ai-dialog-backdrop");
  const dialog = view.closest(".zotero-ai-dialog");
  const backdropPresent = backdrop !== null && backdrop !== undefined;
  const dialogPresent = dialog !== null;
  const present = backdropPresent && dialogPresent;
  log("settings:backdrop-present", String(backdropPresent));
  log("settings:dialog-present", String(dialogPresent));
  log("settings:dialog-rendered", String(present));
  const baseUrlInput = view.querySelector<HTMLInputElement>('[name="baseUrl"]');
  log("settings:baseUrl-value", baseUrlInput?.value ?? "<missing>");
  log("settings:base-url-input", baseUrlInput?.value ?? "<missing>");
  const chatInput = view.querySelector<HTMLInputElement>('[name="chatModel"]');
  log("settings:chatModel-value", chatInput?.value ?? "<missing>");
  // Close THIS dialog via its own handle. A global
  // `querySelector('[data-action="close-dialog"]')` closes whichever
  // dialog is first in DOM order — if the first-run onboarding dialog is
  // still open it absorbs the close-click, leaving this dialog mounted
  // and its (now detached) controls reachable by later global queries.
  dialogHandle.close();
  detach();
  log("phase", "settings:done");
}

async function runIndexFlow(deps: E2eDriverDeps, log: Logger): Promise<void> {
  log("phase", "index:start");
  const view = renderSettingsView({
    settings: deps.settings,
    indexStatus: deps.indexingController.getStatus()
  });
  const detach = attachIndexControls(view, deps.indexingController);
  // Capture the dialog handle and close it via `handle.close()` at the
  // end. A global `document.querySelector('[data-action="close-dialog"]')`
  // closes whichever dialog appears FIRST in DOM order — when the
  // first-run onboarding dialog ("Set up Ollama") is still open, that
  // close-click hits the onboarding dialog and leaves THIS dialog
  // mounted. Stale dialogs then accumulate, and a later global
  // `querySelector('[data-action="start-index"]')` returns the first
  // (detached-handler) button — clicking it is a silent no-op.
  const dialog = deps.ui.openDialog("Zotero AI Explain", view);
  // Scope every control lookup to `view` — the live dialog content this
  // flow just mounted — so a stale prior dialog's buttons can never be
  // picked up by a global document query.
  const summary = view.querySelector<HTMLElement>(".zotero-ai-index-controls__summary");
  log("index:summary-before", summary?.textContent ?? "<missing>");

  const startBtn = view.querySelector<HTMLButtonElement>('[data-action="start-index"]');
  startBtn?.click();
  log("index:started", "true");
  log("index:summary-after-start", summary?.textContent ?? "<missing>");
  log("index:status-after-start", deps.indexingController.getStatus().state);

  // Drive pause SYNCHRONOUSLY while the controller is still in `running`.
  // With a single tiny attachment to index against the fake server, the
  // crawler can complete before any awaitable yield — driving pause
  // immediately catches the live state. The reducer's pause action is
  // a no-op outside `running` (FINDING-6), so if the run already
  // resolved, the summary reflects `complete` and the test's loose
  // `/pause/` regex on the pause snapshot would not match. To make the
  // observable transition deterministic, the loop below polls until we
  // see either `paused` (success) or `complete` (race won by crawler),
  // then logs the snapshot accordingly.
  const pauseBtn = view.querySelector<HTMLButtonElement>('[data-action="pause-index"]');
  pauseBtn?.click();
  await waitFor(
    () => {
      const s = deps.indexingController.getStatus().state;
      return s === "paused" || s === "complete" || s === "failed";
    },
    5000,
    25
  );
  log("index:summary-after-pause", summary?.textContent ?? "<missing>");
  log("index:status-after-pause", deps.indexingController.getStatus().state);

  const resumeBtn = view.querySelector<HTMLButtonElement>('[data-action="resume-index"]');
  resumeBtn?.click();
  log("index:summary-after-resume", summary?.textContent ?? "<missing>");
  log("index:status-after-resume", deps.indexingController.getStatus().state);

  // Give the resumed crawler a chance to either complete or to make at
  // least one more embed call before we clear the index file.
  await waitFor(
    () =>
      deps.indexingController.getStatus().state === "complete" ||
      deps.indexingController.getStatus().state === "idle",
    8000,
    50
  );

  const clearBtn = view.querySelector<HTMLButtonElement>('[data-action="clear-index"]');
  // AC-14 Fix 2: the Clear button is a two-stage in-view confirm. The
  // first click only ARMS the confirm (relabels to "Confirm clear"); the
  // second click on the relabelled button drives the real `clear()`.
  clearBtn?.click(); // arm the confirm
  clearBtn?.click(); // confirm → dispatches the real clear()
  // clear() returns a Promise<void>; the view glue fire-and-forgets. Give
  // the storage flush + reducer transition a moment to settle so the
  // summary text reflects the cleared state.
  await waitFor(() => deps.indexingController.getStatus().state === "idle", 2000, 50);
  log("index:summary-after-clear", summary?.textContent ?? "<missing>");
  log("index:status-after-clear", deps.indexingController.getStatus().state);

  // AC3+AC4 e2e expectation: the index file `<dataDir>/zotero-ai-explain-index.json`
  // must exist with ≥1 indexed item AFTER the driver completes. Clear
  // removed it; re-run the crawl so it persists.
  startBtn?.click();
  await waitFor(() => deps.indexingController.getStatus().state === "complete", 10_000, 50);
  log("index:final-status", deps.indexingController.getStatus().state);
  log("index:final-summary", summary?.textContent ?? "<missing>");

  dialog.close();
  detach();
  log("phase", "index:done");
}

// ---------------------------------------------------------------------------
// Explain + sidebar flows (legacy non-adversarial). Drive the popup/sidebar
// controllers directly via in-memory store + ui adapter; these do not need
// the real iframe.
// ---------------------------------------------------------------------------

async function runExplainFlow(deps: E2eDriverDeps, log: Logger): Promise<void> {
  log("phase", "explain:start");
  const selection: SelectionContext = {
    quote: "E2E selected quote.",
    source: {
      itemKey: "e2e-item",
      itemTitle: "E2E Source",
      attachmentKey: "e2e-attach",
      pageLabel: "1",
      pageIndex: 0
    },
    anchor: null
  };
  const conversation = deps.store.createFromSelection(selection, deps.profile());
  deps.store.appendUserMessage(conversation.id, `Explain this: ${selection.quote}`);
  driverExplainContext = { conversationId: conversation.id, selection };

  const popup = renderAnchoredPopup({
    disclosure: deps.disclosure(),
    anchor: selection.anchor,
    text: ""
  });
  const body = popup.querySelector<HTMLElement>(".zotero-ai-explain-popup__body");

  const popupUnmount: Unsubscribe = deps.ui.mountPopup(popup);
  const popupUnsubscribe = deps.store.subscribe(conversation.id, (updated) => {
    if (body === null) {
      return;
    }
    const assistant =
      updated.messages.findLast((message) => message.role === "assistant")?.content ?? "";
    if (assistant.length > 0) {
      body.textContent = assistant;
    } else if (updated.status === "failed" && updated.errorMessage !== null) {
      body.textContent = `Error: ${updated.errorMessage}`;
    }
  });

  log("explain:popup-mounted", "true");
  log("explain:conversation-id", conversation.id);

  await deps.popupController.explain(conversation.id);
  const finalConversation = deps.store.get(conversation.id);
  log("explain:status", finalConversation?.status ?? "<missing>");
  log("explain:popup-body-text", body?.textContent ?? "<missing>");
  log(
    "explain:assistant-text",
    finalConversation?.messages.findLast((message) => message.role === "assistant")?.content ??
      "<missing>"
  );

  popupUnsubscribe();
  popupUnmount();
  log("phase", "explain:done");
}

/**
 * AC-1: exercise the "Ask a question" reader command end-to-end.
 *
 * Two complementary paths (mirroring runExplainFlow + runAnchoredExplainFlow):
 *   - Real-reader path: dispatch a `renderTextSelectionPopup` event, find
 *     the "Ask a question" command button, click it, and inspect the
 *     anchored popup it mounts (quote block, focused textarea, no
 *     auto-stream). Also dispatches an EMPTY-selection event to confirm
 *     the command is hidden.
 *   - Store path: drive an ask-question conversation directly through
 *     `deps.store` + `deps.popupController`, replicating `startAskQuestion`'s
 *     framing, so the framed first turn and the turn-5 system frame are
 *     inspectable (the runtime-created conversation id is not otherwise
 *     observable from the driver).
 */
async function runAskQuestionFlow(deps: E2eDriverDeps, log: Logger): Promise<void> {
  log("phase", "ask-question:start");

  // ---- Real-reader path: command presence + popup behaviour ----
  const askSelectionText = "Ask-question selected passage.";
  const { iframeDoc, buttonHost } = dispatchRealReaderEvent(deps, log, {
    phase: "ask-question",
    selectionText: askSelectionText,
    buttonContainerStyle: "position: absolute; left: 70px; top: 200px;"
  });
  if (iframeDoc === null || buttonHost === null) {
    log("phase", "ask-question:done");
    return;
  }
  const askButton = buttonHost.querySelector<HTMLElement>("button[data-action='ask-question']");
  log("ask-question:command-present", String(askButton !== null));
  if (askButton === null) {
    log("ask-question:error", "no-ask-button-captured");
    buttonHost.remove();
    log("phase", "ask-question:done");
    return;
  }
  askButton.click();
  const chromeDoc = getDocument(deps.zotero);
  if (chromeDoc === null) {
    log("ask-question:error", "no-chrome-doc");
    buttonHost.remove();
    log("phase", "ask-question:done");
    return;
  }
  const wrapper = await waitForPopup(chromeDoc, 5000);
  log("ask-question:popup-mounted", String(wrapper !== null));
  if (wrapper === null) {
    buttonHost.remove();
    log("phase", "ask-question:done");
    return;
  }
  const quoteBlock = wrapper.querySelector<HTMLElement>(".zotero-ai-explain-popup__quote");
  log("ask-question:quote-block-text", (quoteBlock?.textContent ?? "").trim());
  const askTextarea = findFollowUpTextarea(wrapper);
  // The textarea is focused on mount via requestAnimationFrame; give the
  // frame a tick to run before sampling document.activeElement.
  await waitForCondition(() => chromeDoc.activeElement === askTextarea, 2000, chromeDoc);
  log("ask-question:textarea-focused", String(chromeDoc.activeElement === askTextarea));
  // No auto-explain: opening an ask-question popup must not stream an
  // assistant turn. The body stays empty and no assistant turn appears.
  const autoStreamed =
    (wrapper.querySelector<HTMLElement>(".zotero-ai-explain-popup__body")?.textContent ?? "").trim()
      .length > 0 || wrapper.querySelector("[data-role='assistant']") !== null;
  log("ask-question:auto-streamed", String(autoStreamed));

  // Empty-textarea submit must be a rejected no-op — no assistant turn,
  // no streaming. Submit with an empty textarea and confirm nothing ran.
  let emptySubmitRejected = true;
  if (askTextarea !== null) {
    askTextarea.value = "";
    const form = askTextarea.closest<HTMLFormElement>("form");
    if (form !== null) {
      const win = chromeDoc.defaultView;
      const EventCtor = win?.Event ?? globalThis.Event;
      form.dispatchEvent(new EventCtor("submit", { bubbles: true, cancelable: true }));
    }
    await waitFor(() => false, 300, 50);
    const liveWrapper = findPopupWrapper(chromeDoc);
    emptySubmitRejected =
      liveWrapper === null ||
      ((
        liveWrapper.querySelector<HTMLElement>(".zotero-ai-explain-popup__body")?.textContent ?? ""
      ).trim().length === 0 &&
        liveWrapper.querySelector("[data-role='assistant']") === null);
  }
  log("ask-question:empty-submit-rejected", String(emptySubmitRejected));
  findPopupWrapper(chromeDoc)?.remove();
  buttonHost.remove();

  // ---- Empty selection hides the command ----
  const emptyEvent = dispatchRealReaderEvent(deps, log, {
    phase: "ask-question-empty",
    selectionText: "",
    buttonContainerStyle: "position: absolute; left: 70px; top: 260px;"
  });
  const emptyHost = emptyEvent.buttonHost;
  const hiddenWhenNoSelection =
    (emptyHost?.querySelector("button[data-action='ask-question']") ?? null) === null;
  log("ask-question:hidden-when-no-selection", String(hiddenWhenNoSelection));
  emptyHost?.remove();

  // ---- Store path: framed first turn + sticky-quote system frame ----
  const selection: SelectionContext = {
    quote: askSelectionText,
    source: {
      itemKey: "e2e-ask-item",
      itemTitle: "E2E Ask Source",
      attachmentKey: "e2e-ask-attach",
      pageLabel: "1"
    },
    anchor: null
  };
  const conversation = deps.store.createFromSelection(selection, deps.profile());
  // Sticky-quote system frame seeded at conversation creation — rides
  // every turn (mirrors startAskQuestion).
  deps.store.appendSystemMessage(
    conversation.id,
    `The user is asking about this quoted passage: "${selection.quote}"`
  );
  // First turn: framed `Quote: "..."\n\nQuestion: ...`.
  await deps.popupController.sendFollowUp(
    conversation.id,
    `Quote: "${selection.quote}"\n\nQuestion: First question about the passage?`
  );
  const afterFirst = deps.store.get(conversation.id);
  const firstTurn = afterFirst?.messages.find((m) => m.role === "user")?.content ?? "<missing>";
  log("ask-question:first-turn", firstTurn.replace(/[\n\r]/gu, " "));

  // Drive to turn 5 (four more Q&A turns) and confirm the system frame
  // still carries the quote.
  for (let turn = 2; turn <= 5; turn += 1) {
    await deps.popupController.sendFollowUp(conversation.id, `Follow-up question ${String(turn)}?`);
  }
  const afterFive = deps.store.get(conversation.id);
  const systemFrame = afterFive?.messages.find((m) => m.role === "system")?.content ?? "";
  const userTurnCount = afterFive?.messages.filter((m) => m.role === "user").length ?? 0;
  log(
    "ask-question:turn5-has-quote",
    String(userTurnCount >= 5 && systemFrame.includes(selection.quote))
  );

  log("phase", "ask-question:done");
}

// ---------------------------------------------------------------------------
// AC-7 / AC-9 citation jump-to-page (`citation-jump` flow). Builds a
// library-chat turn whose retrieved chunks include TWO chunks from the SAME
// parent item but DIFFERENT pages, renders the assistant answer through the
// production `renderLibraryChatView` + `wireLibraryChatView`, clicks each
// citation, and observes the resulting `Zotero.Reader.open` calls.
//
// `Zotero.Reader.open` is wrapped so the flow can inspect the ACTUAL argument
// shape — AC-7 requires `pageIndex` to ride as the SECOND POSITIONAL arg
// (`open(attachmentId, { pageIndex })`), NOT nested under `{ location: ... }`.
//
// Log-key contract (scraped by tests/e2e/pdf-citation-jump.e2e.test.ts):
//   e2e:citation-jump:chunk0-page / chunk0-arg-shape / chunk1-page /
//   same-tab-navigated / reader-tab-count / nolocation-open /
//   nolocation-page-arg / hallucinated-routed-to-chunk0 /
//   prompt-has-distinct-labels
//   e2e:phase=citation-jump:start | citation-jump:done
// ---------------------------------------------------------------------------

/** Minimal item shape the citation-jump flow reads off `Zotero.Items.get`. */
type CitationJumpItem = {
  readonly id: number;
  readonly key: string;
  readonly parentItemID?: number | false;
};

/**
 * A captured `Zotero.Reader.open` call. `argShape` is `positional` when the
 * second argument is `{ pageIndex }`, `nested-location` when it is
 * `{ location: ... }`, and `none` when there is no second argument.
 */
type CapturedReaderOpen = {
  readonly attachmentId: number;
  readonly pageIndex: number | undefined;
  readonly argShape: "positional" | "nested-location" | "none";
};

/** Classify the second positional argument of a `Reader.open` call. */
function classifyReaderOpenArg(location: unknown): CapturedReaderOpen["argShape"] {
  if (location === undefined || location === null) {
    return "none";
  }
  if (typeof location === "object" && "location" in location) {
    return "nested-location";
  }
  if (typeof location === "object" && "pageIndex" in location) {
    return "positional";
  }
  return "none";
}

async function runCitationJumpFlow(deps: E2eDriverDeps, log: Logger): Promise<void> {
  log("phase", "citation-jump:start");

  const attachmentID = currentReaderAttachmentItemID;
  if (attachmentID === null) {
    log("citation-jump:error", "no-sample-attachment");
    log("phase", "citation-jump:done");
    return;
  }
  const zotero = deps.zotero as ZoteroGlobalWithApis & {
    readonly Items: { get(id: number): CitationJumpItem | null };
  };

  // Resolve the cited item's 8-char Zotero key. `openCitationInReader`
  // looks the item up by key, so the citation tokens must carry the
  // PARENT item's key (the PDF rides as its child attachment).
  let citedItemKey: string | null = null;
  let attachmentKey: string | null = null;
  try {
    const attachmentItem = zotero.Items.get(attachmentID);
    attachmentKey = attachmentItem?.key ?? null;
    const parentID = attachmentItem?.parentItemID;
    if (typeof parentID === "number") {
      citedItemKey = zotero.Items.get(parentID)?.key ?? null;
    } else {
      // No parent — the attachment is itself the cited item.
      citedItemKey = attachmentKey;
    }
  } catch (err) {
    log("citation-jump:error", err instanceof Error ? err.message : String(err));
    log("phase", "citation-jump:done");
    return;
  }
  if (citedItemKey === null || !/^[A-Z0-9]{8}$/u.test(citedItemKey)) {
    log("citation-jump:error", `bad-item-key:${citedItemKey ?? "null"}`);
    log("phase", "citation-jump:done");
    return;
  }

  // Wrap `Zotero.Reader.open` so the flow observes the actual call shape.
  // The wrapper forwards to the real implementation so the reader still
  // navigates — AC-7's "second click navigates the same tab" depends on
  // the genuine `Reader.open` behavior.
  const reader = zotero.Reader as unknown as {
    open: (id: number, location?: unknown) => unknown;
    readonly _readers: readonly { readonly itemID: number }[];
  };
  const realOpen = reader.open.bind(reader);
  const captured: CapturedReaderOpen[] = [];
  const wrappedReader = {
    open: (id: number, location?: unknown) => {
      const argShape = classifyReaderOpenArg(location);
      const pageIndex =
        argShape === "positional" && typeof location === "object" && location !== null
          ? (location as { pageIndex?: number }).pageIndex
          : undefined;
      captured.push({ attachmentId: id, pageIndex, argShape });
      return realOpen(id, location);
    }
  };
  // `openCitationInReader` only reads `Reader.open` / `Items` / `Libraries`.
  const citationZotero = {
    Items: zotero.Items as unknown as Parameters<typeof openCitationInReader>[1]["Items"],
    Libraries: (zotero as unknown as { Libraries?: { userLibraryID: number } }).Libraries,
    Reader: wrappedReader
  } as unknown as Parameters<typeof openCitationInReader>[1];

  // Two chunks of the SAME parent item on DIFFERENT pages (AC-9 collision).
  const chunk0Page = 2;
  const chunk1Page = 17;
  const retrieved: readonly RetrievedChunk[] = [
    {
      itemKey: citedItemKey,
      title: "E2E Sample PDF",
      text: "Chunk zero body on an early page.",
      score: 0.99,
      chunkIndex: 0,
      pageIndex: chunk0Page,
      sourceKind: "pdf-page",
      ...(attachmentKey !== null ? { attachmentKey } : {})
    },
    {
      itemKey: citedItemKey,
      title: "E2E Sample PDF",
      text: "Chunk one body on a much later page.",
      score: 0.95,
      chunkIndex: 1,
      pageIndex: chunk1Page,
      sourceKind: "pdf-page",
      ...(attachmentKey !== null ? { attachmentKey } : {})
    }
  ];

  // (a) The prompt must label the two same-item chunks distinctly.
  const prompt = buildLibraryPrompt({ question: "What does the sample cover?", chunks: retrieved });
  const label0 = `[${citedItemKey}#0]`;
  const label1 = `[${citedItemKey}#1]`;
  const distinctLabels = prompt.includes(label0) && prompt.includes(label1) && label0 !== label1;
  log("citation-jump:prompt-has-distinct-labels", String(distinctLabels));

  const lookup: CitationLookup = buildCitationLookup(retrieved);

  // Render the assistant answer through the production view + wiring so
  // the click delegate, the data-attribute stamping, and the citation
  // payload all run exactly as they do for a real chat turn.
  const onCitationClick = (citation: CitationClick): void => {
    openCitationInReader(citation, citationZotero);
  };
  const renderAndClick = (assistantContent: string, turnLookup: CitationLookup): void => {
    const view = renderLibraryChatView({
      messages: [{ role: "assistant", content: assistantContent }],
      status: "completed",
      errorMessage: null,
      hasIndex: true,
      citationLookups: new Map<number, CitationLookup>([[0, turnLookup]])
    });
    const detach = wireLibraryChatView({
      view,
      onSubmit: () => Promise.resolve(),
      onReset: () => undefined,
      onCitationClick
    });
    for (const link of Array.from(view.querySelectorAll<HTMLAnchorElement>("a[data-item-key]"))) {
      link.click();
    }
    detach();
  };

  // (b) Click the chunk-#0 citation; (c) click the chunk-#1 citation in the
  // SAME already-open reader. Both citations rendered in one turn so both
  // clicks land before any assertion.
  renderAndClick(`Claim zero ${label0}. Claim one ${label1}.`, lookup);
  // Let the two `Reader.open` navigations settle before counting tabs.
  await waitFor(() => false, 400, 100);

  const chunk0Call = captured.find((c) => c.pageIndex === chunk0Page);
  const chunk1Call = captured.find((c) => c.pageIndex === chunk1Page);
  log("citation-jump:chunk0-page", String(chunk0Call?.pageIndex ?? "undefined"));
  log("citation-jump:chunk0-arg-shape", chunk0Call?.argShape ?? "none");
  log("citation-jump:chunk1-page", String(chunk1Call?.pageIndex ?? "undefined"));

  // Both clicks targeted the same attachment — the reader must have
  // navigated its existing tab, not spawned a duplicate.
  const sameAttachment =
    chunk0Call !== undefined && chunk0Call.attachmentId === chunk1Call?.attachmentId;
  const readerTabCount = reader._readers.filter((r) => r.itemID === attachmentID).length;
  log("citation-jump:same-tab-navigated", String(sameAttachment && readerTabCount === 1));
  log("citation-jump:reader-tab-count", String(readerTabCount));

  // (d) A citation whose chunk has NO pageIndex opens with no location arg.
  const noPageChunk: RetrievedChunk = {
    itemKey: citedItemKey,
    title: "E2E Sample PDF",
    text: "Metadata chunk with no page.",
    score: 0.9,
    chunkIndex: 0,
    sourceKind: "metadata"
  };
  const noPageLookup = buildCitationLookup([noPageChunk]);
  captured.length = 0;
  renderAndClick(`Legacy-style claim [${citedItemKey}#0].`, noPageLookup);
  const noPageCall = captured.at(-1);
  log("citation-jump:nolocation-open", String(noPageCall?.argShape === "none"));
  log(
    "citation-jump:nolocation-page-arg",
    noPageCall?.pageIndex === undefined ? "absent" : String(noPageCall.pageIndex)
  );

  // (e) A hallucinated [WRONGKEY#0] token must NOT route to chunk-0's true
  // source. WRONGKEY is a well-formed 8-char key absent from the lookup.
  const wrongKey = "WRONGKEY";
  captured.length = 0;
  renderAndClick(`Hallucinated cite [${wrongKey}#0].`, lookup);
  const hallucinatedCall = captured.at(-1);
  // The fallback resolves WRONGKEY (not in the library) -> `openCitationInReader`
  // returns `not-found`, so no `Reader.open` runs. It must NEVER open the
  // real cited attachment at chunk-0's page.
  const routedToChunk0 =
    hallucinatedCall?.attachmentId === attachmentID && hallucinatedCall.pageIndex === chunk0Page;
  log("citation-jump:hallucinated-routed-to-chunk0", String(routedToChunk0));

  log("phase", "citation-jump:done");
}

async function runSidebarFlow(deps: E2eDriverDeps, log: Logger): Promise<void> {
  log("phase", "sidebar:start");
  const ctx = driverExplainContext;
  if (ctx === null) {
    log("sidebar:error", "no-explain-context");
    log("phase", "sidebar:done");
    return;
  }
  deps.popupController.continueInSidebar(ctx.conversationId);
  const current = deps.store.get(ctx.conversationId);
  if (current === null) {
    log("sidebar:error", "conversation-missing");
    log("phase", "sidebar:done");
    return;
  }
  const sidebarView = renderSidebarConversation({
    quote: ctx.selection.quote,
    sourceLabel: ctx.selection.source.itemTitle ?? "Unknown",
    messages: current.messages
  });
  const sidebarMessages = sidebarView.querySelector<HTMLOListElement>(
    ".zotero-ai-explain-sidebar__messages"
  );
  const form = sidebarView.querySelector<HTMLFormElement>(".zotero-ai-explain-sidebar__form");
  const textarea = sidebarView.querySelector<HTMLTextAreaElement>('[name="followUp"]');
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = textarea?.value ?? "";
    if (textarea) {
      textarea.value = "";
    }
    void deps.sidebarController.sendFollowUp(ctx.conversationId, value);
  });
  const unsubscribe = deps.store.subscribe(ctx.conversationId, (updated) => {
    const list = sidebarMessages;
    if (list === null) {
      return;
    }
    const rows = updated.messages.map((message) => {
      const row = list.ownerDocument.createElement("li");
      row.dataset.role = message.role;
      row.textContent = `${message.role}: ${message.content}`;
      return row;
    });
    list.replaceChildren(...rows);
  });
  const sidebarUnmount = deps.ui.mountSidebar(sidebarView);
  log("sidebar:mounted", "true");
  log("sidebar:handoff-rendered", "true");
  log("sidebar:message-count-before", String(current.messages.length));

  if (textarea) {
    textarea.value = "Follow up question?";
  }
  await deps.sidebarController.sendFollowUp(ctx.conversationId, "Follow up question?");
  const updated = deps.store.get(ctx.conversationId);
  log("sidebar:message-count-after", String(updated?.messages.length ?? 0));
  log("sidebar:last-message-role", updated?.messages.at(-1)?.role ?? "<missing>");
  log("sidebar:last-message-content", updated?.messages.at(-1)?.content ?? "<missing>");
  log("sidebar:assistant-content", updated?.messages.at(-1)?.content ?? "<missing>");

  unsubscribe();
  sidebarUnmount();
  log("phase", "sidebar:done");
}

// ---------------------------------------------------------------------------
// Helpers shared by the adversarial flows. Each phase dispatches through
// the production `Zotero.Reader._dispatchEvent` against the real iframe
// document captured by the prelude.
// ---------------------------------------------------------------------------

function getDocument(zotero: ZoteroGlobal): Document | null {
  const win = zotero.getMainWindow?.();
  return win?.document ?? null;
}

function findPopupWrapper(document: Document): HTMLElement | null {
  return document.querySelector<HTMLElement>(".zotero-ai-popup-wrapper");
}

function findCloseAffordance(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>(
    "[data-action='close-popup'], [aria-label='Close'], .zotero-ai-explain-popup__close"
  );
}

function findFollowUpTextarea(wrapper: HTMLElement): HTMLTextAreaElement | null {
  return wrapper.querySelector<HTMLTextAreaElement>(
    "textarea[name='followUp'], [data-action='popup-followup'], textarea"
  );
}

function findFollowUpSubmit(wrapper: HTMLElement): HTMLButtonElement | null {
  const explicit = wrapper.querySelector<HTMLButtonElement>(
    "[data-action='submit-followup'], [data-action='popup-followup-submit'], [data-action='send-follow-up']"
  );
  if (explicit !== null) {
    return explicit;
  }
  return wrapper.querySelector<HTMLButtonElement>("button[type='submit']");
}

function findLoadingIndicator(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>(
    "[data-state='loading'], [role='status'], .zotero-ai-explain-popup__loading"
  );
}

function isVisibleElement(el: HTMLElement | null): boolean {
  if (el === null) {
    return false;
  }
  if (el.hasAttribute("hidden")) {
    return false;
  }
  const style = el.getAttribute("style") ?? "";
  if (/display:\s*none/iu.test(style)) {
    return false;
  }
  if (/visibility:\s*hidden/iu.test(style)) {
    return false;
  }
  return true;
}

function waitForPopup(document: Document, timeoutMs = 5000): Promise<HTMLElement | null> {
  return new Promise((resolveWait) => {
    const start = Date.now();
    const tick = (): void => {
      const w = findPopupWrapper(document);
      if (w !== null) {
        resolveWait(w);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolveWait(null);
        return;
      }
      const win = document.defaultView;
      win?.setTimeout(tick, 25);
    };
    tick();
  });
}

function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  document: Document
): Promise<boolean> {
  return new Promise((resolveWait) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolveWait(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolveWait(false);
        return;
      }
      const win = document.defaultView;
      win?.setTimeout(tick, 25);
    };
    tick();
  });
}

/**
 * Pure-timer wait that does not depend on a Document. Used by the index
 * flow (which observes controller status, not DOM).
 */
async function waitFor(predicate: () => boolean, timeoutMs: number, stepMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
  }
}

/**
 * Dispatch a `renderTextSelectionPopup` event through the production
 * `Zotero.Reader._dispatchEvent`. The host div is created INSIDE the real
 * iframe document at a known iframe-local rect; the registered handler
 * appends the explain button into the host. Returns the host so the
 * caller can find the captured button and click it.
 */
function dispatchRealReaderEvent(
  _deps: E2eDriverDeps,
  log: Logger,
  options: {
    readonly phase: string;
    readonly selectionText: string;
    readonly buttonContainerStyle: string;
  }
): { readonly iframeDoc: Document | null; readonly buttonHost: HTMLElement | null } {
  const iframeDoc = currentReaderIframeDoc;
  if (iframeDoc === null) {
    log(`${options.phase}:error`, "no-iframe-doc");
    return { iframeDoc: null, buttonHost: null };
  }
  // Iframe-local host. The production handler appends the explain button
  // into this host; the button inherits the host's position so it reports
  // a stable iframe-local rect when clicked.
  const host = iframeDoc.createElement("div");
  host.dataset.testid = `${options.phase}-host`;
  host.setAttribute("style", options.buttonContainerStyle);
  const body = iframeDoc.body as HTMLElement | null;
  if (body !== null) {
    body.append(host);
  } else {
    iframeDoc.documentElement.append(host);
  }
  // CRITICAL: dispatch via Zotero's REAL customEvent bridge
  // (xpcom/reader.js:178-186), not by calling `_dispatchEvent` directly with
  // a chrome-side event. The bridge unwraps via `event.detail.wrappedJSObject`
  // and then assigns `data.reader = this`. The plugin handler subsequently
  // sees `event` as an iframe-side object viewed across an Xray wrapper —
  // which HIDES underscore-prefixed properties like `_iframe`. The previous
  // harness path bypassed this and gave false confidence that production
  // could read `event.reader._iframe` directly.
  const iframeWin = iframeDoc.defaultView;
  if (iframeWin === null) {
    log(`${options.phase}:error`, "no-iframe-window");
    return { iframeDoc, buttonHost: null };
  }
  const append = (content: unknown): void => {
    const HtmlElementCtor = iframeWin.HTMLElement;
    if (content instanceof HtmlElementCtor) {
      host.append(content);
      content.style.minHeight = "28px";
      content.style.padding = "4px 8px";
      content.style.boxSizing = "border-box";
      return;
    }
    const labelled = content as { readonly label: string; readonly onCommand: () => void };
    const btn = iframeDoc.createElement("button");
    btn.type = "button";
    btn.textContent = labelled.label;
    btn.style.minHeight = "28px";
    btn.style.padding = "4px 8px";
    btn.style.boxSizing = "border-box";
    btn.addEventListener("click", () => {
      labelled.onCommand();
    });
    host.append(btn);
  };
  const detailChrome = {
    type: "renderTextSelectionPopup",
    doc: iframeDoc,
    params: { annotation: { text: options.selectionText } },
    append
  };
  const Cu = (
    globalThis as unknown as {
      Components?: {
        utils?: { cloneInto: (obj: unknown, scope: unknown, options?: object) => unknown };
      };
    }
  ).Components?.utils;
  if (Cu === undefined) {
    log(`${options.phase}:error`, "no-components-utils");
    return { iframeDoc, buttonHost: null };
  }
  const detailIframeSide = Cu.cloneInto(detailChrome, iframeWin, {
    wrapReflectors: true,
    cloneFunctions: true
  });
  const customEv = new iframeWin.CustomEvent("customEvent", {
    detail: detailIframeSide as object
  });
  iframeWin.dispatchEvent(customEv);
  log(`${options.phase}:dispatch`, "real-customEvent-bridge");
  return { iframeDoc, buttonHost: host };
}

function rectCsv(
  rect: DOMRect | { left: number; top: number; width: number; height: number }
): string {
  return `${String(rect.left)},${String(rect.top)},${String(rect.width)},${String(rect.height)}`;
}

// ---------------------------------------------------------------------------
// Adversarial flows. Each one (a) dispatches a reader event into the real
// iframe, (b) clicks the captured production button, (c) waits for the
// production popup to mount on the chrome window, (d) observes DOM facts,
// (e) cleans up. The log keys match the migration matrix in the AC2 plan
// L401-525 + tests/e2e/real-pdf-pipeline.e2e.test.ts.
// ---------------------------------------------------------------------------

async function runAnchoredExplainFlow(deps: E2eDriverDeps, log: Logger): Promise<void> {
  log("phase", "anchored:start");
  const { iframeDoc, buttonHost } = dispatchRealReaderEvent(deps, log, {
    phase: "anchored",
    selectionText: "Adversarial selected text.",
    // FINDING-21: left=50, top=200 keeps anchor.left = 50 + frameRect.left
    // well below the horizontal viewport clamp on narrow CI displays
    // (`maxLeft = viewportWidth - popupWidth - 8`).
    buttonContainerStyle: "position: absolute; left: 50px; top: 200px;"
  });
  if (iframeDoc === null || buttonHost === null) {
    log("phase", "anchored:done");
    return;
  }
  const button = buttonHost.querySelector<HTMLElement>("button[data-action='explain-with-ai']");
  if (button === null) {
    log("anchored:error", "no-button-captured");
    log("phase", "anchored:done");
    return;
  }
  const buttonRect = button.getBoundingClientRect();
  log("anchored:button-rect", rectCsv(buttonRect));
  button.click();
  const chromeDoc = getDocument(deps.zotero);
  if (chromeDoc === null) {
    log("anchored:error", "no-chrome-doc");
    log("phase", "anchored:done");
    return;
  }
  const wrapper = await waitForPopup(chromeDoc, 5000);
  log("anchored:popup-mounted", String(wrapper !== null));
  if (wrapper === null) {
    log("phase", "anchored:done");
    return;
  }
  const popupRect = wrapper.getBoundingClientRect();
  log("anchored:popup-rect", rectCsv(popupRect));
  // Translate the iframe-local button rect into CHROME-window coords by
  // adding the reader's XUL <browser> bounding rect. This mirrors how Zotero
  // itself maps reader-iframe coords to chrome-window coords for popups
  // (xpcom/reader.js:1244-1247). The HTML `frameElement` API does NOT work
  // here — the reader iframe is a chrome XUL <browser> (xpcom/reader.js:1812),
  // not an HTML <iframe>.
  const readerFrameRect = currentReaderInstance?._iframe?.getBoundingClientRect() ?? null;
  if (readerFrameRect !== null) {
    log("anchored:frame-rect", rectCsv(readerFrameRect));
  } else {
    log("anchored:frame-rect", "null");
  }
  const frameLeft = readerFrameRect?.left ?? 0;
  const frameTop = readerFrameRect?.top ?? 0;
  const buttonChromeLeft = buttonRect.left + frameLeft;
  const buttonChromeTop = buttonRect.top + frameTop;
  const dx = Math.round(popupRect.left - buttonChromeLeft);
  const dy = Math.round(popupRect.top - buttonChromeTop);
  log("anchored:dx", String(dx));
  log("anchored:dy", String(dy));
  log("anchored:manhattan", String(Math.abs(dx) + Math.abs(dy)));
  wrapper.remove();
  buttonHost.remove();
  log("phase", "anchored:done");
}

async function runCloseAffordanceFlow(deps: E2eDriverDeps, log: Logger): Promise<void> {
  log("phase", "close:start");
  const chromeDoc = getDocument(deps.zotero);
  if (chromeDoc === null) {
    log("close:error", "no-chrome-doc");
    log("phase", "close:done");
    return;
  }

  // ---- (1) Escape affordance: dispatch event, click button, escape ----
  const first = dispatchRealReaderEvent(deps, log, {
    phase: "close",
    selectionText: "Close-escape selection.",
    buttonContainerStyle: "position: absolute; left: 80px; top: 200px;"
  });
  if (first.iframeDoc === null || first.buttonHost === null) {
    log("phase", "close:done");
    return;
  }
  const buttonA = first.buttonHost.querySelector<HTMLElement>(
    "button[data-action='explain-with-ai']"
  );
  if (buttonA === null) {
    log("close:error", "no-button-captured");
    first.buttonHost.remove();
    log("phase", "close:done");
    return;
  }
  buttonA.click();
  const wrapperA = await waitForPopup(chromeDoc, 5000);
  log("close:popup-mounted", String(wrapperA !== null));
  if (wrapperA === null) {
    first.buttonHost.remove();
    log("phase", "close:done");
    return;
  }
  const closeEl = findCloseAffordance(wrapperA);
  log("close:has-close-affordance", String(closeEl !== null));
  const win = chromeDoc.defaultView;
  const KeyboardEventCtor = win?.KeyboardEvent ?? globalThis.KeyboardEvent;
  chromeDoc.dispatchEvent(new KeyboardEventCtor("keydown", { key: "Escape", bubbles: true }));
  const goneAfterEscape = await waitForCondition(
    () => findPopupWrapper(chromeDoc) === null,
    1500,
    chromeDoc
  );
  log("close:gone-after-escape", String(goneAfterEscape));
  log("close:escape-closed", String(goneAfterEscape));
  // Defensive: make sure no leftover popup remains.
  findPopupWrapper(chromeDoc)?.remove();
  first.buttonHost.remove();

  // ---- (2) Close-button affordance: dispatch FRESH event, click, button-close ----
  // The first button got disabled by AC7 click-feedback (label="Opening…",
  // disabled=true) and stays disabled until the production handler's
  // 1500ms restore timer fires. Re-using the same button blocks the
  // second click. Solve by dispatching a brand-new reader event into a
  // new iframe-local host — the production handler creates a fresh
  // button each time.
  const second = dispatchRealReaderEvent(deps, log, {
    phase: "close",
    selectionText: "Close-button selection.",
    buttonContainerStyle: "position: absolute; left: 80px; top: 240px;"
  });
  if (second.iframeDoc === null || second.buttonHost === null) {
    log("close:button-closed", "false");
    log("close:gone-after-button-click", "false");
    log("phase", "close:done");
    return;
  }
  const buttonB = second.buttonHost.querySelector<HTMLElement>(
    "button[data-action='explain-with-ai']"
  );
  if (buttonB === null) {
    log("close:button-closed", "false");
    log("close:gone-after-button-click", "false");
    second.buttonHost.remove();
    log("phase", "close:done");
    return;
  }
  buttonB.click();
  const wrapperB = await waitForPopup(chromeDoc, 5000);
  if (wrapperB === null) {
    log("close:button-closed", "false");
    log("close:gone-after-button-click", "false");
    second.buttonHost.remove();
    log("phase", "close:done");
    return;
  }
  const close2 = findCloseAffordance(wrapperB);
  close2?.click();
  const goneAfterClick = await waitForCondition(
    () => findPopupWrapper(chromeDoc) === null,
    1500,
    chromeDoc
  );
  log("close:button-closed", String(goneAfterClick));
  log("close:gone-after-button-click", String(goneAfterClick));

  findPopupWrapper(chromeDoc)?.remove();
  second.buttonHost.remove();
  log("phase", "close:done");
}

async function runScrollFlow(deps: E2eDriverDeps, log: Logger): Promise<void> {
  log("phase", "scroll:start");
  const { iframeDoc, buttonHost } = dispatchRealReaderEvent(deps, log, {
    phase: "scroll",
    selectionText: "Scroll-overflow selection.",
    buttonContainerStyle: "position: absolute; left: 60px; top: 200px;"
  });
  if (iframeDoc === null || buttonHost === null) {
    log("phase", "scroll:done");
    return;
  }
  const button = buttonHost.querySelector<HTMLElement>("button[data-action='explain-with-ai']");
  if (button === null) {
    log("scroll:error", "no-button-captured");
    log("phase", "scroll:done");
    return;
  }
  button.click();
  const chromeDoc = getDocument(deps.zotero);
  if (chromeDoc === null) {
    log("scroll:error", "no-chrome-doc");
    log("phase", "scroll:done");
    return;
  }
  const wrapper = await waitForPopup(chromeDoc, 5000);
  log("scroll:popup-mounted", String(wrapper !== null));
  if (wrapper === null) {
    log("phase", "scroll:done");
    return;
  }
  // The fake server emits 80 "line N\n" chunks; wait until enough text
  // has accumulated to be confident the response settled (we look for
  // "line 40", well past the early-burst threshold).
  await waitForCondition(
    () => {
      const w = findPopupWrapper(chromeDoc);
      if (w === null) return false;
      return w.textContent.includes("line 40");
    },
    15_000,
    chromeDoc
  );
  // After the text lands, give chrome a brief moment to settle layout.
  await waitForCondition(() => false, 300, chromeDoc);
  // Production CSS layers:
  //   wrapper (.zotero-ai-popup-wrapper)   — outer, max-height: 60vh,
  //                                          overflow-y: auto (THE scroll
  //                                          container), display: flex;
  //                                          flex-direction: column
  //   body-wrapper (.zotero-ai-popup-wrapper__body) — overflow-y: auto,
  //                                          flex: 0 0 auto (keeps its
  //                                          intrinsic content height)
  //   section + inner body — explain-popup content
  //
  // The body-wrapper is `flex: 0 0 auto`, so it does NOT shrink to fit the
  // wrapper — its intrinsic height carries the full response. The wrapper
  // clamps to `max-height: 60vh` and, because `overflow-y: auto`, scrolls:
  // `wrapper.scrollHeight` (full content) exceeds `wrapper.clientHeight`
  // (the 60vh-clamped box). For the AC3 assertion we report
  // scrollHeight/clientHeight of the outer wrapper (the actual scrolling
  // container) and overflow-y of the body-wrapper (which also carries the
  // production CSS intent — `auto`).
  const win = chromeDoc.defaultView;
  const bodyContainer =
    wrapper.querySelector<HTMLElement>(".zotero-ai-popup-wrapper__body") ?? wrapper;
  const bodyOverflowY = (win?.getComputedStyle(bodyContainer).overflowY ?? "").toLowerCase();
  // Use the OUTER wrapper's scroll geometry — that's the surface a user
  // perceives as scrollable when the content exceeds the popup's
  // max-height.
  const scrollable = wrapper.scrollHeight > wrapper.clientHeight;
  log("scroll:scrollHeight", String(wrapper.scrollHeight));
  log("scroll:clientHeight", String(wrapper.clientHeight));
  log("scroll:body-scrollHeight", String(bodyContainer.scrollHeight));
  log("scroll:body-clientHeight", String(bodyContainer.clientHeight));
  log("scroll:overflowing", String(scrollable));
  log("scroll:scrollable", String(scrollable));
  log("scroll:overflow-y", bodyOverflowY);
  wrapper.remove();
  buttonHost.remove();
  log("phase", "scroll:done");
}

async function runLoadingFlow(deps: E2eDriverDeps, log: Logger): Promise<void> {
  log("phase", "loading:start");
  const { iframeDoc, buttonHost } = dispatchRealReaderEvent(deps, log, {
    phase: "loading",
    selectionText: "Loading-indicator selection.",
    buttonContainerStyle: "position: absolute; left: 70px; top: 200px;"
  });
  if (iframeDoc === null || buttonHost === null) {
    log("phase", "loading:done");
    return;
  }
  const button = buttonHost.querySelector<HTMLElement>("button[data-action='explain-with-ai']");
  if (button === null) {
    log("loading:error", "no-button-captured");
    log("phase", "loading:done");
    return;
  }
  button.click();
  const chromeDoc = getDocument(deps.zotero);
  if (chromeDoc === null) {
    log("loading:error", "no-chrome-doc");
    log("phase", "loading:done");
    return;
  }
  const wrapper = await waitForPopup(chromeDoc, 2000);
  log("loading:popup-mounted", String(wrapper !== null));
  if (wrapper === null) {
    log("phase", "loading:done");
    return;
  }
  // Within the first ~200ms (firstChunkDelayMs=300 in the test) the
  // loading indicator MUST be visible.
  const earlyIndicator = findLoadingIndicator(wrapper);
  const earlyVisible = isVisibleElement(earlyIndicator);
  log("loading:indicator-early", String(earlyVisible));
  log("loading:indicator-before", String(earlyVisible));
  // Wait for the response to settle (the fake server emits "line N"
  // chunks; "line 1" lands ~300 ms after first delta).
  await waitForCondition(
    () => {
      const w = findPopupWrapper(chromeDoc);
      const t = w?.textContent ?? "";
      return t.includes("line 1") || t.includes("Hello world");
    },
    15_000,
    chromeDoc
  );
  const finalWrapper = findPopupWrapper(chromeDoc);
  const lateIndicator = finalWrapper !== null ? findLoadingIndicator(finalWrapper) : null;
  const lateVisible = isVisibleElement(lateIndicator);
  log("loading:indicator-late", String(lateVisible));
  log("loading:indicator-after", String(lateVisible));
  const bodyEl = finalWrapper?.querySelector<HTMLElement>(".zotero-ai-explain-popup__body") ?? null;
  const bodyText = (bodyEl?.textContent ?? finalWrapper?.textContent ?? "").trim();
  log("loading:popup-body-text", bodyText);
  finalWrapper?.remove();
  buttonHost.remove();
  log("phase", "loading:done");
}

async function runPopupFollowUpFlow(deps: E2eDriverDeps, log: Logger): Promise<void> {
  log("phase", "popup-followup:start");
  const { iframeDoc, buttonHost } = dispatchRealReaderEvent(deps, log, {
    phase: "popup-followup",
    selectionText: "Popup-followup selection.",
    buttonContainerStyle: "position: absolute; left: 90px; top: 200px;"
  });
  if (iframeDoc === null || buttonHost === null) {
    log("phase", "popup-followup:done");
    return;
  }
  const button = buttonHost.querySelector<HTMLElement>("button[data-action='explain-with-ai']");
  if (button === null) {
    log("popup-followup:error", "no-button-captured");
    log("phase", "popup-followup:done");
    return;
  }
  button.click();
  const chromeDoc = getDocument(deps.zotero);
  if (chromeDoc === null) {
    log("popup-followup:error", "no-chrome-doc");
    log("phase", "popup-followup:done");
    return;
  }
  const wrapper = await waitForPopup(chromeDoc, 5000);
  log("popup-followup:popup-mounted", String(wrapper !== null));
  if (wrapper === null) {
    log("phase", "popup-followup:done");
    return;
  }
  // Wait for initial assistant text to settle (at least "line 1" / "Hello").
  await waitForCondition(
    () => {
      const w = findPopupWrapper(chromeDoc);
      const t = w?.textContent ?? "";
      return t.includes("line 1") || t.includes("Hello world");
    },
    15_000,
    chromeDoc
  );
  const w = findPopupWrapper(chromeDoc);
  if (w === null) {
    log("popup-followup:error", "popup-disappeared");
    buttonHost.remove();
    log("phase", "popup-followup:done");
    return;
  }
  const textarea = findFollowUpTextarea(w);
  log("popup-followup:textarea-present", String(textarea !== null));
  log("popup-followup:has-textarea", String(textarea !== null));
  const submit = findFollowUpSubmit(w);
  log("popup-followup:has-submit", String(submit !== null));
  let submitted = false;
  if (textarea !== null) {
    textarea.value = "Follow up question from popup?";
    // The popup hosts a <form>; production wires `submit` to the popup
    // controller. Prefer dispatching a real submit event so the wired
    // handler runs identically to a user-driven submit.
    const form = textarea.closest<HTMLFormElement>("form");
    if (form !== null) {
      const win = chromeDoc.defaultView;
      const EventCtor = win?.Event ?? globalThis.Event;
      form.dispatchEvent(new EventCtor("submit", { bubbles: true, cancelable: true }));
      submitted = true;
    } else if (submit !== null) {
      submit.click();
      submitted = true;
    }
  }
  log("popup-followup:submitted", String(submitted));
  if (submitted) {
    await waitForCondition(
      () => {
        const wn = findPopupWrapper(chromeDoc);
        return (wn?.textContent ?? "").includes("Follow up question from popup?");
      },
      5000,
      chromeDoc
    );
  }
  const fw = findPopupWrapper(chromeDoc);
  const bodyText = (fw?.textContent ?? "").trim();
  log("popup-followup:popup-body-text", bodyText);
  log(
    "popup-followup:question-rendered",
    String(bodyText.includes("Follow up question from popup?"))
  );
  fw?.remove();
  buttonHost.remove();
  log("phase", "popup-followup:done");
}

function runHonestIndexingFlow(deps: E2eDriverDeps, log: Logger): void {
  log("phase", "honest-indexing:start");
  const view = renderSettingsView({
    settings: deps.settings,
    indexStatus: deps.indexingController.getStatus()
  });
  const detach = attachIndexControls(view, deps.indexingController);
  const dialogHandle = deps.ui.openDialog("Zotero AI Explain", view);
  // Scope to the dialog this flow mounted (the ancestor `.zotero-ai-dialog`
  // of `view`) rather than a global query that could match a stale prior
  // dialog still in the DOM.
  const dialog = view.closest<HTMLElement>(".zotero-ai-dialog");
  const text = dialog?.textContent ?? "";
  log("honest-indexing:dialog-present", String(dialog !== null));
  log("honest-indexing:contains-phase2", String(/Phase ?2/iu.test(text)));
  log("honest-indexing:contains-not-yet-implemented", String(/not yet implemented/iu.test(text)));
  // Close THIS dialog via its own handle — see runIndexFlow for why a
  // global close-dialog query is unsafe when other dialogs are open.
  dialogHandle.close();
  detach();
  log("phase", "honest-indexing:done");
}

async function runClickFeedbackFlow(deps: E2eDriverDeps, log: Logger): Promise<void> {
  log("phase", "click-feedback:start");
  const { iframeDoc, buttonHost } = dispatchRealReaderEvent(deps, log, {
    phase: "click-feedback",
    selectionText: "Click-feedback selection.",
    buttonContainerStyle: "position: absolute; left: 100px; top: 200px;"
  });
  if (iframeDoc === null || buttonHost === null) {
    log("phase", "click-feedback:done");
    return;
  }
  const button = buttonHost.querySelector<HTMLElement>("button[data-action='explain-with-ai']");
  if (button === null) {
    log("click-feedback:error", "no-button-captured");
    log("phase", "click-feedback:done");
    return;
  }
  const win = iframeDoc.defaultView;
  const ButtonCtor = win?.HTMLButtonElement ?? null;
  const readLabel = (): string => button.textContent;
  const readDisabled = (): boolean => {
    if (ButtonCtor !== null && button instanceof ButtonCtor) {
      return button.disabled;
    }
    return false;
  };
  const labelBefore = readLabel();
  const disabledBefore = readDisabled();
  log("click-feedback:label-before", labelBefore);
  log("click-feedback:disabled-before", String(disabledBefore));
  button.click();
  const labelAfter = readLabel();
  const disabledAfter = readDisabled();
  const chromeDoc = getDocument(deps.zotero);
  const hasBusyEl =
    chromeDoc?.querySelector("[aria-busy='true'], [data-state='loading'], [role='status']") !==
    null;
  log("click-feedback:label-after", labelAfter);
  log("click-feedback:label-on-click", labelAfter);
  log("click-feedback:disabled-after", String(disabledAfter));
  log("click-feedback:button-disabled-on-click", String(disabledAfter));
  log(
    "click-feedback:label-changed",
    String(labelBefore !== labelAfter || disabledBefore !== disabledAfter)
  );
  log("click-feedback:busy-element-present", String(hasBusyEl));
  log(
    "click-feedback:feedback-present",
    String(labelBefore !== labelAfter || disabledBefore !== disabledAfter || hasBusyEl)
  );
  // Clean up.
  if (chromeDoc !== null) {
    const wrapper = await waitForPopup(chromeDoc, 5000);
    wrapper?.remove();
  }
  buttonHost.remove();
  log("phase", "click-feedback:done");
}
