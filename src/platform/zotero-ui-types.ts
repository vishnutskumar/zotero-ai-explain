import type { SelectionAnchor, SelectionContext } from "../selection/selection-context.js";

export type Unsubscribe = () => void;

export type PopupMountOptions = {
  /** Anchor rect (typically the reader-popup button) used to position the popup. */
  readonly anchor?: SelectionAnchor | null;
  /** Optional dismiss callback fired when the user closes via Escape, backdrop click, or close button. */
  readonly onDismiss?: () => void;
};

export type SidebarMountOptions = {
  /** Optional dismiss callback fired when the user closes via the in-header close button. */
  readonly onDismiss?: () => void;
};

/**
 * Handle returned by `openDialog`. Lets callers close the dialog
 * imperatively (e.g., after a successful settings save) without
 * synthesising a click on the close button.
 */
export type DialogHandle = {
  /** Tear down the dialog (idempotent). */
  close(): void;
  /**
   * Step the dialog aside without disposing it: drop the backdrop's
   * pointer-blocking, dock the body to the bottom-right corner of the
   * window with reduced opacity, and let the user click the underlying
   * Zotero pane. Clicking the dialog itself (or invoking restore())
   * brings it back to the centered, fully-opaque state. Idempotent.
   */
  minimize(): void;
  /** Reverse of minimize(); idempotent. */
  restore(): void;
};

export type ZoteroUiAdapter = {
  addMenuItem(label: string, action: () => void): Unsubscribe;
  addReaderCommand(label: string, action: (selection: SelectionContext) => void): Unsubscribe;
  openDialog(title: string, content: HTMLElement): DialogHandle;
  mountPopup(content: HTMLElement, options?: PopupMountOptions): Unsubscribe;
  mountSidebar(content: HTMLElement, options?: SidebarMountOptions): Unsubscribe;
};
