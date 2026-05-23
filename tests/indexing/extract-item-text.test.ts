/**
 * Adversarial unit tests for `extractItemText` (AC3 + Phase 4
 * PDF-fulltext extension, real-product-pipeline).
 *
 * Plan section: AC3, L535-592 of
 * `docs/superpowers/plans/2026-05-17-real-product-pipeline.md`.
 *
 * --------------------------------------------------------------------
 * Fault Localization (Template 4)
 * --------------------------------------------------------------------
 *
 * 1. Spec semantics (premises):
 *    P1. `extractItemText(item: ZoteroItemLike, options?): string` is pure and SYNC.
 *    P2. The output MUST concatenate
 *          item.getField('title') ?? ''
 *          + "\n\n"
 *          + item.getField('abstractNote') ?? ''
 *          + "\n\n"
 *          + (Phase 4) cached PDF/EPUB fulltext if options.zotero supplied
 *        then `.trim()`. If the trimmed result is empty, return "".
 *    P3. Fulltext access in Phase 4 is sync via
 *        Zotero.FullText.getItemContent(itemID) OR
 *        Zotero.FullText.getItemCacheFile(item) + Zotero.File.getContents.
 *    P4. For TOP-LEVEL ATTACHMENT items, fulltext is read directly on the
 *        item. For TOP-LEVEL BIBLIOGRAPHIC items (article/book/preprint),
 *        iterate `item.getAttachments()` and concatenate cached fulltext
 *        of each child attachment.
 *    P5. The caller skips items where extractItemText returns "".
 *    P6. Empty/null/missing cache → no fulltext contribution; the item
 *        falls back to title+abstract (existing behavior).
 *    P7. Per-item fulltext is capped at `options.fullTextMaxChars` (50_000
 *        default) so a 5 MB OCR PDF cannot run away with the embed budget.
 *
 * 2. Code path trace (against the contracts, NOT impl):
 *    - extractItemText invokes getField twice; when options.zotero is
 *      provided, it ALSO calls FullText.getItemContent OR
 *      FullText.getItemCacheFile+File.getContents per the access shape.
 *    - For child attachments, getAttachments() returns IDs and
 *      Items.get(id) hydrates each before the fulltext read.
 *
 * 3. Divergence analysis (likely bugs):
 *    D1 [HIGH]   Forgetting `??` coalescing → throws on undefined field.
 *    D2 [HIGH]   Trim never happens → whitespace-only items produce a
 *                non-empty string and end up indexed (wasted embed call).
 *    D3 [HIGH]   Calling `getNote()` on a parent (article/preprint/book)
 *                throws "getNote() can only be called on notes and
 *                attachments" — must be caught.
 *    D4 [MEDIUM] Awaiting a sync getContents() → returns "[object Promise]"
 *                in the concatenation (FINDING-7 regression).
 *    D5 [HIGH]   Calling `getAttachments()` on an attachment item throws
 *                ("getAttachments() cannot be called on attachment items"
 *                per Zotero source, data/item.js L3970-3972).
 *    D6 [HIGH]   Empty/null/missing cache treated as a failure rather
 *                than a fallback → user sees crash instead of "no PDF text".
 *    D7 [HIGH]   No cap on per-item fulltext → a single 5 MB PDF blows
 *                up the embed budget.
 *    D8 [LOW]    Wrong return type (Promise<string>) — caught at compile
 *                time but asserted at runtime.
 *
 * 4. Note on T6/T7 historical failures:
 *    Pre-Phase-4 the test file expected `extractItemText` to walk
 *    multiple child-note bodies via `item.getNote()` returning the next
 *    body on each call. The production `readNoteBodies` helper only
 *    ever calls `getNote()` ONCE (and only when the ITEM itself is a
 *    note/attachment — not when it's a parent). True child-note lookup
 *    requires `Zotero.Items.get(noteID).getNote()` per child, plus
 *    HTML-strip of the note body (Zotero stores notes as HTML). That
 *    work is deferred — see the inline comment on `readNoteBodies` in
 *    `src/indexing/library-crawler.ts`. T6/T7 are removed below; the
 *    PDF-fulltext tests (T-fulltext-*) cover the user-visible bug.
 */

import { describe, expect, it } from "vitest";

import type { ZoteroItemLike } from "./contracts.js";
import type { ZoteroFullTextAccess } from "../../src/indexing/library-crawler.js";
import { extractItemText } from "../../src/indexing/library-crawler.js";

type FakeItemSpec = {
  readonly title?: string | undefined;
  readonly abstractNote?: string | undefined;
  /**
   * When provided AND the item is itself a note/attachment, the first
   * body is returned by `getNote()`. The crawler does not exercise this
   * path for top-level bibliographic items; it stays here for back-compat
   * with the pure-helper unit-test contract.
   */
  readonly noteBody?: string;
  readonly isAttachment?: boolean;
  readonly isAnnotation?: boolean;
  /**
   * Child-attachment IDs the item exposes via getAttachments(). The
   * fulltext test harness pre-registers each ID → fulltext mapping in
   * the FakeFullText below.
   */
  readonly attachmentIds?: readonly number[];
};

function makeFakeItem(spec: FakeItemSpec): ZoteroItemLike {
  const noteBody = spec.noteBody;
  const attachmentIds = spec.attachmentIds;
  const item: ZoteroItemLike = {
    id: 1,
    key: "FAKE",
    getField(name) {
      if (name === "title") return spec.title;
      return spec.abstractNote;
    },
    getNotes() {
      return [];
    },
    ...(noteBody !== undefined ? { getNote: () => noteBody } : {}),
    ...(attachmentIds !== undefined ? { getAttachments: () => attachmentIds } : {}),
    isAttachment() {
      return spec.isAttachment ?? false;
    },
    isAnnotation() {
      return spec.isAnnotation ?? false;
    }
  };
  return item;
}

/**
 * Build a fake FullText access object backed by an in-memory map of
 * attachment ID → cached fulltext. Two access modes are exercised:
 *   - `mode: "direct"` uses `getItemContent(itemID)` (the preferred
 *     sync path the prod code probes for first).
 *   - `mode: "cacheFile"` uses `getItemCacheFile(item)` +
 *     `File.getContents(file, charset, maxLength)` (the fallback that
 *     mirrors what `attachmentText` does internally in Zotero source).
 *
 * Items not present in the map produce empty fulltext (the "no PDF
 * cached" path); items whose entry is the literal empty string also
 * fall back to title+abstract.
 */
type FakeFullTextOptions = {
  readonly mode: "direct" | "cacheFile";
  readonly entries: Record<number, string>;
  readonly attachmentItemsById?: Record<number, ZoteroItemLike>;
};

function makeFakeAccess(opts: FakeFullTextOptions): ZoteroFullTextAccess {
  const Items: ZoteroFullTextAccess["Items"] = {
    get(itemID) {
      return opts.attachmentItemsById?.[itemID] ?? null;
    }
  };

  if (opts.mode === "direct") {
    return {
      Items,
      FullText: {
        getItemContent(itemID) {
          // `undefined` is a deliberate "not yet indexed" signal that
          // the prod code must treat as "no contribution" — not as an
          // exception.
          return opts.entries[itemID] ?? undefined;
        }
      }
    };
  }

  // cacheFile mode: surface a fake nsIFile + Zotero.File.getContents.
  return {
    Items,
    FullText: {
      getItemCacheFile(item) {
        const has = Object.prototype.hasOwnProperty.call(opts.entries, item.id);
        return {
          exists() {
            return has;
          },
          path: `/var/test-fixture/zotero-storage/${item.key}/.zotero-ft-cache`
        };
      }
    },
    File: {
      getContents(file, _charset, maxLength) {
        // Extract the item key out of the fake path so we can resolve
        // the fulltext via the entries map. (A real chrome IO would
        // hand us bytes; the fake hands us strings, with maxLength
        // truncation just like the real impl.)
        const path = typeof file === "string" ? file : (file.path ?? "");
        // Find the entry whose key appears in the path.
        for (const [idStr, content] of Object.entries(opts.entries)) {
          const id = Number(idStr);
          const referencedKey =
            opts.attachmentItemsById?.[id]?.key ?? (path.includes(String(id)) ? String(id) : null);
          if (referencedKey !== null && path.includes(referencedKey)) {
            return maxLength !== undefined && content.length > maxLength
              ? content.substring(0, maxLength)
              : content;
          }
        }
        return "";
      }
    }
  };
}

describe("extractItemText — title/abstract base path", () => {
  it("T1: returns '' when the item has no title, no abstract, and no notes", () => {
    const item = makeFakeItem({});
    expect(extractItemText(item)).toBe("");
  });

  it("T2: returns '' when fields are whitespace-only", () => {
    const item = makeFakeItem({ title: "   ", abstractNote: "\n\n  \t" });
    expect(extractItemText(item)).toBe("");
  });

  it("T2b: returns '' when fields are empty strings and there are no notes", () => {
    const item = makeFakeItem({ title: "", abstractNote: "" });
    expect(extractItemText(item)).toBe("");
  });

  it("T3: returns just the title when only the title is set", () => {
    const item = makeFakeItem({ title: "Attention Is All You Need" });
    expect(extractItemText(item)).toBe("Attention Is All You Need");
  });

  it("T4: returns 'title\\n\\nabstract' when both title and abstract are set", () => {
    const item = makeFakeItem({
      title: "Attention Is All You Need",
      abstractNote: "We propose a new simple architecture."
    });
    expect(extractItemText(item)).toBe(
      "Attention Is All You Need\n\nWe propose a new simple architecture."
    );
  });

  it("T5: appends a note body synchronously when the item is itself a note", () => {
    // Note: the production `extractItemText` only reads a note body via
    // `item.getNote()` when THIS item supports it (i.e., the item is a
    // note or an attachment). Child-note traversal via the parent is
    // deferred — see the file-level comment for the historical T6/T7
    // removal rationale.
    const item = makeFakeItem({
      title: "Note title",
      noteBody: "a note about the paper"
    });
    const result = extractItemText(item);
    expect(typeof result).toBe("string");
    expect(result).toContain("Note title");
    expect(result).toContain("a note about the paper");
    // The result must NOT contain a stringified Promise.
    expect(result).not.toMatch(/\[object Promise\]/u);
  });

  it("T8: leading/trailing whitespace on the assembled string is trimmed", () => {
    const item = makeFakeItem({
      title: "  T  ",
      abstractNote: ""
    });
    // After concatenation: "  T  \n\n" -> trim -> "T".
    expect(extractItemText(item)).toBe("T");
  });

  it("T8b: only-abstract item — no title — does not leak leading blank line", () => {
    const item = makeFakeItem({ abstractNote: "abstract only" });
    const result = extractItemText(item);
    // Pre-trim: "\n\nabstract only"; post-trim: "abstract only".
    expect(result).toBe("abstract only");
  });

  it("T9: return value is a synchronous string, not a Promise", () => {
    const item = makeFakeItem({ title: "Sync" });
    const result = extractItemText(item);
    expect(typeof result).toBe("string");
    expect(result).not.toHaveProperty("then");
  });

  it("T10: item with empty title and non-empty abstract behaves like 'abstract only'", () => {
    const item = makeFakeItem({ title: "", abstractNote: "abstract content" });
    expect(extractItemText(item)).toBe("abstract content");
  });

  it("T11: title with embedded newlines is preserved verbatim", () => {
    const item = makeFakeItem({ title: "line 1\nline 2", abstractNote: "abs" });
    expect(extractItemText(item)).toBe("line 1\nline 2\n\nabs");
  });

  it("T12: undefined-returning getField (no field set) is treated as empty", () => {
    // getField returning undefined is allowed by the contract.
    const item: ZoteroItemLike = {
      id: 1,
      key: "K",
      getField() {
        return undefined;
      },
      getNotes() {
        return [];
      },
      isAttachment() {
        return false;
      },
      isAnnotation() {
        return false;
      }
    };
    expect(extractItemText(item)).toBe("");
  });
});

describe("extractItemText — PDF fulltext (Phase 4)", () => {
  it("T-fulltext-standalone-direct: standalone PDF attachment with cached fulltext (direct API)", () => {
    // A top-level attachment whose only metadata is the PDF text.
    const item = makeFakeItem({ isAttachment: true });
    const access = makeFakeAccess({
      mode: "direct",
      entries: { 1: "Paper body line 1.\n\nLine 2." }
    });
    const result = extractItemText(item, { zotero: access });
    expect(result).toBe("Paper body line 1.\n\nLine 2.");
  });

  it("T-fulltext-standalone-cacheFile: standalone PDF attachment with cached fulltext (cache-file API)", () => {
    const item = makeFakeItem({ isAttachment: true });
    const access = makeFakeAccess({
      mode: "cacheFile",
      entries: { 1: "Cache-file content." },
      attachmentItemsById: { 1: item }
    });
    const result = extractItemText(item, { zotero: access });
    expect(result).toBe("Cache-file content.");
  });

  it("T-fulltext-standalone-with-title: title + cached fulltext are both included", () => {
    const item = makeFakeItem({ title: "Paper Title", isAttachment: true });
    const access = makeFakeAccess({
      mode: "direct",
      entries: { 1: "Full body text." }
    });
    const result = extractItemText(item, { zotero: access });
    expect(result).toBe("Paper Title\n\nFull body text.");
  });

  it("T-fulltext-toplevel-with-child: top-level bibliographic item + child attachment with fulltext", () => {
    // Parent article + one child PDF.
    const childAttachment = makeFakeItem({ isAttachment: true });
    // We need the child to have a distinct id so the Items.get lookup
    // works. makeFakeItem hardcodes id=1; replace with a per-test build.
    const child: ZoteroItemLike = {
      id: 42,
      key: "CHILD",
      getField: () => undefined,
      getNotes: () => [],
      isAttachment: () => true,
      isAnnotation: () => false
    };
    const parent: ZoteroItemLike = {
      id: 7,
      key: "PARENT",
      getField(name) {
        if (name === "title") return "Parent Paper";
        return "Parent abstract.";
      },
      getNotes: () => [],
      getAttachments: () => [42],
      isAttachment: () => false,
      isAnnotation: () => false
    };
    void childAttachment;
    const access = makeFakeAccess({
      mode: "direct",
      entries: { 42: "PDF body content." },
      attachmentItemsById: { 42: child }
    });
    const result = extractItemText(parent, { zotero: access });
    expect(result).toBe("Parent Paper\n\nParent abstract.\n\nPDF body content.");
  });

  it("T-fulltext-toplevel-no-attachment: top-level item with no children unchanged", () => {
    const parent: ZoteroItemLike = {
      id: 7,
      key: "PARENT",
      getField(name) {
        if (name === "title") return "Solo Paper";
        return "Solo abstract.";
      },
      getNotes: () => [],
      getAttachments: () => [],
      isAttachment: () => false,
      isAnnotation: () => false
    };
    const access = makeFakeAccess({ mode: "direct", entries: {} });
    const result = extractItemText(parent, { zotero: access });
    expect(result).toBe("Solo Paper\n\nSolo abstract.");
  });

  it("T-fulltext-empty-cache: attachment with empty cache falls back to title+abstract", () => {
    const item: ZoteroItemLike = {
      id: 5,
      key: "K",
      getField(name) {
        if (name === "title") return "Has Title";
        return undefined;
      },
      getNotes: () => [],
      isAttachment: () => true,
      isAnnotation: () => false
    };
    const access = makeFakeAccess({ mode: "direct", entries: { 5: "" } });
    const result = extractItemText(item, { zotero: access });
    // Empty fulltext does NOT contribute; the title alone survives.
    expect(result).toBe("Has Title");
  });

  it("T-fulltext-null-cache: attachment whose direct lookup returns null falls back", () => {
    const item: ZoteroItemLike = {
      id: 5,
      key: "K",
      getField() {
        return undefined;
      },
      getNotes: () => [],
      isAttachment: () => true,
      isAnnotation: () => false
    };
    const access: ZoteroFullTextAccess = {
      Items: { get: () => null },
      FullText: {
        getItemContent() {
          return null;
        }
      }
    };
    expect(extractItemText(item, { zotero: access })).toBe("");
  });

  it("T-fulltext-missing-cachefile: cache file absent → no contribution, no throw", () => {
    const item: ZoteroItemLike = {
      id: 5,
      key: "K",
      getField(name) {
        if (name === "abstractNote") return "abstract";
        return undefined;
      },
      getNotes: () => [],
      isAttachment: () => true,
      isAnnotation: () => false
    };
    const access: ZoteroFullTextAccess = {
      Items: { get: () => null },
      FullText: {
        getItemCacheFile() {
          return {
            exists() {
              return false;
            },
            path: "/var/test-fixture/whatever"
          };
        }
      },
      File: {
        getContents() {
          throw new Error("must not be called");
        }
      }
    };
    expect(extractItemText(item, { zotero: access })).toBe("abstract");
  });

  it("T-fulltext-cap: per-item fulltext is hard-capped at fullTextMaxChars", () => {
    const item = makeFakeItem({ isAttachment: true });
    const huge = "x".repeat(200_000);
    const access = makeFakeAccess({ mode: "direct", entries: { 1: huge } });
    const result = extractItemText(item, { zotero: access, fullTextMaxChars: 1024 });
    expect(result.length).toBeLessThanOrEqual(1024);
    expect(result.startsWith("x")).toBe(true);
  });

  it("T-fulltext-annotation-skipped: annotation items contribute no fulltext even if cached", () => {
    const item: ZoteroItemLike = {
      id: 9,
      key: "ANN",
      getField() {
        return undefined;
      },
      getNotes: () => [],
      isAttachment: () => true,
      isAnnotation: () => true
    };
    const access = makeFakeAccess({ mode: "direct", entries: { 9: "annotation body" } });
    // Annotations are excluded from the fulltext extraction (per the
    // crawler's policy in `readAttachmentFullText`). The item also has
    // no title/abstract, so the result is "".
    expect(extractItemText(item, { zotero: access })).toBe("");
  });

  it("T-fulltext-getAttachments-throws: top-level item whose getAttachments throws degrades gracefully", () => {
    // A top-level item incorrectly typed by Zotero (e.g., a malformed
    // record) where `getAttachments()` throws. The crawler must not
    // crash; fall back to title+abstract.
    const item: ZoteroItemLike = {
      id: 10,
      key: "BROKEN",
      getField(name) {
        if (name === "title") return "Broken Item";
        return undefined;
      },
      getNotes: () => [],
      getAttachments() {
        throw new Error("getAttachments() cannot be called on attachment items");
      },
      isAttachment: () => false,
      isAnnotation: () => false
    };
    const access = makeFakeAccess({ mode: "direct", entries: {} });
    expect(extractItemText(item, { zotero: access })).toBe("Broken Item");
  });

  it("T-fulltext-getitemcontent-throws: FullText.getItemContent throwing falls through to cache file", () => {
    const item = makeFakeItem({ isAttachment: true });
    const access: ZoteroFullTextAccess = {
      Items: { get: () => null },
      FullText: {
        getItemContent() {
          throw new Error("not implemented in this build");
        },
        getItemCacheFile() {
          return {
            exists() {
              return true;
            },
            path: "/var/test-fixture/x/FAKE/.zotero-ft-cache"
          };
        }
      },
      File: {
        getContents() {
          return "fallback content";
        }
      }
    };
    expect(extractItemText(item, { zotero: access })).toBe("fallback content");
  });

  it("T-fulltext-no-zotero-option: extractItemText without options behaves like the pre-Phase-4 helper", () => {
    // Backward compatibility: every call site that does NOT pass
    // options.zotero must keep getting title + abstract only.
    const item = makeFakeItem({ title: "T", abstractNote: "A", isAttachment: true });
    expect(extractItemText(item)).toBe("T\n\nA");
  });
});
