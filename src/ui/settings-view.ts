import type { IndexingStatus } from "../indexing/indexing-status.js";
import type { OllamaSettings } from "../preferences/ollama-profile.js";
import { renderIndexControls } from "./index-controls-view.js";

function input(name: string, labelText: string, value: string): HTMLLabelElement {
  const label = document.createElement("label");
  label.textContent = labelText;
  const field = document.createElement("input");
  field.name = name;
  field.value = value;
  label.append(field);
  return label;
}

export function renderSettingsView(inputData: {
  readonly settings: OllamaSettings;
  readonly indexStatus: IndexingStatus;
}): HTMLElement {
  const element = document.createElement("form");
  element.className = "zotero-ai-settings";

  const title = document.createElement("h2");
  title.textContent = "Zotero AI Explain";

  const privacy = document.createElement("p");
  privacy.textContent = inputData.settings.localOnly
    ? "Local only: document text stays on this machine."
    : "Online embeddings are enabled.";

  element.append(
    title,
    input("baseUrl", "Ollama URL", inputData.settings.baseUrl),
    input("chatModel", "Chat model", inputData.settings.chatModel),
    input("embeddingModel", "Embedding model", inputData.settings.embeddingModel),
    privacy,
    renderIndexControls(inputData.indexStatus)
  );

  return element;
}
