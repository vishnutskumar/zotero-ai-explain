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

  element.append(disclosure, body);

  return element;
}
