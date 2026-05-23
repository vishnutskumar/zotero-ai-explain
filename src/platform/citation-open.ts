/**
 * Library-chat citation → Zotero reader opening (AC-6 / AC-7 / AC-9).
 *
 * Extracted from `src/bootstrap.ts` into a narrow `platform/` module so
 * the bootstrap entrypoint and the e2e driver both depend on this helper
 * instead of the driver importing the bootstrap entrypoint (which created
 * a backwards `platform → bootstrap` module edge). The helper has a
 * single dependency — a narrow slice of the chrome `Zotero` global — so
 * the `pageIndex !== undefined` branch and the `attachmentKey` resolution
 * order are black-box unit-testable with a hand-rolled fake.
 */

/**
 * A resolved library-chat citation click (AC-6/AC-7). `attachmentKey`
 * and `pageIndex` are present only when the click hit a chunk-scoped
 * lookup entry. `attachmentKey` is the source attachment's Zotero key —
 * for a multi-PDF parent item it identifies WHICH attachment the cited
 * chunk came from.
 */
export type ResolvedCitation = {
  readonly itemKey: string;
  readonly attachmentKey?: string;
  readonly pageIndex?: number;
};

/**
 * Narrow slice of an attachment-shaped Zotero item the resolver inspects
 * to decide whether it is an openable PDF.
 */
type CitationAttachmentItem = {
  readonly id: number;
  readonly key?: string;
  readonly isPDFAttachment?: () => boolean;
  readonly attachmentContentType?: string;
};

/**
 * Narrow slice of the chrome `Zotero` global that `openCitationInReader`
 * depends on. Kept local + minimal so the helper is unit-testable with a
 * hand-rolled fake — no full `Zotero` mock required.
 */
export type CitationReaderZotero = {
  getActiveZoteroPane?: () => {
    selectItems?: (ids: readonly number[]) => Promise<void> | void;
  } | null;
  Items?: {
    getByLibraryAndKey?: (
      libraryID: number,
      key: string
    ) =>
      | {
          readonly id: number;
          readonly isRegularItem?: () => boolean;
          readonly getAttachments?: () => readonly number[];
        }
      | false
      | null;
    get?: (id: number) => CitationAttachmentItem | null;
  };
  Libraries?: { userLibraryID: number };
  Reader?: { open?: (id: number, location?: { pageIndex: number }) => Promise<void> | void };
};

/** True when the resolved attachment item is an openable PDF. */
function isPdfAttachment(att: CitationAttachmentItem): boolean {
  return att.isPDFAttachment?.() === true || att.attachmentContentType === "application/pdf";
}

/**
 * Resolve the attachment id to open for a citation.
 *
 * Resolution order:
 *   1. When `citation.attachmentKey` is present, scan the parent's
 *      attachments for the child whose Zotero key matches AND which is an
 *      openable PDF. This routes chunk-scoped citations on a multi-PDF
 *      parent item to the EXACT attachment the cited chunk came from.
 *   2. Legacy fallback (no `attachmentKey`, or the keyed attachment is
 *      missing / not a PDF): the first PDF child of the parent item — the
 *      v0.2.0 behavior, kept for citations from a pre-v0.3.0 index.
 *
 * Returns `null` when the parent item exposes no openable PDF child.
 */
function resolveParentPdfAttachment(
  parent: { readonly getAttachments?: () => readonly number[] },
  zotero: CitationReaderZotero,
  attachmentKey: string | undefined
): number | null {
  if (parent.getAttachments === undefined) {
    return null;
  }
  const childIds = parent.getAttachments();
  // Tier 1: attachmentKey-scoped resolution. Only when a key is present.
  if (attachmentKey !== undefined && attachmentKey.length > 0) {
    for (const childId of childIds) {
      const att = zotero.Items?.get?.(childId);
      if (att === null || att === undefined) continue;
      if (att.key === attachmentKey && isPdfAttachment(att)) {
        return att.id;
      }
    }
    // Fall through to the legacy first-PDF-child scan: the citation's
    // attachmentKey may be stale (attachment deleted) — opening the
    // first PDF child is better than failing the click entirely.
  }
  // Tier 2: legacy first-PDF-child resolution.
  for (const childId of childIds) {
    const att = zotero.Items?.get?.(childId);
    if (att === null || att === undefined) continue;
    if (isPdfAttachment(att)) {
      return att.id;
    }
  }
  return null;
}

/**
 * Open a clicked library-chat citation in the Zotero reader (AC-7).
 *
 * Resolution order:
 *   1. Resolve the cited item by `itemKey` in the user library.
 *   2. Pick the attachment to open — for a regular parent item, the PDF
 *      child identified by `citation.attachmentKey` (multi-PDF parents
 *      route to the exact cited attachment), falling back to the first
 *      PDF child for legacy citations without an `attachmentKey`; for a
 *      cited item that is itself an attachment, the item itself.
 *   3. When an attachment and the `Reader.open` API are both available:
 *        - `pageIndex !== undefined` → `Reader.open(attachmentId, { pageIndex })`
 *          — `pageIndex` rides as the SECOND POSITIONAL argument (NOT
 *          nested under `{ location: ... }`). A reader already open for
 *          that attachment navigates its existing tab.
 *        - `pageIndex === undefined` → `Reader.open(attachmentId)` — the
 *          v0.2.0 no-location behavior.
 *      The check is `pageIndex !== undefined`, never a truthiness test:
 *      `pageIndex: 0` is a real first page and must open at page 0.
 *   4. Fallback when there is no openable attachment / no Reader API:
 *      select the item row so the user at least sees what was cited.
 *
 * Returns a structured outcome so callers (and the e2e driver) can
 * observe which path ran without scraping logs for side effects.
 */
export function openCitationInReader(
  citation: ResolvedCitation,
  zotero: CitationReaderZotero
): {
  readonly outcome:
    | "opened-with-page"
    | "opened-no-page"
    | "selected-row"
    | "not-found"
    | "no-target";
  readonly attachmentId?: number;
} {
  const userLibraryID = zotero.Libraries?.userLibraryID ?? 1;
  const item = zotero.Items?.getByLibraryAndKey?.(userLibraryID, citation.itemKey);
  if (item === false || item === null || item === undefined) {
    return { outcome: "not-found" };
  }
  // Resolve the best attachment to open: prefer the PDF child identified
  // by `citation.attachmentKey` (multi-PDF parents); if `item` is already
  // an attachment, use it; else there is nothing to open and we fall back
  // to selecting the row.
  let attachmentId: number | null = null;
  const isRegular = item.isRegularItem?.() === true;
  if (isRegular) {
    attachmentId = resolveParentPdfAttachment(item, zotero, citation.attachmentKey);
  } else {
    // The cited item is itself an attachment (rarer but possible).
    attachmentId = item.id;
  }
  if (attachmentId !== null && zotero.Reader?.open !== undefined) {
    if (citation.pageIndex !== undefined) {
      // pageIndex as the SECOND positional arg — `open(id, { pageIndex })`.
      void zotero.Reader.open(attachmentId, { pageIndex: citation.pageIndex });
      return { outcome: "opened-with-page", attachmentId };
    }
    void zotero.Reader.open(attachmentId);
    return { outcome: "opened-no-page", attachmentId };
  }
  // Fallback: no PDF child or no Reader API — at least select the row so
  // the user sees what was cited.
  const pane = zotero.getActiveZoteroPane?.();
  if (pane?.selectItems !== undefined) {
    void pane.selectItems([item.id]);
    return { outcome: "selected-row" };
  }
  return { outcome: "no-target" };
}
