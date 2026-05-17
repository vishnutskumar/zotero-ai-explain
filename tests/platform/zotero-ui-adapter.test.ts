/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createZoteroUiAdapter, type ZoteroGlobal } from "../../src/platform/zotero-ui-adapter.js";

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
