import type { SelectionContext } from "../selection/selection-context.js";

export type Unsubscribe = () => void;

export type ZoteroUiAdapter = {
  addMenuItem(label: string, action: () => void): Unsubscribe;
  addReaderCommand(label: string, action: (selection: SelectionContext) => void): Unsubscribe;
  openDialog(title: string, content: HTMLElement): void;
  mountPopup(content: HTMLElement): Unsubscribe;
  mountSidebar(content: HTMLElement): Unsubscribe;
};
