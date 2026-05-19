/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computePopupPosition,
  createZoteroUiAdapter,
  type ZoteroGlobal
} from "../../src/platform/zotero-ui-adapter.js";

type CreatedAdapter = {
  ui: ReturnType<typeof createZoteroUiAdapter>;
  debug: ReturnType<typeof vi.fn>;
  mainWindow: Window & typeof globalThis;
};

function createAdapter(): CreatedAdapter {
  const debug = vi.fn();
  const mainWindow = window;
  const zotero: ZoteroGlobal = {
    debug,
    getMainWindow: () => mainWindow
  };
  const ui = createZoteroUiAdapter({ Zotero: zotero, pluginId: "test" });
  return { ui, debug, mainWindow };
}

describe("createZoteroUiAdapter floating layers", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("openDialog: appends a fixed-position dialog above zotero chrome", () => {
    const { ui } = createAdapter();
    const content = document.createElement("p");
    content.textContent = "settings";

    ui.openDialog("Settings", content);

    const dialog = document.querySelector<HTMLElement>(".zotero-ai-dialog");
    const backdrop = document.querySelector<HTMLElement>(".zotero-ai-dialog-backdrop");

    expect(dialog).not.toBeNull();
    expect(backdrop).not.toBeNull();
    expect(dialog?.getAttribute("style")).toContain("position: fixed");
    expect(dialog?.getAttribute("style")).toContain("z-index: 999999");
    expect(backdrop?.getAttribute("style")).toContain("position: fixed");
    expect(backdrop?.getAttribute("style")).toContain("z-index: 999998");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-label")).toBe("Settings");
    expect(dialog?.contains(content)).toBe(true);
  });

  it("openDialog: surface styles bind to live Zotero 9 tokens with system-color fallbacks", () => {
    const { ui } = createAdapter();
    ui.openDialog("Settings", document.createElement("p"));

    const dialog = document.querySelector<HTMLElement>(".zotero-ai-dialog");
    const style = dialog?.getAttribute("style") ?? "";

    // Surface and foreground come from the dump'd Zotero 9 tokens.
    expect(style).toContain("var(--material-background, Canvas)");
    expect(style).toContain("var(--fill-primary, CanvasText)");
    // Hairline borders come from the fill token, not from a hard color.
    expect(style).toContain("var(--fill-quarternary, ButtonBorder)");
    // We never fall back to literal white/black: those would render as
    // black-on-dark on Zotero 9's dark theme (the bug we are fixing).
    expect(style).not.toMatch(
      /(?:^|[^-])(?:#fff\b|#ffffff\b|\bwhite\b|\bblack\b|#000\b|#000000\b)/i
    );
  });

  it("openDialog: renders a header with the title and a close affordance", () => {
    const { ui } = createAdapter();
    ui.openDialog("Plugin Settings", document.createElement("p"));

    const heading = document.querySelector(".zotero-ai-dialog__title");
    const closeButton = document.querySelector('[data-action="close-dialog"]');
    expect(heading?.textContent).toBe("Plugin Settings");
    expect(closeButton?.getAttribute("aria-label")).toBe("Close");
  });

  it("mountPopup: applies the design tokens", () => {
    const { ui } = createAdapter();
    const unmount = ui.mountPopup(document.createElement("section"));
    const wrapper = document.querySelector<HTMLElement>(".zotero-ai-popup-wrapper");
    const style = wrapper?.getAttribute("style") ?? "";
    expect(style).toContain("var(--material-background, Canvas)");
    expect(style).toContain("var(--fill-primary, CanvasText)");
    expect(style).not.toMatch(
      /(?:^|[^-])(?:#fff\b|#ffffff\b|\bwhite\b|\bblack\b|#000\b|#000000\b)/i
    );
    unmount();
  });

  it("mountSidebar: uses the sidepane token and a left-edge hairline", () => {
    const { ui } = createAdapter();
    const unmount = ui.mountSidebar(document.createElement("aside"));
    const wrapper = document.querySelector<HTMLElement>(".zotero-ai-sidebar-wrapper");
    const style = wrapper?.getAttribute("style") ?? "";
    expect(style).toContain("var(--material-sidepane, Canvas)");
    expect(style).toContain("var(--fill-primary, CanvasText)");
    expect(style).toContain("border-left: 1px solid var(--fill-quarternary, ButtonBorder)");
    expect(style).not.toMatch(
      /(?:^|[^-])(?:#fff\b|#ffffff\b|\bwhite\b|\bblack\b|#000\b|#000000\b)/i
    );
    unmount();
  });

  it("openDialog: returns a handle whose close() removes the dialog", () => {
    const { ui } = createAdapter();
    const handle = ui.openDialog("Settings", document.createElement("p"));

    expect(document.querySelector(".zotero-ai-dialog")).not.toBeNull();
    handle.close();
    expect(document.querySelector(".zotero-ai-dialog")).toBeNull();
    expect(document.querySelector(".zotero-ai-dialog-backdrop")).toBeNull();
    // Idempotent: calling again is a safe no-op.
    expect(() => {
      handle.close();
    }).not.toThrow();
  });

  it("openDialog: clicking the backdrop closes the dialog", () => {
    const { ui } = createAdapter();
    ui.openDialog("Settings", document.createElement("p"));

    const backdrop = document.querySelector<HTMLElement>(".zotero-ai-dialog-backdrop");
    expect(backdrop).not.toBeNull();
    backdrop?.click();

    expect(document.querySelector(".zotero-ai-dialog")).toBeNull();
    expect(document.querySelector(".zotero-ai-dialog-backdrop")).toBeNull();
  });

  it("openDialog: clicking the close button closes the dialog", () => {
    const { ui } = createAdapter();
    ui.openDialog("Settings", document.createElement("p"));

    const closeButton = document.querySelector<HTMLButtonElement>('[data-action="close-dialog"]');
    expect(closeButton).not.toBeNull();
    closeButton?.click();

    expect(document.querySelector(".zotero-ai-dialog")).toBeNull();
    expect(document.querySelector(".zotero-ai-dialog-backdrop")).toBeNull();
  });

  it("openDialog: pressing Escape closes the dialog", () => {
    const { ui } = createAdapter();
    ui.openDialog("Settings", document.createElement("p"));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(document.querySelector(".zotero-ai-dialog")).toBeNull();
    expect(document.querySelector(".zotero-ai-dialog-backdrop")).toBeNull();
  });

  it("mountPopup: wraps content in a fixed-position container", () => {
    const { ui } = createAdapter();
    const content = document.createElement("section");
    content.className = "inner-popup";

    const unmount = ui.mountPopup(content);

    const wrapper = document.querySelector<HTMLElement>(".zotero-ai-popup-wrapper");
    expect(wrapper).not.toBeNull();
    expect(wrapper?.contains(content)).toBe(true);
    expect(wrapper?.getAttribute("style")).toContain("position: fixed");
    expect(wrapper?.getAttribute("style")).toContain("z-index: 999999");

    unmount();
    expect(document.querySelector(".zotero-ai-popup-wrapper")).toBeNull();
  });

  it("mountSidebar: wraps content in a fixed-position panel", () => {
    const { ui } = createAdapter();
    const content = document.createElement("aside");
    content.className = "inner-sidebar";

    const unmount = ui.mountSidebar(content);

    const wrapper = document.querySelector<HTMLElement>(".zotero-ai-sidebar-wrapper");
    expect(wrapper).not.toBeNull();
    expect(wrapper?.contains(content)).toBe(true);
    expect(wrapper?.getAttribute("style")).toContain("position: fixed");
    expect(wrapper?.getAttribute("style")).toContain("right: 0");
    expect(wrapper?.getAttribute("style")).toContain("z-index: 999998");

    unmount();
    expect(document.querySelector(".zotero-ai-sidebar-wrapper")).toBeNull();
  });

  it("mountSidebar: clicking the in-content close button dismisses the wrapper and fires onDismiss", () => {
    const { ui } = createAdapter();
    const content = document.createElement("aside");
    // The sidebar view (renderSidebarConversation) places the close button
    // inside the mounted content. The adapter wires the click to dispose.
    const close = document.createElement("button");
    close.type = "button";
    close.dataset.action = "close-sidebar";
    content.append(close);

    const onDismiss = vi.fn();
    ui.mountSidebar(content, { onDismiss });

    expect(document.querySelector(".zotero-ai-sidebar-wrapper")).not.toBeNull();
    close.click();
    expect(document.querySelector(".zotero-ai-sidebar-wrapper")).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("mountSidebar: onDismiss fires at most once even if dispose is called repeatedly", () => {
    const { ui } = createAdapter();
    const content = document.createElement("aside");
    const close = document.createElement("button");
    close.type = "button";
    close.dataset.action = "close-sidebar";
    content.append(close);

    const onDismiss = vi.fn();
    const unmount = ui.mountSidebar(content, { onDismiss });

    close.click();
    // Calling the returned unsubscribe after the close click must not
    // re-fire onDismiss — the runtime relies on this idempotence to keep
    // its bookkeeping straight when shutdown overlaps with a manual close.
    unmount();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("mountPopup: places popup near the anchor when one is provided (AC1)", () => {
    const { ui } = createAdapter();
    const unmount = ui.mountPopup(document.createElement("section"), {
      anchor: {
        left: 600,
        top: 700,
        width: 80,
        height: 24,
        viewportWidth: 1200,
        viewportHeight: 800
      }
    });
    const wrapper = document.querySelector<HTMLElement>(".zotero-ai-popup-wrapper");
    const style = wrapper?.getAttribute("style") ?? "";
    // Position should reflect the anchor, NOT the legacy "top: 80px; left: 50%".
    expect(style).not.toContain("left: 50%");
    expect(style).toMatch(/top:\s*\d+px/u);
    expect(style).toMatch(/left:\s*\d+px/u);
    unmount();
  });

  it("mountPopup: includes a close button (data-action=close-popup) with aria-label (AC2)", () => {
    const { ui } = createAdapter();
    const unmount = ui.mountPopup(document.createElement("section"));
    const close = document.querySelector<HTMLButtonElement>('[data-action="close-popup"]');
    expect(close).not.toBeNull();
    expect(close?.getAttribute("aria-label")).toBe("Close");
    expect(close?.textContent).toBe("×");
    unmount();
  });

  it("mountPopup: clicking the close button removes the wrapper from the DOM (AC2)", () => {
    const { ui } = createAdapter();
    const onDismiss = vi.fn();
    ui.mountPopup(document.createElement("section"), { onDismiss });
    const close = document.querySelector<HTMLButtonElement>('[data-action="close-popup"]');
    close?.click();
    expect(document.querySelector(".zotero-ai-popup-wrapper")).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("mountPopup: pressing Escape dismisses the popup (AC2)", () => {
    const { ui } = createAdapter();
    const onDismiss = vi.fn();
    ui.mountPopup(document.createElement("section"), { onDismiss });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".zotero-ai-popup-wrapper")).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("mountPopup: clicking outside the wrapper dismisses it (AC2)", () => {
    const { ui } = createAdapter();
    const onDismiss = vi.fn();
    ui.mountPopup(document.createElement("section"), { onDismiss });
    const outside = document.createElement("div");
    outside.id = "outside-area";
    document.body.append(outside);
    outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".zotero-ai-popup-wrapper")).toBeNull();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    outside.remove();
  });

  it("mountPopup: clicking inside the wrapper does NOT dismiss it (AC2)", () => {
    const { ui } = createAdapter();
    const content = document.createElement("section");
    content.id = "inner-content";
    const onDismiss = vi.fn();
    ui.mountPopup(content, { onDismiss });
    content.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.querySelector(".zotero-ai-popup-wrapper")).not.toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("mountPopup: dismiss handlers are removed after the popup is unmounted (AC2)", () => {
    const { ui } = createAdapter();
    const onDismiss = vi.fn();
    const unmount = ui.mountPopup(document.createElement("section"), { onDismiss });
    unmount();
    // Subsequent Escape presses should not re-fire onDismiss because we
    // removed the listener on dispose.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("mountPopup: wrapper keeps overflow auto + max-height for scrollability (AC3)", () => {
    const { ui } = createAdapter();
    const unmount = ui.mountPopup(document.createElement("section"));
    const wrapper = document.querySelector<HTMLElement>(".zotero-ai-popup-wrapper");
    const style = wrapper?.getAttribute("style") ?? "";
    expect(style).toContain("max-height: 60vh");
    const bodyWrapper = document.querySelector<HTMLElement>(".zotero-ai-popup-wrapper__body");
    expect(bodyWrapper?.getAttribute("style") ?? "").toMatch(/overflow\s*:\s*auto/u);
    unmount();
  });

  it("computePopupPosition flips above when the popup would overflow the viewport bottom (AC1)", () => {
    const viewport = { width: 1200, height: 800 };
    // Anchor near the bottom of the viewport — below-placement would
    // overflow, so we expect a flip upward.
    const result = computePopupPosition({ left: 100, top: 750, width: 80, height: 24 }, viewport);
    expect(result.top).toBeLessThan(750);
  });

  it("computePopupPosition clamps horizontally so the popup never overflows the right edge (AC1)", () => {
    const viewport = { width: 1200, height: 800 };
    const result = computePopupPosition({ left: 1180, top: 200, width: 80, height: 24 }, viewport);
    // 320px min-width + 8px margin means left cannot exceed 1200-320-8 = 872.
    expect(result.left).toBeLessThanOrEqual(872);
  });

  it("addReaderCommand: clicking the injected button gives instant visual feedback (AC7)", () => {
    const reader = {
      registerEventListener: vi.fn(),
      unregisterEventListener: vi.fn()
    };
    const debug = vi.fn();
    const zotero: ZoteroGlobal = {
      debug,
      getMainWindow: () => window,
      Reader: reader
    };
    const ui = createZoteroUiAdapter({ Zotero: zotero, pluginId: "test" });
    const action = vi.fn();
    ui.addReaderCommand("Explain with AI", action);

    const handler = reader.registerEventListener.mock.calls[0]?.[1] as
      | ((event: {
          doc: Document;
          reader?: { _iframe?: { getBoundingClientRect(): DOMRect } };
          append: (el: HTMLElement) => void;
        }) => void)
      | undefined;
    expect(handler).toBeDefined();

    let appended: HTMLButtonElement | null = null;
    handler?.({
      doc: document,
      reader: {
        _iframe: { getBoundingClientRect: () => document.body.getBoundingClientRect() }
      },
      append: (el: HTMLElement) => {
        appended = el as HTMLButtonElement;
        document.body.append(el);
      }
    });

    expect(appended).not.toBeNull();
    const button = appended as unknown as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Explain with AI");

    button.click();

    // AC7: immediate busy state
    expect(button.disabled).toBe(true);
    expect(button.dataset.busy).toBe("true");
    expect(button.textContent).not.toBe("Explain with AI");
    expect(action).toHaveBeenCalledTimes(1);
    const passed = action.mock.calls[0]?.[0] as { anchor?: unknown };
    expect(passed.anchor).not.toBeNull();
    button.remove();
  });

  it("addReaderCommand: the selection passed to the action carries the button's bounding rect (AC1)", () => {
    const reader = {
      registerEventListener: vi.fn(),
      unregisterEventListener: vi.fn()
    };
    const zotero: ZoteroGlobal = {
      debug: vi.fn(),
      getMainWindow: () => window,
      Reader: reader
    };
    const ui = createZoteroUiAdapter({ Zotero: zotero, pluginId: "test" });
    const action = vi.fn();
    ui.addReaderCommand("Explain with AI", action);

    const handler = reader.registerEventListener.mock.calls[0]?.[1] as
      | ((event: {
          doc: Document;
          reader?: { _iframe?: { getBoundingClientRect(): DOMRect } };
          append: (el: HTMLElement) => void;
        }) => void)
      | undefined;
    let appended: HTMLButtonElement | null = null;
    handler?.({
      doc: document,
      reader: {
        _iframe: { getBoundingClientRect: () => document.body.getBoundingClientRect() }
      },
      append: (el: HTMLElement) => {
        appended = el as HTMLButtonElement;
        document.body.append(el);
      }
    });

    const button = appended as unknown as HTMLButtonElement;
    button.click();

    const selection = action.mock.calls[0]?.[0] as {
      anchor: { left: number; top: number; width: number; height: number } | null;
    };
    expect(selection.anchor).not.toBeNull();
    expect(typeof selection.anchor?.left).toBe("number");
    expect(typeof selection.anchor?.top).toBe("number");
    button.remove();
  });

  // ---------------------------------------------------------------------------
  // Phase 4 — draggable popup + better default positioning
  // ---------------------------------------------------------------------------
  // The popup must be draggable from its header (close-button row) so users
  // can move it out of the way without losing context. Dragging must clamp
  // to the viewport so the popup cannot be carried fully off-screen. Drag
  // must only initiate on elements tagged `data-drag-handle="true"` — body
  // content remains non-draggable so text selection still works inside it.
  // Default positioning prefers below the anchor but flips above whenever
  // the anchor sits in the lower half of the viewport, since below-placement
  // there would push the popup further from the user's selection.

  function mustQueryElement(selector: string): HTMLElement {
    const el = document.querySelector<HTMLElement>(selector);
    if (el === null) {
      throw new Error(`expected an element matching ${selector} to be mounted`);
    }
    return el;
  }
  function mustQueryButton(selector: string): HTMLButtonElement {
    const el = document.querySelector<HTMLButtonElement>(selector);
    if (el === null) {
      throw new Error(`expected an element matching ${selector} to be mounted`);
    }
    return el;
  }

  it("mountPopup: header carries data-drag-handle=true so drag initiates only on header", () => {
    const { ui } = createAdapter();
    const unmount = ui.mountPopup(document.createElement("section"));
    const header = mustQueryElement(".zotero-ai-popup-wrapper__header");
    expect(header.dataset.dragHandle).toBe("true");
    unmount();
  });

  it("mountPopup: mousedown on drag handle + mousemove repositions wrapper top/left", () => {
    const { ui } = createAdapter();
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    // Anchor-mode call gives the wrapper a deterministic `top: Npx; left: Npx`
    // inline style that the drag-offset math reads back from.
    const unmount = ui.mountPopup(document.createElement("section"), {
      anchor: {
        left: 100,
        top: 100,
        width: 80,
        height: 24,
        viewportWidth: 1200,
        viewportHeight: 800
      }
    });
    const wrapper = mustQueryElement(".zotero-ai-popup-wrapper");
    const header = mustQueryElement(".zotero-ai-popup-wrapper__header");
    // After mount with anchor (left=100, top=100, height=24) the wrapper's
    // inline style is `top: 132px; left: 100px;` (top = 100+24+8 gap).
    const initialLeft = Number.parseFloat(wrapper.style.left);
    const initialTop = Number.parseFloat(wrapper.style.top);
    expect(initialLeft).toBe(100);
    expect(initialTop).toBe(132);

    // Press the header at (initialLeft+10, initialTop+10) -> offset (10, 10).
    header.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        clientX: initialLeft + 10,
        clientY: initialTop + 10,
        button: 0
      })
    );
    // Drag to (300, 300) -> new wrapper position (300-10, 300-10) = (290, 290).
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 300 })
    );

    expect(wrapper.style.left).toBe("290px");
    expect(wrapper.style.top).toBe("290px");
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    unmount();
  });

  it("mountPopup: mousedown on body content does NOT start a drag", () => {
    const { ui } = createAdapter();
    const body = document.createElement("section");
    body.id = "popup-body-content";
    const unmount = ui.mountPopup(body, {
      anchor: {
        left: 100,
        top: 100,
        width: 80,
        height: 24,
        viewportWidth: 1200,
        viewportHeight: 800
      }
    });
    const wrapper = mustQueryElement(".zotero-ai-popup-wrapper");

    // Mousedown on the body content (NOT on the header). A subsequent
    // mousemove must NOT update the wrapper position.
    const originalLeft = wrapper.style.left;
    const originalTop = wrapper.style.top;
    body.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, clientX: 110, clientY: 110, button: 0 })
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 400, clientY: 400 })
    );

    expect(wrapper.style.left).toBe(originalLeft);
    expect(wrapper.style.top).toBe(originalTop);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    unmount();
  });

  it("mountPopup: drag clamps to viewport bounds (POPUP_VIEWPORT_MARGIN)", () => {
    const { ui } = createAdapter();
    // Force innerWidth/innerHeight to known values so clamp math is deterministic.
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const unmount = ui.mountPopup(document.createElement("section"), {
      anchor: {
        left: 100,
        top: 100,
        width: 80,
        height: 24,
        viewportWidth: 1200,
        viewportHeight: 800
      }
    });
    const wrapper = mustQueryElement(".zotero-ai-popup-wrapper");
    const header = mustQueryElement(".zotero-ai-popup-wrapper__header");
    const initialLeft = Number.parseFloat(wrapper.style.left);
    const initialTop = Number.parseFloat(wrapper.style.top);

    // Start drag with offset (10,10) into the wrapper.
    header.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        clientX: initialLeft + 10,
        clientY: initialTop + 10,
        button: 0
      })
    );
    // Try to drag way past the right/bottom edges — clamp must keep the popup on-screen.
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 99999, clientY: 99999 })
    );

    const left = Number.parseFloat(wrapper.style.left);
    const top = Number.parseFloat(wrapper.style.top);
    // Max left/top: 1200-320-8 = 872 and 800-240-8 = 552.
    expect(left).toBeLessThanOrEqual(872);
    expect(top).toBeLessThanOrEqual(552);

    // Now try to drag off the top-left edge.
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: -99999, clientY: -99999 })
    );
    const left2 = Number.parseFloat(wrapper.style.left);
    const top2 = Number.parseFloat(wrapper.style.top);
    // Min left/top: 8 (POPUP_VIEWPORT_MARGIN).
    expect(left2).toBeGreaterThanOrEqual(8);
    expect(top2).toBeGreaterThanOrEqual(8);

    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    unmount();
  });

  it("mountPopup: mouseup ends drag — subsequent mousemoves do not move the popup", () => {
    const { ui } = createAdapter();
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const unmount = ui.mountPopup(document.createElement("section"), {
      anchor: {
        left: 100,
        top: 100,
        width: 80,
        height: 24,
        viewportWidth: 1200,
        viewportHeight: 800
      }
    });
    const wrapper = mustQueryElement(".zotero-ai-popup-wrapper");
    const header = mustQueryElement(".zotero-ai-popup-wrapper__header");
    const initialLeft = Number.parseFloat(wrapper.style.left);
    const initialTop = Number.parseFloat(wrapper.style.top);

    header.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        clientX: initialLeft + 10,
        clientY: initialTop + 10,
        button: 0
      })
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 200, clientY: 200 })
    );
    const afterDragLeft = wrapper.style.left;
    const afterDragTop = wrapper.style.top;
    expect(afterDragLeft).toBe("190px");
    expect(afterDragTop).toBe("190px");

    // Release the mouse — subsequent mousemoves must be ignored.
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 500, clientY: 500 })
    );
    expect(wrapper.style.left).toBe(afterDragLeft);
    expect(wrapper.style.top).toBe(afterDragTop);
    unmount();
  });

  it("mountPopup: drag mousedown calls preventDefault to suppress text selection", () => {
    const { ui } = createAdapter();
    const unmount = ui.mountPopup(document.createElement("section"), {
      anchor: {
        left: 100,
        top: 100,
        width: 80,
        height: 24,
        viewportWidth: 1200,
        viewportHeight: 800
      }
    });
    const header = mustQueryElement(".zotero-ai-popup-wrapper__header");
    // Construct a cancelable mousedown so defaultPrevented reliably flips.
    const ev = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      clientX: 110,
      clientY: 110,
      button: 0
    });
    header.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    unmount();
  });

  it("mountPopup: clicking the close button does NOT initiate a drag", () => {
    const { ui } = createAdapter();
    const unmount = ui.mountPopup(document.createElement("section"), {
      anchor: {
        left: 100,
        top: 100,
        width: 80,
        height: 24,
        viewportWidth: 1200,
        viewportHeight: 800
      }
    });
    const close = mustQueryButton('[data-action="close-popup"]');
    const wrapper = mustQueryElement(".zotero-ai-popup-wrapper");
    // Snapshot the inline style so we can prove drag did not alter it.
    const originalLeft = wrapper.style.left;
    const originalTop = wrapper.style.top;

    // Mousedown on the close button (which lives inside the header) must
    // not start a drag — otherwise a fast click + jitter would teleport
    // the popup before the close handler fires.
    const ev = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      clientX: 110,
      clientY: 110,
      button: 0
    });
    close.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    document.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 300, clientY: 300 })
    );
    expect(wrapper.style.left).toBe(originalLeft);
    expect(wrapper.style.top).toBe(originalTop);
    unmount();
  });

  it("computePopupPosition flips above when anchor sits in the lower half of the viewport", () => {
    const viewport = { width: 1200, height: 800 };
    // Anchor at top=500 — well below viewport.height/2 (400). Below-placement
    // (500 + 24 + 8 = 532) still fits (532 + 240 = 772 < 792 margin), so the
    // OLD rule would NOT flip. The NEW lower-half rule must flip above.
    const result = computePopupPosition({ left: 100, top: 500, width: 80, height: 24 }, viewport);
    expect(result.top).toBeLessThan(500);
  });

  it("computePopupPosition does NOT flip above when anchor sits in the upper half", () => {
    const viewport = { width: 1200, height: 800 };
    // Anchor at top=100 — upper half. Below-placement (100 + 24 + 8 = 132)
    // fits comfortably; expect popup placed below the anchor.
    const result = computePopupPosition({ left: 100, top: 100, width: 80, height: 24 }, viewport);
    expect(result.top).toBeGreaterThan(100);
  });

  it("openDialog falls back to documentElement when body is unavailable", () => {
    const debug = vi.fn();
    const fakeDoc: Document = Object.assign(document.implementation.createHTMLDocument("fake"), {});
    fakeDoc.body.remove();
    Object.defineProperty(fakeDoc, "body", { value: null, configurable: true });
    const fakeWindow = { document: fakeDoc } as unknown as Window & typeof globalThis;
    const zotero: ZoteroGlobal = {
      debug,
      getMainWindow: () => fakeWindow
    };
    const ui = createZoteroUiAdapter({ Zotero: zotero, pluginId: "test" });

    ui.openDialog("Settings", fakeDoc.createElement("p"));

    expect(fakeDoc.documentElement.querySelector(".zotero-ai-dialog")).not.toBeNull();
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining("mounted on documentElement because body is unavailable")
    );
  });
});
