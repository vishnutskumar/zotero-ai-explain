import type { ChatMessage } from "../providers/provider-types.js";
import { renderMarkdown } from "./markdown.js";
import {
  ACCENT,
  BORDER_HAIRLINE,
  BUTTON_PRIMARY_STYLE,
  FG,
  FG_MUTED,
  FIELD_TEXTAREA_STYLE,
  FONT_STACK,
  MARKDOWN_CSS,
  STRIPE_BG,
  SURFACE_BG,
  TOOLBAR_BG,
  applyFocusRing
} from "./styles.js";

/**
 * Close-button style matched to the popup's `×` button (see
 * `POPUP_CLOSE_STYLE` in `src/platform/zotero-ui-adapter.ts`). Kept inline
 * with the view so the sidebar renders self-contained without leaking a
 * style constant out of the platform adapter (which owns popup chrome).
 */
const SIDEBAR_CLOSE_STYLE =
  `appearance: none; border: 1px solid transparent; background: transparent; color: ${FG}; ` +
  "width: 22px; height: 22px; padding: 0; border-radius: 4px; cursor: pointer; " +
  "font-size: 16px; line-height: 1; display: inline-flex; align-items: center; justify-content: center;";

export function renderSidebarConversation(input: {
  readonly quote: string;
  readonly sourceLabel: string;
  readonly messages: readonly ChatMessage[];
}): HTMLElement {
  const element = document.createElement("aside");
  element.className = "zotero-ai-explain-sidebar";
  element.setAttribute(
    "style",
    `display: flex; flex-direction: column; height: 100%; font-family: ${FONT_STACK};`
  );

  // The sidebar mounts MARKDOWN_CSS so its body divs share popup
  // typography, plus chat-bubble layout rules so each `<li>` turn
  // renders as a left (assistant) or right (user) bubble. Role text
  // is hidden — the side + colour carries the signal.
  const styleTag = document.createElement("style");
  styleTag.textContent = `${MARKDOWN_CSS}
    .zotero-ai-explain-sidebar__turn {
      max-width: 88%;
      padding: 8px 12px;
      border-radius: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .zotero-ai-explain-sidebar__turn[data-role="assistant"] {
      align-self: flex-start;
      background: rgba(127, 127, 127, 0.15);
      border-bottom-left-radius: 4px;
    }
    .zotero-ai-explain-sidebar__turn[data-role="user"] {
      align-self: flex-end;
      background: rgba(64, 128, 255, 0.22);
      border-bottom-right-radius: 4px;
    }
    .zotero-ai-explain-sidebar__role {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }`;

  // Header: selection quote + source label + close button. Pinned at the top
  // so the user always sees what they asked about as the conversation scrolls.
  const header = document.createElement("header");
  header.className = "zotero-ai-explain-sidebar__header";
  header.setAttribute(
    "style",
    `padding: 12px 16px; background: ${TOOLBAR_BG}; ` +
      `border-bottom: 1px solid ${BORDER_HAIRLINE}; ` +
      "display: flex; flex-direction: column; gap: 4px;"
  );

  // Top row hosts the close `×` so it sits on the same baseline as the
  // quote without overlapping it. The button is rendered before the quote
  // so screen readers announce the dismiss control near the top.
  const topRow = document.createElement("div");
  topRow.setAttribute(
    "style",
    "display: flex; align-items: flex-start; justify-content: flex-end; min-height: 22px;"
  );

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "zotero-ai-explain-sidebar__close";
  closeButton.dataset.action = "close-sidebar";
  closeButton.setAttribute("aria-label", "Close");
  // Literal multiplication sign (×) to match the popup close affordance.
  closeButton.textContent = "×";
  closeButton.setAttribute("style", SIDEBAR_CLOSE_STYLE);
  applyFocusRing(closeButton);
  topRow.append(closeButton);

  const quote = document.createElement("blockquote");
  quote.textContent = input.quote;
  quote.setAttribute(
    "style",
    `margin: 0; padding: 8px 12px; border-left: 2px solid ${ACCENT}; ` +
      `background: ${STRIPE_BG}; color: ${FG}; ` +
      `font-size: 12px; line-height: 1.4; font-style: italic; ` +
      "max-height: 5.6em; overflow: auto;"
  );

  const source = document.createElement("p");
  source.className = "zotero-ai-explain-sidebar__source";
  source.textContent = input.sourceLabel;
  source.setAttribute("style", `margin: 0; font-size: 11px; color: ${FG_MUTED};`);

  header.append(topRow, quote, source);

  // Message stack: chronological turns. Each row gets an attribution
  // line in the muted color and the body in primary text.
  const messages = document.createElement("ol");
  messages.className = "zotero-ai-explain-sidebar__messages";
  messages.setAttribute(
    "style",
    "list-style: none; margin: 0; padding: 12px 16px; flex: 1 1 auto; " +
      "overflow-y: auto; display: flex; flex-direction: column; gap: 10px;"
  );

  // Skip system messages — they're prompt frames meant for the model,
  // not user-visible turns. The popup never renders them; symmetry.
  for (const message of input.messages) {
    if (message.role === "system") continue;
    messages.append(renderMessage(message));
  }

  // Footer form: textarea + send button, pinned at the bottom so it
  // stays visible while messages scroll above it.
  const form = document.createElement("form");
  form.className = "zotero-ai-explain-sidebar__form";
  form.setAttribute(
    "style",
    `padding: 12px 16px; border-top: 1px solid ${BORDER_HAIRLINE}; ` +
      `background: ${SURFACE_BG}; display: flex; flex-direction: column; gap: 8px;`
  );

  const followUp = document.createElement("textarea");
  followUp.name = "followUp";
  followUp.placeholder = "Ask a follow-up";
  followUp.setAttribute("style", FIELD_TEXTAREA_STYLE);
  applyFocusRing(followUp);

  const send = document.createElement("button");
  send.type = "submit";
  send.dataset.action = "send-follow-up";
  send.textContent = "Send";
  send.setAttribute("style", `${BUTTON_PRIMARY_STYLE} align-self: flex-end;`);
  applyFocusRing(send);

  form.append(followUp, send);
  element.append(styleTag, header, messages, form);

  return element;
}

function renderMessage(message: ChatMessage): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "zotero-ai-explain-sidebar__turn";
  row.dataset.role = message.role;

  // Kept for assistive tech; CSS `display: none` hides it visually so
  // role is communicated by bubble side + colour.
  const attribution = document.createElement("span");
  attribution.className = "zotero-ai-explain-sidebar__role";
  attribution.textContent = `${message.role}: `;

  const body = document.createElement("div");
  body.className = "zotero-ai-explain-sidebar__body";
  renderMarkdown(body, message.content);

  row.append(attribution, body);
  return row;
}
