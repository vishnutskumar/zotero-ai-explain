import type { SelectionContext } from "../selection/selection-context.js";
import { renderMarkdown } from "./markdown.js";
import {
  BORDER_HAIRLINE,
  BUTTON_BASE_STYLE,
  BUTTON_PRIMARY_STYLE,
  BUTTON_ROW_STYLE,
  FG_MUTED,
  FIELD_TEXTAREA_STYLE,
  FONT_STACK,
  MARKDOWN_CSS,
  applyFocusRing,
  applyHoverState
} from "./styles.js";

export type AnchoredPopupInput = {
  readonly disclosure: string;
  readonly anchor: SelectionContext["anchor"];
  readonly text: string;
  /**
   * Popup mode. `explain` (default) auto-streams an explanation on open.
   * `ask-question` renders the selection as a sticky quote block, focuses
   * the textarea, and waits for the user's first question (no auto-stream).
   */
  readonly mode?: "explain" | "ask-question";
  /** Selection text rendered as a quote block — used only in `ask-question` mode. */
  readonly quote?: string;
};

/**
 * Render the inner content of the response popup. The wrapper (positioning,
 * close button, viewport guards) is owned by the UI adapter's `mountPopup`;
 * this function only renders the disclosure, body, loading affordance,
 * action buttons, and inline follow-up form.
 */
export function renderAnchoredPopup(input: AnchoredPopupInput): HTMLElement {
  const mode = input.mode ?? "explain";
  const element = document.createElement("section");
  element.className = "zotero-ai-explain-popup";
  element.dataset.mode = mode;
  // The wrapper from `mountPopup` owns positioning (position: fixed; top; left).
  // Setting `position: absolute; left; top` here would create a positioned
  // descendant that escapes the wrapper's max-width and lands at
  // `(wrapper.left + anchor.left, wrapper.top + anchor.top)` in viewport
  // coords — observed as a 1100px-wide popup at the top of the page when the
  // anchor was correct. Only set layout-neutral styles here.
  void input.anchor;
  element.style.display = "flex";
  element.style.flexDirection = "column";
  element.style.gap = "8px";
  element.style.fontFamily = FONT_STACK;

  const disclosure = document.createElement("p");
  disclosure.className = "zotero-ai-explain-popup__disclosure";
  disclosure.textContent = input.disclosure;
  disclosure.setAttribute(
    "style",
    `margin: 0; font-size: 11px; line-height: 1.4; color: ${FG_MUTED};`
  );

  const body = document.createElement("div");
  body.className = "zotero-ai-explain-popup__body";
  // Render the (possibly empty) body through the markdown renderer so the
  // initial paint already has structured DOM if the stream began with a
  // heading or code fence. `renderMarkdown` clears the target and reparses
  // each call, so streaming deltas can call it again without diffing.
  renderMarkdown(body, input.text);
  // The body reads as a normal paragraph; keep it dense but not cramped.
  // No overflow constraint here — the popup wrapper owns scrolling.
  // `white-space: pre-wrap` preserves blank lines INSIDE rendered paragraphs
  // (markdown collapses inter-block whitespace into structure, so this only
  // affects raw text inside <p>, <li>, etc.).
  body.setAttribute(
    "style",
    "margin: 0; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;"
  );

  // CSS for the loading-dot animation. Layout properties (display,
  // align-items) MUST live here rather than inline — an inline
  // `display: inline-flex` would override the UA stylesheet's
  // `[hidden] { display: none }`, defeating `loading.hidden = true`
  // and leaving the spinner visible after the response completes.
  const styleTag = document.createElement("style");
  styleTag.textContent = `
    @keyframes zotero-ai-explain-loading-pulse {
      0%, 80%, 100% { opacity: 0.2; transform: scale(0.85); }
      40% { opacity: 1; transform: scale(1); }
    }
    .zotero-ai-explain-popup__loading:not([hidden]) {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .zotero-ai-explain-popup__loading-dot {
      display: inline-block;
      width: 5px;
      height: 5px;
      margin: 0 2px;
      border-radius: 50%;
      background: currentColor;
      vertical-align: middle;
      animation: zotero-ai-explain-loading-pulse 1.2s infinite ease-in-out;
    }
    .zotero-ai-explain-popup__loading-dot:nth-child(2) { animation-delay: 0.15s; }
    .zotero-ai-explain-popup__loading-dot:nth-child(3) { animation-delay: 0.3s; }
    /* Chat-bubble layout for the message thread. User on the right with
       an accent background; assistant on the left with a neutral fill.
       The body (first assistant turn) also gets the left-bubble style. */
    .zotero-ai-explain-popup__body,
    .zotero-ai-explain-popup__turn {
      max-width: 88%;
      padding: 8px 12px;
      border-radius: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .zotero-ai-explain-popup__body,
    .zotero-ai-explain-popup__turn[data-role="assistant"] {
      align-self: flex-start;
      background: rgba(127, 127, 127, 0.15);
      border-bottom-left-radius: 4px;
    }
    .zotero-ai-explain-popup__turn[data-role="user"] {
      align-self: flex-end;
      background: rgba(64, 128, 255, 0.22);
      border-bottom-right-radius: 4px;
    }
    .zotero-ai-explain-popup__turn-role {
      display: none; /* role is communicated by side + colour, not text */
    }
    .zotero-ai-explain-popup__turns {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
${MARKDOWN_CSS}
  `;

  const loading = document.createElement("div");
  loading.className = "zotero-ai-explain-popup__loading";
  loading.dataset.state = "loading";
  loading.setAttribute("role", "status");
  loading.setAttribute("aria-live", "polite");
  loading.setAttribute(
    "style",
    `margin: 0; font-size: 12px; color: ${FG_MUTED}; font-style: italic;`
  );
  const loadingLabel = document.createElement("span");
  loadingLabel.textContent = "Working";
  loadingLabel.className = "zotero-ai-explain-popup__loading-label";
  const dot1 = document.createElement("span");
  dot1.className = "zotero-ai-explain-popup__loading-dot";
  const dot2 = document.createElement("span");
  dot2.className = "zotero-ai-explain-popup__loading-dot";
  const dot3 = document.createElement("span");
  dot3.className = "zotero-ai-explain-popup__loading-dot";
  loading.append(loadingLabel, dot1, dot2, dot3);
  // In `ask-question` mode the popup never auto-streams — it waits for the
  // user's first question, so the loading indicator starts hidden.
  if (input.text.length > 0 || mode === "ask-question") {
    loading.hidden = true;
  }

  // Error block — separate from `body` so the error styling is visually
  // distinct (red border + role label) and doesn't pollute the markdown
  // tree when the user later retries. Hidden by default; the runtime
  // populates + reveals it when the conversation status flips to failed.
  const errorBlock = document.createElement("div");
  errorBlock.className = "zotero-ai-explain-popup__error";
  errorBlock.dataset.role = "error";
  errorBlock.hidden = true;
  errorBlock.setAttribute("role", "alert");
  errorBlock.setAttribute(
    "style",
    `margin: 0; padding: 8px 10px; border: 1px solid #c33; border-left: 3px solid #c33; ` +
      `border-radius: 4px; background: rgba(204, 51, 51, 0.08); font-size: 12px; ` +
      `line-height: 1.4; color: inherit;`
  );
  const errorLabel = document.createElement("strong");
  errorLabel.textContent = "Error";
  errorLabel.setAttribute("style", "color: #c33; display: block; margin-bottom: 2px;");
  const errorMessage = document.createElement("span");
  errorMessage.className = "zotero-ai-explain-popup__error-message";
  errorMessage.setAttribute("style", "white-space: pre-wrap; word-break: break-word;");
  errorBlock.append(errorLabel, errorMessage);

  const actions = document.createElement("div");
  actions.className = "zotero-ai-explain-popup__actions";
  actions.setAttribute("style", BUTTON_ROW_STYLE);

  const sidebar = document.createElement("button");
  sidebar.type = "button";
  sidebar.dataset.action = "continue-sidebar";
  sidebar.textContent = "Open in sidebar";
  sidebar.setAttribute("style", BUTTON_PRIMARY_STYLE);
  applyFocusRing(sidebar);

  const retry = document.createElement("button");
  retry.type = "button";
  retry.dataset.action = "retry";
  retry.textContent = "Retry";
  retry.setAttribute("style", BUTTON_BASE_STYLE);
  applyFocusRing(retry);
  applyHoverState(retry);

  actions.append(sidebar, retry);

  // AC5: inline follow-up form. Submitting fires a `submit` event on the
  // <form>; the runtime listens for it and calls
  // `popupController.sendFollowUp` with the textarea's current value.
  const followForm = document.createElement("form");
  followForm.className = "zotero-ai-explain-popup__form";
  followForm.setAttribute(
    "style",
    `display: flex; flex-direction: column; gap: 6px; padding-top: 8px; ` +
      `border-top: 1px solid ${BORDER_HAIRLINE};`
  );

  const followUp = document.createElement("textarea");
  followUp.name = "followUp";
  // In ask-question mode the textarea hosts the FIRST question, so it is
  // labelled accordingly; in explain mode it is the follow-up box.
  followUp.placeholder = mode === "ask-question" ? "Ask a question" : "Ask a follow-up";
  followUp.setAttribute("style", `${FIELD_TEXTAREA_STYLE} min-height: 48px;`);
  applyFocusRing(followUp);

  const send = document.createElement("button");
  send.type = "submit";
  send.dataset.action = "send-follow-up";
  send.textContent = "Send";
  send.setAttribute("style", `${BUTTON_PRIMARY_STYLE} align-self: flex-end;`);
  applyFocusRing(send);

  followForm.append(followUp, send);

  // Container for streaming follow-up turns (rendered as <article>s appended
  // by the runtime; tests look for `.zotero-ai-explain-popup__turns`).
  const turns = document.createElement("div");
  turns.className = "zotero-ai-explain-popup__turns";
  turns.setAttribute("style", "display: flex; flex-direction: column; gap: 8px;");

  // Ask-question mode: render the selection as a sticky quote block at the
  // top of the popup so the user sees what their question is anchored to.
  const children: HTMLElement[] = [styleTag];
  if (mode === "ask-question") {
    const quoteBlock = document.createElement("blockquote");
    quoteBlock.className = "zotero-ai-explain-popup__quote";
    quoteBlock.dataset.role = "quote";
    quoteBlock.textContent = input.quote ?? "";
    quoteBlock.setAttribute(
      "style",
      `margin: 0; padding: 6px 10px; border-left: 3px solid ${BORDER_HAIRLINE}; ` +
        `background: rgba(127, 127, 127, 0.12); border-radius: 4px; font-size: 12px; ` +
        `line-height: 1.45; font-style: italic; white-space: pre-wrap; word-break: break-word;`
    );
    children.push(quoteBlock);
  }
  children.push(disclosure, body, errorBlock, turns, loading, actions, followForm);
  element.append(...children);

  // Focus the textarea on mount in ask-question mode so the user can type
  // their question immediately. `requestAnimationFrame` defers the call to
  // after the element is attached to the document; a synchronous `focus()`
  // on a detached node is a no-op.
  if (mode === "ask-question") {
    const view = element.ownerDocument.defaultView;
    if (view !== null) {
      view.requestAnimationFrame(() => {
        followUp.focus();
      });
    } else {
      followUp.focus();
    }
  }

  return element;
}
