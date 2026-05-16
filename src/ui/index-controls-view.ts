import type { IndexingStatus } from "../indexing/indexing-status.js";

export function renderIndexControls(status: IndexingStatus): HTMLElement {
  const element = document.createElement("section");
  element.className = "zotero-ai-index-controls";

  const summary = document.createElement("p");
  summary.textContent = `${String(status.indexedItems)} / ${String(status.totalItems)} indexed, ${String(
    status.failedItems
  )} failed`;

  const start = document.createElement("button");
  start.type = "button";
  start.dataset.action = "start-index";
  start.textContent = "Index library";

  const pause = document.createElement("button");
  pause.type = "button";
  pause.dataset.action = "pause-index";
  pause.textContent = "Pause";

  const resume = document.createElement("button");
  resume.type = "button";
  resume.dataset.action = "resume-index";
  resume.textContent = "Resume";

  const clear = document.createElement("button");
  clear.type = "button";
  clear.dataset.action = "clear-index";
  clear.textContent = "Clear index";

  element.append(summary, start, pause, resume, clear);
  return element;
}
