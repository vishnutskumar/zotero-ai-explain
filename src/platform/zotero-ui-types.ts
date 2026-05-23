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

/**
 * Mode of a reader-selection command. `explain` mounts the popup and
 * auto-streams an explanation; `ask-question` opens the popup with the
 * selection preloaded as a quote block and waits for the user's first
 * question (no auto-explain).
 */
export type ReaderCommandMode = "explain" | "ask-question";

/**
 * A single reader-selection command. Multiple specs registered together
 * via {@link ZoteroUiAdapter.addReaderCommands} ride ONE
 * `renderTextSelectionPopup` listener and append one button each.
 */
export type ReaderCommandSpec = {
  readonly label: string;
  readonly mode: ReaderCommandMode;
  readonly action: (selection: SelectionContext) => void;
};

export type ZoteroUiAdapter = {
  addMenuItem(label: string, action: () => void): Unsubscribe;
  /**
   * Register one reader-event listener that appends one button per
   * {@link ReaderCommandSpec}. The button is hidden (not rendered) when
   * the reader reports no text selection.
   */
  addReaderCommands(commands: readonly ReaderCommandSpec[]): Unsubscribe;
  /**
   * Convenience wrapper — equivalent to
   * `addReaderCommands([{ label, mode: "explain", action }])`.
   */
  addReaderCommand(label: string, action: (selection: SelectionContext) => void): Unsubscribe;
  openDialog(title: string, content: HTMLElement): DialogHandle;
  mountPopup(content: HTMLElement, options?: PopupMountOptions): Unsubscribe;
  mountSidebar(content: HTMLElement, options?: SidebarMountOptions): Unsubscribe;
};
