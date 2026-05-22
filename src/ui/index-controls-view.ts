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

/** Default label for the destructive clear button (its disarmed state). */
const CLEAR_LABEL = "Clear index";
/** Label shown once the two-stage clear confirm has been armed. */
const CLEAR_CONFIRM_LABEL = "Confirm clear";

/**
 * AC-14 Fix 1: whether a `start()` click on the controller can actually
 * begin a run. A click is a SILENT no-op while a run is in flight
 * (`running`/`paused`) or while an AC-5 migration owns the index
 * (`migrationActive`). The button is disabled in exactly those cases so
 * the user is never left wondering why nothing happened.
 */
function startBlocked(status: IndexingStatus): boolean {
  return status.state === "running" || status.state === "paused" || status.migrationActive === true;
}

/**
 * AC-14 Fix 1: the short no-op-reason fragment appended to the status
 * summary so a disabled "Index library" button is always explained.
 * Returns `""` when a run is startable (nothing to explain).
 */
function noOpReason(status: IndexingStatus): string {
  if (status.migrationActive === true) {
    return "Migrating the index — please wait…";
  }
  if (status.state === "running") {
    return "Already indexing…";
  }
  if (status.state === "paused") {
    return "Paused — use Resume to continue.";
  }
  return "";
}

/**
 * AC-14 Fix 2: the indexed-item count quoted in the destructive-clear
 * consequence line. Uses the LARGER of `previouslyIndexed` and the
 * live-run `indexedItems` so the count is never understated — a clear
 * deletes every embedded item regardless of which counter is higher.
 */
function clearItemCount(status: IndexingStatus): number {
  return Math.max(status.previouslyIndexed ?? 0, status.indexedItems);
}

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
  summary.textContent = composeSummary(status, false);
  summary.setAttribute("style", `margin: 0; font-size: 11px; color: ${FG_MUTED};`);

  const buttons = document.createElement("div");
  buttons.className = "zotero-ai-index-controls__buttons";
  buttons.setAttribute("style", BUTTON_ROW_STYLE);

  const start = makeButton("start-index", "Index library", true);
  const pause = makeButton("pause-index", "Pause", false);
  const resume = makeButton("resume-index", "Resume", false);
  const clear = makeButton("clear-index", CLEAR_LABEL, false);

  // AC-14 Fix 1: set the initial `disabled` flags so `renderIndexControls`
  // alone (before `attachIndexControls` wires the controller) already
  // reflects whether each lifecycle action can run. `attachIndexControls`
  // recomputes these on every status change.
  setDisabled(start, startBlocked(status));
  setDisabled(pause, status.state !== "running");
  setDisabled(resume, status.state !== "paused");
  setDisabled(clear, status.migrationActive === true);

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
  const startBtn = root.querySelector<HTMLButtonElement>('[data-action="start-index"]');
  const pauseBtn = root.querySelector<HTMLButtonElement>('[data-action="pause-index"]');
  const resumeBtn = root.querySelector<HTMLButtonElement>('[data-action="resume-index"]');
  const clearBtn = root.querySelector<HTMLButtonElement>('[data-action="clear-index"]');

  // AC-14 Fix 2: the two-stage clear confirm is VIEW-LOCAL — a closure
  // flag, never controller state. The controller is unaware a confirm is
  // pending; it only ever sees the real `clear()` on the second click.
  let pendingClearConfirm = false;

  /**
   * AC-14 Fix 1 + Fix 2: recompute every button's `disabled` flag and
   * repaint the status summary (base text + no-op reason fragment +,
   * while a clear confirm is armed, the destructive-consequence line).
   */
  const refreshControls = (): void => {
    const status = controller.getStatus();
    setDisabled(startBtn, startBlocked(status));
    setDisabled(pauseBtn, status.state !== "running");
    setDisabled(resumeBtn, status.state !== "paused");
    // A clear during a migration is controller-safe, but the two-stage
    // destructive confirm would be confusing mid-migration — disable it.
    setDisabled(clearBtn, status.migrationActive === true);
    if (summary !== null) {
      summary.textContent = composeSummary(status, pendingClearConfirm);
    }
  };

  /**
   * AC-14 Fix 2: cancel a pending clear confirm and repaint. Clicking
   * any other control reverts the relabelled button to "Clear index"
   * and drops the consequence line so a stale confirm can never latch
   * into a later destructive click.
   */
  const cancelClearConfirm = (): void => {
    if (!pendingClearConfirm) {
      return;
    }
    pendingClearConfirm = false;
    if (clearBtn !== null) {
      clearBtn.textContent = CLEAR_LABEL;
    }
  };

  const bindings: { button: HTMLButtonElement | null; handler: () => void }[] = [
    {
      button: startBtn,
      handler: () => {
        // AC-14 Fix 2: clicking another control cancels a pending
        // clear confirm before dispatching this action.
        cancelClearConfirm();
        controller.start();
      }
    },
    {
      button: pauseBtn,
      handler: () => {
        cancelClearConfirm();
        controller.pause();
      }
    },
    {
      button: resumeBtn,
      handler: () => {
        cancelClearConfirm();
        controller.resume();
      }
    },
    {
      button: clearBtn,
      handler: () => {
        if (!pendingClearConfirm) {
          // AC-14 Fix 2 — first click: ARM the confirm. Relabel the
          // button and write the concrete N-item consequence line; do
          // NOT call `clear()`.
          pendingClearConfirm = true;
          if (clearBtn !== null) {
            clearBtn.textContent = CLEAR_CONFIRM_LABEL;
          }
          refreshControls();
          return;
        }
        // Second click — CONFIRM: dispatch the real destructive clear
        // and disarm. `clear()` returns `Promise<void>`; the UI glue is
        // fire-and-forget — the controller's listener chain repaints the
        // summary when the `cleared` reducer action fires.
        pendingClearConfirm = false;
        if (clearBtn !== null) {
          clearBtn.textContent = CLEAR_LABEL;
        }
        void controller.clear();
      }
    }
  ];

  const removers: (() => void)[] = [];
  for (const { button, handler } of bindings) {
    if (button === null) {
      continue;
    }
    button.addEventListener("click", handler);
    removers.push(() => {
      button.removeEventListener("click", handler);
    });
  }

  const unsubscribe = controller.subscribe(() => {
    // AC-14 Fix 2: a controller status change also cancels a pending
    // confirm — the run that just transitioned changed the picture, so
    // a stale confirm must not survive.
    cancelClearConfirm();
    refreshControls();
  });
  refreshControls();

  return () => {
    unsubscribe();
    for (const remove of removers) {
      remove();
    }
  };
}

/**
 * Compose the visible status line: the base `describeIndexingStatus`
 * text, plus the AC-14 no-op-reason fragment, plus — while a clear
 * confirm is armed — the destructive-consequence line naming the
 * indexed-item count.
 */
function composeSummary(status: IndexingStatus, clearConfirmArmed: boolean): string {
  const parts = [describeIndexingStatus(status)];
  const reason = noOpReason(status);
  if (reason.length > 0) {
    parts.push(reason);
  }
  if (clearConfirmArmed) {
    const n = String(clearItemCount(status));
    parts.push(
      `This deletes all ${n} embedded items. Re-indexing will re-embed your ` +
        `whole library. Click "${CLEAR_CONFIRM_LABEL}" again to proceed, or any ` +
        `other button to cancel.`
    );
  }
  return parts.join(" ");
}

/**
 * Toggle a button's disabled affordance. Sets the native `disabled`
 * property (so a disabled button cannot dispatch an ignored action) plus
 * `aria-disabled` and a muted opacity so the visual matches the state.
 */
function setDisabled(button: HTMLButtonElement | null, disabled: boolean): void {
  if (button === null) {
    return;
  }
  button.disabled = disabled;
  button.setAttribute("aria-disabled", disabled ? "true" : "false");
  button.style.opacity = disabled ? "0.5" : "";
  button.style.cursor = disabled ? "default" : "pointer";
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
