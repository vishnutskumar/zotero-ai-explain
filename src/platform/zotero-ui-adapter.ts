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
      if (!document?.body) {
        input.Zotero.debug(`Zotero AI Explain could not open dialog: ${title}`);
        return;
      }
      const dialog = document.createElement("section");
      dialog.className = "zotero-ai-dialog";
      dialog.setAttribute("aria-label", title);
      dialog.append(content);
      document.body.append(dialog);
    },
    mountPopup(content): Unsubscribe {
      const mainWindow = input.Zotero.getMainWindow?.();
      mainWindow?.document.body.append(content);
      return () => {
        content.remove();
      };
    },
    mountSidebar(content): Unsubscribe {
      const mainWindow = input.Zotero.getMainWindow?.();
      mainWindow?.document.body.append(content);
      return () => {
        content.remove();
      };
    }
  };
}
