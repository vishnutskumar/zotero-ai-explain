import type { ChatMessage } from "../providers/provider-types.js";

export function renderSidebarConversation(input: {
  readonly quote: string;
  readonly sourceLabel: string;
  readonly messages: readonly ChatMessage[];
}): HTMLElement {
  const element = document.createElement("aside");
  element.className = "zotero-ai-explain-sidebar";

  const quote = document.createElement("blockquote");
  quote.textContent = input.quote;

  const source = document.createElement("p");
  source.className = "zotero-ai-explain-sidebar__source";
  source.textContent = input.sourceLabel;

  const messages = document.createElement("ol");
  messages.className = "zotero-ai-explain-sidebar__messages";

  for (const message of input.messages) {
    const row = document.createElement("li");
    row.dataset.role = message.role;
    row.textContent = `${message.role}: ${message.content}`;
    messages.append(row);
  }

  const form = document.createElement("form");
  form.className = "zotero-ai-explain-sidebar__form";

  const followUp = document.createElement("textarea");
  followUp.name = "followUp";

  const send = document.createElement("button");
  send.type = "submit";
  send.dataset.action = "send-follow-up";
  send.textContent = "Send";

  form.append(followUp, send);
  element.append(quote, source, messages, form);

  return element;
}
