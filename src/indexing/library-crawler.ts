/**
 * Library crawler — the AC3 module of the real-product-pipeline plan.
 *
 * Three pure helpers and one orchestrator:
 *
 *   - `extractItemText(item, options?)` — synchronous concatenator of
 *     title + abstract + (optional) cached PDF/EPUB fulltext from
 *     Zotero's `.zotero-ft-cache`. Skips items whose combined text is
 *     whitespace-only. When `options.zotero` is supplied, fulltext is
 *     read from `Zotero.FullText` for the item itself (when it is a
 *     standalone attachment) and for each child attachment of a
 *     top-level bibliographic item. No async work; uses
 *     `Zotero.File.getContents` (synchronous in Zotero 9). When
 *     `options.zotero` is omitted (unit tests of the pure helper), only
 *     title + abstract are concatenated.
 *
 *   - `chunkText(text, maxBytes)` — splits text on paragraph boundary
 *     when possible; falls back to a surrogate-pair-safe hard cut when
 *     a paragraph alone exceeds `maxBytes`. Empty/whitespace-only input
 *     returns `[]`.
 *
 *   - `indexLibrary(deps, options)` — iterates
 *     `Zotero.Items.getAll(libraryID, true)`, embeds each chunk via the
 *     injected provider, persists per-item, and respects pause/abort
 *     signals. Yields to the event loop between items AND between
 *     chunks (`await deps.scheduler()`) so the Zotero chrome stays
 *     responsive: worst-case freeze window is ONE chunk fetch, not the
 *     full library scan (FINDING-4). Tripping the circuit breaker
 *     (K=3 consecutive chunk failures) rejects with
 *     `EmbedCircuitBreakerError` whose message matches the controller's
 *     pattern (FINDING-12).
 *
 * Contract source: `docs/superpowers/plans/2026-05-17-real-product-pipeline.md`
 * AC3 (L527-684, L976-1014).
 */

import {
  extractPerSourceChunks,
  type PerSourceAccess,
  type PerSourceChunk
} from "./per-source-chunks.js";

/** Default chunk size — approximately the 2 KB the plan calls out. */
export const DEFAULT_CHUNK_BYTES = 2048;

/** Circuit-breaker threshold: consecutive per-chunk embed failures. */
export const CIRCUIT_BREAKER_THRESHOLD = 3;

/** Exact failure message the controller pattern-matches against. */
export const CIRCUIT_BREAKER_MESSAGE = "Connection to Ollama lost after 3 consecutive failures.";

export type ZoteroItemLike = {
  readonly id: number;
  readonly key: string;
  getField(name: "title" | "abstractNote"): string | undefined;
  getNotes(includeTrashed?: boolean): readonly number[];
  // FINDING-7: synchronous in Zotero 9; returns the note HTML body.
  // Only defined on note/attachment items — calling on a regular item
  // (article, preprint, book) THROWS. The crawler does not invoke this
  // directly; it stays on the type for back-compat with tests that
  // exercise the pure `extractItemText` helper.
  getNote?(): string;
  // Sync in Zotero 9; returns child attachment item IDs. Throws when
  // called on an attachment item (Zotero source: data/item.js
  // `Zotero.Item.prototype.getAttachments`). The crawler guards with
  // `isAttachment()` before calling.
  getAttachments?(includeTrashed?: boolean): readonly number[];
  isAttachment(): boolean;
  isAnnotation(): boolean;
  // Phase 4 (per-page PDF text): MIME type of an attachment item
  // (`application/pdf`, `application/epub+zip`, `text/html`, …). Used by
  // `extractPerSourceChunks` to route an attachment to the PDF-worker
  // path vs. the cached-fulltext path. Absent on non-attachment items
  // and on stripped-down hosts / test fixtures — the per-source helper
  // then probes `Zotero.PDFWorker` directly.
  readonly attachmentContentType?: string;
};

/**
 * Narrow view of `Zotero.FullText` + `Zotero.File` that the crawler
 * needs to read the cached fulltext for one attachment. Both methods
 * are synchronous in Zotero 9:
 *
 *   - `Zotero.FullText.getItemCacheFile(attachment)` — returns an
 *     nsIFile pointing at the attachment's `.zotero-ft-cache` (or a
 *     path-like object with an `exists()` and `path`). When Zotero has
 *     never indexed the attachment the file does not exist on disk.
 *   - `Zotero.File.getContents(file, charset, maxLength)` — reads
 *     synchronously up to `maxLength` UTF-16 code units. Throwing or
 *     returning empty is fine; the caller falls back to "".
 *
 * `getItemContent(itemID)` is referenced in some Zotero docs as a
 * convenience that wraps the above two; when present we prefer it.
 */
export type ZoteroFullTextAccess = {
  readonly FullText?: {
    getItemContent?(itemID: number): string | null | undefined;
    getItemCacheFile?(item: ZoteroItemLike): { exists(): boolean; path?: string } | null;
  };
  readonly File?: {
    getContents?(
      file: { exists(): boolean; path?: string } | string,
      charset?: string,
      maxLength?: number
    ): string;
  };
  readonly Items: {
    get(itemID: number): ZoteroItemLike | null;
  };
};

/**
 * Narrow view of `Zotero.PDFWorker` — the chrome-side PDF.js worker
 * bridge. `getFullText` resolves to per-page text where page boundaries
 * are `\f` form-feed characters (an N-page PDF has exactly N-1
 * form-feeds). Rejects when the attachment is not a PDF or the worker
 * fails to parse it (corrupt / password-protected file).
 */
export type ZoteroPdfWorker = {
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

export type ExtractItemTextOptions = {
  readonly zotero?: ZoteroFullTextAccess;
  /**
   * Hard cap on attachment fulltext per item. 50_000 chars is roughly
   * the chunkText output for a 25-page paper at ~2 KB per chunk and is
   * tight enough to bound a single item's embed cost. Above this the
   * marginal embed value drops sharply and the failure-mode cost (a
   * 500-page book OCR'd to 5 MB of text) grows linearly. The cap is
   * applied BEFORE chunkText so the chunker never sees a runaway input.
   */
  readonly fullTextMaxChars?: number;
};

export const DEFAULT_FULLTEXT_MAX_CHARS = 50_000;

/**
 * Current IndexFile schema version (v0.3.0). Legacy files written by
 * v0.2.0 and earlier have no `schemaVersion` field and are treated as
 * version 1 by all readers. Bumping this constant signals to
 * `readWithMigration()` that a one-time atomic migration is due.
 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * Descriptive provenance for an indexed chunk. `pdf-page` chunks carry a
 * `pageIndex`; `metadata`/`note` chunks never do; `epub`/`snapshot`/
 * `attachment` chunks carry an `attachmentKey` but no `pageIndex`.
 */
export type SourceKind = "pdf-page" | "metadata" | "note" | "epub" | "snapshot" | "attachment";

export type IndexedItemChunk = {
  readonly text: string;
  readonly embedding: readonly number[];
  /** REQUIRED (v0.3.0) — describes where the chunk's text came from. */
  readonly sourceKind: SourceKind;
  /** PDF-page chunks only; 0-indexed page number. undefined-absent. */
  readonly pageIndex?: number;
  /** PDF/EPUB/snapshot/attachment chunks; the source attachment's key. */
  readonly attachmentKey?: string;
};

export type IndexedItem = {
  readonly title: string;
  readonly chunks: readonly IndexedItemChunk[];
};

export type IndexFile = {
  /**
   * Schema version. `CURRENT_SCHEMA_VERSION` for v0.3.0 crawls; legacy
   * files have no field and are treated as version 1 by readers.
   */
  readonly schemaVersion: number;
  readonly items: Record<string, IndexedItem>;
  readonly indexedAt: string;
};

export type LibraryCrawlerDeps = {
  readonly zotero: {
    readonly Libraries: { readonly userLibraryID: number };
    readonly Items: {
      getAll(libraryID: number, onlyTopLevel: boolean): Promise<readonly ZoteroItemLike[]>;
      get(itemID: number): ZoteroItemLike | null;
    };
    // Optional — when present, `extractItemText` pulls cached PDF/EPUB
    // fulltext from `.zotero-ft-cache`. Tests that don't care about
    // fulltext can omit it (the crawler then degrades to title+abstract
    // only, matching pre-Phase 4 behavior).
    readonly FullText?: ZoteroFullTextAccess["FullText"];
    readonly File?: ZoteroFullTextAccess["File"];
    // Phase 4 (per-page PDF text): the chrome-side PDF.js worker bridge.
    // When present the crawler extracts per-page text via
    // `getFullText` instead of reading the `.zotero-ft-cache` blob.
    // Absent on hosts that stripped the module; the crawler then falls
    // back to `readAttachmentFullText`.
    readonly PDFWorker?: ZoteroPdfWorker;
  };
  readonly provider: {
    embedTexts(request: {
      readonly baseUrl: string;
      readonly model: string;
      readonly texts: readonly string[];
      readonly signal: AbortSignal;
    }): Promise<readonly (readonly number[])[]>;
  };
  readonly settings: { readonly baseUrl: string; readonly embeddingModel: string };
  readonly storage: {
    read(): Promise<IndexFile | null>;
    /**
     * Back-compat / AC-15 final-write fallback. Persists the WHOLE
     * IndexFile (O(N) in items). The hot per-item loop uses `writeItem`
     * (O(1)) instead — `write` is only called once at the end of an
     * empty completion. Migration adapters in the controller also wire
     * `write` to `writeTmp` so the empty-completion seed lands in the
     * AC-5 `.tmp` rather than the primary.
     */
    write(file: IndexFile): Promise<void>;
    /**
     * AC-23 (OOM fix): per-item persist. The crawler calls this after
     * each successfully-indexed item so each persist is O(1) instead of
     * O(N) per item / O(N²) over a crawl.
     */
    writeItem(itemKey: string, entry: IndexedItem): Promise<void>;
    clear(): Promise<void>;
    path(): string;
  };
  /**
   * Per-progress-tick callback. `indexed` / `failed` / `total` are the
   * canonical counts; `skippedNoText` reports items skipped this run
   * because they had no embeddable text (honest-counter cleanup). The
   * `skippedNoText` argument is optional in the signature so existing
   * test stubs that ignore it keep compiling.
   */
  readonly onProgress: (
    indexed: number,
    failed: number,
    total: number,
    skippedNoText?: number
  ) => void;
  /**
   * One-shot run-start callback. Fires once after the crawler reads
   * the persisted IndexFile so the controller can seed the reducer's
   * `previouslyIndexed` counter (items already indexed before this
   * run). Optional — older callers that only consume `onProgress`
   * continue to work.
   */
  readonly onRunStart?: (info: { previouslyIndexed: number; total: number }) => void;
  // FINDING-4: scheduler awaited between items + chunks. Default
  // injected by the controller is `() => new Promise(r => setTimeout(r, 0))`.
  readonly scheduler: () => Promise<void>;
  // FINDING-4: pause aborts any in-flight embed by aborting this controller.
  readonly abortController: AbortController;
};

export type IndexLibraryOptions = {
  readonly signal: AbortSignal;
  readonly isPaused: () => boolean;
  readonly resumeFromItemKey?: string;
};

/**
 * Custom error subclass for the AC3 circuit breaker so the controller can
 * pattern-match either on `instanceof` or on `message` per the plan.
 */
export class EmbedCircuitBreakerError extends Error {
  public override readonly name = "EmbedCircuitBreakerError";

  public constructor(message: string = CIRCUIT_BREAKER_MESSAGE) {
    super(message);
  }
}

export function readNoteBodies(item: ZoteroItemLike): readonly string[] {
  // getNotes() returns CHILD note item IDs. Calling item.getNote() on a
  // PARENT item (article/preprint/book) THROWS at runtime ("getNote()
  // can only be called on notes and attachments"). Child-note bodies
  // would require Zotero.Items.get(noteID).getNote() and are deferred:
  // the user-visible bug we are fixing in Phase 4 is missing PDF
  // fulltext, not missing notes, and a real child-note pass would also
  // need HTML-strip handling (Zotero stores notes as HTML). For now
  // `extractItemText` only returns a body if THIS item itself supports
  // getNote() (i.e., it is a note/attachment) — that path is dead code
  // for the orchestrator (which calls only on top-level items) but kept
  // for the unit-test contract.
  if (typeof item.getNote !== "function") {
    return [];
  }
  try {
    const body = item.getNote();
    return body.length > 0 ? [body] : [];
  } catch {
    return [];
  }
}

/**
 * Read the cached fulltext (`.zotero-ft-cache`) for ONE attachment.
 * Returns "" when:
 *   - the FullText/File access object is not wired (test harness path),
 *   - the attachment has never been indexed (cache file missing),
 *   - the file read throws (permission, transient IO),
 *   - the cached content is whitespace-only.
 *
 * Synchronous: relies on `Zotero.File.getContents` (sync in Zotero 9)
 * or `Zotero.FullText.getItemContent` (sync; preferred when present).
 */
export function readAttachmentFullText(
  attachment: ZoteroItemLike,
  access: ZoteroFullTextAccess,
  maxChars: number
): string {
  if (!attachment.isAttachment()) return "";
  // Skip annotations — they have their own text but are noisy and the
  // user is already free to comment via the existing note path.
  if (attachment.isAnnotation()) return "";

  const fullText = access.FullText;
  if (fullText === undefined) return "";

  // Preferred path: a synchronous Zotero.FullText.getItemContent that
  // returns the cached text directly. Not present in every Zotero 9
  // build, hence the optional chain.
  if (typeof fullText.getItemContent === "function") {
    try {
      const direct = fullText.getItemContent(attachment.id);
      if (typeof direct === "string" && direct.trim().length > 0) {
        return direct.length > maxChars ? direct.substring(0, maxChars) : direct;
      }
    } catch {
      // Fall through to the cache-file path.
    }
  }

  // Fallback path: read the .zotero-ft-cache file directly. Mirrors what
  // `attachmentText` does internally (data/item.js L3893 in the Zotero
  // source) without paying the async / on-demand-extract cost.
  if (typeof fullText.getItemCacheFile !== "function") return "";
  if (access.File === undefined || typeof access.File.getContents !== "function") return "";
  let cacheFile: { exists(): boolean; path?: string } | null;
  try {
    cacheFile = fullText.getItemCacheFile(attachment);
  } catch {
    return "";
  }
  if (cacheFile === null) return "";
  let exists = false;
  try {
    exists = cacheFile.exists();
  } catch {
    return "";
  }
  if (!exists) return "";
  try {
    const text = access.File.getContents(cacheFile, "UTF-8", maxChars);
    if (typeof text !== "string") return "";
    return text;
  } catch {
    return "";
  }
}

/**
 * Walk a regular (top-level bibliographic) item's child attachments and
 * concatenate their cached fulltext. Each attachment contributes at
 * most `maxChars`; the per-item total is capped at `maxChars` overall
 * so a multi-PDF item (preprint + supplement) does not balloon past the
 * cap. Returns "" when no attachments have cached text.
 */
function readChildAttachmentFullText(
  item: ZoteroItemLike,
  access: ZoteroFullTextAccess,
  maxChars: number
): string {
  if (typeof item.getAttachments !== "function") return "";
  let attachmentIds: readonly number[];
  try {
    attachmentIds = item.getAttachments();
  } catch {
    return "";
  }
  if (attachmentIds.length === 0) return "";

  const parts: string[] = [];
  let remaining = maxChars;
  for (const id of attachmentIds) {
    if (remaining <= 0) break;
    const child = access.Items.get(id);
    if (child === null) continue;
    const text = readAttachmentFullText(child, access, remaining);
    if (text.length === 0) continue;
    parts.push(text);
    remaining -= text.length;
  }
  if (parts.length === 0) return "";
  const joined = parts.join("\n\n");
  return joined.length > maxChars ? joined.substring(0, maxChars) : joined;
}

export function extractItemText(item: ZoteroItemLike, options?: ExtractItemTextOptions): string {
  const title = (item.getField("title") ?? "").trim();
  const abstract = (item.getField("abstractNote") ?? "").trim();
  const notes = readNoteBodies(item).map((b) => b.trim());

  const parts: string[] = [];
  if (title.length > 0) parts.push(title);
  if (abstract.length > 0) parts.push(abstract);
  for (const note of notes) {
    if (note.length > 0) parts.push(note);
  }

  // Phase 4: attachment fulltext. Only activated when the caller wires
  // a `zotero` access object — pure-helper tests omit it and keep the
  // old "title + abstract" surface.
  if (options?.zotero !== undefined) {
    const maxChars = options.fullTextMaxChars ?? DEFAULT_FULLTEXT_MAX_CHARS;
    let fullText = "";
    if (item.isAttachment()) {
      // Standalone (top-level) PDF / EPUB / web snapshot attachment.
      fullText = readAttachmentFullText(item, options.zotero, maxChars);
    } else {
      // Top-level bibliographic item — walk child attachments.
      fullText = readChildAttachmentFullText(item, options.zotero, maxChars);
    }
    if (fullText.trim().length > 0) {
      parts.push(fullText);
    }
  }

  return parts.join("\n\n");
}

/**
 * Split a string of code units into surrogate-safe chunks of at most
 * `maxBytes` code units. Never separates a high surrogate from its low
 * surrogate (FINDING — see `chunk-text.test.ts` T8).
 */
function hardCut(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxBytes, text.length);
    if (end < text.length) {
      const lastCode = text.charCodeAt(end - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        // The last included unit is a high surrogate; back off so its
        // low-surrogate partner stays with it in the next chunk.
        end -= 1;
      }
    }
    if (end === i) {
      // Pathological input (e.g., maxBytes=1 with a lone high surrogate).
      // Emit a single unit to guarantee progress.
      end = i + 1;
    }
    chunks.push(text.substring(i, end));
    i = end;
  }
  return chunks;
}

export function chunkText(text: string, maxBytes: number): readonly string[] {
  if (text.trim().length === 0) return [];
  if (text.length <= maxBytes) return [text];

  const paragraphs = text.split("\n\n").filter((p) => p.length > 0);
  if (paragraphs.length === 0) return [];
  if (paragraphs.length === 1) {
    // No paragraph boundary to lean on — hard-cut the single paragraph.
    return hardCut(paragraphs[0] ?? text, maxBytes);
  }

  const chunks: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    if (para.length > maxBytes) {
      // Flush any accumulated chunk first, then hard-cut this paragraph.
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      for (const piece of hardCut(para, maxBytes)) {
        chunks.push(piece);
      }
      continue;
    }
    const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
    if (candidate.length <= maxBytes) {
      current = candidate;
    } else {
      chunks.push(current);
      current = para;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return true;
  if (typeof err === "object" && err !== null && "name" in err && err.name === "AbortError") {
    return true;
  }
  return false;
}

function abortError(): Error {
  const err = new Error("indexLibrary aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Walk the user library, embed each item's text through the configured
 * provider, and persist the running `IndexFile` between items.
 *
 * Behavior is documented inline in the per-test references. See the
 * module-level doc-comment above for the AC3 plan citation.
 */
export async function indexLibrary(
  deps: LibraryCrawlerDeps,
  options: IndexLibraryOptions
): Promise<{ readonly completed: boolean }> {
  const { signal } = options;
  const checkAborted = (): void => {
    if (signal.aborted) {
      throw abortError();
    }
  };

  checkAborted();

  const initialFile = await deps.storage.read();
  const items = await deps.zotero.Items.getAll(deps.zotero.Libraries.userLibraryID, true);
  const total = items.length;

  let currentFile: IndexFile = initialFile ?? {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    items: {},
    indexedAt: new Date().toISOString()
  };
  // AC-15: track whether the loop wrote at least once. The per-item write
  // at the bottom of the loop only fires on a successful index. If a fresh
  // crawl indexes zero items (empty library; or every item skipped for
  // no-text; or every item failed), nothing ever writes, but we still
  // return `{completed: true}` — leaving downstream consumers ("complete
  // implies file exists") inconsistent. The migration path handles this
  // by seeding an empty `.tmp` (indexing-controller.ts:323-327); the
  // non-migration path needs the same invariant, applied below.
  let didWriteThisRun = false;

  let indexed = 0;
  let failed = 0;
  let skippedNoText = 0;
  // Phase 4 (PDF fulltext) diagnostics. `indexedAttachments` counts
  // items that contributed at least one chunk of attachment fulltext
  // (i.e. a PDF/EPUB whose cache was non-empty). `skippedAttachmentText`
  // counts standalone attachment items that the caller asked us to
  // index but for which the cache was empty/missing — those items
  // would have been skipped under the old title+abstract-only path and
  // still are, but this counter makes the "why is my coverage low"
  // story visible in the summary log.
  let indexedAttachments = 0;
  let skippedAttachmentText = 0;
  let consecutiveFailures = 0;
  // Honest counter: tell the controller how many items were already
  // indexed before this run so the UI can display "X already indexed"
  // instead of restarting from 0 on every resumed run.
  const previouslyIndexedInitial = initialFile !== null ? Object.keys(initialFile.items).length : 0;
  deps.onRunStart?.({ previouslyIndexed: previouslyIndexedInitial, total });
  deps.onProgress(indexed, failed, total, skippedNoText);

  // Resume: skip to the first item whose key matches resumeFromItemKey.
  let startIndex = 0;
  if (options.resumeFromItemKey !== undefined) {
    const idx = items.findIndex((it) => it.key === options.resumeFromItemKey);
    if (idx >= 0) {
      startIndex = idx;
    }
  }

  for (let i = startIndex; i < items.length; i += 1) {
    checkAborted();
    await deps.scheduler();

    const item = items[i];
    if (item === undefined) continue;

    // Resume skip: items already present in the loaded initialFile are
    // not re-embedded (FINDING-5).
    if (initialFile !== null && Object.prototype.hasOwnProperty.call(initialFile.items, item.key)) {
      continue;
    }

    // Build the per-source access object once per loop iteration — the
    // zotero deps object already carries `Items`, and the optional
    // `FullText`/`File`/`PDFWorker` properties make this a safe widening
    // that narrows to "title + abstract only" when the host is a test
    // stub without the PDF worker.
    const access: PerSourceAccess = {
      Items: deps.zotero.Items,
      ...(deps.zotero.FullText !== undefined ? { FullText: deps.zotero.FullText } : {}),
      ...(deps.zotero.File !== undefined ? { File: deps.zotero.File } : {}),
      ...(deps.zotero.PDFWorker !== undefined ? { PDFWorker: deps.zotero.PDFWorker } : {})
    };

    // Phase 4: iterate the per-source generator (metadata, notes, PDF
    // pages, non-PDF attachments) so each chunk carries its provenance
    // (`sourceKind` / `pageIndex` / `attachmentKey`). A `getFullText`
    // rejection on a corrupt PDF is contained inside the generator — it
    // skips that attachment and continues, so a bad PDF never counts
    // the whole item as failed.
    let sources: PerSourceChunk[];
    try {
      sources = [];
      for await (const source of extractPerSourceChunks(item, access, {
        fullTextMaxChars: DEFAULT_FULLTEXT_MAX_CHARS
      })) {
        sources.push(source);
      }
    } catch {
      // Defensive: if a single item's metadata read throws (e.g. an
      // unexpected Zotero item type that rejects one of the field/note
      // calls), count it as a failure but keep crawling. The K=3 circuit
      // breaker is for embed failures only — metadata-read failures should
      // never take down the whole library scan.
      failed += 1;
      deps.onProgress(indexed, failed, total, skippedNoText);
      continue;
    }

    // Chunk each source independently, stamping its provenance on every
    // resulting chunk. Whitespace-only pages (blank PDF pages) chunk to
    // `[]` and contribute nothing.
    //
    // AC-16: wrap chunking in a try/catch so a memory-exhaustion error
    // here (a single source yielding many MB of text, then chunkText's
    // intermediate arrays pushing the chrome process past its memory
    // cap) is contained per-item — the same way an `extractPerSourceChunks`
    // failure already is. Without this wrap, the OOM escapes the narrow
    // extract-only catch above and aborts the whole crawl (the user's
    // observed "Indexing failed: out of memory" after 33 skipped items).
    let sourceChunks: PerSourceChunk[];
    try {
      sourceChunks = [];
      for (const source of sources) {
        for (const chunk of chunkText(source.text, DEFAULT_CHUNK_BYTES)) {
          sourceChunks.push({
            text: chunk,
            sourceKind: source.sourceKind,
            ...(source.pageIndex !== undefined ? { pageIndex: source.pageIndex } : {}),
            ...(source.attachmentKey !== undefined ? { attachmentKey: source.attachmentKey } : {})
          });
        }
      }
    } catch {
      // Memory exhaustion (or any other unexpected chunking error) for
      // ONE item must not abort the entire crawl. Mark the item failed,
      // advance progress, and continue.
      failed += 1;
      deps.onProgress(indexed, failed, total, skippedNoText);
      continue;
    }

    if (sourceChunks.length === 0) {
      // Empty items are skipped without counting as failures (P3 in the
      // test fault-localization). Most commonly these are standalone
      // attachments / annotations without a populated title or abstract
      // AND no cached fulltext. Bump the attachment-specific counter
      // when the item we just skipped IS itself an attachment, so the
      // summary log can distinguish "no metadata" from "no PDF text".
      skippedNoText += 1;
      if (item.isAttachment() && !item.isAnnotation()) {
        skippedAttachmentText += 1;
      }
      // Push the skip into the progress stream so the UI's "W skipped"
      // counter advances live rather than only after the final summary.
      deps.onProgress(indexed, failed, total, skippedNoText);
      continue;
    }
    // An item is "attachment-driven" when at least one chunk came from
    // an attachment (PDF/EPUB/snapshot/other) rather than metadata/note
    // — the user's mental model is "did the PDF contribute?".
    const attachmentTextContributed = sourceChunks.some(
      (chunk) => chunk.attachmentKey !== undefined
    );

    const accumulated: IndexedItemChunk[] = [];
    let itemFailed = false;

    for (const chunk of sourceChunks) {
      await deps.scheduler();

      // Point (a): pause check BEFORE the in-flight embed call.
      if (options.isPaused()) {
        deps.abortController.abort();
        return { completed: false };
      }

      let embedding: readonly number[] | undefined;
      try {
        const result = await deps.provider.embedTexts({
          baseUrl: deps.settings.baseUrl,
          model: deps.settings.embeddingModel,
          texts: [chunk.text],
          signal: deps.abortController.signal
        });
        embedding = result[0];
      } catch (err) {
        // An aborted in-flight fetch surfaces as AbortError. Treat it as
        // a pause signal: discard, bail out cleanly.
        if (isAbortError(err)) {
          deps.abortController.abort();
          return { completed: false };
        }
        consecutiveFailures += 1;
        itemFailed = true;
        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          throw new EmbedCircuitBreakerError();
        }
        break;
      }

      // Point (b): pause check AFTER the embed resolves but before the
      // chunk accumulator update.
      if (options.isPaused()) {
        deps.abortController.abort();
        return { completed: false };
      }

      if (embedding === undefined) {
        // Provider returned an empty embeddings array — treat as failure.
        consecutiveFailures += 1;
        itemFailed = true;
        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          throw new EmbedCircuitBreakerError();
        }
        break;
      }

      accumulated.push({
        text: chunk.text,
        embedding,
        sourceKind: chunk.sourceKind,
        ...(chunk.pageIndex !== undefined ? { pageIndex: chunk.pageIndex } : {}),
        ...(chunk.attachmentKey !== undefined ? { attachmentKey: chunk.attachmentKey } : {})
      });
    }

    if (itemFailed) {
      failed += 1;
      deps.onProgress(indexed, failed, total, skippedNoText);
      continue;
    }

    // Success: reset the breaker, persist the item, advance progress.
    // AC-23: per-item file write — O(1) regardless of library size
    // (was O(N) per write under the monolithic-file layout, which
    // OOMed at ~200 items). The persist step is wrapped in try/catch
    // so a single-item write failure (the JSON for one item is still
    // measured in MB) counts as `failed += 1` rather than aborting
    // the whole crawl; the in-memory `currentFile` is only mutated
    // on success so a failed write doesn't leak a phantom entry.
    consecutiveFailures = 0;
    const title = (item.getField("title") ?? "").trim();
    const entry = { title, chunks: accumulated };
    try {
      await deps.storage.writeItem(item.key, entry);
    } catch (err) {
      if (isAbortError(err)) throw err;
      failed += 1;
      deps.onProgress(indexed, failed, total, skippedNoText);
      continue;
    }
    currentFile = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      items: { ...currentFile.items, [item.key]: entry },
      indexedAt: new Date().toISOString()
    };
    didWriteThisRun = true;
    indexed += 1;
    if (attachmentTextContributed) {
      indexedAttachments += 1;
    }
    deps.onProgress(indexed, failed, total, skippedNoText);
  }

  // DIAG: print the final breakdown so users can understand why coverage is
  // lower than expected. Most large libraries have many standalone PDFs
  // / annotations with no populated title/abstract — those are skipped
  // without counting as failures.
  const mainWin = (
    globalThis as unknown as {
      Zotero?: {
        debug(msg: string): void;
        getMainWindow?(): { console?: { error(m: string): void } };
      };
    }
  ).Zotero;
  const summary = `[AI-EXPLAIN crawler] total=${String(total)} previouslyIndexed=${String(previouslyIndexedInitial)} indexed=${String(indexed)} failed=${String(failed)} skippedNoText=${String(skippedNoText)} indexedAttachments=${String(indexedAttachments)} skippedAttachmentText=${String(skippedAttachmentText)}`;
  mainWin?.debug(summary);
  const mw = mainWin?.getMainWindow?.();
  mw?.console?.error(summary);

  // AC-15: guarantee the "completed → file exists" invariant. The per-item
  // write inside the loop only fires when an item indexes successfully.
  // If nothing was written this run — empty library, every item skipped
  // for no-text, every item failed, or a resume where every item was
  // already in initialFile — write `currentFile` once now so the file
  // exists on disk before we return `{completed: true}`. This matches the
  // migration path's existing empty-tmp seed. Conditional, not unconditional:
  // when items DID index, the last per-item write already persisted the
  // same `currentFile`, and a duplicate write would be a wasted 70 MB
  // rewrite on a large library.
  if (!didWriteThisRun) {
    await deps.storage.write(currentFile);
  }

  return { completed: true };
}
