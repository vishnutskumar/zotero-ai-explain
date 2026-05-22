/**
 * Adversarial unit tests for the AC-4 per-source helper module
 * (`src/indexing/per-source-chunks.ts`).
 *
 * Plan: `docs/superpowers/plans/2026-05-19-pdf-context-features.md`
 *   AC-4 description           L435-449
 *   AC-4 interface contracts   L662-714
 *
 * --------------------------------------------------------------------
 * Fault Localization (Template 4 — AC-4 per-source extraction)
 * --------------------------------------------------------------------
 *
 * 1. Spec semantics (premises):
 *    P1.  `splitPdfWorkerText(text): readonly string[]` splits `text`
 *         on the `\f` form-feed delimiter. An N-page PDF emits N-1
 *         form-feeds, so a single-page document (zero `\f`) yields a
 *         split of length 1 (the entire text as page 0).
 *    P2.  `splitPdfWorkerText("")` — empty input is still ONE page
 *         (`"".split("\f") === [""]`, length 1). The page-0 invariant
 *         holds: page index 0 always exists.
 *    P3.  A trailing `\f` produces a final empty page string. A run of
 *         `\f\f` produces an empty page between the two delimiters.
 *         splitPdfWorkerText does NOT silently drop empty pages — the
 *         page INDEX must stay aligned with the physical page number.
 *    P4.  `extractPerSourceChunks(item, access, options?)` is an
 *         AsyncGenerator yielding `{text, sourceKind, pageIndex?,
 *         attachmentKey?}`.
 *    P5.  For every PDF child attachment the generator calls
 *         `access.PDFWorker.getFullText(attachment.id)`, splits the
 *         returned `.text` on `\f`, and yields ONE source per page with
 *         `sourceKind: "pdf-page"`, `pageIndex` = 0-indexed page number,
 *         and `attachmentKey` = the attachment's `.key`.
 *    P6.  `pageIndex: 0` is a VALID value — never conflated with
 *         `undefined`. The first page of every PDF carries `pageIndex`
 *         exactly `0`.
 *    P7.  Non-PDF attachments (EPUB / snapshot / other) flow through
 *         `readAttachmentFullText` and yield `sourceKind` of
 *         `"epub" | "snapshot" | "attachment"` with `attachmentKey`
 *         stamped and `pageIndex` ABSENT (undefined).
 *    P8.  Metadata (title + abstract) and note sources yield
 *         `sourceKind: "metadata" | "note"` with BOTH `pageIndex` and
 *         `attachmentKey` undefined.
 *    P9.  When `getFullText` REJECTS (corrupt / password-protected
 *         PDF), the per-attachment failure is caught: the generator
 *         skips that attachment and continues to the next source. It
 *         does NOT abort the whole item, and does NOT yield a partial
 *         pdf-page source.
 *    P10. A standalone PDF attachment with no parent
 *         (`item.isAttachment() === true`) is handled by calling
 *         `getFullText(item.id)` directly.
 *
 * 2. Code path trace (against the contract — bodies NOT inspected):
 *    - splitPdfWorkerText: pure string split on "\f".
 *    - extractPerSourceChunks: yields metadata → note → PDF-page →
 *      non-PDF-attachment sources in order. PDF child enumerated via
 *      `item.getAttachments()` + `access.Items.get(childId)`.
 *
 * 3. Divergence analysis (likely bugs):
 *    D1 [HIGH]   `splitPdfWorkerText` trims/filters empty pages →
 *                pageIndex desyncs from the physical page number.
 *    D2 [HIGH]   The PDF-page source omits `pageIndex` for page 0 (a
 *                truthiness check `if (pageIndex)` drops 0).
 *    D3 [HIGH]   `getFullText` rejection propagates out of the
 *                generator and kills the whole item instead of skip +
 *                continue.
 *    D4 [HIGH]   `attachmentKey` not stamped on pdf-page / epub
 *                sources → citation jump-to-page later has no anchor.
 *    D5 [MEDIUM] Standalone PDF attachment: generator looks for child
 *                attachments (finds none) and never extracts text from
 *                the attachment itself.
 *    D6 [MEDIUM] Non-PDF attachment mislabelled `pdf-page` or carries
 *                a spurious `pageIndex`.
 *    D7 [MEDIUM] Metadata / note sources carry a `pageIndex` (should be
 *                undefined).
 *    D8 [LOW]    Multi-page PDF: page N's source gets pageIndex N+1 or
 *                N-1 (off-by-one).
 *
 * 4. Test targets (ranked): D1/D2 (page-index integrity) >
 *    D3 (rejection isolation) > D4 (attachmentKey) > D5 (standalone) >
 *    D6/D7 (sourceKind correctness) > D8 (off-by-one).
 *
 * --------------------------------------------------------------------
 * COMPILE NOTE: `splitPdfWorkerText` and `extractPerSourceChunks` are
 * NEW exports of `src/indexing/per-source-chunks.ts` (plan File
 * Structure L211). Until the AC-4 implementer lands that module these
 * tests fail to COMPILE. The test SOURCE is written against the plan's
 * declared contract (L662-714) and is the authority on correct
 * behavior.
 * --------------------------------------------------------------------
 */

import { describe, expect, it } from "vitest";

import type { ZoteroItemLike, ZoteroFullTextAccess } from "../../src/indexing/library-crawler.js";
import {
  splitPdfWorkerText,
  extractPerSourceChunks
} from "../../src/indexing/per-source-chunks.js";

// --------------------------------------------------------------------
// Local fixture builders. Realistic Zotero item / PDF-worker shapes —
// NOT tautological mirrors of the implementation.
// --------------------------------------------------------------------

type PdfWorkerResult = { text: string; extractedPages: number; totalPages: number };

/** Build a `Zotero.PDFWorker` stub from an itemID → result/reject map. */
function makePdfWorker(
  outcomes: Record<number, PdfWorkerResult | { reject: string }>
): NonNullable<Parameters<typeof extractPerSourceChunks>[1]["PDFWorker"]> {
  return {
    async getFullText(itemID: number): Promise<PdfWorkerResult> {
      await Promise.resolve();
      const outcome = outcomes[itemID];
      if (outcome === undefined) {
        throw new Error(`no PDF worker outcome for itemID ${String(itemID)}`);
      }
      if ("reject" in outcome) {
        throw new Error(outcome.reject);
      }
      return outcome;
    }
  };
}

/** A page string that comfortably yields exactly one chunk. */
function pageText(label: string): string {
  return `Page content for ${label}. `.repeat(8).trim();
}

/** Compose worker `text` from per-page strings joined by the `\f` delimiter. */
function workerText(pages: readonly string[]): string {
  return pages.join("\f");
}

type AttachmentSpec = {
  readonly id: number;
  readonly key: string;
  readonly kind: "pdf" | "epub" | "snapshot" | "other";
};

function fakeAttachment(spec: AttachmentSpec): ZoteroItemLike {
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
      return name === "title" ? spec.title : spec.abstractNote;
    },
    getNotes: () => [],
    getAttachments: () => spec.attachmentIds,
    isAttachment: () => false,
    isAnnotation: () => false
  };
}

/**
 * Assemble a `ZoteroFullTextAccess` (with optional PDFWorker) whose
 * `Items.get` resolves the supplied child-attachment items by id.
 */
function makeAccess(opts: {
  readonly children?: readonly ZoteroItemLike[];
  readonly pdfWorker?: NonNullable<Parameters<typeof extractPerSourceChunks>[1]["PDFWorker"]>;
  readonly fullTextCache?: Record<number, string>;
}): ZoteroFullTextAccess & {
  readonly PDFWorker?: NonNullable<Parameters<typeof extractPerSourceChunks>[1]["PDFWorker"]>;
} {
  const byId = new Map<number, ZoteroItemLike>(
    (opts.children ?? []).map((child) => [child.id, child])
  );
  const cache = opts.fullTextCache ?? {};
  return {
    Items: {
      get(itemID: number): ZoteroItemLike | null {
        return byId.get(itemID) ?? null;
      }
    },
    FullText: {
      getItemContent(itemID: number): string | null {
        return cache[itemID] ?? null;
      }
    },
    // `exactOptionalPropertyTypes` rejects assigning a possibly-absent
    // value to an optional property; spread the PDF worker in only when
    // the fixture supplies one.
    ...(opts.pdfWorker !== undefined ? { PDFWorker: opts.pdfWorker } : {})
  };
}

/** Drain an AsyncGenerator into an array. */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of gen) {
    out.push(value);
  }
  return out;
}

// ====================================================================
// splitPdfWorkerText — pure string-split edge cases (D1)
// ====================================================================

describe("AC-4 splitPdfWorkerText — page-boundary split on \\f", () => {
  it("single-page text with no \\f → one page (the whole string)", () => {
    // P1: zero form-feeds → split length 1.
    const text = "The entire body of a one-page document.";
    const pages = splitPdfWorkerText(text);
    expect(pages.length).toBe(1);
    expect(pages[0]).toBe(text);
  });

  it("empty string → exactly one (empty) page, NOT zero pages", () => {
    // P2: page index 0 must always exist. "".split("\f") === [""].
    const pages = splitPdfWorkerText("");
    expect(pages.length).toBe(1);
    expect(pages[0]).toBe("");
  });

  it("N-1 form-feeds → N pages, in physical order", () => {
    // P1: a 3-page PDF has exactly 2 form-feeds.
    const pages = splitPdfWorkerText("page-zero\fpage-one\fpage-two");
    expect(pages).toEqual(["page-zero", "page-one", "page-two"]);
  });

  it("trailing \\f produces a final EMPTY page (page index preserved)", () => {
    // P3: a trailing delimiter must NOT be trimmed away — dropping it
    // would mean a downstream pageIndex no longer matches the PDF page.
    const pages = splitPdfWorkerText("page-zero\fpage-one\f");
    expect(pages.length).toBe(3);
    expect(pages[0]).toBe("page-zero");
    expect(pages[1]).toBe("page-one");
    expect(pages[2]).toBe("");
  });

  it("consecutive \\f\\f produces an EMPTY page between (no collapsing)", () => {
    // P3: a blank physical page (image-only / OCR miss) still occupies
    // a page slot. Collapsing it would shift every later pageIndex.
    const pages = splitPdfWorkerText("page-zero\f\fpage-two");
    expect(pages.length).toBe(3);
    expect(pages[0]).toBe("page-zero");
    expect(pages[1]).toBe("");
    expect(pages[2]).toBe("page-two");
  });

  it("leading \\f produces an empty page 0", () => {
    const pages = splitPdfWorkerText("\fpage-one");
    expect(pages.length).toBe(2);
    expect(pages[0]).toBe("");
    expect(pages[1]).toBe("page-one");
  });
});

// ====================================================================
// extractPerSourceChunks — PDF child attachments (P5, P6, P8, D2, D4)
// ====================================================================

describe("AC-4 extractPerSourceChunks — single-page PDF child", () => {
  it("single-page PDF → all pdf-page sources carry pageIndex 0", async () => {
    // Adversarial case: single-page PDF, split length 1.
    const pdf = fakeAttachment({ id: 200, key: "PDFKEY01", kind: "pdf" });
    const parent = fakeParent({
      id: 100,
      key: "ITEMKEY1",
      title: "Single Page Paper",
      attachmentIds: [200]
    });
    const access = makeAccess({
      children: [pdf],
      pdfWorker: makePdfWorker({
        200: { text: pageText("only page"), extractedPages: 1, totalPages: 1 }
      })
    });

    const sources = await collect(extractPerSourceChunks(parent, access));
    const pdfSources = sources.filter((s) => s.sourceKind === "pdf-page");
    expect(pdfSources.length).toBeGreaterThanOrEqual(1);
    for (const src of pdfSources) {
      // P6 / D2: pageIndex 0 is a valid value, never undefined.
      expect(src.pageIndex).toBe(0);
      expect(src.pageIndex).not.toBeUndefined();
      expect(src.attachmentKey).toBe("PDFKEY01");
    }
  });
});

describe("AC-4 extractPerSourceChunks — 10-page PDF child", () => {
  it("each page's source carries the correct 0-indexed pageIndex 0..9", async () => {
    // Adversarial case: 10-page PDF, pageIndex 0..9.
    const pdf = fakeAttachment({ id: 201, key: "PDFKEY10", kind: "pdf" });
    const parent = fakeParent({ id: 101, key: "ITEMKEYA", attachmentIds: [201] });
    const pages = Array.from({ length: 10 }, (_, n) => pageText(`physical page ${String(n)}`));
    const access = makeAccess({
      children: [pdf],
      pdfWorker: makePdfWorker({
        201: { text: workerText(pages), extractedPages: 10, totalPages: 10 }
      })
    });

    const sources = await collect(extractPerSourceChunks(parent, access));
    const pdfSources = sources.filter((s) => s.sourceKind === "pdf-page");

    // Every observed pageIndex must be an integer in 0..9.
    const observedIndices = new Set<number>();
    for (const src of pdfSources) {
      expect(typeof src.pageIndex).toBe("number");
      expect(Number.isInteger(src.pageIndex)).toBe(true);
      // `pageIndex` is `number | undefined` on the source type; the
      // `typeof` assertion above already pins it numeric. `Number(...)`
      // yields a plain `number` for the range matchers without a
      // forbidden non-null assertion (an undefined would surface as NaN
      // and still fail the range checks).
      const idx = Number(src.pageIndex);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThanOrEqual(9);
      expect(src.attachmentKey).toBe("PDFKEY10");
      observedIndices.add(idx);
    }
    // All 10 pages produced at least one source — none silently dropped.
    expect([...observedIndices].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    // D8: a source whose text mentions "physical page 7" must carry
    // pageIndex 7 — page identity, not just count.
    const page7 = pdfSources.find((s) => s.text.includes("physical page 7"));
    expect(page7).toBeDefined();
    expect(page7?.pageIndex).toBe(7);
  });
});

describe("AC-4 extractPerSourceChunks — paragraph spanning a page boundary", () => {
  it("a chunk that starts on page N keeps pageIndex N (chunker is page-unaware)", async () => {
    // Adversarial case: the `\f` falls between paragraphs; the chunk
    // beginning on page N keeps pageIndex N even if downstream text
    // physically lives on page N+1. extractPerSourceChunks yields ONE
    // source per PAGE — the chunker (chunkText) runs over each page's
    // text independently, so every chunk derived from page N inherits
    // pageIndex N.
    const pdf = fakeAttachment({ id: 202, key: "PDFKEYSP", kind: "pdf" });
    const parent = fakeParent({ id: 102, key: "ITEMKEYB", attachmentIds: [202] });
    // Page 0 ends mid-thought; page 1 continues the same paragraph.
    const page0 = "The argument begins here and continues without a clean break";
    const page1 = "into the next physical page where the sentence finally ends.";
    const access = makeAccess({
      children: [pdf],
      pdfWorker: makePdfWorker({
        202: { text: workerText([page0, page1]), extractedPages: 2, totalPages: 2 }
      })
    });

    const sources = await collect(extractPerSourceChunks(parent, access));
    const pdfSources = sources.filter((s) => s.sourceKind === "pdf-page");

    // The source containing page-0 text must be tagged pageIndex 0;
    // the source containing page-1 text must be tagged pageIndex 1.
    const startSource = pdfSources.find((s) => s.text.includes("argument begins here"));
    const endSource = pdfSources.find((s) => s.text.includes("sentence finally ends"));
    expect(startSource?.pageIndex).toBe(0);
    expect(endSource?.pageIndex).toBe(1);
    // The page-0 source must NOT have leaked page-1 content: per-page
    // extraction means page boundaries are hard cuts at the source level.
    expect(startSource?.text.includes("sentence finally ends")).toBe(false);
  });
});

describe("AC-4 extractPerSourceChunks — getFullText rejection isolation", () => {
  it("a corrupt/password PDF whose getFullText rejects is skipped, item continues", async () => {
    // Adversarial case: getFullText rejects → per-attachment catch
    // logs + increments skip counter + continues. The good PDF child
    // of the SAME item must still produce sources.
    const corruptPdf = fakeAttachment({ id: 203, key: "PDFBADKY", kind: "pdf" });
    const goodPdf = fakeAttachment({ id: 204, key: "PDFGOODK", kind: "pdf" });
    const parent = fakeParent({
      id: 103,
      key: "ITEMKEYC",
      title: "Paper With One Bad PDF",
      attachmentIds: [203, 204]
    });
    const access = makeAccess({
      children: [corruptPdf, goodPdf],
      pdfWorker: makePdfWorker({
        203: { reject: "PDF is password protected" },
        204: { text: pageText("readable page"), extractedPages: 1, totalPages: 1 }
      })
    });

    // The generator must NOT throw — the rejection is contained.
    const sources = await collect(extractPerSourceChunks(parent, access));

    // The corrupt PDF emits no pdf-page source for its key.
    const corruptSources = sources.filter((s) => s.attachmentKey === "PDFBADKY");
    expect(corruptSources).toEqual([]);

    // The good PDF of the same item still produced sources.
    const goodSources = sources.filter((s) => s.sourceKind === "pdf-page");
    expect(goodSources.length).toBeGreaterThanOrEqual(1);
    expect(goodSources.every((s) => s.attachmentKey === "PDFGOODK")).toBe(true);
  });

  it("an item whose ONLY PDF child rejects yields no pdf-page sources but does not throw", async () => {
    const corruptPdf = fakeAttachment({ id: 205, key: "PDFONLYB", kind: "pdf" });
    const parent = fakeParent({
      id: 104,
      key: "ITEMKEYD",
      title: "Paper Whose Only PDF Is Corrupt",
      abstractNote: "A readable abstract that still produces metadata.",
      attachmentIds: [205]
    });
    const access = makeAccess({
      children: [corruptPdf],
      pdfWorker: makePdfWorker({ 205: { reject: "Invalid PDF structure" } })
    });

    const sources = await collect(extractPerSourceChunks(parent, access));
    expect(sources.some((s) => s.sourceKind === "pdf-page")).toBe(false);
    // Metadata extraction is unaffected by the PDF failure.
    expect(sources.some((s) => s.sourceKind === "metadata")).toBe(true);
  });
});

describe("AC-4 extractPerSourceChunks — mixed PDF + EPUB children", () => {
  it("emits pdf-page chunks for the PDF and epub chunks for the EPUB, both with attachmentKey", async () => {
    // Adversarial case: item with a PDF child AND an EPUB child.
    const pdf = fakeAttachment({ id: 206, key: "PDFMIXED", kind: "pdf" });
    const epub = fakeAttachment({ id: 207, key: "EPUBMIXD", kind: "epub" });
    const parent = fakeParent({
      id: 105,
      key: "ITEMKEYE",
      title: "Item With PDF And EPUB",
      attachmentIds: [206, 207]
    });
    const access = makeAccess({
      children: [pdf, epub],
      pdfWorker: makePdfWorker({
        206: { text: pageText("pdf body"), extractedPages: 1, totalPages: 1 }
      }),
      // The EPUB attachment's fulltext flows through the FullText cache
      // (readAttachmentFullText), NOT the PDF worker.
      fullTextCache: { 207: pageText("epub body extracted from the spine") }
    });

    const sources = await collect(extractPerSourceChunks(parent, access));

    const pdfSources = sources.filter((s) => s.sourceKind === "pdf-page");
    const epubSources = sources.filter((s) => s.sourceKind === "epub");

    expect(pdfSources.length).toBeGreaterThanOrEqual(1);
    expect(epubSources.length).toBeGreaterThanOrEqual(1);

    // D4: both kinds stamp attachmentKey.
    expect(pdfSources.every((s) => s.attachmentKey === "PDFMIXED")).toBe(true);
    expect(epubSources.every((s) => s.attachmentKey === "EPUBMIXD")).toBe(true);

    // D6 / D7: epub sources must NOT carry a pageIndex.
    expect(epubSources.every((s) => s.pageIndex === undefined)).toBe(true);
    // pdf sources MUST carry a numeric pageIndex.
    expect(pdfSources.every((s) => typeof s.pageIndex === "number")).toBe(true);
  });
});

describe("AC-4 extractPerSourceChunks — standalone PDF attachment (no parent)", () => {
  it("a top-level PDF attachment is extracted via getFullText(item.id) directly", async () => {
    // Adversarial case: standalone PDF attachment, no parent → the
    // crawler walks the `item.isAttachment()` branch and calls
    // getFullText on the attachment item itself.
    const standalone = fakeAttachment({ id: 300, key: "STANDPDF", kind: "pdf" });
    const access = makeAccess({
      // No children registered — the attachment itself is the PDF.
      children: [],
      pdfWorker: makePdfWorker({
        300: {
          text: workerText([pageText("standalone p0"), pageText("standalone p1")]),
          extractedPages: 2,
          totalPages: 2
        }
      })
    });

    const sources = await collect(extractPerSourceChunks(standalone, access));
    const pdfSources = sources.filter((s) => s.sourceKind === "pdf-page");

    expect(pdfSources.length).toBeGreaterThanOrEqual(2);
    // attachmentKey is the standalone attachment's own key.
    expect(pdfSources.every((s) => s.attachmentKey === "STANDPDF")).toBe(true);
    // pageIndex 0 and 1 both observed — direct getFullText(item.id).
    const indices = new Set(pdfSources.map((s) => s.pageIndex));
    expect(indices.has(0)).toBe(true);
    expect(indices.has(1)).toBe(true);
  });
});

// ====================================================================
// extractPerSourceChunks — metadata / note sourceKind invariants (P8)
// ====================================================================

describe("AC-4 extractPerSourceChunks — metadata and note source kinds", () => {
  it("metadata source carries sourceKind 'metadata' with pageIndex and attachmentKey undefined", async () => {
    const parent = fakeParent({
      id: 106,
      key: "ITEMKEYF",
      title: "Title Only Paper",
      abstractNote: "An abstract that becomes a metadata source.",
      attachmentIds: []
    });
    const access = makeAccess({ children: [] });

    const sources = await collect(extractPerSourceChunks(parent, access));
    const metadata = sources.filter((s) => s.sourceKind === "metadata");
    expect(metadata.length).toBeGreaterThanOrEqual(1);
    for (const src of metadata) {
      // P8 / D7: metadata never carries a page index or attachment key.
      expect(src.pageIndex).toBeUndefined();
      expect(src.attachmentKey).toBeUndefined();
    }
  });

  it("every emitted source carries a sourceKind from the declared SourceKind union", async () => {
    const pdf = fakeAttachment({ id: 207, key: "PDFKINDS", kind: "pdf" });
    const parent = fakeParent({
      id: 107,
      key: "ITEMKEYG",
      title: "Coverage Item",
      abstractNote: "Abstract.",
      attachmentIds: [207]
    });
    const access = makeAccess({
      children: [pdf],
      pdfWorker: makePdfWorker({
        207: { text: pageText("body"), extractedPages: 1, totalPages: 1 }
      })
    });

    const sources = await collect(extractPerSourceChunks(parent, access));
    const allowed = new Set(["pdf-page", "metadata", "note", "epub", "snapshot", "attachment"]);
    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) {
      expect(allowed.has(src.sourceKind)).toBe(true);
    }
  });
});
