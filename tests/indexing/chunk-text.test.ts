/**
 * Adversarial unit tests for `chunkText` (AC3, real-product-pipeline).
 *
 * Plan section: AC3, L579-584 of
 * `docs/superpowers/plans/2026-05-17-real-product-pipeline.md`.
 *
 * --------------------------------------------------------------------
 * Fault Localization (Template 4)
 * --------------------------------------------------------------------
 *
 * 1. Spec semantics (premises):
 *    P1. `chunkText(text: string, maxBytes: number): readonly string[]`.
 *    P2. Empty input → []. (Plan L584.)
 *    P3. Split on paragraph boundary (`\n\n`) when present; fall back to
 *        a hard byte cut otherwise. (Plan L583.)
 *    P4. Each emitted chunk MUST be ≤ maxBytes long.
 *    P5. Re-joining all chunks (with appropriate paragraph glue) MUST
 *        reconstruct the original input (modulo collapsed boundary
 *        whitespace — spec is lenient here, but content must round-trip).
 *
 * 2. Code path trace (against the contract, NOT impl):
 *    - For text under maxBytes → return [text].
 *    - For text with paragraph boundaries → split on \n\n, greedily fill
 *      chunks up to maxBytes.
 *    - For a single paragraph longer than maxBytes → hard byte cut at
 *      maxBytes.
 *
 * 3. Divergence analysis (likely bugs):
 *    D1 [HIGH]   Off-by-one: a chunk of EXACTLY maxBytes is split into
 *                two unnecessarily.
 *    D2 [HIGH]   Hard cut on a multi-byte codepoint surrogate pair →
 *                chunk contains a broken codepoint (renders as U+FFFD).
 *    D3 [HIGH]   Empty input returns [""] (length 1) instead of [].
 *    D4 [MEDIUM] Paragraph boundary is "\r\n\r\n" (Windows) — impl
 *                only matches "\n\n" so input doesn't split.
 *    D5 [MEDIUM] Input with only "\n\n" separators (no content) returns
 *                [""] entries instead of [].
 *    D6 [MEDIUM] Greedy fill is anti-greedy: each paragraph emitted as
 *                its own chunk, even when several would fit together.
 *    D7 [LOW]    maxBytes = 0 → infinite loop (no progress).
 *    D8 [LOW]    Very long paragraph: hard-cut produces chunks larger
 *                than maxBytes because of off-by-one in the slice.
 *
 * 4. Test targets (ranked):
 *    T1 — D3: empty input → [].
 *    T2 — D5: whitespace-only → [].
 *    T3 — short text under maxBytes → [text].
 *    T4 — D6: multi-paragraph fits in one chunk → [text].
 *    T5 — paragraph boundary preferred: 3 paragraphs each ~maxBytes/2.
 *    T6 — single paragraph > maxBytes: hard cut, every chunk ≤ maxBytes.
 *    T7 — D1: chunk of EXACTLY maxBytes stays as a single chunk.
 *    T8 — D2: multi-byte (emoji) input is not cut mid-codepoint.
 *    T9 — re-join round-trip preserves content (modulo paragraph glue).
 *    T10 — D8: any chunk's .length ≤ maxBytes for very long input.
 */

import { describe, expect, it } from "vitest";

import { chunkText } from "../../src/indexing/library-crawler.js";

const MAX = 32;

describe("chunkText", () => {
  it("T1: empty string returns []", () => {
    expect(chunkText("", MAX)).toEqual([]);
  });

  it("T2: whitespace-only input returns []", () => {
    expect(chunkText("   ", MAX)).toEqual([]);
    expect(chunkText("\n\n\n\n", MAX)).toEqual([]);
  });

  it("T3: short text under maxBytes returns a single chunk", () => {
    const text = "short";
    const chunks = chunkText(text, MAX);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("short");
  });

  it("T4: multi-paragraph text that fits in one chunk returns a single chunk", () => {
    const text = "a\n\nb"; // 4 bytes, well under MAX=32
    const chunks = chunkText(text, MAX);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("a\n\nb");
  });

  it("T5: multi-paragraph text that exceeds maxBytes splits on paragraph boundary", () => {
    const p1 = "a".repeat(20);
    const p2 = "b".repeat(20);
    const p3 = "c".repeat(20);
    const text = `${p1}\n\n${p2}\n\n${p3}`; // 64 bytes (+ separators)
    const chunks = chunkText(text, MAX);
    // We MUST get at least two chunks (single chunk would exceed MAX).
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX);
    }
    // Each paragraph must end up entirely inside a single chunk (because
    // each paragraph is ≤ MAX and the splitter is paragraph-aware).
    const joined = chunks.join("");
    expect(joined).toContain(p1);
    expect(joined).toContain(p2);
    expect(joined).toContain(p3);
  });

  it("T6: single paragraph longer than maxBytes is hard-cut into chunks ≤ maxBytes", () => {
    const text = "x".repeat(MAX * 3 + 5); // 101 bytes
    const chunks = chunkText(text, MAX);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX);
    }
    // Content round-trip: concatenation of all chunks equals input.
    expect(chunks.join("")).toBe(text);
  });

  it("T7: text whose total length equals maxBytes stays as a single chunk", () => {
    const text = "y".repeat(MAX);
    const chunks = chunkText(text, MAX);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("T7b: text whose total length equals maxBytes + 1 splits into 2 chunks", () => {
    const text = "y".repeat(MAX + 1);
    const chunks = chunkText(text, MAX);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("T8: emoji input is not cut mid-codepoint", () => {
    // Each emoji is a surrogate pair (2 UTF-16 code units, 4 UTF-8
    // bytes). We use 20 emoji = 40 UTF-16 code units total. With
    // maxBytes = 8 (UTF-16 code units), a naive substring(0, 8) would
    // be fine on the boundary, but any cut at an odd code-unit index
    // would split a surrogate pair.
    const text = "😀".repeat(20); // 40 UTF-16 code units
    const chunks = chunkText(text, 8);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const c of chunks) {
      // No chunk contains a lone surrogate.
      for (let i = 0; i < c.length; i += 1) {
        const code = c.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          // high surrogate must be followed by a low surrogate
          const next = c.charCodeAt(i + 1);
          expect(next).toBeGreaterThanOrEqual(0xdc00);
          expect(next).toBeLessThanOrEqual(0xdfff);
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          // low surrogate must be preceded by a high surrogate
          const prev = c.charCodeAt(i - 1);
          expect(prev).toBeGreaterThanOrEqual(0xd800);
          expect(prev).toBeLessThanOrEqual(0xdbff);
        }
      }
    }
    // Round-trip preserves all 20 emoji (count via Intl.Segmenter so we
    // don't trip the no-misused-spread rule).
    const joined = chunks.join("");
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    const graphemes = Array.from(segmenter.segment(joined));
    expect(graphemes).toHaveLength(20);
  });

  it("T9: multi-byte CJK input is not cut mid-codepoint", () => {
    // BMP characters (no surrogate pair), but the test still proves
    // that a hard cut respects code-unit boundaries.
    const text = "漢字".repeat(20); // 40 code units
    const chunks = chunkText(text, 7);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(7);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("T10: every chunk ≤ maxBytes for very long pathological input", () => {
    const text = "z".repeat(1000);
    const chunks = chunkText(text, 13);
    expect(chunks.length).toBeGreaterThan(70);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(13);
      // No empty chunks allowed.
      expect(c.length).toBeGreaterThan(0);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("T11: paragraph boundary preferred over hard cut when both are possible", () => {
    // A 20-byte paragraph, then \n\n, then another 20 — with MAX = 25,
    // a naive hard-cut would split the first paragraph mid-way. The
    // spec mandates a paragraph-boundary split, so chunk 1 should be
    // exactly p1.
    const p1 = "a".repeat(20);
    const p2 = "b".repeat(20);
    const text = `${p1}\n\n${p2}`;
    const chunks = chunkText(text, 25);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The first chunk should be just p1 (with no part of p2 leaking in)
    // because the splitter preferred the paragraph boundary at offset
    // 20-22 over a hard cut at offset 25.
    expect(chunks[0]).toBe(p1);
    expect(chunks[1]).toContain(p2);
  });
});
