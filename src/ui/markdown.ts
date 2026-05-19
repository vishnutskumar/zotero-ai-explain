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

const ALLOWED_URL_SCHEMES = new Set<string>(["http:", "https:", "mailto:"]);

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

function renderBlock(doc: Document, block: Block): HTMLElement {
  switch (block.kind) {
    case "heading": {
      const element = doc.createElement(`h${String(block.level)}`);
      renderInline(doc, element, block.text);
      return element;
    }
    case "paragraph": {
      const element = doc.createElement("p");
      renderInline(doc, element, block.text);
      return element;
    }
    case "blockquote": {
      const element = doc.createElement("blockquote");
      renderInline(doc, element, block.text);
      return element;
    }
    case "code": {
      // <pre><code>…</code></pre> is the conventional fenced-code shape.
      // The text is set via `textContent` (no HTML interpretation) so any
      // markup inside the code block renders verbatim.
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
        renderInline(doc, li, item);
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
 */
function renderInline(doc: Document, target: HTMLElement, source: string): void {
  const tokens = tokeniseInline(source);
  for (const token of tokens) {
    target.append(renderInlineToken(doc, token));
  }
}

function renderInlineToken(doc: Document, token: InlineToken): Node {
  switch (token.kind) {
    case "text":
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
