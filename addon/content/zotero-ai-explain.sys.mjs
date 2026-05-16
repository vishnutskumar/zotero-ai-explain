// src/indexing/indexing-status.ts
function createInitialIndexingStatus() {
  return { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 };
}

// src/ui/index-controls-view.ts
function renderIndexControls(status) {
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

// src/ui/settings-view.ts
function input(name, labelText, value) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const field = document.createElement("input");
  field.name = name;
  field.value = value;
  label.append(field);
  return label;
}
function renderSettingsView(inputData) {
  const element = document.createElement("form");
  element.className = "zotero-ai-settings";
  const title = document.createElement("h2");
  title.textContent = "Zotero AI Explain";
  const privacy = document.createElement("p");
  privacy.textContent = inputData.settings.localOnly ? "Local only: document text stays on this machine." : "Online embeddings are enabled.";
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

// src/platform/zotero-runtime.ts
function createZoteroRuntime(deps) {
  const cleanup = [];
  return {
    startup() {
      cleanup.push(
        deps.ui.addMenuItem("Zotero AI Explain Settings", () => {
          deps.ui.openDialog(
            "Zotero AI Explain",
            renderSettingsView({ settings: deps.settings, indexStatus: deps.indexStatus })
          );
        })
      );
      cleanup.push(deps.ui.addReaderCommand("Explain with AI", deps.onExplain));
      return Promise.resolve();
    },
    shutdown() {
      while (cleanup.length > 0) {
        cleanup.shift()?.();
      }
      return Promise.resolve();
    }
  };
}

// src/platform/zotero-ui-adapter.ts
function noOp() {
  return void 0;
}
function createZoteroUiAdapter(input2) {
  return {
    addMenuItem(label, action) {
      const mainWindow = input2.Zotero.getMainWindow?.();
      const document2 = mainWindow?.document;
      const toolsPopup = document2?.getElementById("menu_ToolsPopup") ?? document2?.getElementById("menuToolsPopup");
      if (!document2 || !toolsPopup) {
        input2.Zotero.debug("Zotero AI Explain could not find the Tools menu popup.");
        return noOp;
      }
      const xulDocument = document2;
      const createGenericElement = (tag) => document2.createElement(tag);
      const item = xulDocument.createXULElement?.("menuitem") ?? createGenericElement("menuitem");
      item.setAttribute("label", label);
      item.addEventListener("command", action);
      toolsPopup.append(item);
      return () => {
        item.remove();
      };
    },
    addReaderCommand(label, action) {
      const handler = (event) => {
        const quote = event.params?.annotation?.text?.trim() ?? "";
        const button = event.doc.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => {
          const selection = {
            quote,
            source: {
              itemKey: null,
              itemTitle: null,
              attachmentKey: null,
              pageLabel: null,
              location: null
            },
            anchor: null
          };
          action(selection);
        });
        event.append(button);
      };
      input2.Zotero.Reader?.registerEventListener(
        "renderTextSelectionPopup",
        handler,
        input2.pluginId
      );
      return () => input2.Zotero.Reader?.unregisterEventListener("renderTextSelectionPopup", handler);
    },
    openDialog(title, content) {
      const mainWindow = input2.Zotero.getMainWindow?.();
      const document2 = mainWindow?.document;
      if (!document2?.body) {
        input2.Zotero.debug(`Zotero AI Explain could not open dialog: ${title}`);
        return;
      }
      const dialog = document2.createElement("section");
      dialog.className = "zotero-ai-dialog";
      dialog.setAttribute("aria-label", title);
      dialog.append(content);
      document2.body.append(dialog);
    },
    mountPopup(content) {
      const mainWindow = input2.Zotero.getMainWindow?.();
      mainWindow?.document.body.append(content);
      return () => {
        content.remove();
      };
    },
    mountSidebar(content) {
      const mainWindow = input2.Zotero.getMainWindow?.();
      mainWindow?.document.body.append(content);
      return () => {
        content.remove();
      };
    }
  };
}

// src/preferences/ollama-profile.ts
function createDefaultOllamaSettings() {
  return {
    baseUrl: "http://localhost:11434",
    chatModel: "gemma4:e4b",
    embeddingModel: "embeddinggemma",
    localOnly: true
  };
}

// src/bootstrap.ts
var runtime = null;
async function startup(context) {
  context.Zotero.debug("Zotero AI Explain startup");
  runtime = createZoteroRuntime({
    settings: createDefaultOllamaSettings(),
    indexStatus: createInitialIndexingStatus(),
    ui: createZoteroUiAdapter({ Zotero: context.Zotero, pluginId: context.pluginId }),
    onExplain(selection) {
      context.Zotero.debug(`Zotero AI Explain selected ${String(selection.quote.length)} chars`);
    }
  });
  await runtime.startup();
}
async function shutdown(context) {
  context.Zotero.debug("Zotero AI Explain shutdown");
  await runtime?.shutdown();
  runtime = null;
}
export {
  shutdown,
  startup
};
