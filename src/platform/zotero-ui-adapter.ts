import type { SelectionContext } from "../selection/selection-context.js";
import type { Unsubscribe, ZoteroUiAdapter } from "./zotero-ui-types.js";

type ReaderEvent = {
  readonly doc: Document;
  readonly params?: { readonly annotation?: { readonly text?: string } };
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

const DIALOG_BACKDROP_STYLE =
  "position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 999998;";
const DIALOG_CONTENT_STYLE =
  "position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); " +
  "z-index: 999999; max-width: 480px; min-width: 320px; padding: 24px; " +
  "background: var(--material-background, white); color: var(--material-color, black); " +
  "border-radius: 8px; max-height: 80vh; overflow: auto; box-shadow: 0 12px 36px rgba(0,0,0,0.3);";
const POPUP_WRAPPER_STYLE =
  "position: fixed; top: 80px; left: 50%; transform: translateX(-50%); " +
  "z-index: 999999; max-width: 480px; min-width: 280px; padding: 16px; " +
  "background: var(--material-background, white); color: inherit; border-radius: 6px; " +
  "box-shadow: 0 8px 24px rgba(0,0,0,0.25); max-height: 60vh; overflow: auto;";
const SIDEBAR_WRAPPER_STYLE =
  "position: fixed; top: 0; right: 0; height: 100vh; width: 360px; max-width: 40vw; " +
  "z-index: 999998; background: var(--material-background, white); color: inherit; " +
  "box-shadow: -4px 0 12px rgba(0,0,0,0.2); padding: 16px; overflow: auto; " +
  "display: flex; flex-direction: column; gap: 12px;";

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
    addReaderCommand(label, action): Unsubscribe {
      const handler = (event: ReaderEvent): void => {
        const quote = event.params?.annotation?.text?.trim() ?? "";
        const button = event.doc.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => {
          const selection: SelectionContext = {
            quote,
            source: {
              itemKey: null,
              itemTitle: null,
              attachmentKey: null,
              pageLabel: null,
              location: null
            },
            anchor: null
          };
          action(selection);
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
      input.Zotero.debug(`Zotero AI Explain registered reader command: ${label}`);
      return () => {
        reader.unregisterEventListener("renderTextSelectionPopup", handler);
      };
    },
    openDialog(title, content): void {
      const mainWindow = input.Zotero.getMainWindow?.();
      const document = mainWindow?.document;
      if (!document) {
        input.Zotero.debug(`Zotero AI Explain could not open dialog: ${title}`);
        return;
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

      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.dataset.action = "close-dialog";
      closeButton.textContent = "Close";
      closeButton.setAttribute(
        "style",
        "position: absolute; top: 8px; right: 8px; padding: 4px 12px; cursor: pointer;"
      );

      const dispose = (): void => {
        document.removeEventListener("keydown", onKeydown);
        backdrop.remove();
        dialog.remove();
      };

      function onKeydown(event: KeyboardEvent): void {
        if (event.key === "Escape") {
          dispose();
        }
      }

      backdrop.addEventListener("click", dispose);
      closeButton.addEventListener("click", dispose);
      document.addEventListener("keydown", onKeydown);

      dialog.append(closeButton, content);
      appendFloatingLayer(input.Zotero, document, backdrop, "dialog backdrop");
      appendFloatingLayer(input.Zotero, document, dialog, "dialog");
      input.Zotero.debug(`Zotero AI Explain opened dialog: ${title}`);
    },
    mountPopup(content): Unsubscribe {
      const mainWindow = input.Zotero.getMainWindow?.();
      const document = mainWindow?.document;
      if (!document) {
        input.Zotero.debug("Zotero AI Explain could not mount popup: no document");
        return noOp;
      }
      const wrapper = document.createElement("div");
      wrapper.className = "zotero-ai-popup-wrapper";
      wrapper.setAttribute("style", POPUP_WRAPPER_STYLE);
      wrapper.append(content);
      appendFloatingLayer(input.Zotero, document, wrapper, "popup");
      return () => {
        wrapper.remove();
      };
    },
    mountSidebar(content): Unsubscribe {
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
      appendFloatingLayer(input.Zotero, document, wrapper, "sidebar");
      return () => {
        wrapper.remove();
      };
    }
  };
}
