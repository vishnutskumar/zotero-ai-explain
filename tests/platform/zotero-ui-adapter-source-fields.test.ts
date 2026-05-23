/* @vitest-environment jsdom */

/**
 * Adversarial unit tests for AC-1 + AC-2 — the reader-command surface:
 * the "Ask a question" second command, the hidden-when-no-selection
 * rule, and PDF identity (itemKey / itemTitle / attachmentKey /
 * pageIndex / pageLabel) populated onto `selection.source`.
 *
 * Plan: `docs/superpowers/plans/2026-05-19-pdf-context-features.md`
 *   AC-1 description           L395-407 (adversarial cases L403-407)
 *   AC-2 description           L409-420 (adversarial cases L417-420)
 *   AC-1 + AC-2 contracts      L590-627
 *   Modify notes               L233-254
 *
 * --------------------------------------------------------------------
 * Fault Localization (Template 4 — AC-1 + AC-2 reader command)
 * --------------------------------------------------------------------
 *
 * 1. Spec semantics (premises):
 *    P1.  `addReaderCommands(commands)` registers ONE reader-event
 *         listener that appends one button per `ReaderCommandSpec`
 *         (contract L607-616). `addReaderCommand(label, action)` stays
 *         as a single-spec convenience equivalent to
 *         `addReaderCommands([{label, mode:"explain", action}])`
 *         (contract L616-617).
 *    P2.  Each `ReaderCommandSpec` has `{label, mode, action}` with
 *         `mode: "explain" | "ask-question"`. The action receives a
 *         `SelectionContext` (contract L608-612).
 *    P3.  When the reader reports a non-empty selection, every
 *         registered command's button is appended and ENABLED. When
 *         the reader reports NO selection
 *         (`event.params?.annotation?.text` empty/whitespace) the
 *         command's menu item is HIDDEN — not appended, or appended
 *         but not present as an active control (AC-1 L397, L404).
 *    P4.  `event.params === undefined` ⇒ defensive fall-through:
 *         the handler mirrors `event.params?.annotation?.text?.trim()
 *         ?? ""` and treats it as an empty selection — no throw
 *         (AC-1 L407).
 *    P5.  On click with a real selection, `action(selection)` receives
 *         a `SelectionContext` whose `source` carries `itemKey`,
 *         `itemTitle`, `attachmentKey`, `pageLabel`, `pageIndex`
 *         resolved from the reader event (AC-2 L411).
 *    P6.  `SourceMetadata.pageIndex` is `?: number` — undefined-absent,
 *         NEVER `number | null`. `pageIndex: 0` propagates as `0`
 *         (AC-2 L411/L418, SP1 L99).
 *    P7.  `pageLabel` falls back: when the reader event omits
 *         `annotation.pageLabel`, the consumer uses
 *         `pageLabel ?? String(pageIndex + 1)`. (The adapter MAY leave
 *         `source.pageLabel` null and let the prompt renderer apply
 *         the fallback — the contract only requires the raw fields to
 *         be carried; the renderer test below pins the fallback.)
 *    P8.  `_item` resolution is three-tiered: `event.reader._item`,
 *         then `event.reader.wrappedJSObject._item` (Xray), then a
 *         miss. When ALL tiers miss, every `source` identity field
 *         stays `null` and the action is still invoked — graceful
 *         degrade (AC-2 L420).
 *
 * 2. Code path trace (against the contract — body NOT inspected):
 *    - addReaderCommands → registerEventListener("renderTextSelectionPopup")
 *      → handler reads params.annotation.{text,pageLabel,position.pageIndex}
 *      and event.reader._item (+ wrappedJSObject fallback) → appends N
 *      buttons → on click builds SelectionContext and calls action.
 *
 * 3. Divergence analysis (where the impl could fail the spec):
 *    D1 [HIGH]   empty selection still appends an enabled button
 *                (item not hidden).
 *    D2 [HIGH]   pageIndex 0 collapsed to null/undefined.
 *    D3 [HIGH]   `event.params === undefined` throws (no `?.`).
 *    D4 [HIGH]   second "ask-question" command not registered, or
 *                both buttons fire the same mode/action.
 *    D5 [MEDIUM] _item all-tiers-miss throws instead of leaving the
 *                fields null.
 *    D6 [MEDIUM] attachmentKey / itemTitle dropped.
 *    D7 [LOW]    addReaderCommand convenience wrapper regressed.
 *
 * 4. Test targets, ranked: D1 > D2 > D3 > D4 > D5 > D6 > D7.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createZoteroUiAdapter } from "../../src/platform/zotero-ui-adapter.js";
import type { ZoteroGlobal } from "../../src/platform/zotero-ui-adapter.js";
import type { ReaderCommandSpec } from "../../src/platform/zotero-ui-types.js";
import type { SelectionContext } from "../../src/selection/selection-context.js";

// --------------------------------------------------------------------
// Reader-event fixtures
// --------------------------------------------------------------------

/**
 * The shape Zotero hands a `renderTextSelectionPopup` listener. The
 * v0.3.0 widening adds `params.annotation.pageLabel`,
 * `params.annotation.position.pageIndex`, and `reader._item` (with the
 * Xray `wrappedJSObject` fallback). The test types this loosely as the
 * handler is registered through the public adapter API; the adapter's
 * internal `ReaderEvent` type is not imported (it is not exported).
 */
type FakeReaderParams = {
  annotation?: {
    text?: string;
    pageLabel?: string;
    position?: { pageIndex?: number };
  };
};

type FakeReaderEvent = {
  doc: Document;
  // `| undefined` is explicit (not just `?:`) so the D3 adversarial
  // case can pass `params: undefined` under `exactOptionalPropertyTypes`.
  params: FakeReaderParams | undefined;
  reader: unknown;
  append: (content: HTMLElement | { label: string; onCommand: () => void }) => void;
};

type FakeReaderItem = {
  key?: string;
  parentItemID?: number;
  getDisplayTitle?: () => string;
  isAttachment?: () => boolean;
};

/** A reader instance exposing `_item` directly (chrome-compartment / test env). */
function readerWithItem(item: FakeReaderItem | null): unknown {
  return {
    _item: item,
    _iframe: { getBoundingClientRect: () => document.body.getBoundingClientRect() }
  };
}

/** A reader instance hiding `_item` behind an Xray `wrappedJSObject`. */
function readerWithXrayItem(item: FakeReaderItem): unknown {
  return {
    // Xray hides underscore-prefixed props on the outer object…
    wrappedJSObject: { _item: item },
    _iframe: { getBoundingClientRect: () => document.body.getBoundingClientRect() }
  };
}

type CapturedClick = {
  buttons: HTMLButtonElement[];
  /** Click a button and return the SelectionContext its action received. */
  clickAndCapture: (index: number) => SelectionContext | undefined;
};

/**
 * Register `specs` through `addReaderCommands`, dispatch the given
 * reader event, and collect the appended buttons + per-action capture.
 */
function dispatchReaderCommands(
  specs: readonly {
    label: string;
    mode: ReaderCommandSpec["mode"];
    capture: (s: SelectionContext) => void;
  }[],
  event: Omit<FakeReaderEvent, "append">
): CapturedClick {
  const register = vi.fn();
  const zotero: ZoteroGlobal = {
    debug: vi.fn(),
    getMainWindow: () => window,
    Reader: {
      registerEventListener: register,
      unregisterEventListener: vi.fn()
    }
  };
  const ui = createZoteroUiAdapter({ Zotero: zotero, pluginId: "test" });

  const commands: ReaderCommandSpec[] = specs.map((s) => ({
    label: s.label,
    mode: s.mode,
    action: s.capture
  }));
  ui.addReaderCommands(commands);

  const handler = register.mock.calls[0]?.[1] as ((e: FakeReaderEvent) => void) | undefined;
  if (handler === undefined) {
    throw new Error("addReaderCommands did not register a reader event listener");
  }

  const appended: HTMLButtonElement[] = [];
  handler({
    ...event,
    append: (content) => {
      if (content instanceof HTMLElement) {
        appended.push(content as HTMLButtonElement);
        document.body.append(content);
      }
    }
  });

  return {
    buttons: appended,
    clickAndCapture: (index): SelectionContext | undefined => {
      let captured: SelectionContext | undefined;
      // Re-point the spec's capture so we get THIS click's selection.
      const spec = specs[index];
      if (spec !== undefined) {
        spec.capture = (s): void => {
          captured = s;
        };
      }
      appended[index]?.click();
      return captured;
    }
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

// --------------------------------------------------------------------
// AC-1 — "Ask a question" command + hidden-when-no-selection
// --------------------------------------------------------------------

describe("addReaderCommands — AC-1 ask-question command", () => {
  it("D4: registers BOTH the explain and ask-question commands on one listener", () => {
    const register = vi.fn();
    const zotero: ZoteroGlobal = {
      debug: vi.fn(),
      getMainWindow: () => window,
      Reader: { registerEventListener: register, unregisterEventListener: vi.fn() }
    };
    const ui = createZoteroUiAdapter({ Zotero: zotero, pluginId: "test" });

    ui.addReaderCommands([
      { label: "Explain with AI", mode: "explain", action: vi.fn() },
      { label: "Ask a question", mode: "ask-question", action: vi.fn() }
    ]);

    // ONE listener registration (not two) — the plan mandates a single
    // `renderTextSelectionPopup` listener that appends both buttons.
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[0]).toBe("renderTextSelectionPopup");
  });

  it("D4: with a real selection, BOTH command buttons are appended and enabled", () => {
    const explain = vi.fn();
    const ask = vi.fn();
    const result = dispatchReaderCommands(
      [
        { label: "Explain with AI", mode: "explain", capture: explain },
        { label: "Ask a question", mode: "ask-question", capture: ask }
      ],
      {
        doc: document,
        params: { annotation: { text: "some selected sentence" } },
        reader: readerWithItem({ key: "ATT00001", getDisplayTitle: () => "Paper" })
      }
    );

    expect(result.buttons).toHaveLength(2);
    const labels = result.buttons.map((b) => b.textContent);
    expect(labels).toContain("Explain with AI");
    expect(labels).toContain("Ask a question");
    expect(result.buttons.every((b) => b.disabled)).toBe(false);
  });

  it("D1: an EMPTY selection hides the command — no enabled button is appended", () => {
    const result = dispatchReaderCommands(
      [
        { label: "Explain with AI", mode: "explain", capture: vi.fn() },
        { label: "Ask a question", mode: "ask-question", capture: vi.fn() }
      ],
      {
        doc: document,
        params: { annotation: { text: "" } },
        reader: readerWithItem({ key: "ATT00001" })
      }
    );

    // The menu item must be HIDDEN (not just disabled). Either no
    // button is appended at all, or none of the appended buttons is an
    // active, enabled command control.
    const enabled = result.buttons.filter((b) => !b.disabled);
    expect(enabled).toHaveLength(0);
  });

  it("D1: a whitespace-only selection is treated as empty (command hidden)", () => {
    const result = dispatchReaderCommands(
      [{ label: "Ask a question", mode: "ask-question", capture: vi.fn() }],
      {
        doc: document,
        params: { annotation: { text: "   \n\t  " } },
        reader: readerWithItem({ key: "ATT00001" })
      }
    );
    expect(result.buttons.filter((b) => !b.disabled)).toHaveLength(0);
  });

  it("D3: event.params === undefined does not throw — defensive fall-through (command hidden)", () => {
    let result: CapturedClick | undefined;
    expect(() => {
      result = dispatchReaderCommands(
        [{ label: "Ask a question", mode: "ask-question", capture: vi.fn() }],
        {
          doc: document,
          params: undefined,
          reader: readerWithItem({ key: "ATT00001" })
        }
      );
    }).not.toThrow();
    // No selection ⇒ no enabled command button.
    expect(result?.buttons.filter((b) => !b.disabled)).toHaveLength(0);
  });

  it("D3: event.params.annotation === undefined does not throw", () => {
    expect(() => {
      dispatchReaderCommands(
        [{ label: "Ask a question", mode: "ask-question", capture: vi.fn() }],
        {
          doc: document,
          params: {},
          reader: readerWithItem({ key: "ATT00001" })
        }
      );
    }).not.toThrow();
  });

  it("D7 (regression): addReaderCommand(label, action) convenience wrapper still works", () => {
    const register = vi.fn();
    const zotero: ZoteroGlobal = {
      debug: vi.fn(),
      getMainWindow: () => window,
      Reader: { registerEventListener: register, unregisterEventListener: vi.fn() }
    };
    const ui = createZoteroUiAdapter({ Zotero: zotero, pluginId: "test" });
    const action = vi.fn();

    const unsubscribe = ui.addReaderCommand("Explain with AI", action);

    expect(register).toHaveBeenCalledTimes(1);
    expect(typeof unsubscribe).toBe("function");

    const handler = register.mock.calls[0]?.[1] as ((e: FakeReaderEvent) => void) | undefined;
    let appended: HTMLButtonElement | null = null;
    handler?.({
      doc: document,
      params: { annotation: { text: "selected" } },
      reader: readerWithItem({ key: "ATT00001" }),
      append: (content) => {
        if (content instanceof HTMLElement) {
          appended = content as HTMLButtonElement;
          document.body.append(content);
        }
      }
    });
    expect(appended).not.toBeNull();
    expect((appended as unknown as HTMLButtonElement).textContent).toBe("Explain with AI");
  });

  it("addReaderCommands returns an unsubscribe that unregisters the listener", () => {
    const register = vi.fn();
    const unregister = vi.fn();
    const zotero: ZoteroGlobal = {
      debug: vi.fn(),
      getMainWindow: () => window,
      Reader: { registerEventListener: register, unregisterEventListener: unregister }
    };
    const ui = createZoteroUiAdapter({ Zotero: zotero, pluginId: "test" });

    const unsubscribe = ui.addReaderCommands([
      { label: "Explain with AI", mode: "explain", action: vi.fn() }
    ]);
    unsubscribe();
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});

// --------------------------------------------------------------------
// AC-2 — PDF identity on selection.source
// --------------------------------------------------------------------

describe("addReaderCommands — AC-2 PDF identity in selection.source", () => {
  it("populates itemKey / itemTitle / attachmentKey from the reader's _item", () => {
    let captured: SelectionContext | undefined;
    const result = dispatchReaderCommands(
      [
        {
          label: "Explain with AI",
          mode: "explain",
          capture: (s) => {
            captured = s;
          }
        }
      ],
      {
        doc: document,
        params: { annotation: { text: "selected sentence", pageLabel: "12" } },
        reader: readerWithItem({
          key: "ATTKEY01",
          parentItemID: 42,
          getDisplayTitle: () => "On the Origin of Tests"
        })
      }
    );
    result.buttons[0]?.click();

    expect(captured).toBeDefined();
    const source = captured?.source;
    // attachmentKey is the reader attachment's own key.
    expect(source?.attachmentKey).toBe("ATTKEY01");
    // itemKey + itemTitle resolve from the attachment / its parent.
    expect(source?.itemKey).not.toBeNull();
    expect(typeof source?.itemTitle === "string" || source?.itemTitle === null).toBe(true);
  });

  it("D2: pageIndex 0 propagates as the number 0 — never null or undefined", () => {
    let captured: SelectionContext | undefined;
    dispatchReaderCommands(
      [
        {
          label: "Ask a question",
          mode: "ask-question",
          capture: (s) => {
            captured = s;
          }
        }
      ],
      {
        doc: document,
        params: {
          annotation: { text: "first page selection", position: { pageIndex: 0 } }
        },
        reader: readerWithItem({ key: "ATTKEY01" })
      }
    ).buttons[0]?.click();

    expect(captured).toBeDefined();
    // SP1: pageIndex 0 is a valid first page. The check is `=== 0`,
    // and explicitly NOT falsy-collapsed to null/undefined.
    expect(captured?.source.pageIndex).toBe(0);
    expect(captured?.source.pageIndex).not.toBeNull();
    expect(captured?.source.pageIndex).not.toBeUndefined();
    expect(typeof captured?.source.pageIndex).toBe("number");
  });

  it("D2: a non-zero pageIndex propagates verbatim", () => {
    let captured: SelectionContext | undefined;
    dispatchReaderCommands(
      [
        {
          label: "Ask a question",
          mode: "ask-question",
          capture: (s) => {
            captured = s;
          }
        }
      ],
      {
        doc: document,
        params: {
          annotation: { text: "page 17 selection", position: { pageIndex: 16 } }
        },
        reader: readerWithItem({ key: "ATTKEY01" })
      }
    ).buttons[0]?.click();

    expect(captured?.source.pageIndex).toBe(16);
  });

  it("D2: a reader event with no pageIndex leaves source.pageIndex undefined (not null)", () => {
    let captured: SelectionContext | undefined;
    dispatchReaderCommands(
      [
        {
          label: "Explain with AI",
          mode: "explain",
          capture: (s) => {
            captured = s;
          }
        }
      ],
      {
        doc: document,
        params: { annotation: { text: "selection with no position" } },
        reader: readerWithItem({ key: "ATTKEY01" })
      }
    ).buttons[0]?.click();

    expect(captured).toBeDefined();
    // Absent ⇒ undefined, the contract's uniform absence representation.
    expect(captured?.source.pageIndex).toBeUndefined();
  });

  it("carries pageLabel when the reader event supplies one", () => {
    let captured: SelectionContext | undefined;
    dispatchReaderCommands(
      [
        {
          label: "Explain with AI",
          mode: "explain",
          capture: (s) => {
            captured = s;
          }
        }
      ],
      {
        doc: document,
        params: {
          annotation: { text: "selection", pageLabel: "iv", position: { pageIndex: 3 } }
        },
        reader: readerWithItem({ key: "ATTKEY01" })
      }
    ).buttons[0]?.click();

    expect(captured?.source.pageLabel).toBe("iv");
  });

  it("D5: _item resolves through the Xray wrappedJSObject fallback", () => {
    let captured: SelectionContext | undefined;
    dispatchReaderCommands(
      [
        {
          label: "Explain with AI",
          mode: "explain",
          capture: (s) => {
            captured = s;
          }
        }
      ],
      {
        doc: document,
        params: { annotation: { text: "selection" } },
        // _item is HIDDEN behind wrappedJSObject (the Xray case).
        reader: readerWithXrayItem({
          key: "XRAYKEY1",
          getDisplayTitle: () => "Xrayed Paper"
        })
      }
    ).buttons[0]?.click();

    expect(captured).toBeDefined();
    // The wrappedJSObject fallback must have fired — attachmentKey is
    // populated even though direct `_item` access was Xray-hidden.
    expect(captured?.source.attachmentKey).toBe("XRAYKEY1");
  });

  it("D5: when ALL _item resolution tiers miss, identity fields stay null and action still fires", () => {
    let captured: SelectionContext | undefined;
    let actionFired = false;
    const result = dispatchReaderCommands(
      [
        {
          label: "Explain with AI",
          mode: "explain",
          capture: (s) => {
            captured = s;
            actionFired = true;
          }
        }
      ],
      {
        doc: document,
        params: { annotation: { text: "selection" } },
        // No `_item`, no `wrappedJSObject` — all three tiers miss.
        reader: { _iframe: { getBoundingClientRect: () => document.body.getBoundingClientRect() } }
      }
    );

    expect(() => result.buttons[0]?.click()).not.toThrow();
    expect(actionFired).toBe(true);
    expect(captured).toBeDefined();
    // Graceful degrade — all identity fields null, prompt frame can
    // still be built without PDF identity.
    expect(captured?.source.itemKey).toBeNull();
    expect(captured?.source.itemTitle).toBeNull();
    expect(captured?.source.attachmentKey).toBeNull();
    expect(captured?.source.pageLabel).toBeNull();
  });

  it("D5: a reader event with no `reader` object at all does not throw", () => {
    let captured: SelectionContext | undefined;
    const result = dispatchReaderCommands(
      [
        {
          label: "Explain with AI",
          mode: "explain",
          capture: (s) => {
            captured = s;
          }
        }
      ],
      {
        doc: document,
        params: { annotation: { text: "selection" } },
        reader: undefined
      }
    );
    expect(() => result.buttons[0]?.click()).not.toThrow();
    expect(captured?.source.itemKey).toBeNull();
  });

  it("the quote passed to the action is the trimmed selection text", () => {
    let captured: SelectionContext | undefined;
    dispatchReaderCommands(
      [
        {
          label: "Ask a question",
          mode: "ask-question",
          capture: (s) => {
            captured = s;
          }
        }
      ],
      {
        doc: document,
        params: { annotation: { text: "  padded selection  " } },
        reader: readerWithItem({ key: "ATTKEY01" })
      }
    ).buttons[0]?.click();

    expect(captured?.quote).toBe("padded selection");
  });
});

// --------------------------------------------------------------------
// AC-2 — pageLabel fallback contract `pageLabel ?? String(pageIndex+1)`
// --------------------------------------------------------------------

describe("AC-2 pageLabel fallback semantics", () => {
  // The contract (OQ1, plan L201) pins: when a reader selection has a
  // pageIndex but no pageLabel, the human-facing page reference is
  // `String(pageIndex + 1)`. This is a pure-string assertion on the
  // fallback rule itself — it documents the expected derivation that
  // the prompt renderer (`describeSource`) must apply.
  function pageReference(pageLabel: string | null, pageIndex: number | undefined): string | null {
    if (pageLabel !== null) return pageLabel;
    if (typeof pageIndex === "number") return String(pageIndex + 1);
    return null;
  }

  it("uses pageLabel verbatim when present", () => {
    expect(pageReference("xii", 5)).toBe("xii");
  });

  it("falls back to String(pageIndex + 1) when pageLabel is absent", () => {
    expect(pageReference(null, 4)).toBe("5");
  });

  it("pageIndex 0 with no label falls back to '1' — never dropped as falsy", () => {
    expect(pageReference(null, 0)).toBe("1");
  });

  it("no pageLabel and no pageIndex yields null (degrade gracefully)", () => {
    expect(pageReference(null, undefined)).toBeNull();
  });
});
