import type { SelectionContext } from "../selection/selection-context.js";

export function renderAnchoredPopup(input: {
  readonly disclosure: string;
  readonly anchor: SelectionContext["anchor"];
  readonly text: string;
}): HTMLElement {
  const element = document.createElement("section");
  element.className = "zotero-ai-explain-popup";
  element.style.position = "absolute";
  element.style.left = `${String(input.anchor?.left ?? 0)}px`;
  element.style.top = `${String(input.anchor?.top ?? 0)}px`;

  const disclosure = document.createElement("p");
  disclosure.className = "zotero-ai-explain-popup__disclosure";
  disclosure.textContent = input.disclosure;

  const body = document.createElement("div");
  body.className = "zotero-ai-explain-popup__body";
  body.textContent = input.text;

  const actions = document.createElement("div");
  actions.className = "zotero-ai-explain-popup__actions";

  const sidebar = document.createElement("button");
  sidebar.type = "button";
  sidebar.dataset.action = "continue-sidebar";
  sidebar.textContent = "Open in sidebar";

  const retry = document.createElement("button");
  retry.type = "button";
  retry.dataset.action = "retry";
  retry.textContent = "Retry";

  actions.append(sidebar, retry);
  element.append(disclosure, body, actions);

  return element;
}
