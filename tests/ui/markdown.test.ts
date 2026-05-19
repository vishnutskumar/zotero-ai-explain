/* @vitest-environment jsdom */

/*
 * Black-box tests for `renderMarkdown`. The contract:
 *
 *   1. `target` is cleared before each render (streaming-friendly).
 *   2. Headings (#-####), paragraphs, blockquotes, fenced code blocks,
 *      unordered + ordered lists are rendered as real DOM elements.
 *   3. Inline syntax: `**bold**`, `*italic*`, `` `code` ``, `[text](url)`.
 *   4. Links get `rel="noopener noreferrer"` and `target="_blank"`. Unsafe
 *      URL schemes (e.g., `javascript:`) yield an anchor with NO `href`.
 *   5. XSS-safe: raw `<script>`, `<img onerror>`, etc. in source MUST be
 *      rendered as literal text (not executed and not creating real
 *      `<script>`/`<img>` elements).
 *   6. LaTeX math (`$x^2$`) is left as literal text — no crash, no special
 *      rendering.
 */

import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../../src/ui/markdown.js";

function fresh(): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  return target;
}

describe("renderMarkdown — block elements", () => {
  it("renders ATX headings 1 through 4 as h1..h4", () => {
    const target = fresh();
    renderMarkdown(target, "# H1\n\n## H2\n\n### H3\n\n#### H4");
    expect(target.querySelector("h1")?.textContent).toBe("H1");
    expect(target.querySelector("h2")?.textContent).toBe("H2");
    expect(target.querySelector("h3")?.textContent).toBe("H3");
    expect(target.querySelector("h4")?.textContent).toBe("H4");
  });

  it("renders blank-line-separated text as paragraphs", () => {
    const target = fresh();
    renderMarkdown(target, "First paragraph.\n\nSecond paragraph.");
    const paragraphs = target.querySelectorAll("p");
    expect(paragraphs.length).toBe(2);
    expect(paragraphs[0]?.textContent).toBe("First paragraph.");
    expect(paragraphs[1]?.textContent).toBe("Second paragraph.");
  });

  it("renders unordered lists with each item as <li>", () => {
    const target = fresh();
    renderMarkdown(target, "- one\n- two\n- three");
    const list = target.querySelector("ul");
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll("li").length).toBe(3);
    expect(list?.querySelectorAll("li")[1]?.textContent).toBe("two");
  });

  it("renders ordered lists with each item as <li> in an <ol>", () => {
    const target = fresh();
    renderMarkdown(target, "1. first\n2. second\n3. third");
    const list = target.querySelector("ol");
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll("li").length).toBe(3);
    expect(list?.querySelectorAll("li")[0]?.textContent).toBe("first");
  });

  it("renders fenced code blocks as <pre><code> with language class", () => {
    const target = fresh();
    renderMarkdown(target, "```python\nprint('hi')\n```");
    const pre = target.querySelector("pre");
    const code = pre?.querySelector("code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe("print('hi')");
    expect(code?.className).toBe("language-python");
  });

  it("renders fenced code blocks without language as <pre><code> sans class", () => {
    const target = fresh();
    renderMarkdown(target, "```\nplain\n```");
    const code = target.querySelector("pre code");
    expect(code?.textContent).toBe("plain");
    expect(code?.className).toBe("");
  });

  it("preserves markdown-looking characters INSIDE fenced code blocks as literal text", () => {
    const target = fresh();
    renderMarkdown(target, "```\n# not a heading\n**not bold**\n```");
    const code = target.querySelector("pre code");
    expect(code?.textContent).toBe("# not a heading\n**not bold**");
    // No actual heading/strong elements should have been created.
    expect(target.querySelector("h1")).toBeNull();
    expect(target.querySelector("strong")).toBeNull();
  });

  it("renders consecutive `>` lines as a single <blockquote>", () => {
    const target = fresh();
    renderMarkdown(target, "> first quoted\n> second quoted");
    const quotes = target.querySelectorAll("blockquote");
    expect(quotes.length).toBe(1);
    expect(quotes[0]?.textContent).toContain("first quoted");
    expect(quotes[0]?.textContent).toContain("second quoted");
  });
});

describe("renderMarkdown — inline elements", () => {
  it("renders **bold** as <strong>", () => {
    const target = fresh();
    renderMarkdown(target, "Important: **read carefully**.");
    const strong = target.querySelector("strong");
    expect(strong?.textContent).toBe("read carefully");
  });

  it("renders *italic* as <em>", () => {
    const target = fresh();
    renderMarkdown(target, "Be *very* careful.");
    const em = target.querySelector("em");
    expect(em?.textContent).toBe("very");
  });

  it("does NOT misinterpret `**double**` as two italics", () => {
    const target = fresh();
    renderMarkdown(target, "**emphatic**");
    expect(target.querySelector("strong")?.textContent).toBe("emphatic");
    expect(target.querySelector("em")).toBeNull();
  });

  it("renders inline `code` as <code> within a paragraph", () => {
    const target = fresh();
    renderMarkdown(target, "Call `foo()` to start.");
    const code = target.querySelector("p code");
    expect(code?.textContent).toBe("foo()");
  });

  it("renders [text](https://example.com) with noopener/noreferrer/_blank", () => {
    const target = fresh();
    renderMarkdown(target, "See [docs](https://example.com/path).");
    const link = target.querySelector("a");
    expect(link?.textContent).toBe("docs");
    expect(link?.getAttribute("href")).toBe("https://example.com/path");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("strips javascript: URLs from links (renders text without href)", () => {
    const target = fresh();
    renderMarkdown(target, "Bad [click](javascript:alert(1)) here.");
    const link = target.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("click");
    // The href MUST NOT be set when the scheme is unsafe.
    expect(link?.hasAttribute("href")).toBe(false);
  });
});

describe("renderMarkdown — streaming behavior", () => {
  it("clears the target before each render so partial deltas don't accumulate stale DOM", () => {
    const target = fresh();
    renderMarkdown(target, "# Hello");
    expect(target.querySelector("h1")?.textContent).toBe("Hello");

    renderMarkdown(target, "# Goodbye");
    const headings = target.querySelectorAll("h1");
    // Only the latest heading should remain — the first one must have
    // been removed by the clear step.
    expect(headings.length).toBe(1);
    expect(headings[0]?.textContent).toBe("Goodbye");
  });

  it("handles empty source by clearing the target without throwing", () => {
    const target = fresh();
    renderMarkdown(target, "# Will be replaced");
    expect(() => {
      renderMarkdown(target, "");
    }).not.toThrow();
    expect(target.children.length).toBe(0);
  });
});

describe("renderMarkdown — XSS safety", () => {
  it("renders a literal <script> tag in source as text (does NOT create a script element)", () => {
    const target = fresh();
    renderMarkdown(target, "Hello <script>alert('xss')</script> world");
    // No real <script> element should be created — the raw angle brackets
    // become text nodes inside a paragraph.
    expect(target.querySelector("script")).toBeNull();
    // The visible text must contain the literal markup so the user can
    // see what the model emitted.
    expect(target.textContent).toContain("<script>");
    expect(target.textContent).toContain("alert('xss')");
  });

  it("renders <img onerror=...> in source as literal text (does NOT create an img element)", () => {
    const target = fresh();
    renderMarkdown(target, "<img src=x onerror=alert(1)>");
    expect(target.querySelector("img")).toBeNull();
    expect(target.textContent).toContain("<img");
    expect(target.textContent).toContain("onerror");
  });

  it("renders an <iframe> tag in source as literal text", () => {
    const target = fresh();
    renderMarkdown(target, "Embed: <iframe src='https://evil'></iframe>");
    expect(target.querySelector("iframe")).toBeNull();
    expect(target.textContent).toContain("<iframe");
  });

  it("does not execute scripts in link text", () => {
    const target = fresh();
    renderMarkdown(target, "[<script>alert(1)</script>](https://example.com)");
    const link = target.querySelector("a");
    expect(target.querySelector("script")).toBeNull();
    // The angle brackets must show up as text inside the anchor.
    expect(link?.textContent).toContain("<script>");
  });
});

describe("renderMarkdown — LaTeX passthrough", () => {
  it("leaves $inline math$ as literal text without crashing", () => {
    const target = fresh();
    renderMarkdown(target, "The arrow $\\rightarrow$ means implication.");
    expect(target.textContent).toContain("$\\rightarrow$");
  });

  it("leaves $x^2 + y^2 = z^2$ unchanged", () => {
    const target = fresh();
    renderMarkdown(target, "Pythagoras: $x^2 + y^2 = z^2$.");
    expect(target.textContent).toContain("$x^2 + y^2 = z^2$");
  });
});

describe("renderMarkdown — mixed content", () => {
  it("renders a heading followed by a paragraph followed by a list", () => {
    const target = fresh();
    renderMarkdown(target, "# Title\n\nIntro text.\n\n- one\n- two");
    expect(target.querySelector("h1")?.textContent).toBe("Title");
    expect(target.querySelector("p")?.textContent).toBe("Intro text.");
    expect(target.querySelectorAll("ul li").length).toBe(2);
  });

  it("paragraph does not swallow a following heading", () => {
    const target = fresh();
    renderMarkdown(target, "Some prose\n# Heading");
    expect(target.querySelector("p")?.textContent).toBe("Some prose");
    expect(target.querySelector("h1")?.textContent).toBe("Heading");
  });

  it("paragraph does not swallow a following fenced code block", () => {
    const target = fresh();
    renderMarkdown(target, "Run this:\n```\ncode\n```");
    expect(target.querySelector("p")?.textContent).toBe("Run this:");
    expect(target.querySelector("pre code")?.textContent).toBe("code");
  });
});
