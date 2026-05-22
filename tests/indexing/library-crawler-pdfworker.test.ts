/**
 * Adversarial integration tests for AC-4 — per-page PDF text extraction
 * wired through `indexLibrary`. Verifies that the per-source generator's
 * pdf-page sources reach the persisted `IndexFile` as `IndexedItemChunk`s
 * carrying `pageIndex`, `attachmentKey`, and `sourceKind`.
 *
 * Plan: `docs/superpowers/plans/2026-05-19-pdf-context-features.md`
 *   AC-4 description           L435-449
 *   AC-4 interface contracts   L662-714
 *
 * --------------------------------------------------------------------
 * Fault Localization (Template 4 — AC-4 crawler integration)
 * --------------------------------------------------------------------
 *
 * 1. Spec semantics (premises):
 *    P1.  `indexLibrary` iterates the per-source generator instead of
 *         calling `extractItemText` once (plan Modify L259-268).
 *    P2.  `chunkText` runs PER source; each resulting chunk inherits
 *         the source's `sourceKind` / `pageIndex` / `attachmentKey`.
 *    P3.  Every persisted `IndexedItemChunk` carries a REQUIRED
 *         `sourceKind` (contract L670). v0.3.0 chunks always have one.
 *    P4.  PDF-page chunks carry a numeric `pageIndex` (0-indexed) and
 *         an `attachmentKey`. `pageIndex: 0` survives end-to-end.
 *    P5.  Metadata / note chunks carry `sourceKind: "metadata" | "note"`
 *         and leave `pageIndex` undefined.
 *    P6.  A corrupt PDF (getFullText rejects) does NOT fail the item:
 *         the item's other sources still persist; the run still
 *         resolves `{completed: true}`.
 *    P7.  A standalone PDF attachment produces pdf-page chunks
 *         (`getFullText(item.id)` directly).
 *    P8.  `IndexFile` gains `schemaVersion` — written as
 *         `CURRENT_SCHEMA_VERSION` (= 2) by a v0.3.0 crawl
 *         (contract L680-689; plan Modify L262).
 *
 * 2. Code path trace (against the contract — bodies NOT inspected):
 *    - getAll → per-item: extractPerSourceChunks → chunkText per source
 *      → embed per chunk → accumulate IndexedItemChunk with the source's
 *      metadata → storage.write.
 *
 * 3. Divergence analysis (likely bugs):
 *    D1 [HIGH]   pdf-page chunks land WITHOUT pageIndex (truthiness drop
 *                of 0, or the field never propagated from the source).
 *    D2 [HIGH]   `sourceKind` missing on persisted chunks (the field is
 *                REQUIRED — a chunk without it violates the contract).
 *    D3 [HIGH]   A corrupt PDF aborts the whole item (failed++ or run
 *                rejects) instead of skip + continue.
 *    D4 [MEDIUM] `attachmentKey` not stamped → citation jump has no
 *                anchor.
 *    D5 [MEDIUM] `schemaVersion` absent on the freshly written file.
 *    D6 [MEDIUM] Multi-page PDF: chunk text lands but every chunk gets
 *                pageIndex 0 (page identity lost in the chunk loop).
 *    D7 [LOW]    Standalone PDF skipped because the crawler only walks
 *                child attachments.
 *
 * 4. Test targets (ranked): D1/D2 (chunk metadata) > D3 (failure
 *    isolation) > D4 (attachmentKey) > D6 (multi-page identity) >
 *    D5 (schemaVersion) > D7 (standalone).
 *
 * --------------------------------------------------------------------
 * COMPILE NOTE: this file depends on (a) the widened `IndexedItem.chunks`
 * element type (sourceKind/pageIndex/attachmentKey), (b) `schemaVersion`
 * on `IndexFile`, (c) `CURRENT_SCHEMA_VERSION`, and (d) a `PDFWorker`
 * field on `LibraryCrawlerDeps.zotero`. All four are AC-4/AC-5
 * implementer deliverables — until they land this file fails to
 * COMPILE. The test SOURCE is the authority on correct behavior.
 * --------------------------------------------------------------------
 */

import { describe, expect, it } from "vitest";

import {
  indexLibrary,
  CURRENT_SCHEMA_VERSION,
  type IndexFile,
  type IndexLibraryOptions,
  type LibraryCrawlerDeps,
  type ZoteroItemLike
} from "../../src/indexing/library-crawler.js";
import type { IndexStorage } from "../../src/indexing/index-storage.js";

type PdfWorkerResult = { text: string; extractedPages: number; totalPages: number };

/** Realistic per-page text — long enough to chunk into one chunk per page. */
function pageBody(label: string): string {
  return `Body text for ${label}. `.repeat(6).trim();
}

function workerText(pages: readonly string[]): string {
  return pages.join("\f");
}

function fakePdfChild(spec: { id: number; key: string }): ZoteroItemLike {
  return {
    id: spec.id,
    key: spec.key,
    getField: () => undefined,
    getNotes: () => [],
    isAttachment: () => true,
    isAnnotation: () => false
  };
}

function fakeParent(spec: {
  id: number;
  key: string;
  title?: string;
  abstractNote?: string;
  attachmentIds: readonly number[];
}): ZoteroItemLike {
  return {
    id: spec.id,
    key: spec.key,
    getField(name) {
      return name === "title" ? spec.title : spec.abstractNote;
    },
    getNotes: () => [],
    getAttachments: () => spec.attachmentIds,
    isAttachment: () => false,
    isAnnotation: () => false
  };
}

function fakeStandalonePdf(spec: { id: number; key: string; title?: string }): ZoteroItemLike {
  return {
    id: spec.id,
    key: spec.key,
    getField(name) {
      return name === "title" ? spec.title : undefined;
    },
    getNotes: () => [],
    isAttachment: () => true,
    isAnnotation: () => false
  };
}

type CrawlOutcome = {
  readonly result: { completed: boolean };
  readonly written: IndexFile | null;
  readonly progress: { indexed: number; failed: number; total: number }[];
};

/**
 * Drive `indexLibrary` against a fake Zotero whose `PDFWorker.getFullText`
 * is backed by an itemID → outcome map. The embed provider returns a
 * deterministic stub vector so the test exercises the crawl wiring, not
 * the network.
 */
async function runCrawl(opts: {
  readonly items: readonly ZoteroItemLike[];
  readonly children?: readonly ZoteroItemLike[];
  readonly pdfOutcomes: Record<number, PdfWorkerResult | { reject: string }>;
  readonly fullTextCache?: Record<number, string>;
}): Promise<CrawlOutcome> {
  const writes: IndexFile[] = [];
  const progress: { indexed: number; failed: number; total: number }[] = [];

  const itemsById = new Map<number, ZoteroItemLike>();
  for (const item of opts.items) {
    itemsById.set(item.id, item);
  }
  for (const child of opts.children ?? []) {
    itemsById.set(child.id, child);
  }

  const storage: IndexStorage = {
    async read() {
      await Promise.resolve();
      return null;
    },
    async readItemCount() {
      await Promise.resolve();
      return 0;
    },
    async write(file: IndexFile) {
      await Promise.resolve();
      writes.push(file);
    },
    async clear() {
      await Promise.resolve();
    },
    path() {
      return "/var/test-fixture/zotero-data/zotero-ai-explain-index.json";
    }
  } as unknown as IndexStorage;

  const cache = opts.fullTextCache ?? {};
  const deps: LibraryCrawlerDeps = {
    zotero: {
      Libraries: { userLibraryID: 1 },
      Items: {
        async getAll() {
          await Promise.resolve();
          return opts.items;
        },
        get(itemID: number) {
          return itemsById.get(itemID) ?? null;
        }
      },
      FullText: {
        getItemContent(itemID: number): string | undefined {
          return cache[itemID];
        }
      },
      // PDFWorker is a NEW field on LibraryCrawlerDeps.zotero added by
      // the AC-4 implementer (plan Modify L259-268 + contract L703-711).
      PDFWorker: {
        async getFullText(itemID: number): Promise<PdfWorkerResult> {
          await Promise.resolve();
          const outcome = opts.pdfOutcomes[itemID];
          if (outcome === undefined) {
            throw new Error(`no PDF worker outcome for itemID ${String(itemID)}`);
          }
          if ("reject" in outcome) {
            throw new Error(outcome.reject);
          }
          return outcome;
        }
      }
    },
    provider: {
      async embedTexts(request) {
        await Promise.resolve();
        return request.texts.map(() => [0.11, 0.22, 0.33]);
      }
    },
    settings: { baseUrl: "http://localhost:11434", embeddingModel: "nomic-embed-text" },
    storage,
    onProgress(indexed, failed, total) {
      progress.push({ indexed, failed, total });
    },
    async scheduler() {
      await Promise.resolve();
    },
    abortController: new AbortController()
  };

  const options: IndexLibraryOptions = {
    signal: new AbortController().signal,
    isPaused: () => false
  };

  const result = await indexLibrary(deps, options);
  return { result, written: writes.at(-1) ?? null, progress };
}

// ====================================================================
// AC-4 — PDF-page chunks land in the IndexFile with full metadata
// ====================================================================

describe("AC-4 indexLibrary — single-page PDF child", () => {
  it("persists pdf-page chunks with pageIndex 0 and attachmentKey", async () => {
    const pdf = fakePdfChild({ id: 200, key: "PDFCHLD1" });
    const parent = fakeParent({
      id: 100,
      key: "PARENT01",
      title: "Single Page Paper",
      attachmentIds: [200]
    });
    const { result, written } = await runCrawl({
      items: [parent],
      children: [pdf],
      pdfOutcomes: {
        200: { text: pageBody("only page"), extractedPages: 1, totalPages: 1 }
      }
    });

    expect(result.completed).toBe(true);
    const chunks = written?.items.PARENT01?.chunks ?? [];
    const pdfChunks = chunks.filter((c) => c.sourceKind === "pdf-page");
    expect(pdfChunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of pdfChunks) {
      // D1: pageIndex 0 must survive — never undefined, never dropped.
      expect(chunk.pageIndex).toBe(0);
      expect(chunk.pageIndex).not.toBeUndefined();
      // D4: attachmentKey present.
      expect(chunk.attachmentKey).toBe("PDFCHLD1");
    }
  });
});

describe("AC-4 indexLibrary — 10-page PDF child", () => {
  it("persists chunks spanning pageIndex 0..9 with correct page identity", async () => {
    const pdf = fakePdfChild({ id: 201, key: "PDFCHLDA" });
    const parent = fakeParent({ id: 101, key: "PARENT0A", attachmentIds: [201] });
    const pages = Array.from({ length: 10 }, (_, n) => pageBody(`physical page ${String(n)}`));
    const { written } = await runCrawl({
      items: [parent],
      children: [pdf],
      pdfOutcomes: {
        201: { text: workerText(pages), extractedPages: 10, totalPages: 10 }
      }
    });

    const chunks = (written?.items.PARENT0A?.chunks ?? []).filter(
      (c) => c.sourceKind === "pdf-page"
    );
    // D6: every page is represented with its own pageIndex.
    const indices = new Set(chunks.map((c) => c.pageIndex));
    expect([...indices].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9
    ]);
    // D6: page-7 text must carry pageIndex 7 (not 0, not count-based).
    const page7Chunk = chunks.find((c) => c.text.includes("physical page 7"));
    expect(page7Chunk?.pageIndex).toBe(7);
    expect(chunks.every((c) => c.attachmentKey === "PDFCHLDA")).toBe(true);
  });
});

describe("AC-4 indexLibrary — corrupt PDF isolation", () => {
  it("a corrupt PDF child does not fail the item; other sources persist", async () => {
    const corrupt = fakePdfChild({ id: 202, key: "PDFBADKY" });
    const parent = fakeParent({
      id: 102,
      key: "PARENT0B",
      title: "Paper With Corrupt PDF",
      abstractNote: "An abstract that yields a metadata chunk.",
      attachmentIds: [202]
    });
    const { result, written, progress } = await runCrawl({
      items: [parent],
      children: [corrupt],
      pdfOutcomes: { 202: { reject: "PDF is password protected" } }
    });

    // D3: the run still completes; the item is NOT counted failed.
    expect(result.completed).toBe(true);
    expect(progress.at(-1)?.failed).toBe(0);
    // The corrupt PDF emits no pdf-page chunk...
    const chunks = written?.items.PARENT0B?.chunks ?? [];
    expect(chunks.some((c) => c.sourceKind === "pdf-page")).toBe(false);
    // ...but the metadata chunk still persisted.
    expect(chunks.some((c) => c.sourceKind === "metadata")).toBe(true);
  });
});

describe("AC-4 indexLibrary — mixed PDF + EPUB children", () => {
  it("persists both pdf-page and epub chunks, each with attachmentKey", async () => {
    const pdf = fakePdfChild({ id: 203, key: "PDFMIXED" });
    const epub = fakePdfChild({ id: 204, key: "EPUBMIXD" });
    const parent = fakeParent({
      id: 103,
      key: "PARENT0C",
      title: "Item With PDF And EPUB",
      attachmentIds: [203, 204]
    });
    const { written } = await runCrawl({
      items: [parent],
      children: [pdf, epub],
      pdfOutcomes: {
        203: { text: pageBody("pdf body"), extractedPages: 1, totalPages: 1 }
      },
      // The EPUB attachment's fulltext flows through the FullText cache.
      fullTextCache: { 204: pageBody("epub body from spine") }
    });

    const chunks = written?.items.PARENT0C?.chunks ?? [];
    const pdfChunks = chunks.filter((c) => c.sourceKind === "pdf-page");
    const epubChunks = chunks.filter((c) => c.sourceKind === "epub");
    expect(pdfChunks.length).toBeGreaterThanOrEqual(1);
    expect(epubChunks.length).toBeGreaterThanOrEqual(1);
    expect(pdfChunks.every((c) => c.attachmentKey === "PDFMIXED")).toBe(true);
    expect(epubChunks.every((c) => c.attachmentKey === "EPUBMIXD")).toBe(true);
    // EPUB chunks carry no pageIndex.
    expect(epubChunks.every((c) => c.pageIndex === undefined)).toBe(true);
  });
});

describe("AC-4 indexLibrary — standalone PDF attachment", () => {
  it("a top-level PDF attachment yields pdf-page chunks via getFullText(item.id)", async () => {
    const standalone = fakeStandalonePdf({ id: 300, key: "STANDPDF", title: "Loose PDF" });
    const { written } = await runCrawl({
      items: [standalone],
      pdfOutcomes: {
        300: {
          text: workerText([pageBody("standalone p0"), pageBody("standalone p1")]),
          extractedPages: 2,
          totalPages: 2
        }
      }
    });

    const chunks = (written?.items.STANDPDF?.chunks ?? []).filter(
      (c) => c.sourceKind === "pdf-page"
    );
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.attachmentKey === "STANDPDF")).toBe(true);
    const indices = new Set(chunks.map((c) => c.pageIndex));
    expect(indices.has(0)).toBe(true);
    expect(indices.has(1)).toBe(true);
  });
});

// ====================================================================
// AC-4 — required sourceKind + AC-5 schemaVersion stamping
// ====================================================================

describe("AC-4 indexLibrary — every persisted chunk carries a sourceKind", () => {
  it("no v0.3.0 chunk is written without a sourceKind", async () => {
    const pdf = fakePdfChild({ id: 205, key: "PDFKINDS" });
    const parent = fakeParent({
      id: 104,
      key: "PARENT0D",
      title: "Coverage Item",
      abstractNote: "Abstract text.",
      attachmentIds: [205]
    });
    const { written } = await runCrawl({
      items: [parent],
      children: [pdf],
      pdfOutcomes: {
        205: { text: pageBody("body"), extractedPages: 1, totalPages: 1 }
      }
    });

    const allowed = new Set(["pdf-page", "metadata", "note", "epub", "snapshot", "attachment"]);
    const chunks = written?.items.PARENT0D?.chunks ?? [];
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      // D2: sourceKind is REQUIRED — undefined violates the contract.
      expect(chunk.sourceKind).toBeDefined();
      expect(allowed.has(chunk.sourceKind)).toBe(true);
    }
    // Metadata chunks carry no pageIndex.
    const metaChunks = chunks.filter((c) => c.sourceKind === "metadata");
    expect(metaChunks.length).toBeGreaterThanOrEqual(1);
    expect(metaChunks.every((c) => c.pageIndex === undefined)).toBe(true);
  });

  it("a v0.3.0 crawl writes IndexFile.schemaVersion === CURRENT_SCHEMA_VERSION", async () => {
    // D5: the freshly written file must declare its schema version so
    // the next hydrate() does not re-fire a migration (AC-5 Adv-2).
    const pdf = fakePdfChild({ id: 206, key: "PDFSCHEM" });
    const parent = fakeParent({ id: 105, key: "PARENT0E", attachmentIds: [206] });
    const { written } = await runCrawl({
      items: [parent],
      children: [pdf],
      pdfOutcomes: {
        206: { text: pageBody("schema body"), extractedPages: 1, totalPages: 1 }
      }
    });

    expect(written).not.toBeNull();
    expect(written?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
  });
});
