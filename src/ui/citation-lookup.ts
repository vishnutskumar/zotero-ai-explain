/**
 * Chunk-scoped citation tokens for the library chat (AC-6).
 *
 * The library-chat LLM is instructed to cite retrieved excerpts as
 * `[itemKey#chunkIndex]` (e.g. `[ABCD1234#3]`). This module owns the two
 * pure helpers that bracket that token:
 *
 *   - `parseCitationToken` — parse a single `[ITEMKEY]` / `[ITEMKEY#3]`
 *     token into its halves, or `null` when the token is malformed.
 *   - `buildCitationLookup` — turn the retrieved chunks into a lookup
 *     table keyed by the FULL `${itemKey}#${chunkIndex}` token.
 *
 * Keying by the full token (not the bare itemKey) is the hallucination
 * guard: an LLM that emits `[ABCD1234#99]` when only chunks 0-7 were
 * retrieved produces a key that simply is not in the table — the
 * renderer then falls back to legacy `[itemKey]` behavior rather than
 * silently routing the click to some unrelated chunk.
 *
 * Both helpers are deliberately free of any DOM dependency so they are
 * unit-testable without jsdom.
 */

import type { RetrievedChunk } from "../indexing/index-search.js";

/**
 * A resolved citation target. Derived from a single `RetrievedChunk`;
 * `pageIndex`/`attachmentKey` are `undefined`-absent for metadata / note
 * chunks that have no in-PDF location.
 */
export type CitationLookupEntry = {
  readonly itemKey: string;
  readonly attachmentKey?: string;
  readonly pageIndex?: number;
  readonly text: string;
};

/**
 * Per-turn citation lookup. Keyed by the FULL `${itemKey}#${chunkIndex}`
 * token so a hallucinated itemKey OR a hallucinated chunk-index both miss.
 */
export type CitationLookup = ReadonlyMap<string, CitationLookupEntry>;

/**
 * Item-key alphabet for a citation token: exactly 8 uppercase-alphanumeric
 * characters — the shape Zotero assigns to item keys. The optional
 * `#<digits>` half carries the chunk index. Anchored at both ends so a
 * token with trailing junk (e.g. `[ABCD1234#x]`) does not match.
 */
const SINGLE_TOKEN_PATTERN = /^\[([A-Z0-9]{8})(?:#(\d+))?\]$/u;

/**
 * Parse a single bracketed citation token.
 *
 *   `[ABCD1234]`    ⇒ `{ itemKey: "ABCD1234", chunkIndex: undefined }`
 *   `[ABCD1234#3]`  ⇒ `{ itemKey: "ABCD1234", chunkIndex: 3 }`
 *   `[ABCD1234#0]`  ⇒ `{ itemKey: "ABCD1234", chunkIndex: 0 }`
 *
 * Returns `null` for any malformed token — a key that is not exactly 8
 * uppercase-alphanumeric chars, a dangling `#`, a non-numeric chunk
 * index, an empty bracket, or a string with no brackets at all.
 */
export function parseCitationToken(token: string): {
  readonly itemKey: string;
  readonly chunkIndex?: number;
} | null {
  const match = SINGLE_TOKEN_PATTERN.exec(token);
  if (match === null) {
    return null;
  }
  const itemKey = match[1] ?? "";
  const rawChunkIndex = match[2];
  // `rawChunkIndex === undefined` is the legacy `[ITEMKEY]` shape — leave
  // `chunkIndex` off the result. When present it is a `\d+` capture, so
  // `Number()` cannot yield NaN; `chunkIndex: 0` is preserved verbatim.
  if (rawChunkIndex === undefined) {
    return { itemKey };
  }
  return { itemKey, chunkIndex: Number(rawChunkIndex) };
}

/**
 * Build the per-turn citation lookup table from the retrieved chunks.
 *
 * Each entry is keyed by `${chunk.itemKey}#${chunk.chunkIndex}`.
 * `topKChunks` stamps `chunkIndex` as the post-sort position in the
 * retrieval result, so it is always a number here; a chunk that somehow
 * arrives without a `chunkIndex` is skipped rather than keyed under
 * `${itemKey}#undefined`.
 */
/**
 * Resolve a parsed `[itemKey]` / `[itemKey#chunkIndex]` token against the
 * per-turn citation lookup, applying the README contract:
 *
 *   - **Full-key hit.** `parsed.chunkIndex !== undefined` AND
 *     `${itemKey}#${chunkIndex}` is in `lookup` → return the matched
 *     entry verbatim (carries `attachmentKey`/`pageIndex` so the caller
 *     can jump to the cited page).
 *   - **Legacy / bare-key fallback.** `parsed.chunkIndex === undefined`
 *     (the LLM emitted `[itemKey]` without a chunk index) → return a
 *     minimal entry `{ itemKey, text }` whenever ANY chunk in the lookup
 *     shares this `itemKey`. No `pageIndex` / `attachmentKey` on the
 *     fallback entry — downstream `citation-open.ts` opens the
 *     attachment at page 1 when `pageIndex` is undefined, matching the
 *     v0.2.0 "open the document, don't pick a specific page" behavior.
 *     The `text` field is borrowed from the first matching chunk so the
 *     popup/sidebar tooltip can still show a snippet.
 *   - **Hallucinated key.** Either `parsed.chunkIndex` is set and the
 *     full-key composition misses, OR `parsed.chunkIndex` is unset and
 *     no chunk shares this `itemKey` → return `undefined`. The caller
 *     renders the original `[itemKey#…]` token as inert text (no anchor)
 *     so a model hallucination does not become a clickable but
 *     misdirected link.
 *
 * Pure / DOM-free so it can be exercised without jsdom.
 */
export function resolveCitation(
  parsed: { readonly itemKey: string; readonly chunkIndex?: number },
  lookup: CitationLookup
): CitationLookupEntry | undefined {
  if (parsed.chunkIndex !== undefined) {
    // Full-key path — straight lookup. Misses (out-of-range chunk index,
    // hallucinated itemKey) drop through to `undefined` per contract.
    return lookup.get(`${parsed.itemKey}#${String(parsed.chunkIndex)}`);
  }
  // Legacy `[itemKey]` shape: scan for ANY chunk sharing this itemKey.
  // We synthesize a fallback entry rather than returning the first
  // matching chunk verbatim because a single itemKey can have many
  // chunks at different pages — silently picking one would route the
  // click to an arbitrary chunk. The empty-page-index fallback opens
  // the attachment at page 1, which is the README-documented intent.
  for (const entry of lookup.values()) {
    if (entry.itemKey === parsed.itemKey) {
      return { itemKey: parsed.itemKey, text: entry.text };
    }
  }
  return undefined;
}

export function buildCitationLookup(chunks: readonly RetrievedChunk[]): CitationLookup {
  const lookup = new Map<string, CitationLookupEntry>();
  for (const chunk of chunks) {
    if (typeof chunk.chunkIndex !== "number") {
      continue;
    }
    const key = `${chunk.itemKey}#${String(chunk.chunkIndex)}`;
    // `pageIndex: 0` and `attachmentKey` are copied only when present so
    // a metadata/note chunk leaves both undefined on the entry. The
    // `exactOptionalPropertyTypes` compiler rule rejects assigning an
    // explicit `undefined` to an optional field, hence the conditional
    // spreads rather than always-assign.
    lookup.set(key, {
      itemKey: chunk.itemKey,
      text: chunk.text,
      ...(typeof chunk.pageIndex === "number" ? { pageIndex: chunk.pageIndex } : {}),
      ...(chunk.attachmentKey !== undefined ? { attachmentKey: chunk.attachmentKey } : {})
    });
  }
  return lookup;
}

// The module-level `export const CITATION_PATTERN = /.../gu;` was removed:
// a global `/g`-flag RegExp carries a mutable `lastIndex` that any
// concurrent caller (re-entrant render, two assistant turns rendered in
// the same tick) could leak across. `emitTextWithCitations` now builds
// a fresh regex per call below. No external module imported the symbol
// (audited via grep on src/ + tests/ at the time of the LOW-9 fix).

/**
 * Render a resolved citation as an `<a>` element. Public so every
 * citation renderer (popup, sidebar, library-chat) stamps the same
 * data-attribute shape — `data-item-key` always; `data-chunk-index`,
 * `data-attachment-key`, `data-page-index` only when present on the
 * resolved entry.
 *
 * The anchor's textContent is the bracketed token (e.g. `[ABCD1234#3]`,
 * or `[ABCD1234]` for the legacy / fallback shape) so the user sees the
 * exact string the model emitted, not just the bare item key.
 */
export function renderCitationAnchor(
  doc: Document,
  itemKey: string,
  rawChunkIndex: string | undefined,
  entry: { readonly attachmentKey?: string; readonly pageIndex?: number }
): HTMLAnchorElement {
  const link = doc.createElement("a");
  link.dataset.itemKey = itemKey;
  // Stamp the chunk-scoped data attributes only when the renderer
  // actually had them. A legacy / fallback citation (no chunkIndex in
  // the token, no per-page entry data) emits just `data-item-key`,
  // matching the README contract that bare keys open the attachment at
  // page 1.
  if (rawChunkIndex !== undefined) {
    link.dataset.chunkIndex = rawChunkIndex;
  }
  if (entry.attachmentKey !== undefined) {
    link.dataset.attachmentKey = entry.attachmentKey;
  }
  if (typeof entry.pageIndex === "number") {
    link.dataset.pageIndex = String(entry.pageIndex);
  }
  // `#` keeps the anchor from navigating; the wiring layer's click
  // handler calls preventDefault and dispatches to `onCitationClick`.
  link.setAttribute("href", "#");
  link.textContent = `[${itemKey}${rawChunkIndex !== undefined ? `#${rawChunkIndex}` : ""}]`;
  return link;
}

/**
 * Walk `text`, split on the citation token pattern, and emit either a
 * text node or a citation anchor for each piece. Resolved citations
 * become anchors (`renderCitationAnchor`); hallucinated keys and
 * malformed tokens land as INERT TEXT — the README-documented contract.
 *
 * Shared by the popup/sidebar markdown renderer and the library-chat
 * plain-text renderer so a hallucinated `[ABCD1234#99]` always renders
 * the same way no matter which surface the assistant turn lands on.
 *
 * The regex is constructed per call (not a module-level constant) so a
 * stateful `/g` `lastIndex` cannot leak across concurrent iterations.
 */
export function emitTextWithCitations(
  host: HTMLElement,
  text: string,
  lookup: CitationLookup
): void {
  const doc = host.ownerDocument;
  // Per-call regex avoids the re-entrancy footgun of a module-level
  // `/g` RegExp's shared `lastIndex`. Two simultaneous render passes
  // (e.g. a follow-up turn rendering while the prior turn is still in
  // a microtask queue) cannot now interfere with each other's iteration.
  const pattern = /\[([A-Z0-9]{8})(?:#(\d+))?\]/gu;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      host.append(doc.createTextNode(text.slice(cursor, match.index)));
    }
    // Round-trip through the canonical parser so the alphabet /
    // chunk-index handling stays single-sourced in this module.
    const parsed = parseCitationToken(match[0]);
    const entry = parsed !== null ? resolveCitation(parsed, lookup) : undefined;
    if (entry === undefined || parsed === null) {
      // Hallucinated key (or malformed token, which the per-call
      // `pattern` regex never matches but defended against here) —
      // render the original token verbatim so the user sees what the
      // model emitted.
      host.append(doc.createTextNode(match[0]));
    } else {
      host.append(renderCitationAnchor(doc, parsed.itemKey, match[2], entry));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    host.append(doc.createTextNode(text.slice(cursor)));
  }
}
