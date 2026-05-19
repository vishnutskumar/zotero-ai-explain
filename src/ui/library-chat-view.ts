/**
 * NotebookLM-style library chat view.
 *
 * Renders a chat thread + question form. Citations of the form `[KEY]`
 * inside assistant messages render as clickable `<a data-item-key="...">`
 * links — clicks are dispatched through the wire's `onCitationClick`
 * callback. Citation rendering is XSS-safe: every text fragment is
 * inserted via `createTextNode` and every element via `createElement`;
 * `innerHTML` is never used.
 *
 * The view is self-contained — it does not own the conversation store
 * or runtime; callers re-render by replacing the messages container's
 * children whenever the underlying state changes.
 */

import type { ChatMessage } from "../providers/provider-types.js";
import type { RetrievedChunk } from "../indexing/index-search.js";
import {
  ACCENT,
  BORDER_HAIRLINE,
  BUTTON_BASE_STYLE,
  BUTTON_PRIMARY_STYLE,
  FG,
  FG_MUTED,
  FIELD_TEXTAREA_STYLE,
  FONT_STACK,
  SURFACE_BG,
  TOOLBAR_BG,
  applyFocusRing
} from "./styles.js";

export type LibraryChatViewInput = {
  readonly messages: readonly ChatMessage[];
  readonly status: "idle" | "streaming" | "completed" | "failed";
  readonly errorMessage: string | null;
  readonly hasIndex: boolean;
};

/**
 * Regex that matches a bracketed item key: `[ABCD1234]`, `[XYZ99]`, etc.
 * Zotero item keys are 8 alphanumeric chars in practice but to be liberal
 * we accept any string of word characters (letters, digits, underscore)
 * of length 3-32 between square brackets. Anything else (e.g. `[<img>]`)
 * does NOT match, so injection payloads fall through to literal text.
 */
const CITATION_PATTERN = /\[([A-Za-z0-9_]{3,32})\]/gu;

const MESSAGES_STYLE =
  "list-style: none; margin: 0; padding: 12px 16px; flex: 1 1 auto; " +
  "overflow-y: auto; display: flex; flex-direction: column; gap: 10px;";

export function renderLibraryChatView(input: LibraryChatViewInput): HTMLElement {
  const root = document.createElement("aside");
  root.className = "zotero-ai-library-chat";
  root.setAttribute(
    "style",
    `display: flex; flex-direction: column; min-height: 360px; max-height: 70vh; ` +
      `font-family: ${FONT_STACK}; color: ${FG};`
  );

  // Chat-bubble + streaming-dots styling. The CSS lives in a `<style>`
  // tag rather than inline so the UA stylesheet's `[hidden] { display: none }`
  // is not overridden by an inline `display:` declaration (the popup
  // had this exact bug — see anchored-popup-view.ts).
  const styleTag = document.createElement("style");
  styleTag.textContent = `
    @keyframes zotero-ai-library-chat-pulse {
      0%, 80%, 100% { opacity: 0.2; transform: scale(0.85); }
      40% { opacity: 1; transform: scale(1); }
    }
    .zotero-ai-library-chat__streaming { display: inline-flex; align-items: center; gap: 4px; }
    .zotero-ai-library-chat__streaming-dot {
      display: inline-block; width: 5px; height: 5px; margin: 0 2px;
      border-radius: 50%; background: currentColor; vertical-align: middle;
      animation: zotero-ai-library-chat-pulse 1.2s infinite ease-in-out;
    }
    .zotero-ai-library-chat__streaming-dot:nth-child(2) { animation-delay: 0.15s; }
    .zotero-ai-library-chat__streaming-dot:nth-child(3) { animation-delay: 0.3s; }
    .zotero-ai-library-chat__messages li[data-role] {
      list-style: none;
      max-width: 88%;
      padding: 8px 12px;
      border-radius: 12px;
      line-height: 1.45;
    }
    .zotero-ai-library-chat__messages li[data-role="assistant"] {
      align-self: flex-start;
      background: rgba(127, 127, 127, 0.15);
      border-bottom-left-radius: 4px;
    }
    .zotero-ai-library-chat__messages li[data-role="user"] {
      align-self: flex-end;
      background: rgba(64, 128, 255, 0.22);
      border-bottom-right-radius: 4px;
    }
    .zotero-ai-library-chat__role {
      /* Role is communicated by side + colour; the text label is redundant. */
      display: none;
    }
  `;
  root.append(styleTag);

  // Header: title + "New conversation" button. Pinned at the top so the
  // user always has a way to start over even after a long thread.
  const header = document.createElement("header");
  header.className = "zotero-ai-library-chat__header";
  header.setAttribute(
    "style",
    `padding: 10px 16px; background: ${TOOLBAR_BG}; ` +
      `border-bottom: 1px solid ${BORDER_HAIRLINE}; ` +
      "display: flex; align-items: center; justify-content: space-between; gap: 8px;"
  );

  const title = document.createElement("h2");
  title.textContent = "Ask your library";
  title.setAttribute("style", "margin: 0; font-size: 14px; font-weight: 600;");

  const reset = document.createElement("button");
  reset.type = "button";
  reset.dataset.action = "new-conversation";
  reset.textContent = "New conversation";
  reset.setAttribute("style", BUTTON_BASE_STYLE);
  applyFocusRing(reset);

  header.append(title, reset);

  // Messages container. When empty, a placeholder explains the next step
  // (either "ask a question" or "index your library first").
  const messages = document.createElement("ol");
  messages.className = "zotero-ai-library-chat__messages";
  messages.setAttribute("style", MESSAGES_STYLE);

  if (input.messages.length === 0) {
    messages.append(renderEmptyState(input.hasIndex));
  } else {
    for (const message of input.messages) {
      messages.append(renderMessage(message));
    }
  }
  if (input.status === "streaming") {
    messages.append(renderStreamingIndicator());
  }
  if (input.status === "failed" && input.errorMessage !== null) {
    messages.append(renderError(input.errorMessage));
  }

  // Footer form: textarea + Ask button.
  const form = document.createElement("form");
  form.className = "zotero-ai-library-chat__form";
  form.setAttribute(
    "style",
    `padding: 12px 16px; border-top: 1px solid ${BORDER_HAIRLINE}; ` +
      `background: ${SURFACE_BG}; display: flex; flex-direction: column; gap: 8px;`
  );

  const textarea = document.createElement("textarea");
  textarea.name = "question";
  textarea.placeholder = "Ask a question about your library…";
  textarea.setAttribute("style", FIELD_TEXTAREA_STYLE);
  applyFocusRing(textarea);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.dataset.action = "submit-question";
  submit.textContent = "Ask";
  submit.setAttribute("style", `${BUTTON_PRIMARY_STYLE} align-self: flex-end;`);
  applyFocusRing(submit);

  form.append(textarea, submit);
  root.append(header, messages, form);

  return root;
}

function renderEmptyState(hasIndex: boolean): HTMLElement {
  const empty = document.createElement("li");
  empty.className = "zotero-ai-library-chat__empty";
  empty.setAttribute(
    "style",
    `list-style: none; padding: 16px; text-align: center; color: ${FG_MUTED}; ` +
      "font-size: 12px; line-height: 1.5;"
  );
  if (!hasIndex) {
    empty.textContent =
      "Index your library first to enable retrieval. Open the settings dialog and click " +
      "“Index library” to build the index.";
  } else {
    empty.textContent =
      "Ask a question about your library. Answers cite source items by key in [brackets].";
  }
  return empty;
}

function renderStreamingIndicator(): HTMLElement {
  const li = document.createElement("li");
  li.className = "zotero-ai-library-chat__streaming";
  li.setAttribute("style", `font-size: 11px; color: ${FG_MUTED}; font-style: italic;`);
  const label = document.createElement("span");
  label.textContent = "Working";
  const dot1 = document.createElement("span");
  dot1.className = "zotero-ai-library-chat__streaming-dot";
  const dot2 = document.createElement("span");
  dot2.className = "zotero-ai-library-chat__streaming-dot";
  const dot3 = document.createElement("span");
  dot3.className = "zotero-ai-library-chat__streaming-dot";
  li.append(label, dot1, dot2, dot3);
  return li;
}

function renderError(message: string): HTMLElement {
  const li = document.createElement("li");
  li.className = "zotero-ai-library-chat__error";
  li.setAttribute("style", "color: #d70015; font-size: 12px; line-height: 1.4;");
  li.textContent = message;
  return li;
}

function renderMessage(message: ChatMessage): HTMLLIElement {
  const row = document.createElement("li");
  row.dataset.role = message.role;

  const attribution = document.createElement("span");
  attribution.className = "zotero-ai-library-chat__role";
  attribution.setAttribute("style", `font-size: 11px; color: ${FG_MUTED};`);
  attribution.textContent = `${message.role}: `;

  const body = document.createElement("div");
  body.className = "zotero-ai-library-chat__body";
  body.setAttribute("style", "font-size: 13px; line-height: 1.45; white-space: pre-wrap;");
  // Only assistant messages contain citations worth linkifying. User
  // questions render as plain text so a typed `[FOO]` does not become a
  // bogus link.
  if (message.role === "assistant") {
    appendWithCitations(body, message.content);
  } else {
    body.append(document.createTextNode(message.content));
  }

  row.append(attribution, body);
  return row;
}

/**
 * Append `source` to `target` with every `[KEY]` citation replaced by a
 * `<a data-item-key="KEY">KEY</a>` element. Everything else is inserted
 * via `createTextNode`, so model output that contains literal `<script>`
 * or `<img>` markup lands as text — not interpreted HTML.
 *
 * Exported separately from `renderMessage` to keep the helper unit-
 * testable without a full view render.
 */
export function appendWithCitations(target: HTMLElement, source: string): void {
  CITATION_PATTERN.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_PATTERN.exec(source)) !== null) {
    if (match.index > cursor) {
      target.append(document.createTextNode(source.slice(cursor, match.index)));
    }
    const itemKey = match[1] ?? "";
    target.append(renderCitationLink(itemKey));
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) {
    target.append(document.createTextNode(source.slice(cursor)));
  }
}

function renderCitationLink(itemKey: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.dataset.itemKey = itemKey;
  // Use `#` rather than a real URL so click handlers can preventDefault
  // without navigating; the wire layer dispatches to `onCitationClick`.
  link.setAttribute("href", "#");
  link.setAttribute("style", `color: ${ACCENT}; text-decoration: underline; cursor: pointer;`);
  link.textContent = itemKey;
  return link;
}

export type LibraryChatDetach = () => void;

export type WireLibraryChatInput = {
  readonly view: HTMLElement;
  readonly onSubmit: (question: string) => Promise<void> | void;
  readonly onReset: () => void;
  readonly onCitationClick: (itemKey: string) => void;
};

export function wireLibraryChatView(input: WireLibraryChatInput): LibraryChatDetach {
  const { view, onSubmit, onReset, onCitationClick } = input;
  const form = view.querySelector<HTMLFormElement>(".zotero-ai-library-chat__form");
  const textarea = view.querySelector<HTMLTextAreaElement>('[name="question"]');
  const reset = view.querySelector<HTMLButtonElement>('[data-action="new-conversation"]');

  const handleSubmit = (event: Event): void => {
    event.preventDefault();
    const value = textarea?.value ?? "";
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (textarea) {
      textarea.value = "";
    }
    void onSubmit(trimmed);
  };

  const handleReset = (): void => {
    onReset();
  };

  // Delegate citation clicks at the view root so re-renders (which
  // replace `.zotero-ai-library-chat__messages` children) keep working
  // without re-binding.
  const handleClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target === null) return;
    const link = target.closest<HTMLAnchorElement>("a[data-item-key]");
    if (link === null) return;
    event.preventDefault();
    const key = link.dataset.itemKey ?? "";
    if (key.length > 0) {
      onCitationClick(key);
    }
  };

  // Enter submits; Shift+Enter inserts a newline. Same convention as
  // the popup so users don't have to mouse to "Ask" for every question.
  const handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form?.requestSubmit();
    }
  };

  form?.addEventListener("submit", handleSubmit);
  reset?.addEventListener("click", handleReset);
  view.addEventListener("click", handleClick);
  textarea?.addEventListener("keydown", handleKeydown);

  return () => {
    form?.removeEventListener("submit", handleSubmit);
    reset?.removeEventListener("click", handleReset);
    view.removeEventListener("click", handleClick);
    textarea?.removeEventListener("keydown", handleKeydown);
  };
}

/**
 * Build the LLM prompt that grounds the chat answer in the retrieved
 * excerpts. The prompt asks the model to cite item keys in square
 * brackets so the renderer's `appendWithCitations` can convert them
 * into clickable links.
 */
export function buildLibraryPrompt(input: {
  readonly question: string;
  readonly chunks: readonly RetrievedChunk[];
}): string {
  const excerpts =
    input.chunks.length === 0
      ? "(no excerpts available)"
      : input.chunks.map((c) => `[${c.itemKey}] ${c.text}`).join("\n\n");
  return (
    `You are answering questions using only the excerpts below from the user's Zotero library.\n` +
    `Cite the item key in square brackets after each claim, e.g. "X is true [ABCD1234]".\n` +
    `If the excerpts don't contain enough information, say so directly.\n\n` +
    `Excerpts:\n${excerpts}\n\n` +
    `Question: ${input.question}`
  );
}
