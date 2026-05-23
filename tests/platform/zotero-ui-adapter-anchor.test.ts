/* @vitest-environment jsdom */

/*
 * ============================================================================
 * Fault Localization (AC1: iframe-offset fix in addReaderCommand)
 * ============================================================================
 *
 * Spec semantics (from docs/superpowers/plans/2026-05-17-real-product-pipeline.md):
 *
 *   The `renderTextSelectionPopup` click handler registered by
 *   `addReaderCommand` MUST construct `SelectionContext.anchor` whose
 *   `left`/`top` are in CHROME-WINDOW coordinates, by adding
 *   `event.reader._iframe.getBoundingClientRect()` (the reader's chrome-side
 *   XUL <browser> rect; see xpcom/reader.js:1244-1247 for the same pattern in
 *   Zotero core) to the button's iframe-local `getBoundingClientRect()`.
 *   Viewport dimensions come from `input.Zotero.getMainWindow().innerWidth/
 *   innerHeight` — NOT the iframe view. If `getMainWindow()` returns
 *   null/undefined OR `event.reader._iframe` is missing, the handler MUST
 *   bail out by calling `action({...selection, anchor: null})` (FINDING-3
 *   removed the `rect.left + rect.width` fallback). Empty
 *   `event.params.annotation.text` MUST still mount the popup with
 *   `quote: ""` (FINDING-11).
 *
 * Code path under test (from Investigation Certificate L76):
 *
 *   1. `addReaderCommand(label, action)` calls
 *      `Zotero.Reader.registerEventListener('renderTextSelectionPopup',
 *      handler, pluginID)`.
 *   2. Production: when text is selected, Zotero dispatches a
 *      `renderTextSelectionPopup` event whose `doc` is the reader IFRAME
 *      document, whose `append` injects into the iframe's selection popup
 *      container, and whose `reader` is the ReaderInstance attached by
 *      Zotero's customEvent bridge (xpcom/reader.js:184). The chrome-window
 *      offset comes from `event.reader._iframe.getBoundingClientRect()` —
 *      the HTML `event.doc.defaultView.frameElement` returns null because
 *      the reader iframe is a chrome XUL <browser>, not an HTML <iframe>.
 *   3. Handler creates a `<button>` via `event.doc.createElement('button')`
 *      and calls `event.append(button)`.
 *   4. On `button.click()`, the handler reads `button.getBoundingClientRect()`
 *      (iframe-local), the frame offset, and constructs `SelectionAnchor`.
 *   5. Handler invokes `action(selection)` synchronously with the
 *      constructed `SelectionContext`.
 *
 * Divergence analysis (where the implementation could fail to satisfy
 * the spec):
 *
 *   D1: HIGHEST RISK — the historical bug: handler omits the
 *       `event.reader._iframe.getBoundingClientRect()` offset, so
 *       `anchor.left/top` are iframe-local. Manifests when frame offset != 0.
 *   D2: HIGH — handler uses `event.doc.defaultView.innerWidth/innerHeight`
 *       (iframe view) for viewport instead of `mainWindow.innerWidth/Height`.
 *       Manifests when iframe and chrome viewports differ.
 *   D3: HIGH — handler does NOT bail out (i.e., still produces a non-null
 *       anchor) when `getMainWindow()` returns null. Per FINDING-3, the
 *       removed `rect.left + rect.width` fallback would produce a nonsense
 *       viewport that clamps to `left=8`. A regression would re-introduce
 *       any of those fallbacks.
 *   D4: MEDIUM — empty `event.params.annotation.text` causes the handler
 *       to early-return WITHOUT calling `action()`, breaking the popup
 *       mount flow for empty-quote (per FINDING-11 the handler MUST still
 *       call `action()` with `quote: ""`).
 *   D5: MEDIUM — handler throws OR fabricates an anchor when
 *       `event.reader._iframe` is missing. Per the fail-closed contract,
 *       the handler MUST bail out with `anchor: null` (same path as the
 *       no-mainWindow bail-out), so downstream code reliably observes a
 *       single failure mode for "chrome geometry unavailable."
 *   D6: LOW — handler invokes `action()` more than once, or asynchronously,
 *       breaking the synchronous contract `runtime.startExplain` depends on.
 *
 * Test targets (ranked by failure likelihood) — each gets one or more
 * tests below:
 *
 *   - D1 → "Happy path", "Frame at origin", "Large iframe offset"
 *   - D2 → "Viewport plumbed from mainWindow, not iframe"
 *   - D3 → "No mainWindow → anchor === null (bail-out)"
 *   - D4 → "Empty annotation text still mounts the popup"
 *   - D5 → "No reader._iframe → anchor === null (fail-closed)"
 *   - D6 → "action() called exactly once and synchronously"
 *
 * Blindness statement: this file does not read
 * `src/platform/zotero-ui-adapter.ts` after the AC1 spec was finalized.
 * Tests are derived from the AC1 interface contract in the plan (L906-941)
 * and from the existing public `ZoteroGlobal` / `ZoteroUiAdapter` types
 * defined in `src/platform/zotero-ui-adapter.ts` (public re-exports) and
 * `src/platform/zotero-ui-types.ts`. The `createZoteroUiAdapter` mocking
 * pattern follows the in-repo style at
 * `tests/platform/zotero-ui-adapter.test.ts`.
 * ============================================================================
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createZoteroUiAdapter, type ZoteroGlobal } from "../../src/platform/zotero-ui-adapter.js";
import type { SelectionContext } from "../../src/selection/selection-context.js";

type ReaderEventLike = {
  readonly doc: Document;
  readonly params?: { readonly annotation?: { readonly text?: string } };
  readonly reader?: { readonly _iframe?: { getBoundingClientRect(): DOMRect } };
  append(content: HTMLElement | { readonly label: string; readonly onCommand: () => void }): void;
};

type ReaderHandler = (event: ReaderEventLike) => void;

type AnchorRect = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

type CaptureResult = {
  readonly action: ReturnType<typeof vi.fn>;
  readonly handler: ReaderHandler;
  readonly registerEventListener: ReturnType<typeof vi.fn>;
};

/**
 * Build a ZoteroGlobal-like object suitable for createZoteroUiAdapter.
 * Returns the global plus the captured handler after addReaderCommand
 * registers it. `mainWindow` may be `null` to exercise the bail-out path.
 */
function setupAdapter(input: {
  mainWindow:
    | (Window & typeof globalThis)
    | { readonly innerWidth: number; readonly innerHeight: number }
    | null
    | undefined;
}): CaptureResult {
  const registerEventListener = vi.fn();
  const unregisterEventListener = vi.fn();
  const reader = {
    registerEventListener,
    unregisterEventListener
  };
  const getMainWindow = (): Window & typeof globalThis => {
    // Cast through unknown for the bail-out (null/undefined) cases — the
    // production type signature is non-null but the spec requires the
    // handler to defensively handle `null`/`undefined`.
    return input.mainWindow as unknown as Window & typeof globalThis;
  };
  const zotero: ZoteroGlobal = {
    debug: vi.fn(),
    getMainWindow,
    Reader: reader
  };
  const ui = createZoteroUiAdapter({ Zotero: zotero, pluginId: "test-anchor" });
  const action = vi.fn();
  ui.addReaderCommand("Explain with AI", action);
  const captured = registerEventListener.mock.calls[0]?.[1] as ReaderHandler | undefined;
  if (typeof captured !== "function") {
    throw new Error("addReaderCommand did not register an event listener handler");
  }
  return { action, handler: captured, registerEventListener };
}

/**
 * Build a fake reader event. The button created via `event.doc.createElement`
 * gets a stubbed `getBoundingClientRect` returning `buttonRect`. The
 * `event.reader._iframe.getBoundingClientRect()` returns `frameRect` — or
 * `event.reader` is omitted entirely when `frameRect === null` to exercise
 * the fail-closed bail-out path.
 *
 * A real jsdom iframe document is used for `event.doc` so the production
 * handler's `event.doc.createElement('button')` and
 * `event.doc.defaultView.setTimeout(...)` calls land on real DOM. The
 * chrome-offset is plumbed via `event.reader._iframe`, NOT via
 * `defaultView.frameElement` — the reader iframe is a chrome XUL <browser>
 * (xpcom/reader.js:1812) and HTML `frameElement` returns null on it.
 */
function buildReaderEvent(input: {
  readonly buttonRect: AnchorRect;
  readonly frameRect: AnchorRect | null;
  readonly annotationText?: string;
}): {
  readonly event: ReaderEventLike;
  readonly getAppendedButton: () => HTMLButtonElement;
  readonly cleanup: () => void;
} {
  const iframeEl = document.createElement("iframe");
  document.body.append(iframeEl);
  const iframeDoc = iframeEl.contentDocument;
  if (iframeDoc === null) {
    throw new Error("iframe.contentDocument is null; jsdom did not produce an iframe document");
  }
  let appendedButton: HTMLButtonElement | null = null;

  const frameRect = input.frameRect;
  const buttonRect = input.buttonRect;

  const makeDomRect = (r: AnchorRect): DOMRect => ({
    left: r.left,
    top: r.top,
    right: r.left + r.width,
    bottom: r.top + r.height,
    width: r.width,
    height: r.height,
    x: r.left,
    y: r.top,
    toJSON: () => ({})
  });

  const readerField: Pick<ReaderEventLike, "reader"> =
    frameRect === null
      ? {}
      : {
          reader: {
            _iframe: {
              getBoundingClientRect: () => makeDomRect(frameRect)
            }
          }
        };

  const event: ReaderEventLike = {
    doc: iframeDoc,
    params: {
      annotation: { text: input.annotationText ?? "selected quote" }
    },
    ...readerField,
    append: (content) => {
      // Note: `content instanceof HTMLElement` is unreliable here
      // because the button is created by the production handler via
      // `event.doc.createElement('button')` — the iframe document's
      // `HTMLElement` constructor is distinct from the test's main-window
      // `HTMLElement`. We instead detect "DOM node" by duck-typing
      // `nodeType === 1` (Node.ELEMENT_NODE) and `tagName`.
      const maybeElement = content as Partial<HTMLElement> & {
        readonly nodeType?: number;
      };
      if (maybeElement.nodeType === 1 && typeof maybeElement.tagName === "string") {
        const buttonEl = content as HTMLButtonElement;
        // Patch the button's getBoundingClientRect to return the
        // controlled iframe-local rect. We do this in `append` (rather
        // than monkey-patching `Document.createElement`, which is
        // deprecated in lib.dom).
        Object.defineProperty(buttonEl, "getBoundingClientRect", {
          configurable: true,
          value: () => makeDomRect(buttonRect)
        });
        appendedButton = buttonEl;
        iframeDoc.body.append(buttonEl);
      }
      // Menu-like content (shouldn't happen for reader command) is ignored.
    }
  };

  return {
    event,
    getAppendedButton: () => {
      if (appendedButton === null) {
        throw new Error("event.append was never called with an HTMLElement button");
      }
      return appendedButton;
    },
    cleanup: () => {
      iframeEl.remove();
    }
  };
}

function readSelection(action: ReturnType<typeof vi.fn>): SelectionContext {
  expect(action).toHaveBeenCalledTimes(1);
  const arg = action.mock.calls[0]?.[0] as SelectionContext | undefined;
  if (arg === undefined) {
    throw new Error("action was not invoked with a selection argument");
  }
  return arg;
}

describe("addReaderCommand: anchor coordinate construction (AC1)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("happy path: adds iframe frameRect offset to button rect (chrome (200, 100) + button (50, 30))", () => {
    const { action, handler } = setupAdapter({
      mainWindow: { innerWidth: 1400, innerHeight: 900 }
    });
    const { event, getAppendedButton } = buildReaderEvent({
      buttonRect: { left: 50, top: 30, width: 120, height: 24 },
      frameRect: { left: 200, top: 100, width: 1000, height: 700 }
    });

    handler(event);
    getAppendedButton().click();

    const selection = readSelection(action);
    expect(selection.anchor).not.toBeNull();
    expect(selection.anchor?.left).toBe(250);
    expect(selection.anchor?.top).toBe(130);
    expect(selection.anchor?.width).toBe(120);
    expect(selection.anchor?.height).toBe(24);
  });

  it("frame at origin (0, 0): anchor uses raw button rect (no double-add)", () => {
    const { action, handler } = setupAdapter({
      mainWindow: { innerWidth: 1200, innerHeight: 800 }
    });
    const { event, getAppendedButton } = buildReaderEvent({
      buttonRect: { left: 50, top: 30, width: 80, height: 24 },
      frameRect: { left: 0, top: 0, width: 1200, height: 800 }
    });

    handler(event);
    getAppendedButton().click();

    const selection = readSelection(action);
    expect(selection.anchor?.left).toBe(50);
    expect(selection.anchor?.top).toBe(30);
  });

  it("large iframe offset (chrome (500, 300) + button (100, 50)) → anchor (600, 350)", () => {
    const { action, handler } = setupAdapter({
      mainWindow: { innerWidth: 1600, innerHeight: 1000 }
    });
    const { event, getAppendedButton } = buildReaderEvent({
      buttonRect: { left: 100, top: 50, width: 96, height: 28 },
      frameRect: { left: 500, top: 300, width: 1000, height: 600 }
    });

    handler(event);
    getAppendedButton().click();

    const selection = readSelection(action);
    expect(selection.anchor?.left).toBe(600);
    expect(selection.anchor?.top).toBe(350);
    expect(selection.anchor?.width).toBe(96);
    expect(selection.anchor?.height).toBe(28);
  });

  it("no reader._iframe → anchor === null (fail-closed, codex review redo)", () => {
    // The original AC1 fix used `event.doc.defaultView.frameElement` and
    // fell back to `{0, 0}` when null. Codex's Phase 4 review found that
    // path returns null in production (Zotero's reader iframe is a chrome
    // XUL <browser>, not an HTML <iframe>), so the fix was non-functional.
    // The corrected contract uses `event.reader._iframe` and FAILS CLOSED:
    // if the reader instance or its `_iframe` is missing, the handler MUST
    // call `action()` with `anchor: null`. Same failure mode as the
    // no-mainWindow bail-out so downstream code observes one path for
    // "chrome geometry unavailable."
    const { action, handler } = setupAdapter({
      mainWindow: { innerWidth: 1200, innerHeight: 800 }
    });
    const { event, getAppendedButton } = buildReaderEvent({
      buttonRect: { left: 50, top: 30, width: 80, height: 24 },
      frameRect: null
    });

    handler(event);
    expect(() => {
      getAppendedButton().click();
    }).not.toThrow();

    const selection = readSelection(action);
    expect(selection.anchor).toBeNull();
  });

  it("bail-out: no mainWindow → anchor === null (FINDING-3, no rect.left+width fallback)", () => {
    // Per plan L283-287, L920-927: when `input.Zotero.getMainWindow()`
    // returns null/undefined, the handler MUST call `action()` with
    // `anchor: null`. The previous `rect.left + rect.width` fallback is
    // forbidden and MUST NOT be re-introduced.
    const { action, handler } = setupAdapter({ mainWindow: null });
    const { event, getAppendedButton } = buildReaderEvent({
      buttonRect: { left: 50, top: 30, width: 80, height: 24 },
      frameRect: { left: 200, top: 100, width: 1000, height: 700 }
    });

    handler(event);
    expect(() => {
      getAppendedButton().click();
    }).not.toThrow();

    const selection = readSelection(action);
    expect(selection.anchor).toBeNull();
  });

  it("bail-out: mainWindow undefined → anchor === null (no throw)", () => {
    // Defensive: `getMainWindow?.()` may return `undefined`. The spec's
    // bail-out covers both null and undefined.
    const { action, handler } = setupAdapter({ mainWindow: undefined });
    const { event, getAppendedButton } = buildReaderEvent({
      buttonRect: { left: 50, top: 30, width: 80, height: 24 },
      frameRect: { left: 200, top: 100, width: 1000, height: 700 }
    });

    handler(event);
    expect(() => {
      getAppendedButton().click();
    }).not.toThrow();

    const selection = readSelection(action);
    expect(selection.anchor).toBeNull();
  });

  it("viewport: plumbed from mainWindow.innerWidth/innerHeight (not iframe view)", () => {
    // Per plan L280-282, L933-934: viewport comes from mainWindow, NOT
    // event.doc.defaultView. Stub the iframe view's dimensions to a
    // distinguishable value, then assert the anchor carries the mainWindow's.
    const { action, handler } = setupAdapter({
      mainWindow: { innerWidth: 1200, innerHeight: 800 }
    });
    const { event, getAppendedButton } = buildReaderEvent({
      buttonRect: { left: 10, top: 20, width: 60, height: 24 },
      frameRect: { left: 100, top: 50, width: 800, height: 600 }
    });
    // Make the iframe view's innerWidth/innerHeight differ from the
    // mainWindow's — if the handler incorrectly reads from the iframe view
    // we will see 800x600 instead of 1200x800.
    const iframeView = event.doc.defaultView;
    if (iframeView === null) {
      throw new Error("iframe defaultView is null; cannot set viewport overrides");
    }
    Object.defineProperty(iframeView, "innerWidth", {
      configurable: true,
      get: () => 800
    });
    Object.defineProperty(iframeView, "innerHeight", {
      configurable: true,
      get: () => 600
    });

    handler(event);
    getAppendedButton().click();

    const selection = readSelection(action);
    expect(selection.anchor?.viewportWidth).toBe(1200);
    expect(selection.anchor?.viewportHeight).toBe(800);
    // Adversarial: explicit assertion that we are NOT using the legacy
    // `rect.left + rect.width` fallback (which would yield 70 for
    // viewportWidth here — 10 + 60).
    expect(selection.anchor?.viewportWidth).not.toBe(70);
  });

  it("empty annotation text: the command is hidden — no button is appended (AC-1)", () => {
    // The v0.3.0 pdf-context-features plan (AC-1, adversarial case L404)
    // supersedes the old FINDING-11 "mount with quote=''" behavior: an
    // empty / whitespace-only reader selection HIDES the command — no
    // command button is appended at all.
    const { action, handler } = setupAdapter({
      mainWindow: { innerWidth: 1400, innerHeight: 900 }
    });
    const { event } = buildReaderEvent({
      buttonRect: { left: 50, top: 30, width: 120, height: 24 },
      frameRect: { left: 200, top: 100, width: 1000, height: 700 },
      annotationText: "   "
    });

    expect(() => {
      handler(event);
    }).not.toThrow();
    // No button was appended ⇒ the command is hidden, and the action is
    // never invoked because there is nothing to click.
    expect(action).not.toHaveBeenCalled();
  });

  it("action() is invoked exactly once and synchronously on click", () => {
    // Per plan SP3 (L122): `_dispatchEvent` invokes handlers synchronously.
    // The downstream `startExplain` pipeline depends on a single
    // synchronous invocation per click.
    const { action, handler } = setupAdapter({
      mainWindow: { innerWidth: 1200, innerHeight: 800 }
    });
    const { event, getAppendedButton } = buildReaderEvent({
      buttonRect: { left: 50, top: 30, width: 80, height: 24 },
      frameRect: { left: 100, top: 50, width: 1000, height: 700 }
    });

    handler(event);
    expect(action).toHaveBeenCalledTimes(0);
    getAppendedButton().click();
    // Synchronous: we did not await anything between click and assertion.
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("preserves AC7 button feedback regardless of anchor path (button disables after click)", () => {
    // Per plan L289-291: AC7 click-feedback (immediate disable + label
    // swap) MUST remain intact. This is here to catch a regression where
    // the anchor-construction refactor accidentally removes the disable.
    const { action, handler } = setupAdapter({
      mainWindow: { innerWidth: 1200, innerHeight: 800 }
    });
    const { event, getAppendedButton } = buildReaderEvent({
      buttonRect: { left: 50, top: 30, width: 80, height: 24 },
      frameRect: { left: 100, top: 50, width: 1000, height: 700 }
    });

    handler(event);
    const button = getAppendedButton();
    expect(button.disabled).toBe(false);
    button.click();
    expect(button.disabled).toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
  });
});
