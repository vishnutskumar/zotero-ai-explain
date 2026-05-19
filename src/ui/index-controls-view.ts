import {
  describeIndexingStatus,
  type IndexingController
} from "../indexing/indexing-controller.js";
import type { IndexingStatus } from "../indexing/indexing-status.js";
import {
  BUTTON_BASE_STYLE,
  BUTTON_PRIMARY_STYLE,
  BUTTON_ROW_STYLE,
  FG_MUTED,
  applyFocusRing,
  applyHoverState
} from "./styles.js";

export function renderIndexControls(status: IndexingStatus): HTMLElement {
  const element = document.createElement("section");
  element.className = "zotero-ai-index-controls";
  element.setAttribute("style", "display: flex; flex-direction: column; gap: 8px;");

  // NOTE: no local heading — the settings dialog renders the
  // "Library Index" section heading + blurb above. Duplicating it here
  // (as the original version did) produced two stacked "LIBRARY INDEX"
  // labels in the rendered dialog.
  const summary = document.createElement("p");
  summary.className = "zotero-ai-index-controls__summary";
  summary.textContent = describeIndexingStatus(status);
  summary.setAttribute("style", `margin: 0; font-size: 11px; color: ${FG_MUTED};`);

  const buttons = document.createElement("div");
  buttons.className = "zotero-ai-index-controls__buttons";
  buttons.setAttribute("style", BUTTON_ROW_STYLE);

  const start = makeButton("start-index", "Index library", true);
  const pause = makeButton("pause-index", "Pause", false);
  const resume = makeButton("resume-index", "Resume", false);
  const clear = makeButton("clear-index", "Clear index", false);

  buttons.append(start, pause, resume, clear);
  element.append(summary, buttons);
  return element;
}

export type IndexControlsDetach = () => void;

/**
 * Wire the index-control buttons inside `root` to dispatch through the
 * indexing controller, and update the visible status line on every state
 * change. Returns a detacher to remove the subscription on unmount.
 *
 * `root` may be the element returned by {@link renderIndexControls} OR
 * any ancestor (the settings form) that contains it; we look up by class
 * so the wiring works whether the controls are mounted alone or inside
 * the settings dialog.
 */
export function attachIndexControls(
  root: ParentNode,
  controller: IndexingController
): IndexControlsDetach {
  const summary = root.querySelector<HTMLElement>(".zotero-ai-index-controls__summary");
  const updateSummary = (): void => {
    if (summary !== null) {
      summary.textContent = describeIndexingStatus(controller.getStatus());
    }
  };

  const bindings: { selector: string; handler: () => void }[] = [
    {
      selector: '[data-action="start-index"]',
      handler: () => {
        controller.start();
      }
    },
    {
      selector: '[data-action="pause-index"]',
      handler: () => {
        controller.pause();
      }
    },
    {
      selector: '[data-action="resume-index"]',
      handler: () => {
        controller.resume();
      }
    },
    {
      selector: '[data-action="clear-index"]',
      handler: () => {
        // AC4: `clear()` returns `Promise<void>` so the e2e harness can
        // sequence the Clear button against the storage flush. The UI
        // glue itself is fire-and-forget — the controller's listener
        // chain repaints the summary when the cleared reducer action
        // fires, so we don't need to await here.
        void controller.clear();
      }
    }
  ];

  const removers: (() => void)[] = [];
  for (const { selector, handler } of bindings) {
    const button = root.querySelector<HTMLButtonElement>(selector);
    if (button === null) {
      continue;
    }
    button.addEventListener("click", handler);
    removers.push(() => {
      button.removeEventListener("click", handler);
    });
  }

  const unsubscribe = controller.subscribe(() => {
    updateSummary();
  });
  updateSummary();

  return () => {
    unsubscribe();
    for (const remove of removers) {
      remove();
    }
  };
}

function makeButton(action: string, label: string, primary: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.textContent = label;
  button.setAttribute("style", primary ? BUTTON_PRIMARY_STYLE : BUTTON_BASE_STYLE);
  applyFocusRing(button);
  if (!primary) {
    applyHoverState(button);
  }
  return button;
}
