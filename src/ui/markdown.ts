/**
 * Lightweight, XSS-safe markdown renderer for streamed model output.
 *
 * Scope: headings (#–####), bold (`**text**`), italic (`*text*`), inline
 * code (`` `code` ``), fenced code blocks (```), unordered and ordered
 * lists, links `[text](url)` (always `rel="noopener noreferrer"` and
 * `target="_blank"`), blockquotes (`>`), and paragraphs (blank-line
 * separated). Out of scope: tables, raw HTML embedding, footnotes,
 * definition lists, and LaTeX math (left as literal text so the bundle
 * stays small).
 *
 * The renderer is **streaming-friendly**: callers invoke
 * `renderMarkdown(target, source)` on every delta. The target is cleared
 * and reparsed end-to-end each time. Re-parsing is cheap because the
 * popup body is small and we never recurse into untrusted libraries.
 *
 * Security: every text fragment lands in the DOM through
 * `document.createTextNode` or `element.textContent`. We never use
 * `innerHTML` and never interpolate source strings into HTML strings, so
 * `<script>` and `<img onerror>` in model output render as literal text.
 */

import { parseCitationToken, resolveCitation, type CitationLookup } from "./citation-lookup.js";
import type { CitationClick } from "./library-chat-view.js";

const ALLOWED_URL_SCHEMES = new Set<string>(["http:", "https:", "mailto:"]);

/**
 * Citation token shape: `[ABCD1234]` (legacy) or `[ABCD1234#3]`
 * (chunk-scoped). The item key is exactly 8 uppercase-alphanumeric
 * chars — the shape Zotero assigns. Stays in sync with the regex used
 * by `appendWithCitations` in `library-chat-view.ts`.
 */
const CITATION_PATTERN = /\[([A-Z0-9]{8})(?:#(\d+))?\]/gu;

type Block =
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3 | 4; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "blockquote"; readonly text: string }
  | { readonly kind: "code"; readonly text: string; readonly language: string | null }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      readonly items: readonly string[];
    };

/**
 * Render `source` as markdown into `target`, replacing all existing
 * children. Safe to call repeatedly with growing `source` (streaming
 * deltas).
 */
export function renderMarkdown(target: HTMLElement, source: string): void {
  // Clear once per render. We never reuse existing nodes — re-parsing is
  // simpler than diffing and the popup body is small enough that the
  // overhead is invisible.
  target.replaceChildren();
  const doc = target.ownerDocument;
  const blocks = parseBlocks(source);
  for (const block of blocks) {
    target.append(renderBlock(doc, block));
  }
}

function parseBlocks(source: string): readonly Block[] {
  // Normalise newlines so CRLF input from copy-paste behaves the same as
  // LF input from the model stream.
  const normalised = source.replace(/\r\n?/gu, "\n");
  const lines = normalised.split("\n");
  const blocks: Block[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Skip blank lines between blocks; the block-emitters below decide
    // where blanks split groups (e.g., consecutive list items don't need
    // blanks).
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Fenced code block: ```optional-language ... ```
    const fenceMatch = /^```(.*)$/u.exec(line);
    if (fenceMatch !== null) {
      const language = fenceMatch[1]?.trim() ?? "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (/^```\s*$/u.test(next)) {
          i += 1;
          break;
        }
        codeLines.push(next);
        i += 1;
      }
      blocks.push({
        kind: "code",
        text: codeLines.join("\n"),
        language: language === "" ? null : language
      });
      continue;
    }

    // Headings: 1–4 `#` followed by a space. Headings beyond level 4 are
    // rare in explain output; we treat them as paragraphs.
    const headingMatch = /^(#{1,4})\s+(.*)$/u.exec(line);
    if (headingMatch !== null) {
      const level = headingMatch[1]?.length as 1 | 2 | 3 | 4;
      const text = (headingMatch[2] ?? "").trim();
      blocks.push({ kind: "heading", level, text });
      i += 1;
      continue;
    }

    // Blockquote: one or more consecutive `>` lines. We strip the leader
    // and join with spaces so wrapped quotes read as one paragraph.
    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith(">")) {
        const stripped = (lines[i] ?? "").replace(/^>\s?/u, "");
        quoteLines.push(stripped);
        i += 1;
      }
      blocks.push({ kind: "blockquote", text: quoteLines.join("\n") });
      continue;
    }

    // Unordered list: lines starting with `-`, `*`, or `+` then a space.
    // We deliberately do NOT support nested lists — the renderer flattens
    // to a single level. Nested lists are uncommon in explain output and
    // supporting them would require tracking indentation depth.
    if (/^[-*+]\s+/u.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s+/u.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^[-*+]\s+/u, ""));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: false, items });
      continue;
    }

    // Ordered list: lines starting with `<digits>.` then a space.
    if (/^\d+\.\s+/u.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/u.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\d+\.\s+/u, ""));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: true, items });
      continue;
    }

    // Paragraph: collect contiguous non-blank, non-special lines.
    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (next.trim() === "") {
        break;
      }
      // Stop at any line that starts a new block kind so paragraphs don't
      // swallow following headings/lists/blockquotes/fences.
      if (
        next.startsWith("```") ||
        /^(#{1,4})\s+/u.test(next) ||
        next.startsWith(">") ||
        /^[-*+]\s+/u.test(next) ||
        /^\d+\.\s+/u.test(next)
      ) {
        break;
      }
      paragraphLines.push(next);
      i += 1;
    }
    if (paragraphLines.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraphLines.join("\n") });
    }
  }

  return blocks;
}

function renderBlock(
  doc: Document,
  block: Block,
  emitText: (target: HTMLElement, text: string) => void = appendPlainText
): HTMLElement {
  switch (block.kind) {
    case "heading": {
      const element = doc.createElement(`h${String(block.level)}`);
      renderInline(doc, element, block.text, emitText);
      return element;
    }
    case "paragraph": {
      const element = doc.createElement("p");
      renderInline(doc, element, block.text, emitText);
      return element;
    }
    case "blockquote": {
      const element = doc.createElement("blockquote");
      renderInline(doc, element, block.text, emitText);
      return element;
    }
    case "code": {
      // <pre><code>…</code></pre> is the conventional fenced-code shape.
      // The text is set via `textContent` (no HTML interpretation) so any
      // markup inside the code block renders verbatim. Citation tokens
      // inside a code block stay literal — they are quoted source code,
      // not links.
      const pre = doc.createElement("pre");
      const code = doc.createElement("code");
      if (block.language !== null) {
        code.className = `language-${block.language}`;
      }
      code.textContent = block.text;
      pre.append(code);
      return pre;
    }
    case "list": {
      const list = doc.createElement(block.ordered ? "ol" : "ul");
      for (const item of block.items) {
        const li = doc.createElement("li");
        renderInline(doc, li, item, emitText);
        list.append(li);
      }
      return list;
    }
  }
}

type InlineToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "bold"; readonly text: string }
  | { readonly kind: "italic"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

/**
 * Render inline markdown into `target`. Supports `**bold**`, `*italic*`,
 * `` `code` ``, and `[text](url)`. Tokens are matched greedily left-to-right
 * using a single scanner so we never recurse and never construct an
 * intermediate HTML string.
 *
 * `emitText` is the leaf text-emitter. By default it appends a single
 * text node; `renderMarkdownWithCitations` swaps in a citation-aware
 * variant that splits each text token on `CITATION_PATTERN` and emits
 * `<a data-item-key>` anchors for matched tokens.
 */
function renderInline(
  doc: Document,
  target: HTMLElement,
  source: string,
  emitText: (target: HTMLElement, text: string) => void = appendPlainText
): void {
  const tokens = tokeniseInline(source);
  for (const token of tokens) {
    if (token.kind === "text") {
      emitText(target, token.text);
      continue;
    }
    target.append(renderInlineToken(doc, token));
  }
}

function appendPlainText(target: HTMLElement, text: string): void {
  target.append(target.ownerDocument.createTextNode(text));
}

function renderInlineToken(doc: Document, token: InlineToken): Node {
  switch (token.kind) {
    case "text":
      // Unreached: `renderInline` now routes text tokens through
      // `emitText` directly. Kept for switch-exhaustiveness so a future
      // refactor cannot accidentally drop the text branch.
      return doc.createTextNode(token.text);
    case "code": {
      const element = doc.createElement("code");
      element.textContent = token.text;
      return element;
    }
    case "bold": {
      const element = doc.createElement("strong");
      // Bold and italic do NOT recurse into more inline markup. Supporting
      // nested emphasis (e.g., `**bold _and italic_**`) would require a
      // parser; we keep the renderer linear and accept the limitation.
      element.textContent = token.text;
      return element;
    }
    case "italic": {
      const element = doc.createElement("em");
      element.textContent = token.text;
      return element;
    }
    case "link": {
      const element = doc.createElement("a");
      // textContent prevents any model-supplied markup in the link label
      // from being interpreted as HTML.
      element.textContent = token.text;
      // External-link safety: noopener+noreferrer drops window.opener and
      // suppresses the Referer header, mitigating reverse-tabnabbing. We
      // also gate the URL through `safeHref` so `javascript:` and other
      // unsafe schemes never reach the DOM.
      const safe = safeHref(token.href);
      if (safe !== null) {
        element.setAttribute("href", safe);
        element.setAttribute("rel", "noopener noreferrer");
        element.setAttribute("target", "_blank");
      }
      return element;
    }
  }
}

function tokeniseInline(source: string): readonly InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;
  let textStart = 0;

  const flushText = (end: number): void => {
    if (end > textStart) {
      tokens.push({ kind: "text", text: source.slice(textStart, end) });
    }
  };

  while (i < source.length) {
    const ch = source[i];

    // Inline code: `…`. Matches the shortest closing backtick to handle
    // multiple inline-code spans in one line.
    if (ch === "`") {
      const close = source.indexOf("`", i + 1);
      if (close > i) {
        flushText(i);
        tokens.push({ kind: "code", text: source.slice(i + 1, close) });
        i = close + 1;
        textStart = i;
        continue;
      }
    }

    // Bold: **…**. Checked before italic so `**word**` does not split
    // into two `*word*` italics.
    if (ch === "*" && source[i + 1] === "*") {
      const close = source.indexOf("**", i + 2);
      if (close > i + 1) {
        flushText(i);
        tokens.push({ kind: "bold", text: source.slice(i + 2, close) });
        i = close + 2;
        textStart = i;
        continue;
      }
    }

    // Italic: *…*. We require the opening `*` to be followed by a
    // non-space and the closing `*` to be preceded by a non-space so we
    // don't accidentally match arithmetic like `a * b * c`.
    if (ch === "*") {
      const next = source[i + 1];
      if (next !== undefined && next !== " " && next !== "*") {
        const close = findMatchingItalicClose(source, i + 1);
        if (close > i + 1) {
          flushText(i);
          tokens.push({ kind: "italic", text: source.slice(i + 1, close) });
          i = close + 1;
          textStart = i;
          continue;
        }
      }
    }

    // Link: [text](href). We do not support reference-style links; they
    // are rare in explain output and would require a two-pass scan.
    if (ch === "[") {
      const closeBracket = source.indexOf("]", i + 1);
      if (closeBracket > i && source[closeBracket + 1] === "(") {
        const closeParen = source.indexOf(")", closeBracket + 2);
        if (closeParen > closeBracket + 1) {
          flushText(i);
          tokens.push({
            kind: "link",
            text: source.slice(i + 1, closeBracket),
            href: source.slice(closeBracket + 2, closeParen)
          });
          i = closeParen + 1;
          textStart = i;
          continue;
        }
      }
    }

    i += 1;
  }

  flushText(source.length);
  return tokens;
}

function findMatchingItalicClose(source: string, from: number): number {
  // Walk forward looking for a `*` that is preceded by a non-space and
  // not part of a `**` bold marker. Returns -1 if no match.
  let i = from;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "*" && source[i + 1] !== "*" && source[i - 1] !== " ") {
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Citation-aware variant of `renderMarkdown`. Identical block/inline
 * markdown handling, plus: every plain-text fragment is scanned for
 * `[itemKey]` / `[itemKey#chunkIndex]` tokens and matching tokens become
 * `<a data-item-key=... data-chunk-index=...>` anchors.
 *
 * Anchor emission rules:
 *
 *   - `opts.lookup === undefined` (the caller has no retrieval lookup
 *     yet) → no tokenization; every text fragment renders as a literal
 *     text node, matching the legacy `renderMarkdown` behaviour. This is
 *     the popup/sidebar's pre-retrieval state.
 *   - `opts.lookup` defined AND `resolveCitation(parsed, lookup)` returns
 *     an entry → emit an `<a>` carrying `data-item-key`, optional
 *     `data-chunk-index`, `data-attachment-key`, and `data-page-index`.
 *     The caller is responsible for wiring a delegated click handler
 *     that reads those attributes and invokes `opts.onCitationClick`.
 *   - `opts.lookup` defined but `resolveCitation` returns undefined
 *     (hallucinated itemKey, out-of-range chunk index) → emit the literal
 *     `[itemKey#…]` token as text. The README contract is "inert text on
 *     a hallucination" so a clickable-but-misdirected link is never
 *     produced.
 *
 * Click handling is intentionally NOT attached inside this function —
 * the caller mounts a delegated `click` listener on the popup/sidebar
 * root (mirroring `wireLibraryChatView`) so re-renders that `replaceChildren`
 * the message body don't have to re-bind per-anchor listeners.
 *
 * `opts.onCitationClick` is currently unused inside the renderer; it is
 * accepted on the type so future migrations (and the type-tested wiring
 * site in zotero-runtime) can carry the same options bag through.
 */
export type CitationRenderOptions = {
  readonly lookup?: CitationLookup;
  readonly onCitationClick?: (citation: CitationClick) => void;
};

export function renderMarkdownWithCitations(
  target: HTMLElement,
  source: string,
  opts?: CitationRenderOptions
): void {
  target.replaceChildren();
  const doc = target.ownerDocument;
  const blocks = parseBlocks(source);
  const lookup = opts?.lookup;
  // The text emitter is the only behaviour difference between
  // renderMarkdown and renderMarkdownWithCitations. When no lookup is
  // available we fall back to plain text so the popup/sidebar's
  // pre-retrieval render path stays byte-identical to the existing
  // renderMarkdown output.
  const emitText: (target: HTMLElement, text: string) => void =
    lookup === undefined
      ? appendPlainText
      : (host, text): void => {
          emitTextWithCitations(host, text, lookup);
        };
  for (const block of blocks) {
    target.append(renderBlock(doc, block, emitText));
  }
}

/**
 * Walk `text`, split on `CITATION_PATTERN`, and emit either a text node
 * or a citation anchor for each piece. Exported only via
 * `renderMarkdownWithCitations`; not a public helper.
 */
function emitTextWithCitations(host: HTMLElement, text: string, lookup: CitationLookup): void {
  const doc = host.ownerDocument;
  CITATION_PATTERN.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_PATTERN.exec(text)) !== null) {
    if (match.index > cursor) {
      host.append(doc.createTextNode(text.slice(cursor, match.index)));
    }
    // Round-trip through the canonical parser so the alphabet /
    // chunk-index handling stays single-sourced in citation-lookup.ts.
    const parsed = parseCitationToken(match[0]);
    const entry = parsed !== null ? resolveCitation(parsed, lookup) : undefined;
    if (entry === undefined || parsed === null) {
      // Hallucinated key (or malformed token, which CITATION_PATTERN
      // never matches but defended against here) — render the original
      // token verbatim so the user sees what the model emitted.
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

function renderCitationAnchor(
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
  // matching `library-chat-view.ts`'s fallback shape.
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

function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  // Relative URLs (no scheme) are allowed — Zotero plugin output rarely
  // emits them but they're harmless.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(trimmed)) {
    return trimmed;
  }
  // Absolute URL: parse and check the scheme against the allow-list.
  // URL parsing also rejects malformed inputs like `javascript: alert(1)`
  // because `javascript:` is not in `ALLOWED_URL_SCHEMES`.
  try {
    const url = new URL(trimmed);
    if (ALLOWED_URL_SCHEMES.has(url.protocol)) {
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}
