/**
 * Delegated citation-click handler.
 *
 * The popup, sidebar, and library-chat views all stamp citation anchors
 * of the shape `<a data-item-key="..." data-chunk-index="..."
 * data-attachment-key="..." data-page-index="...">` and want the same
 * click semantics: walk the click target's ancestors to the nearest
 * citation anchor, parse the dataset into a `CitationClick`, prevent
 * default navigation, and dispatch the citation through a host-supplied
 * callback. Before this helper landed the same delegation block was
 * copy-pasted in three places (`library-chat-view.ts`,
 * `zotero-runtime.ts` popup wiring, `zotero-runtime.ts` sidebar wiring)
 * with trivial drift in payload construction — `attachCitationClickHandler`
 * is the single source of truth.
 *
 * The helper returns a teardown function that detaches the listener so
 * callers can clean up symmetrically on view unmount (matches the
 * pattern used by `wireLibraryChatView`).
 */

import type { CitationClick } from "./library-chat-view.js";

/**
 * Attach a delegated click handler at `root` that fires `onCitationClick`
 * when the click hits (or bubbles up through) an `a[data-item-key]`
 * citation anchor. Returns a teardown function that removes the listener
 * — call it when the host view is unmounted.
 *
 * Payload shape:
 *
 *   - `itemKey` is always present (the delegated lookup ignores anchors
 *     with an empty `data-item-key`, so the dispatch never fires with
 *     `itemKey === ""`).
 *   - `attachmentKey` rides through when the anchor's dataset has it.
 *   - `pageIndex` is parsed from `data-page-index` via a strict
 *     `/^\d+$/u` guard so a malformed value (e.g. "abc") never reaches
 *     the host as `NaN`.
 *
 * Note on `data-chunk-index`: the renderers stamp it for symmetry, but
 * the `CitationClick` shape does not carry it — the chunk-index only
 * affected lookup resolution at render time, and the click handler has
 * no further use for it. Intentionally omitted from the payload (matches
 * the prior inline shape across all three call sites).
 */
export function attachCitationClickHandler(
  root: HTMLElement,
  onCitationClick: (citation: CitationClick) => void
): () => void {
  const handler = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target === null) return;
    const link = target.closest<HTMLAnchorElement>("a[data-item-key]");
    if (link === null) return;
    event.preventDefault();
    const key = link.dataset.itemKey ?? "";
    if (key.length === 0) return;
    const attachmentKey = link.dataset.attachmentKey;
    const rawPageIndex = link.dataset.pageIndex;
    const pageIndex =
      rawPageIndex !== undefined && /^\d+$/u.test(rawPageIndex) ? Number(rawPageIndex) : undefined;
    onCitationClick({
      itemKey: key,
      ...(attachmentKey !== undefined ? { attachmentKey } : {}),
      ...(pageIndex !== undefined ? { pageIndex } : {})
    });
  };
  root.addEventListener("click", handler);
  return () => {
    root.removeEventListener("click", handler);
  };
}
