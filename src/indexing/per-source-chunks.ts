/**
 * Per-source text extraction — the AC-4 helper of the
 * pdf-context-features plan.
 *
 * `extractItemText` (in `library-crawler.ts`) concatenates an item's
 * whole text into one string. That loses provenance: a citation can no
 * longer point at the PDF page a chunk came from. This module replaces
 * that with a per-source generator: every distinct text source of an
 * item (its metadata, each note, each PDF page, each non-PDF
 * attachment) is yielded individually so the crawler can stamp a
 * `sourceKind` / `pageIndex` / `attachmentKey` on the resulting chunks.
 *
 * Two exports:
 *
 *   - `splitPdfWorkerText(text)` — splits `Zotero.PDFWorker.getFullText`
 *     output on the `\f` form-feed page delimiter. An N-page PDF emits
 *     N-1 form-feeds, so a single-page document yields a split of
 *     length 1. Empty pages (trailing `\f`, consecutive `\f\f`) are
 *     PRESERVED so a page index never desyncs from the physical page.
 *
 *   - `extractPerSourceChunks(item, access, options?)` — an
 *     AsyncGenerator yielding `{text, sourceKind, pageIndex?,
 *     attachmentKey?}` for every text source of the item, in order:
 *     metadata → notes → PDF pages → non-PDF attachments.
 *
 * Contract source: `docs/superpowers/plans/2026-05-19-pdf-context-features.md`
 * AC-4 (L435-449) and Public Interface Contracts (L662-714).
 */

import {
  DEFAULT_FULLTEXT_MAX_CHARS,
  readAttachmentFullText,
  readNoteBodies,
  type ExtractItemTextOptions,
  type SourceKind,
  type ZoteroFullTextAccess,
  type ZoteroItemLike,
  type ZoteroPdfWorker
} from "./library-crawler.js";

/**
 * One raw text source of an item, before chunking. The crawler runs
 * `chunkText` over `.text` and stamps the remaining fields on every
 * resulting chunk.
 */
export type PerSourceChunk = {
  readonly text: string;
  readonly sourceKind: SourceKind;
  /** PDF-page sources only; 0-indexed page number. undefined-absent. */
  readonly pageIndex?: number;
  /** PDF/EPUB/snapshot/attachment sources; the attachment's key. */
  readonly attachmentKey?: string;
};

/**
 * The access object `extractPerSourceChunks` consumes —
 * `ZoteroFullTextAccess` widened with the optional PDF worker. The
 * `PDFWorker` slot tolerates an explicit `undefined` so callers that
 * thread a possibly-absent `Zotero.PDFWorker` through need no narrowing.
 */
export type PerSourceAccess = ZoteroFullTextAccess & {
  readonly PDFWorker?: ZoteroPdfWorker | undefined;
};

/**
 * Split `Zotero.PDFWorker.getFullText` output into per-page strings on
 * the `\f` form-feed delimiter.
 *
 * Invariant: the result length equals the physical page count, and
 * `result[n]` is the text of physical page `n`. Empty pages are NEVER
 * dropped or collapsed — a trailing `\f` yields a final empty page, a
 * `\f\f` run yields an empty page between, a leading `\f` yields an
 * empty page 0. `splitPdfWorkerText("")` is one (empty) page, never
 * zero pages, so page index 0 always exists.
 */
export function splitPdfWorkerText(text: string): readonly string[] {
  return text.split("\f");
}

/** Build the combined title + abstract metadata text for an item. */
function metadataText(item: ZoteroItemLike): string {
  const title = (item.getField("title") ?? "").trim();
  const abstract = (item.getField("abstractNote") ?? "").trim();
  const parts: string[] = [];
  if (title.length > 0) parts.push(title);
  if (abstract.length > 0) parts.push(abstract);
  return parts.join("\n\n");
}

/**
 * Classify a non-PDF attachment's `sourceKind` from its content type
 * when Zotero exposes one. Falls back to `"epub"` — the fixtures and
 * the common non-PDF cached-fulltext case (EPUB spine extraction) make
 * this the right default; an explicit content type always wins.
 */
function nonPdfSourceKind(contentType: string | undefined): SourceKind {
  if (contentType === undefined) return "epub";
  const ct = contentType.toLowerCase();
  if (ct.includes("epub")) return "epub";
  if (ct.includes("html")) return "snapshot";
  return "attachment";
}

/**
 * True when an attachment's content type names a PDF. When the content
 * type is absent (test fixtures, stripped hosts) this returns
 * `undefined` so the caller probes the PDF worker instead.
 */
function isPdfContentType(contentType: string | undefined): boolean | undefined {
  if (contentType === undefined) return undefined;
  return contentType.toLowerCase().includes("pdf");
}

/**
 * Extract one attachment's PDF text. Calls
 * `pdfWorker.getFullText(attachment.id)` and splits on `\f`.
 *
 * Returns the per-page strings on success, or `null` when `getFullText`
 * rejects (corrupt / password-protected PDF, or a non-PDF attachment
 * the worker refuses) so the caller can fall back or count a skip.
 */
async function extractPdfPages(
  attachment: ZoteroItemLike,
  pdfWorker: ZoteroPdfWorker,
  maxChars: number
): Promise<readonly string[] | null> {
  try {
    const result = await pdfWorker.getFullText(attachment.id);
    // AC-16: cap the worker output before splitting + chunking. Without
    // this, a textbook-sized PDF can return 50+ MB of text — splitting,
    // chunking, and embedding each chunk then OOMs the Zotero chrome
    // process. The cap matches `readAttachmentFullText`'s for parity.
    // Trim at the last `\f` page boundary before the cap so we never
    // mid-cut a page (keeps page-index alignment clean).
    let text = result.text;
    if (text.length > maxChars) {
      const truncated = text.substring(0, maxChars);
      const lastBoundary = truncated.lastIndexOf("\f");
      text = lastBoundary > 0 ? truncated.substring(0, lastBoundary) : truncated;
    }
    return splitPdfWorkerText(text);
  } catch {
    return null;
  }
}

/**
 * Yield the text sources of ONE attachment item — PDF pages when it is
 * a PDF, otherwise its cached fulltext via `readAttachmentFullText`.
 */
async function* yieldAttachmentSources(
  attachment: ZoteroItemLike,
  access: PerSourceAccess,
  maxChars: number
): AsyncGenerator<PerSourceChunk> {
  if (!attachment.isAttachment()) return;
  if (attachment.isAnnotation()) return;

  const contentType = attachment.attachmentContentType;
  const pdfByContentType = isPdfContentType(contentType);
  const pdfWorker = access.PDFWorker;

  // Treat as a PDF when a PDF worker is wired AND the content type
  // either says PDF or is unknown (probe it; a rejection falls through
  // to the non-PDF path).
  if (pdfWorker !== undefined && pdfByContentType !== false) {
    const pages = await extractPdfPages(attachment, pdfWorker, maxChars);
    if (pages !== null) {
      // getFullText resolved — the attachment IS a PDF. Emit one source
      // per page; `pageIndex` 0 is a VALID value, so every page is
      // emitted to keep the index aligned with the physical page
      // number (the crawler's `chunkText` drops whitespace-only pages).
      for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
        yield {
          text: pages[pageIndex] ?? "",
          sourceKind: "pdf-page",
          pageIndex,
          attachmentKey: attachment.key
        };
      }
      return;
    }
    // getFullText rejected. When the content type explicitly says PDF
    // this is a corrupt / password-protected PDF — stop, emit nothing.
    // When the type was unknown, fall through to the non-PDF path: the
    // attachment may simply be an EPUB the worker refused.
    if (pdfByContentType === true) return;
  }

  // Non-PDF (or PDF-probe-failed unknown type) attachment: read cached
  // fulltext through the existing `.zotero-ft-cache` path.
  const fullText = readAttachmentFullText(attachment, access, maxChars);
  if (fullText.trim().length === 0) return;
  yield {
    text: fullText,
    sourceKind: nonPdfSourceKind(contentType),
    attachmentKey: attachment.key
  };
}

/**
 * Yield every text source of an item — metadata, notes, then each
 * child (or, for a standalone attachment, the item itself) — so the
 * crawler can stamp provenance per chunk.
 *
 * Order: metadata → notes → attachments. PDF attachments yield one
 * source per page (`sourceKind: "pdf-page"`, `pageIndex` set); non-PDF
 * attachments yield one source from their cached fulltext.
 *
 * A `getFullText` rejection on one PDF is contained: the generator
 * skips that attachment and continues — it never aborts the whole item.
 */
export async function* extractPerSourceChunks(
  item: ZoteroItemLike,
  access: PerSourceAccess,
  options?: ExtractItemTextOptions
): AsyncGenerator<PerSourceChunk> {
  const maxChars = options?.fullTextMaxChars ?? DEFAULT_FULLTEXT_MAX_CHARS;

  // 1) Metadata (title + abstract) — never carries a page or attachment.
  const metadata = metadataText(item);
  if (metadata.trim().length > 0) {
    yield { text: metadata, sourceKind: "metadata" };
  }

  // 2) Notes — `readNoteBodies` only returns content when the item
  //    itself supports `getNote()` (a note/attachment item).
  for (const body of readNoteBodies(item)) {
    if (body.trim().length > 0) {
      yield { text: body, sourceKind: "note" };
    }
  }

  // 3a) Standalone attachment (no parent) — extract the item directly.
  if (item.isAttachment()) {
    yield* yieldAttachmentSources(item, access, maxChars);
    return;
  }

  // 3b) Bibliographic item — walk its child attachments.
  if (typeof item.getAttachments !== "function") return;
  let attachmentIds: readonly number[];
  try {
    attachmentIds = item.getAttachments();
  } catch {
    return;
  }
  for (const id of attachmentIds) {
    const child = access.Items.get(id);
    if (child === null) continue;
    yield* yieldAttachmentSources(child, access, maxChars);
  }
}
