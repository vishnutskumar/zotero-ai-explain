import type { SelectionAnchor, SelectionContext } from "../selection/selection-context.js";
import type {
  DialogHandle,
  PopupMountOptions,
  ReaderCommandSpec,
  Unsubscribe,
  ZoteroUiAdapter
} from "./zotero-ui-types.js";

/**
 * Narrow shape of a Zotero reader `_item` (the attachment the reader was
 * opened for). PDF child attachments carry a `parentItem`; standalone PDF
 * attachments do not. Underscore-free public API only, so it survives the
 * Xray wrapper when accessed through `wrappedJSObject`.
 */
type ReaderItem = {
  readonly key?: string;
  readonly parentItem?: {
    readonly key?: string;
    getDisplayTitle?(): string;
  } | null;
  getDisplayTitle?(): string;
};

type ReaderEvent = {
  readonly doc: Document;
  readonly params?: {
    readonly annotation?: {
      readonly text?: string;
      readonly pageLabel?: string;
      readonly position?: { readonly pageIndex?: number };
    };
  };
  // Reader instance attached by Zotero's customEvent bridge (xpcom/reader.js:184).
  // `_iframe` is the chrome-side XUL <browser> element hosting the reader iframe;
  // its bounding rect maps reader-iframe-local coords to chrome-window coords.
  // `_item` is the attachment item the reader was opened for.
  readonly reader?: {
    readonly _iframe?: { getBoundingClientRect(): DOMRect };
    readonly _item?: ReaderItem;
  };
  append(content: HTMLElement | { readonly label: string; readonly onCommand: () => void }): void;
};

export type ZoteroGlobal = {
  readonly initializationPromise?: Promise<void>;
  readonly uiReadyPromise?: Promise<void>;
  readonly MenuManager?: {
    unregisterMenu(id: string): void;
  };
  readonly Reader?: {
    registerEventListener(
      type: string,
      handler: (event: ReaderEvent) => void,
      pluginID: string
    ): void;
    unregisterEventListener(type: string, handler: (event: ReaderEvent) => void): void;
  };
  debug(message: string): void;
  getMainWindow?(): Window & typeof globalThis;
};

function noOp(): void {
  return undefined;
}

/**
 * Design tokens used by every plugin surface. Values come from a live
 * Zotero 9 token dump (.forge/phases/zotero-e2e-harness/zotero9-tokens.json);
 * tokens that do not exist in Zotero 9 are replaced by CSS system colors
 * (Canvas / CanvasText / GrayText / ButtonFace / ButtonBorder / Highlight /
 * HighlightText) so the surface still adapts to the OS theme on builds that
 * lack the token. We never fall back to `white` or `black`.
 */
const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
const SURFACE_BG = "var(--material-background, Canvas)";
const TOOLBAR_BG = "var(--material-toolbar, ButtonFace)";
const SIDEPANE_BG = "var(--material-sidepane, Canvas)";
const FG = "var(--fill-primary, CanvasText)";
const BORDER_HAIRLINE = "var(--fill-quarternary, ButtonBorder)";
const ACCENT = "var(--accent-blue, Highlight)";

const DIALOG_BACKDROP_STYLE =
  "position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 999998;";
const DIALOG_CONTENT_STYLE =
  "position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); " +
  "z-index: 999999; max-width: 480px; min-width: 360px; " +
  `background: ${SURFACE_BG}; color: ${FG}; font-family: ${FONT_STACK}; ` +
  "font-size: 13px; line-height: 1.45; border-radius: 6px; " +
  `border: 1px solid ${BORDER_HAIRLINE}; ` +
  "max-height: 80vh; overflow: hidden; box-shadow: 0 16px 48px rgba(0,0,0,0.45); " +
  "display: flex; flex-direction: column;";
const DIALOG_HEADER_STYLE =
  `display: flex; align-items: center; justify-content: space-between; ` +
  `padding: 10px 12px 10px 16px; background: ${TOOLBAR_BG}; ` +
  `border-bottom: 1px solid ${BORDER_HAIRLINE};`;
const DIALOG_TITLE_STYLE = `margin: 0; font-size: 14px; font-weight: 600; color: ${FG};`;
const DIALOG_CLOSE_STYLE =
  `appearance: none; border: 1px solid transparent; background: transparent; color: ${FG}; ` +
  "width: 24px; height: 24px; padding: 0; border-radius: 4px; cursor: pointer; " +
  "font-size: 16px; line-height: 1; display: inline-flex; align-items: center; justify-content: center;";
const DIALOG_BODY_STYLE = "padding: 16px; overflow: auto; flex: 1 1 auto;";

/**
 * Base popup wrapper style. When an anchor is provided, the wrapper's
 * `top`/`left`/`transform` are recomputed in {@link computePopupPosition}.
 * Otherwise we fall back to the legacy top-center position.
 *
 * The wrapper is the bounded scroll container: `max-height: 60vh` caps the
 * rendered box and `overflow-y: auto` makes content beyond the cap scroll
 * *within the wrapper* rather than growing the popup unboundedly. The
 * `__header` row is `position: sticky` (see {@link POPUP_HEADER_STYLE}) so
 * the close/drag affordance stays pinned while the body scrolls. The body
 * wrapper keeps its intrinsic height (`flex: 0 0 auto`) so a long response
 * pushes the wrapper's `scrollHeight` past its clamped `clientHeight` — if
 * the body were `flex: 1 1 auto` the flex algorithm would shrink it to fit
 * the wrapper and the wrapper would never report overflow.
 */
const POPUP_WRAPPER_BASE_STYLE =
  "position: fixed; z-index: 999999; max-width: 480px; min-width: 320px; " +
  `background: ${SURFACE_BG}; color: ${FG}; font-family: ${FONT_STACK}; ` +
  `font-size: 13px; line-height: 1.45; border-radius: 6px; ` +
  `border: 1px solid ${BORDER_HAIRLINE}; ` +
  "box-shadow: 0 12px 32px rgba(0,0,0,0.35); max-height: 60vh; overflow-y: auto; " +
  "display: flex; flex-direction: column;";
const POPUP_HEADER_STYLE =
  `display: flex; align-items: center; justify-content: flex-end; ` +
  `padding: 4px 6px 0 6px; cursor: move; user-select: none; ` +
  // Pin the close/drag row to the top of the scrolling wrapper so it stays
  // reachable while a long response scrolls underneath it.
  `position: sticky; top: 0; z-index: 1; background: ${SURFACE_BG};`;
const POPUP_CLOSE_STYLE =
  `appearance: none; border: 1px solid transparent; background: transparent; color: ${FG}; ` +
  "width: 22px; height: 22px; padding: 0; border-radius: 4px; cursor: pointer; " +
  "font-size: 16px; line-height: 1; display: inline-flex; align-items: center; justify-content: center;";
const POPUP_BODY_WRAPPER_STYLE = "padding: 0 14px 12px 14px; overflow-y: auto; flex: 0 0 auto;";
/** Fallback used when no anchor is supplied. */
const POPUP_FALLBACK_POSITION_STYLE = "top: 80px; left: 50%; transform: translateX(-50%);";

const POPUP_MAX_WIDTH = 480;
const POPUP_MIN_WIDTH = 320;
const POPUP_ESTIMATED_HEIGHT = 240;
const POPUP_VIEWPORT_MARGIN = 8;
const POPUP_ANCHOR_GAP = 8;

type Coords = { readonly left: number; readonly top: number };

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * Compute viewport-clamped popup coordinates from an anchor rect. The popup
 * is preferred below the anchor; if that overflows the viewport bottom, we
 * flip above. Horizontal positioning aligns to the anchor's left, but
 * clamps within `[margin, viewportWidth - width - margin]` so the popup is
 * never partially off-screen when the anchor is near a viewport edge.
 *
 * Exported for unit tests; the runtime caller does not need to invoke it
 * directly.
 */
export function computePopupPosition(
  anchor: SelectionAnchor,
  viewport: { readonly width: number; readonly height: number }
): Coords {
  const safeWidth = Math.max(1, viewport.width);
  const safeHeight = Math.max(1, viewport.height);
  const popupWidth = Math.min(
    POPUP_MAX_WIDTH,
    Math.max(POPUP_MIN_WIDTH, safeWidth - 2 * POPUP_VIEWPORT_MARGIN)
  );
  // Anchor-left horizontal alignment, clamped within the viewport.
  const rawLeft = anchor.left;
  const maxLeft = Math.max(POPUP_VIEWPORT_MARGIN, safeWidth - popupWidth - POPUP_VIEWPORT_MARGIN);
  const left = clamp(rawLeft, POPUP_VIEWPORT_MARGIN, maxLeft);
  // Prefer placing below the anchor; flip above when (a) below would
  // overflow the viewport bottom, or (b) the anchor sits in the lower
  // half of the viewport — in that case below-placement would push the
  // popup even further from the user's selection, so flipping above
  // keeps the popup closer to the eyes of the read text. We still
  // require the above-position to fit; if it does not, fall back to a
  // clamped below-position so the popup stays on screen rather than
  // disappearing off the top.
  const belowTop = anchor.top + anchor.height + POPUP_ANCHOR_GAP;
  const bottomOverflows = belowTop + POPUP_ESTIMATED_HEIGHT > safeHeight - POPUP_VIEWPORT_MARGIN;
  const anchorInLowerHalf = anchor.top > safeHeight / 2;
  const shouldFlipAbove = bottomOverflows || anchorInLowerHalf;
  let top: number;
  if (shouldFlipAbove) {
    const aboveTop = anchor.top - POPUP_ESTIMATED_HEIGHT - POPUP_ANCHOR_GAP;
    top =
      aboveTop >= POPUP_VIEWPORT_MARGIN
        ? aboveTop
        : clamp(belowTop, POPUP_VIEWPORT_MARGIN, safeHeight - POPUP_VIEWPORT_MARGIN);
  } else {
    top = belowTop;
  }
  return { left, top };
}
const SIDEBAR_WRAPPER_STYLE =
  "position: fixed; top: 0; right: 0; height: 100vh; width: 360px; max-width: 40vw; " +
  `z-index: 999998; background: ${SIDEPANE_BG}; color: ${FG}; font-family: ${FONT_STACK}; ` +
  `font-size: 13px; line-height: 1.45; border-left: 1px solid ${BORDER_HAIRLINE}; ` +
  "box-shadow: -4px 0 16px rgba(0,0,0,0.25); overflow: hidden; " +
  "display: flex; flex-direction: column;";

/**
 * Append a floating layer to the Zotero main window. The main window's
 * `<body>` is filled by XUL chrome boxes, so trailing children render off
 * the visible viewport unless they are positioned absolutely/fixed with a
 * high z-index. We append to `document.body` when available, falling back
 * to `documentElement` so the user still sees something if the body is
 * not yet attached.
 */
function appendFloatingLayer(
  zotero: ZoteroGlobal,
  document: Document,
  element: HTMLElement,
  label: string
): void {
  // TS types Document.body as HTMLElement (never-null), but at runtime in
  // chrome contexts it can be null (XUL/XHTML docs during early init).
  // The conditional is defensive; TS doesn't know that.
  const body = document.body as HTMLElement | null;

  if (body !== null) {
    body.append(element);
    return;
  }
  zotero.debug(
    `Zotero AI Explain: ${label} mounted on documentElement because body is unavailable`
  );
  document.documentElement.append(element);
}

/**
 * Native-feeling Zotero focus ring. CSS `:focus-visible` is not reliably
 * supported in the XUL-chrome context across builds, so we attach explicit
 * focus/blur listeners that paint a 2px outline using the accent token.
 */
function applyFocusRing(element: HTMLElement, color: string = ACCENT): void {
  element.addEventListener("focus", () => {
    element.style.outline = `2px solid ${color}`;
    element.style.outlineOffset = "2px";
  });
  element.addEventListener("blur", () => {
    element.style.outline = "";
    element.style.outlineOffset = "";
  });
}

export function createZoteroUiAdapter(input: {
  readonly Zotero: ZoteroGlobal;
  readonly pluginId: string;
}): ZoteroUiAdapter {
  return {
    addMenuItem(label, action): Unsubscribe {
      const mainWindow = input.Zotero.getMainWindow?.();
      const document = mainWindow?.document;
      const toolsPopup =
        document?.getElementById("menu_ToolsPopup") ?? document?.getElementById("menuToolsPopup");
      if (!document || !toolsPopup) {
        input.Zotero.debug("Zotero AI Explain could not find the Tools menu popup.");
        return noOp;
      }

      const xulDocument = document as Document & {
        createXULElement?: (name: string) => HTMLElement;
      };
      const createGenericElement: (tag: string) => HTMLElement = (tag) =>
        document.createElement(tag);
      const item: HTMLElement =
        xulDocument.createXULElement?.("menuitem") ?? createGenericElement("menuitem");
      item.setAttribute("label", label);
      item.addEventListener("command", action);
      toolsPopup.append(item);
      input.Zotero.debug(`Zotero AI Explain registered menu: ${label}`);

      return () => {
        item.remove();
      };
    },
    addReaderCommands(commands): Unsubscribe {
      // Resolve PDF identity off the reader event ONCE per dispatch so
      // every command button shares the same source metadata. Mirrors the
      // three-tier `_iframe` strategy below: direct `_item`, then the Xray
      // `wrappedJSObject._item`, then a miss → all identity fields null.
      const resolveSource = (event: ReaderEvent): SelectionContext["source"] => {
        const readerRaw = event.reader as
          | {
              readonly wrappedJSObject?: { readonly _item?: ReaderItem };
              readonly _item?: ReaderItem;
            }
          | undefined;
        const item: ReaderItem | undefined = readerRaw?._item ?? readerRaw?.wrappedJSObject?._item;
        const attachmentKey = item?.key ?? null;
        const parent = item?.parentItem ?? null;
        // itemKey resolves to the parent item's key when the reader
        // attachment is a PDF child; standalone attachments fall back to
        // their own key so the field is still populated.
        const itemKey = parent?.key ?? item?.key ?? null;
        const itemTitle = parent?.getDisplayTitle?.() ?? item?.getDisplayTitle?.() ?? null;
        const pageLabel = event.params?.annotation?.pageLabel ?? null;
        const pageIndex = event.params?.annotation?.position?.pageIndex;
        return {
          itemKey,
          itemTitle,
          attachmentKey,
          pageLabel,
          // `pageIndex: 0` is a valid first page — only attach the field
          // when the reader event actually supplied a number, never
          // conflate an absent position with 0.
          ...(typeof pageIndex === "number" ? { pageIndex } : {})
        };
      };

      const handler = (event: ReaderEvent): void => {
        const quote = event.params?.annotation?.text?.trim() ?? "";
        // Hidden-when-no-selection (AC-1): an empty or whitespace-only
        // selection renders NO command buttons at all. `event.params`
        // undefined is the defensive fall-through — `quote` is "" and we
        // bail before appending anything.
        if (quote.length === 0) {
          return;
        }
        const source = resolveSource(event);
        for (const spec of commands) {
          appendReaderCommandButton(event, spec, quote, source);
        }
      };

      const appendReaderCommandButton = (
        event: ReaderEvent,
        spec: ReaderCommandSpec,
        quote: string,
        source: SelectionContext["source"]
      ): void => {
        const { label, action } = spec;
        const button = event.doc.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.dataset.action = spec.mode === "ask-question" ? "ask-question" : "explain-with-ai";
        button.dataset.mode = spec.mode;
        button.addEventListener("click", () => {
          // AC1: compute anchor in CHROME-WINDOW coordinates. The reader iframe
          // is a XUL <browser> element (xpcom/reader.js:1812), so the HTML
          // `viewWindow.frameElement` property returns null — we use the
          // ReaderInstance's chrome-side `_iframe.getBoundingClientRect()`
          // instead, mirroring how Zotero itself positions reader popups
          // (xpcom/reader.js:1244-1247). The reader instance is attached to
          // every event by the customEvent bridge (xpcom/reader.js:184).
          const rect = button.getBoundingClientRect();
          const viewWindow = event.doc.defaultView ?? null;
          // Three-tier strategy to locate the chrome-side reader iframe
          // (whose getBoundingClientRect gives us the iframe's position in
          // chrome-window coordinates):
          //   1. `event.reader.wrappedJSObject._iframe` — bootstrap plugins
          //      run in a sandbox that wraps chrome objects in Xray wrappers;
          //      Xray HIDES underscore-prefixed props, so the unwrap via
          //      `wrappedJSObject` is required.
          //   2. `event.reader._iframe` — direct access works in the test
          //      env (plugin runs in chrome compartment, no Xray).
          //   3. Walk the chrome DOM and find the reader <browser> whose
          //      contentWindow matches `viewWindow`. Bypasses `event.reader`
          //      entirely — works regardless of Xray semantics.
          const readerRaw = event.reader as
            | {
                readonly wrappedJSObject?: {
                  readonly _iframe?: { getBoundingClientRect(): DOMRect };
                };
                readonly _iframe?: { getBoundingClientRect(): DOMRect };
              }
            | undefined;
          let iframeEl: { getBoundingClientRect(): DOMRect } | null =
            readerRaw?.wrappedJSObject?._iframe ?? readerRaw?._iframe ?? null;
          let iframeSource: "wJSO" | "direct" | "dom-search" | "none" =
            readerRaw?.wrappedJSObject?._iframe != null
              ? "wJSO"
              : readerRaw?._iframe != null
                ? "direct"
                : "none";
          if (iframeEl === null) {
            const mainWin = input.Zotero.getMainWindow?.();
            const chromeDoc = mainWin?.document;
            if (chromeDoc && viewWindow !== null) {
              const candidates = chromeDoc.querySelectorAll(
                "browser.reader, iframe.reader, browser#reader, iframe#reader"
              );
              for (const el of Array.from(candidates)) {
                const contentWin = (el as unknown as { contentWindow?: Window | null })
                  .contentWindow;
                if (contentWin === viewWindow) {
                  iframeEl = el;
                  iframeSource = "dom-search";
                  break;
                }
              }
            }
          }
          const readerFrameRect = iframeEl?.getBoundingClientRect() ?? null;
          // DIAG: print what the runtime sees so we can diagnose the
          // anchor-null fallback in real Zotero. Visible in Browser Console
          // when filtering on "AI-EXPLAIN diag".
          const diagMsg =
            `[AI-EXPLAIN diag] event.reader=${typeof event.reader} ` +
            `reader.wrappedJSObject=${typeof readerRaw?.wrappedJSObject} ` +
            `wJSO._iframe=${typeof readerRaw?.wrappedJSObject?._iframe} ` +
            `direct._iframe=${typeof readerRaw?._iframe} ` +
            `iframeSource=${iframeSource} ` +
            `iframeEl=${typeof iframeEl} ` +
            `readerFrameRect=${
              readerFrameRect === null
                ? "null"
                : `{l:${String(readerFrameRect.left)},t:${String(readerFrameRect.top)},w:${String(readerFrameRect.width)},h:${String(readerFrameRect.height)}}`
            } ` +
            `buttonRect={l:${String(rect.left)},t:${String(rect.top)}} ` +
            `event keys=[${Object.keys(event).join(",")}]`;
          input.Zotero.debug(diagMsg);
          // Also emit via console.error so the diag is visible in Browser
          // Console without enabling Zotero's debug-output logging.
          const consoleCtor = (
            input.Zotero.getMainWindow?.() as unknown as
              | {
                  readonly console?: { error(msg: string): void };
                }
              | undefined
          )?.console;
          consoleCtor?.error(diagMsg);
          // The Zotero type signature returns non-nullable, but Zotero can
          // hand us `null`/`undefined` in practice (e.g. before chrome is
          // ready), so we widen to nullable here. FINDING-3 mandates a clean
          // bail-out on that path rather than a viewport fallback.
          const mainWindow: (Window & typeof globalThis) | null =
            input.Zotero.getMainWindow?.() ?? null;
          // AC7: immediate click feedback. Disable the button and swap its
          // label BEFORE action() returns so the user sees acknowledgement
          // even if the response popup takes a moment to mount. Runs on
          // both the anchored and bail-out paths.
          if (!button.disabled) {
            const originalLabel = label;
            button.disabled = true;
            button.dataset.busy = "true";
            button.textContent = "Opening…";
            // Schedule restore so the reader popup keeps the button usable
            // if the response popup never mounts (e.g. user dismisses).
            // 1500ms is empirically long enough to cover the mount call.
            const restore = (): void => {
              button.disabled = false;
              button.dataset.busy = "false";
              button.textContent = originalLabel;
            };
            viewWindow?.setTimeout(restore, 1500);
          }
          // FINDING-3: no `mainWindow` OR no reader frame rect → bail out
          // with `anchor: null` rather than fabricating viewport math.
          // Production always has both; this is defensive.
          if (mainWindow === null || readerFrameRect === null) {
            action({ quote, source, anchor: null });
            return;
          }
          const anchor: SelectionAnchor = {
            left: rect.left + readerFrameRect.left,
            top: rect.top + readerFrameRect.top,
            width: rect.width,
            height: rect.height,
            viewportWidth: mainWindow.innerWidth,
            viewportHeight: mainWindow.innerHeight
          };
          action({ quote, source, anchor });
        });
        event.append(button);
      };

      if (!input.Zotero.Reader) {
        input.Zotero.debug(
          "Zotero AI Explain: Zotero.Reader unavailable, skipping reader command registration"
        );
        return noOp;
      }
      const reader = input.Zotero.Reader;
      reader.registerEventListener("renderTextSelectionPopup", handler, input.pluginId);
      input.Zotero.debug(
        `Zotero AI Explain registered reader commands: ${commands.map((c) => c.label).join(", ")}`
      );
      return () => {
        reader.unregisterEventListener("renderTextSelectionPopup", handler);
      };
    },
    addReaderCommand(label, action): Unsubscribe {
      // Convenience wrapper — a single `explain`-mode command.
      return this.addReaderCommands([{ label, mode: "explain", action }]);
    },
    openDialog(title, content): DialogHandle {
      const mainWindow = input.Zotero.getMainWindow?.();
      const document = mainWindow?.document;
      if (!document) {
        input.Zotero.debug(`Zotero AI Explain could not open dialog: ${title}`);
        // Return a no-op handle so callers can blindly invoke `.close()`
        // without checking — same shape regardless of host availability.
        return {
          close: () => undefined,
          minimize: () => undefined,
          restore: () => undefined
        };
      }

      const backdrop = document.createElement("div");
      backdrop.className = "zotero-ai-dialog-backdrop";
      backdrop.setAttribute("style", DIALOG_BACKDROP_STYLE);

      const dialog = document.createElement("section");
      dialog.className = "zotero-ai-dialog";
      dialog.setAttribute("aria-label", title);
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("style", DIALOG_CONTENT_STYLE);

      const header = document.createElement("header");
      header.className = "zotero-ai-dialog__header";
      header.setAttribute("style", DIALOG_HEADER_STYLE);

      const heading = document.createElement("h2");
      heading.className = "zotero-ai-dialog__title";
      heading.textContent = title;
      heading.setAttribute("style", DIALOG_TITLE_STYLE);

      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.dataset.action = "close-dialog";
      closeButton.setAttribute("aria-label", "Close");
      // Use the literal multiplication sign so it renders the same regardless
      // of the chrome document's font; "Close" text would force a wider hit
      // area and look unlike Zotero's native chrome dialogs.
      closeButton.textContent = "×";
      closeButton.setAttribute("style", DIALOG_CLOSE_STYLE);
      applyFocusRing(closeButton);

      header.append(heading, closeButton);

      const body = document.createElement("div");
      body.className = "zotero-ai-dialog__body";
      body.setAttribute("style", DIALOG_BODY_STYLE);
      body.append(content);

      let disposed = false;
      let minimized = false;
      // Snapshot the dialog's centered styling so restore() can put it
      // back without re-deriving from constants. Captured once at mount.
      const initialDialogStyle = dialog.getAttribute("style") ?? "";
      const initialBackdropStyle = backdrop.getAttribute("style") ?? "";
      const dispose = (): void => {
        if (disposed) {
          return;
        }
        disposed = true;
        document.removeEventListener("keydown", onKeydown);
        dialog.removeEventListener("click", onDialogClick);
        backdrop.remove();
        dialog.remove();
      };

      function onKeydown(event: KeyboardEvent): void {
        if (event.key === "Escape") {
          dispose();
        }
      }

      // Click-to-restore: when minimized, clicking anywhere on the
      // dialog frame brings it back to the centered, fully-opaque
      // state. Capture phase so a click on an inner button restores
      // first and then the button still receives its own event.
      function onDialogClick(event: MouseEvent): void {
        if (!minimized) return;
        // The close button inside the dialog still disposes — let that
        // path run instead of restoring.
        if (
          event.target instanceof Element &&
          event.target.closest("[data-action='close-dialog']")
        ) {
          return;
        }
        restore();
      }

      function minimize(): void {
        if (disposed || minimized) return;
        minimized = true;
        // Drop the modal scrim so the Zotero pane behind is interactive
        // and the user can see the freshly-selected item.
        backdrop.setAttribute("style", `${initialBackdropStyle} pointer-events: none; opacity: 0;`);
        // Dock to the bottom-right corner with reduced size + opacity.
        // The user can still see the conversation; clicking restores.
        dialog.setAttribute(
          "style",
          `${initialDialogStyle} ` +
            `position: fixed; top: auto; left: auto; bottom: 16px; right: 16px; ` +
            `max-width: 320px; max-height: 240px; opacity: 0.55; ` +
            `transform: scale(0.85); transform-origin: bottom right; ` +
            `transition: opacity 120ms ease, transform 120ms ease; cursor: pointer;`
        );
        dialog.setAttribute("aria-modal", "false");
      }

      function restore(): void {
        if (disposed || !minimized) return;
        minimized = false;
        backdrop.setAttribute("style", initialBackdropStyle);
        dialog.setAttribute("style", initialDialogStyle);
        dialog.setAttribute("aria-modal", "true");
      }

      backdrop.addEventListener("click", dispose);
      closeButton.addEventListener("click", dispose);
      dialog.addEventListener("click", onDialogClick);
      document.addEventListener("keydown", onKeydown);

      dialog.append(header, body);
      appendFloatingLayer(input.Zotero, document, backdrop, "dialog backdrop");
      appendFloatingLayer(input.Zotero, document, dialog, "dialog");
      input.Zotero.debug(`Zotero AI Explain opened dialog: ${title}`);
      return { close: dispose, minimize, restore };
    },
    mountPopup(content, options?: PopupMountOptions): Unsubscribe {
      const mainWindowMaybe = input.Zotero.getMainWindow?.();
      const document = mainWindowMaybe?.document;
      if (!mainWindowMaybe || !document) {
        input.Zotero.debug("Zotero AI Explain could not mount popup: no document");
        return noOp;
      }
      // Rebind to a guaranteed-defined local so the drag-handler closures
      // below (function declarations, which TS won't carry narrowing
      // across) see `Window & typeof globalThis` rather than `| undefined`.
      const mainWindow: Window & typeof globalThis = mainWindowMaybe;
      const wrapper = document.createElement("div");
      wrapper.className = "zotero-ai-popup-wrapper";

      // AC1: position from anchor when supplied; otherwise fall back to the
      // legacy top-center placement so older callers keep working.
      const anchor = options?.anchor ?? null;
      let positionStyle = POPUP_FALLBACK_POSITION_STYLE;
      let computedCoords: Coords | null = null;
      if (anchor !== null) {
        const viewport = {
          width: anchor.viewportWidth ?? mainWindow.innerWidth,
          height: anchor.viewportHeight ?? mainWindow.innerHeight
        };
        computedCoords = computePopupPosition(anchor, viewport);
        positionStyle = `top: ${String(computedCoords.top)}px; left: ${String(computedCoords.left)}px;`;
      }
      wrapper.setAttribute("style", `${POPUP_WRAPPER_BASE_STYLE} ${positionStyle}`);
      // Expose the computed rect via `getBoundingClientRect`. A real
      // browser's layout engine would compute the same values for a
      // `position: fixed; top: Xpx; left: Ypx` element with no transformed
      // ancestors or fixed-element scroll containers (the typical case for
      // floating chrome popups). Setting this explicitly makes the popup
      // position observable in non-layout environments (jsdom-driven tests)
      // and keeps real-browser callers consistent.
      if (computedCoords !== null) {
        const widthCap = anchor?.viewportWidth ?? mainWindow.innerWidth;
        const popupWidth = Math.min(
          POPUP_MAX_WIDTH,
          Math.max(POPUP_MIN_WIDTH, widthCap - 2 * POPUP_VIEWPORT_MARGIN)
        );
        const rect: DOMRect = {
          left: computedCoords.left,
          top: computedCoords.top,
          right: computedCoords.left + popupWidth,
          bottom: computedCoords.top + POPUP_ESTIMATED_HEIGHT,
          width: popupWidth,
          height: POPUP_ESTIMATED_HEIGHT,
          x: computedCoords.left,
          y: computedCoords.top,
          toJSON: () => ({})
        };
        Object.defineProperty(wrapper, "getBoundingClientRect", {
          value: () => rect,
          configurable: true
        });
      }

      // AC2: close button (×) at the top-right.
      // The header doubles as the drag handle (data-drag-handle="true")
      // so the user can reposition the popup by grabbing this row. The
      // close button stops drag-initiation in its own mousedown handler
      // below — clicking × should never start a drag.
      const header = document.createElement("div");
      header.className = "zotero-ai-popup-wrapper__header";
      header.setAttribute("style", POPUP_HEADER_STYLE);
      header.dataset.dragHandle = "true";
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.dataset.action = "close-popup";
      closeButton.setAttribute("aria-label", "Close");
      closeButton.textContent = "×";
      closeButton.setAttribute("style", POPUP_CLOSE_STYLE);
      applyFocusRing(closeButton);
      header.append(closeButton);

      // AC3: dedicated body container. It keeps its intrinsic content
      // height (`flex: 0 0 auto`); the scrolling happens on the outer
      // wrapper, which is `max-height`-capped with `overflow-y: auto`. The
      // wrapper is the surface a user perceives as scrollable when a long
      // response exceeds the 60vh cap.
      const bodyWrapper = document.createElement("div");
      bodyWrapper.className = "zotero-ai-popup-wrapper__body";
      bodyWrapper.setAttribute("style", POPUP_BODY_WRAPPER_STYLE);
      bodyWrapper.append(content);

      wrapper.append(header, bodyWrapper);

      // Drag state. `dragOffset` records the pointer offset relative
      // to the wrapper's top-left at the moment drag started, so we can
      // reposition the wrapper to keep the same point under the cursor
      // as it moves. We track via document-level mousemove/mouseup so a
      // fast drag that briefly leaves the header doesn't desync.
      let dragOffset: { readonly x: number; readonly y: number } | null = null;

      let disposed = false;
      const dispose = (): void => {
        if (disposed) {
          return;
        }
        disposed = true;
        document.removeEventListener("keydown", onKeydown);
        document.removeEventListener("mousedown", onDocumentMouseDown, true);
        document.removeEventListener("mousemove", onDragMove);
        document.removeEventListener("mouseup", onDragEnd);
        wrapper.remove();
        options?.onDismiss?.();
      };

      function onKeydown(event: KeyboardEvent): void {
        if (event.key === "Escape") {
          dispose();
        }
      }

      function onDocumentMouseDown(event: MouseEvent): void {
        // AC2: outside-click dismiss. Use mousedown (capture phase) to fire
        // before any inner control consumes the event.
        // NOTE: `Node` is NOT a chrome-script global in Zotero's bootstrap
        // scope. Duck-type by checking for `nodeType` instead of
        // `instanceof Node` (which throws ReferenceError in real Zotero).
        const target = event.target as { readonly nodeType?: unknown } | null;
        if (target === null || typeof target.nodeType !== "number") {
          return;
        }
        if (wrapper.contains(target as unknown as Node)) {
          return;
        }
        dispose();
      }

      function findDragHandle(target: EventTarget | null): HTMLElement | null {
        // Walk up the DOM from the mousedown target looking for an
        // ancestor that carries `data-drag-handle="true"`, stopping at
        // the wrapper boundary. Returns null if the mousedown originated
        // inside the body content (so body clicks do not start a drag).
        let node: HTMLElement | null =
          target !== null && typeof (target as { nodeType?: unknown }).nodeType === "number"
            ? (target as HTMLElement)
            : null;
        while (node !== null && node !== wrapper) {
          if (node.dataset.dragHandle === "true") {
            return node;
          }
          node = node.parentElement;
        }
        return null;
      }

      function onHeaderMouseDown(event: MouseEvent): void {
        // Only primary-button drags. The close button has its own click
        // handler and we explicitly skip drag-initiation when the
        // pointer is on it, otherwise grabbing × would both close and
        // start a drag.
        if (event.button !== 0) {
          return;
        }
        const target = event.target as { readonly nodeType?: unknown } | null;
        if (target !== null && typeof target.nodeType === "number") {
          const el = target as HTMLElement;
          if (el === closeButton || closeButton.contains(el)) {
            return;
          }
        }
        if (findDragHandle(event.target) === null) {
          return;
        }
        // Prefer the live inline pixel `style.top/left` if a previous
        // drag already set them, because anchor-mode callers override
        // getBoundingClientRect to return the *initial* computed rect.
        // Without this, a second drag-grab would compute a stale offset
        // and teleport the popup back to its original position. We only
        // trust the inline style when it is an explicit pixel value
        // (drag sets `${n}px`); a fallback `left: 50%` from the legacy
        // top-center placement would parse to 50 and corrupt the offset.
        const rect = wrapper.getBoundingClientRect();
        const currentLeft = wrapper.style.left.endsWith("px")
          ? Number.parseFloat(wrapper.style.left)
          : rect.left;
        const currentTop = wrapper.style.top.endsWith("px")
          ? Number.parseFloat(wrapper.style.top)
          : rect.top;
        dragOffset = { x: event.clientX - currentLeft, y: event.clientY - currentTop };
        // Prevent the mousedown from starting a text selection on the
        // header row. Without this, Firefox/Zotero begin a range selection
        // that interferes with smooth drag movement.
        event.preventDefault();
      }

      function onDragMove(event: MouseEvent): void {
        if (dragOffset === null) {
          return;
        }
        const viewportWidth = mainWindow.innerWidth;
        const viewportHeight = mainWindow.innerHeight;
        const rect = wrapper.getBoundingClientRect();
        const rawLeft = event.clientX - dragOffset.x;
        const rawTop = event.clientY - dragOffset.y;
        // Clamp so the popup never escapes the viewport: at least the
        // POPUP_VIEWPORT_MARGIN must remain visible on every edge.
        const maxLeft = Math.max(
          POPUP_VIEWPORT_MARGIN,
          viewportWidth - rect.width - POPUP_VIEWPORT_MARGIN
        );
        const maxTop = Math.max(
          POPUP_VIEWPORT_MARGIN,
          viewportHeight - rect.height - POPUP_VIEWPORT_MARGIN
        );
        const nextLeft = clamp(rawLeft, POPUP_VIEWPORT_MARGIN, maxLeft);
        const nextTop = clamp(rawTop, POPUP_VIEWPORT_MARGIN, maxTop);
        wrapper.style.left = `${String(nextLeft)}px`;
        wrapper.style.top = `${String(nextTop)}px`;
        // The base style sets transform via the fallback path when no
        // anchor was supplied (e.g. legacy callers). A leftover
        // `translateX(-50%)` would visually shift the popup off the
        // computed coordinates during/after drag, so clear it.
        wrapper.style.transform = "none";
      }

      function onDragEnd(): void {
        dragOffset = null;
      }

      closeButton.addEventListener("click", dispose);
      header.addEventListener("mousedown", onHeaderMouseDown);
      document.addEventListener("keydown", onKeydown);
      document.addEventListener("mousedown", onDocumentMouseDown, true);
      document.addEventListener("mousemove", onDragMove);
      document.addEventListener("mouseup", onDragEnd);

      appendFloatingLayer(input.Zotero, document, wrapper, "popup");
      return dispose;
    },
    mountSidebar(content, options?): Unsubscribe {
      const mainWindow = input.Zotero.getMainWindow?.();
      const document = mainWindow?.document;
      if (!document) {
        input.Zotero.debug("Zotero AI Explain could not mount sidebar: no document");
        return noOp;
      }
      const wrapper = document.createElement("div");
      wrapper.className = "zotero-ai-sidebar-wrapper";
      wrapper.setAttribute("style", SIDEBAR_WRAPPER_STYLE);
      wrapper.append(content);

      let disposed = false;
      const dispose = (): void => {
        if (disposed) {
          return;
        }
        disposed = true;
        wrapper.remove();
        options?.onDismiss?.();
      };

      // The close affordance lives in the sidebar view (see
      // `renderSidebarConversation`) so it can sit in the header alongside
      // the quote/source. Wire its click to dispose here — the adapter owns
      // wrapper teardown and onDismiss notification.
      const closeButton = wrapper.querySelector<HTMLButtonElement>('[data-action="close-sidebar"]');
      closeButton?.addEventListener("click", dispose);

      appendFloatingLayer(input.Zotero, document, wrapper, "sidebar");
      return dispose;
    }
  };
}
