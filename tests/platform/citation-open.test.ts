/**
 * AC-7 unit coverage — `openCitationInReader` citation -> Zotero.Reader.open
 * dispatch (`src/platform/citation-open.ts`).
 *
 * The dispatch was extracted from an inline `startup()` closure into an
 * exported pure helper so the `pageIndex !== undefined` branch and the
 * positional-vs-nested argument shape became black-box unit-testable. The
 * S4 tester flagged this extraction as a prerequisite for AC-7 unit
 * coverage (Phase4-S4-tests.md "Hard-to-test notes" #1). Phase 4b
 * FINDING-5 moved the helper into its own `platform/citation-open.ts`
 * module so the e2e driver no longer imports the bootstrap entrypoint.
 *
 * ### PHASE 1 — SPEC SEMANTICS (plan L486-498, AC-6 L472-484)
 * - P1: a citation with `pageIndex !== undefined` calls
 *   `Reader.open(attachmentId, { pageIndex })` — `pageIndex` as the SECOND
 *   POSITIONAL arg, NOT nested under `{ location: ... }`.
 * - P2: `pageIndex: 0` opens at page 0 — the impl checks `!== undefined`,
 *   never truthiness; page 0 is a real first page.
 * - P3: a citation with `pageIndex === undefined` calls
 *   `Reader.open(attachmentId)` with NO second argument (v0.2.0 behavior).
 * - P4 (FINDING-3): a citation carrying `attachmentKey` opens THAT exact
 *   attachment, not just the first PDF child — multi-PDF parents route to
 *   the cited supplemental attachment.
 *
 * ### PHASE 3 — DIVERGENCE ANALYSIS
 * - D1: pageIndex passed nested under `{ location: ... }`.
 * - D2: `pageIndex: 0` dropped by a truthy guard -> opens via the
 *   no-location call instead of the positional-pageIndex call.
 * - D3: `pageIndex: undefined` still passes a second argument.
 * - D4 (FINDING-3): `attachmentKey` discarded -> a multi-PDF parent always
 *   opens the FIRST PDF child even when the citation resolved to a later
 *   attachment.
 *
 * Black-box: imports only the public `openCitationInReader` export and
 * drives it with a hand-rolled fake `Zotero` slice.
 */

import { describe, expect, it } from "vitest";

import { openCitationInReader, type ResolvedCitation } from "../../src/platform/citation-open.js";

type ReaderOpenCall = { readonly id: number; readonly args: readonly unknown[] };

/**
 * Build a fake Zotero slice with a regular item that owns one PDF child
 * attachment (Zotero key `ATT00001`). `calls` records every `Reader.open`
 * invocation with its full argument vector so a test can assert the exact
 * arity + shape.
 */
function fakeZotero(calls: ReaderOpenCall[], over: { hasReader?: boolean } = {}) {
  const PARENT_ID = 100;
  const ATTACHMENT_ID = 200;
  const item = {
    id: PARENT_ID,
    isRegularItem: () => true,
    getAttachments: () => [ATTACHMENT_ID]
  };
  const attachment = {
    id: ATTACHMENT_ID,
    key: "ATT00001",
    isPDFAttachment: () => true,
    attachmentContentType: "application/pdf"
  };
  return {
    attachmentId: ATTACHMENT_ID,
    zotero: {
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: (_libraryID: number, key: string) =>
          key === "ABCD1234" ? item : false,
        get: (id: number) => (id === ATTACHMENT_ID ? attachment : null)
      },
      ...(over.hasReader === false
        ? {}
        : {
            Reader: {
              open: (...args: unknown[]) => {
                calls.push({ id: args[0] as number, args });
                return Promise.resolve();
              }
            }
          })
    }
  };
}

/**
 * Build a fake Zotero slice with a regular parent item that owns TWO PDF
 * child attachments — the FINDING-3 multi-PDF case. The first child
 * (`PRIMARY`) and the second child (`SUPPLEMENT`) are both openable PDFs;
 * a chunk-scoped citation must route to the attachment whose Zotero key
 * matches `citation.attachmentKey`, NOT just the first PDF child.
 */
function fakeMultiPdfZotero(calls: ReaderOpenCall[]) {
  const PARENT_ID = 100;
  const PRIMARY_ID = 200;
  const SUPPLEMENT_ID = 201;
  const item = {
    id: PARENT_ID,
    isRegularItem: () => true,
    getAttachments: () => [PRIMARY_ID, SUPPLEMENT_ID]
  };
  const attachments: Record<number, { id: number; key: string; isPDFAttachment: () => boolean }> = {
    [PRIMARY_ID]: { id: PRIMARY_ID, key: "PRIMARY0", isPDFAttachment: () => true },
    [SUPPLEMENT_ID]: { id: SUPPLEMENT_ID, key: "SUPPLMNT", isPDFAttachment: () => true }
  };
  return {
    primaryId: PRIMARY_ID,
    supplementId: SUPPLEMENT_ID,
    zotero: {
      Libraries: { userLibraryID: 1 },
      Items: {
        getByLibraryAndKey: (_libraryID: number, key: string) =>
          key === "ABCD1234" ? item : false,
        get: (id: number) => attachments[id] ?? null
      },
      Reader: {
        open: (...args: unknown[]) => {
          calls.push({ id: args[0] as number, args });
          return Promise.resolve();
        }
      }
    }
  };
}

const PAGED: ResolvedCitation = {
  itemKey: "ABCD1234",
  attachmentKey: "ATT00001",
  pageIndex: 16
};

describe("openCitationInReader", () => {
  it("P1/D1: opens with pageIndex as the SECOND POSITIONAL argument (not nested location)", () => {
    const calls: ReaderOpenCall[] = [];
    const { zotero, attachmentId } = fakeZotero(calls);
    const result = openCitationInReader(PAGED, zotero);

    expect(result.outcome).toBe("opened-with-page");
    expect(result.attachmentId).toBe(attachmentId);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(attachmentId);
    // Exactly two positional args: the attachment id and `{ pageIndex }`.
    expect(calls[0]?.args).toHaveLength(2);
    expect(calls[0]?.args[1]).toEqual({ pageIndex: 16 });
    // Adversarial D1: it must NOT be nested under `{ location: ... }`.
    expect(calls[0]?.args[1]).not.toHaveProperty("location");
  });

  it("P2/D2: a citation resolving to pageIndex 0 still opens via the positional pageIndex arg", () => {
    // Page 0 is a real first page. A truthy guard would drop it and fall
    // through to the no-location call.
    const calls: ReaderOpenCall[] = [];
    const { zotero, attachmentId } = fakeZotero(calls);
    const result = openCitationInReader({ itemKey: "ABCD1234", pageIndex: 0 }, zotero);

    expect(result.outcome).toBe("opened-with-page");
    expect(result.attachmentId).toBe(attachmentId);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toHaveLength(2);
    expect(calls[0]?.args[1]).toEqual({ pageIndex: 0 });
  });

  it("P3/D3: a citation with pageIndex undefined opens with NO second argument", () => {
    const calls: ReaderOpenCall[] = [];
    const { zotero, attachmentId } = fakeZotero(calls);
    const result = openCitationInReader({ itemKey: "ABCD1234" }, zotero);

    expect(result.outcome).toBe("opened-no-page");
    expect(result.attachmentId).toBe(attachmentId);
    expect(calls).toHaveLength(1);
    // v0.2.0 behavior: `Reader.open(attachmentId)` — a single argument.
    expect(calls[0]?.args).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe(attachmentId);
  });

  it("returns `not-found` and never opens the reader for an unknown item key", () => {
    // The hallucination guard: a citation whose itemKey is absent from the
    // library must not route to anything.
    const calls: ReaderOpenCall[] = [];
    const { zotero } = fakeZotero(calls);
    const result = openCitationInReader({ itemKey: "WRONGKEY", pageIndex: 3 }, zotero);

    expect(result.outcome).toBe("not-found");
    expect(calls).toHaveLength(0);
  });

  it("falls back to selecting the row when there is no Reader API", () => {
    const calls: ReaderOpenCall[] = [];
    const selected: number[][] = [];
    const { zotero } = fakeZotero(calls, { hasReader: false });
    const withPane = {
      ...zotero,
      getActiveZoteroPane: () => ({
        selectItems: (ids: readonly number[]) => {
          selected.push([...ids]);
        }
      })
    };
    const result = openCitationInReader(PAGED, withPane);

    expect(result.outcome).toBe("selected-row");
    expect(calls).toHaveLength(0);
    expect(selected).toEqual([[100]]);
  });

  it("P4/D4: a multi-PDF parent routes the citation to the attachment whose key matches", () => {
    // FINDING-3: a parent item with two PDF children. A citation resolved
    // to the SECOND attachment (`SUPPLMNT`) must open that attachment, not
    // the first PDF child. Discarding `attachmentKey` would open PRIMARY.
    const calls: ReaderOpenCall[] = [];
    const { zotero, primaryId, supplementId } = fakeMultiPdfZotero(calls);
    const result = openCitationInReader(
      { itemKey: "ABCD1234", attachmentKey: "SUPPLMNT", pageIndex: 4 },
      zotero
    );

    expect(result.outcome).toBe("opened-with-page");
    expect(result.attachmentId).toBe(supplementId);
    expect(result.attachmentId).not.toBe(primaryId);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(supplementId);
    expect(calls[0]?.args[1]).toEqual({ pageIndex: 4 });
  });

  it("a multi-PDF parent routes a first-attachment citation to the first child", () => {
    // Symmetric to the above: an `attachmentKey` matching the FIRST child
    // still resolves correctly (proves the key lookup, not insertion luck).
    const calls: ReaderOpenCall[] = [];
    const { zotero, primaryId } = fakeMultiPdfZotero(calls);
    const result = openCitationInReader(
      { itemKey: "ABCD1234", attachmentKey: "PRIMARY0", pageIndex: 1 },
      zotero
    );

    expect(result.outcome).toBe("opened-with-page");
    expect(result.attachmentId).toBe(primaryId);
    expect(calls[0]?.id).toBe(primaryId);
  });

  it("legacy citation without attachmentKey opens the first PDF child of a multi-PDF parent", () => {
    // Back-compat: a citation from a pre-v0.3.0 index carries no
    // `attachmentKey`. The resolver falls back to the first PDF child.
    const calls: ReaderOpenCall[] = [];
    const { zotero, primaryId } = fakeMultiPdfZotero(calls);
    const result = openCitationInReader({ itemKey: "ABCD1234", pageIndex: 7 }, zotero);

    expect(result.outcome).toBe("opened-with-page");
    expect(result.attachmentId).toBe(primaryId);
  });

  it("a stale attachmentKey falls back to the first PDF child rather than failing the click", () => {
    // The cited attachment was deleted after indexing — its key no longer
    // matches any child. Opening the first PDF child beats a dead click.
    const calls: ReaderOpenCall[] = [];
    const { zotero, primaryId } = fakeMultiPdfZotero(calls);
    const result = openCitationInReader(
      { itemKey: "ABCD1234", attachmentKey: "GONE0000", pageIndex: 2 },
      zotero
    );

    expect(result.outcome).toBe("opened-with-page");
    expect(result.attachmentId).toBe(primaryId);
  });
});
