"use strict";
var ZoteroAiExplain = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/bootstrap.ts
  var bootstrap_exports = {};
  __export(bootstrap_exports, {
    shutdown: () => shutdown,
    startup: () => startup
  });

  // src/conversation/conversation-store.ts
  function createConversationStore() {
    const conversations = /* @__PURE__ */ new Map();
    const listeners = /* @__PURE__ */ new Map();
    let nextId = 1;
    const notify = (id) => {
      const conversation = conversations.get(id);
      if (conversation === void 0) {
        return;
      }
      const subscribers = listeners.get(id);
      if (subscribers === void 0) {
        return;
      }
      for (const listener of subscribers) {
        listener(conversation);
      }
    };
    const update = (id, updater) => {
      const conversation = conversations.get(id);
      if (conversation === void 0) {
        throw new Error(`Conversation not found: ${id}`);
      }
      conversations.set(id, updater(conversation));
      notify(id);
    };
    return {
      createFromSelection(selection, profile) {
        const conversation = {
          id: `conversation-${String(nextId)}`,
          selection,
          profile,
          messages: [],
          status: "idle",
          visibleSurface: "popup",
          errorMessage: null
        };
        nextId += 1;
        conversations.set(conversation.id, conversation);
        return conversation;
      },
      get(id) {
        return conversations.get(id) ?? null;
      },
      appendUserMessage(id, content) {
        appendMessage(id, { role: "user", content });
      },
      appendAssistantDelta(id, text) {
        update(id, (conversation) => {
          const lastMessage = conversation.messages.at(-1);
          if (lastMessage?.role === "assistant") {
            return {
              ...conversation,
              messages: [
                ...conversation.messages.slice(0, -1),
                { ...lastMessage, content: `${lastMessage.content}${text}` }
              ]
            };
          }
          return {
            ...conversation,
            messages: [...conversation.messages, { role: "assistant", content: text }]
          };
        });
      },
      markStreaming(id) {
        update(id, (conversation) => ({ ...conversation, status: "streaming", errorMessage: null }));
      },
      complete(id) {
        update(id, (conversation) => ({ ...conversation, status: "completed", errorMessage: null }));
      },
      fail(id, message) {
        update(id, (conversation) => ({ ...conversation, status: "failed", errorMessage: message }));
      },
      cancel(id) {
        update(id, (conversation) => ({ ...conversation, status: "cancelled", errorMessage: null }));
      },
      moveToSidebar(id) {
        update(id, (conversation) => ({ ...conversation, visibleSurface: "sidebar" }));
      },
      subscribe(id, listener) {
        let subscribers = listeners.get(id);
        if (subscribers === void 0) {
          subscribers = /* @__PURE__ */ new Set();
          listeners.set(id, subscribers);
        }
        subscribers.add(listener);
        return () => {
          const current = listeners.get(id);
          if (current === void 0) {
            return;
          }
          current.delete(listener);
          if (current.size === 0) {
            listeners.delete(id);
          }
        };
      }
    };
    function appendMessage(id, message) {
      update(id, (conversation) => ({
        ...conversation,
        messages: [...conversation.messages, message]
      }));
    }
  }

  // src/indexing/indexing-status.ts
  function createInitialIndexingStatus() {
    return { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 };
  }

  // src/ui/anchored-popup-view.ts
  function renderAnchoredPopup(input2) {
    const element = document.createElement("section");
    element.className = "zotero-ai-explain-popup";
    element.style.position = "absolute";
    element.style.left = `${String(input2.anchor?.left ?? 0)}px`;
    element.style.top = `${String(input2.anchor?.top ?? 0)}px`;
    const disclosure = document.createElement("p");
    disclosure.className = "zotero-ai-explain-popup__disclosure";
    disclosure.textContent = input2.disclosure;
    const body = document.createElement("div");
    body.className = "zotero-ai-explain-popup__body";
    body.textContent = input2.text;
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

  // src/ui/sidebar-view.ts
  function renderSidebarConversation(input2) {
    const element = document.createElement("aside");
    element.className = "zotero-ai-explain-sidebar";
    const quote = document.createElement("blockquote");
    quote.textContent = input2.quote;
    const source = document.createElement("p");
    source.className = "zotero-ai-explain-sidebar__source";
    source.textContent = input2.sourceLabel;
    const messages = document.createElement("ol");
    messages.className = "zotero-ai-explain-sidebar__messages";
    for (const message of input2.messages) {
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

  // src/platform/zotero-runtime.ts
  function createZoteroRuntime(deps) {
    const cleanup = [];
    function describeSource(selection) {
      const title = selection.source.itemTitle?.trim();
      const page = selection.source.pageLabel?.trim();
      if (title && page) {
        return `${title}, p. ${page}`;
      }
      if (title) {
        return title;
      }
      if (page) {
        return `p. ${page}`;
      }
      return "Unknown source";
    }
    function lastAssistantContent(conversation) {
      return conversation.messages.findLast((message) => message.role === "assistant")?.content ?? "";
    }
    function startExplain(selection) {
      const conversation = deps.store.createFromSelection(selection, deps.profile);
      deps.store.appendUserMessage(conversation.id, `Explain this: ${selection.quote}`);
      const popup = renderAnchoredPopup({
        disclosure: deps.disclosure(deps.profile),
        anchor: selection.anchor,
        text: ""
      });
      const body = popup.querySelector(".zotero-ai-explain-popup__body");
      let popupUnmount = null;
      let popupUnsubscribe = null;
      let sidebarUnmount = null;
      let sidebarUnsubscribe = null;
      let sidebarMessages = null;
      const cleanupExplain = () => {
        popupUnsubscribe?.();
        popupUnmount?.();
        sidebarUnsubscribe?.();
        sidebarUnmount?.();
      };
      const mountSidebar = () => {
        const current = deps.store.get(conversation.id) ?? conversation;
        const view = renderSidebarConversation({
          quote: selection.quote,
          sourceLabel: describeSource(selection),
          messages: current.messages
        });
        sidebarMessages = view.querySelector(
          ".zotero-ai-explain-sidebar__messages"
        );
        const form = view.querySelector(".zotero-ai-explain-sidebar__form");
        const textarea = view.querySelector('[name="followUp"]');
        form?.addEventListener("submit", (event) => {
          event.preventDefault();
          const value = textarea?.value ?? "";
          if (textarea) {
            textarea.value = "";
          }
          void deps.sidebarController.sendFollowUp(conversation.id, value);
        });
        sidebarUnmount = deps.ui.mountSidebar(view);
        sidebarUnsubscribe = deps.store.subscribe(conversation.id, (updated) => {
          const list = sidebarMessages;
          if (list === null) {
            return;
          }
          const rows = updated.messages.map((message) => {
            const row = list.ownerDocument.createElement("li");
            row.dataset.role = message.role;
            row.textContent = `${message.role}: ${message.content}`;
            return row;
          });
          list.replaceChildren(...rows);
        });
      };
      const continueButton = popup.querySelector(
        '[data-action="continue-sidebar"]'
      );
      continueButton?.addEventListener("click", () => {
        popupUnsubscribe?.();
        popupUnsubscribe = null;
        popupUnmount?.();
        popupUnmount = null;
        deps.popupController.continueInSidebar(conversation.id);
        mountSidebar();
      });
      const retryButton = popup.querySelector('[data-action="retry"]');
      retryButton?.addEventListener("click", () => {
        void deps.popupController.retry(conversation.id);
      });
      popupUnmount = deps.ui.mountPopup(popup);
      popupUnsubscribe = deps.store.subscribe(conversation.id, (updated) => {
        if (body !== null) {
          body.textContent = lastAssistantContent(updated);
        }
      });
      cleanup.push(cleanupExplain);
      void deps.popupController.explain(conversation.id);
    }
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
        cleanup.push(deps.ui.addReaderCommand("Explain with AI", startExplain));
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
  var DIALOG_BACKDROP_STYLE = "position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 999998;";
  var DIALOG_CONTENT_STYLE = "position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 999999; max-width: 480px; min-width: 320px; padding: 24px; background: var(--material-background, white); color: var(--material-color, black); border-radius: 8px; max-height: 80vh; overflow: auto; box-shadow: 0 12px 36px rgba(0,0,0,0.3);";
  var POPUP_WRAPPER_STYLE = "position: fixed; top: 80px; left: 50%; transform: translateX(-50%); z-index: 999999; max-width: 480px; min-width: 280px; padding: 16px; background: var(--material-background, white); color: inherit; border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,0.25); max-height: 60vh; overflow: auto;";
  var SIDEBAR_WRAPPER_STYLE = "position: fixed; top: 0; right: 0; height: 100vh; width: 360px; max-width: 40vw; z-index: 999998; background: var(--material-background, white); color: inherit; box-shadow: -4px 0 12px rgba(0,0,0,0.2); padding: 16px; overflow: auto; display: flex; flex-direction: column; gap: 12px;";
  function appendFloatingLayer(zotero, document2, element, label) {
    const body = document2.body;
    if (body !== null) {
      body.append(element);
      return;
    }
    zotero.debug(
      `Zotero AI Explain: ${label} mounted on documentElement because body is unavailable`
    );
    document2.documentElement.append(element);
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
        input2.Zotero.debug(`Zotero AI Explain registered menu: ${label}`);
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
        if (!input2.Zotero.Reader) {
          input2.Zotero.debug(
            "Zotero AI Explain: Zotero.Reader unavailable, skipping reader command registration"
          );
          return noOp;
        }
        const reader = input2.Zotero.Reader;
        reader.registerEventListener("renderTextSelectionPopup", handler, input2.pluginId);
        input2.Zotero.debug(`Zotero AI Explain registered reader command: ${label}`);
        return () => {
          reader.unregisterEventListener("renderTextSelectionPopup", handler);
        };
      },
      openDialog(title, content) {
        const mainWindow = input2.Zotero.getMainWindow?.();
        const document2 = mainWindow?.document;
        if (!document2) {
          input2.Zotero.debug(`Zotero AI Explain could not open dialog: ${title}`);
          return;
        }
        const backdrop = document2.createElement("div");
        backdrop.className = "zotero-ai-dialog-backdrop";
        backdrop.setAttribute("style", DIALOG_BACKDROP_STYLE);
        const dialog = document2.createElement("section");
        dialog.className = "zotero-ai-dialog";
        dialog.setAttribute("aria-label", title);
        dialog.setAttribute("aria-modal", "true");
        dialog.setAttribute("role", "dialog");
        dialog.setAttribute("style", DIALOG_CONTENT_STYLE);
        const closeButton = document2.createElement("button");
        closeButton.type = "button";
        closeButton.dataset.action = "close-dialog";
        closeButton.textContent = "Close";
        closeButton.setAttribute(
          "style",
          "position: absolute; top: 8px; right: 8px; padding: 4px 12px; cursor: pointer;"
        );
        const dispose = () => {
          document2.removeEventListener("keydown", onKeydown);
          backdrop.remove();
          dialog.remove();
        };
        function onKeydown(event) {
          if (event.key === "Escape") {
            dispose();
          }
        }
        backdrop.addEventListener("click", dispose);
        closeButton.addEventListener("click", dispose);
        document2.addEventListener("keydown", onKeydown);
        dialog.append(closeButton, content);
        appendFloatingLayer(input2.Zotero, document2, backdrop, "dialog backdrop");
        appendFloatingLayer(input2.Zotero, document2, dialog, "dialog");
        input2.Zotero.debug(`Zotero AI Explain opened dialog: ${title}`);
      },
      mountPopup(content) {
        const mainWindow = input2.Zotero.getMainWindow?.();
        const document2 = mainWindow?.document;
        if (!document2) {
          input2.Zotero.debug("Zotero AI Explain could not mount popup: no document");
          return noOp;
        }
        const wrapper = document2.createElement("div");
        wrapper.className = "zotero-ai-popup-wrapper";
        wrapper.setAttribute("style", POPUP_WRAPPER_STYLE);
        wrapper.append(content);
        appendFloatingLayer(input2.Zotero, document2, wrapper, "popup");
        return () => {
          wrapper.remove();
        };
      },
      mountSidebar(content) {
        const mainWindow = input2.Zotero.getMainWindow?.();
        const document2 = mainWindow?.document;
        if (!document2) {
          input2.Zotero.debug("Zotero AI Explain could not mount sidebar: no document");
          return noOp;
        }
        const wrapper = document2.createElement("div");
        wrapper.className = "zotero-ai-sidebar-wrapper";
        wrapper.setAttribute("style", SIDEBAR_WRAPPER_STYLE);
        wrapper.append(content);
        appendFloatingLayer(input2.Zotero, document2, wrapper, "sidebar");
        return () => {
          wrapper.remove();
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
  function ollamaSettingsToProfile(settings) {
    return {
      id: "ollama",
      displayName: "Ollama",
      kind: "ollama",
      baseUrl: settings.baseUrl,
      model: settings.chatModel,
      secret: { kind: "none" },
      sendMode: "local",
      enabled: true
    };
  }

  // src/providers/stream-events.ts
  function parseJsonPayload(payload) {
    return JSON.parse(payload);
  }
  function eventFromDelta(text) {
    return { type: "delta", text };
  }
  function messageEndEvent() {
    return { type: "message_end" };
  }
  function readString(value, path) {
    let current = value;
    for (const segment of path) {
      if (Array.isArray(current)) {
        if (!/^\d+$/.test(segment)) {
          return null;
        }
        const index = Number.parseInt(segment, 10);
        if (index >= current.length) {
          return null;
        }
        current = current[index];
        continue;
      }
      if (!isRecord(current)) {
        return null;
      }
      current = current[segment];
    }
    return typeof current === "string" ? current : null;
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  // src/providers/adapters/ollama.ts
  function baseUrl(profileBaseUrl) {
    return (profileBaseUrl ?? "http://localhost:11434").replace(/\/+$/u, "");
  }
  function connectionError(url) {
    return {
      type: "error",
      message: `Could not reach Ollama at ${url}.`,
      retryable: true
    };
  }
  function readEmbeddings(payload) {
    if (isRecord(payload) && Array.isArray(payload.embeddings)) {
      return payload.embeddings;
    }
    throw new Error("Ollama embedding response did not include embeddings.");
  }
  function createOllamaProvider(deps) {
    const id = "ollama";
    return {
      id,
      displayName: "Ollama",
      async *streamChat(request, signal) {
        const url = baseUrl(request.profile.baseUrl);
        yield { type: "message_start", providerId: id, model: request.profile.model };
        try {
          const response = await deps.fetch(`${url}/api/chat`, {
            method: "POST",
            signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: request.profile.model,
              stream: true,
              messages: request.messages
            })
          });
          for (const line of (await response.text()).split("\n").filter((entry) => entry.trim().length > 0)) {
            const payload = parseJsonPayload(line);
            const text = readString(payload, ["message", "content"]);
            if (text !== null) {
              yield eventFromDelta(text);
            }
          }
          yield messageEndEvent();
        } catch (error) {
          if (signal.aborted) {
            throw error;
          }
          yield connectionError(url);
        }
      },
      async embedTexts(request) {
        const url = baseUrl(request.baseUrl);
        const response = await deps.fetch(`${url}/api/embed`, {
          method: "POST",
          signal: request.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: request.model, input: request.texts })
        });
        return readEmbeddings(parseJsonPayload(await response.text()));
      }
    };
  }

  // src/providers/provider-registry.ts
  function createProviderRegistry(providers) {
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    return {
      resolve(profile) {
        if (!profile.enabled) {
          throw new Error("Provider profile is disabled.");
        }
        const provider = byId.get(profile.kind);
        if (provider === void 0) {
          throw new Error(`No provider adapter registered for ${profile.kind}.`);
        }
        return provider;
      }
    };
  }

  // src/ui/popup-controller.ts
  function createPopupController(deps) {
    const abortControllers = /* @__PURE__ */ new Map();
    async function explain(conversationId) {
      const conversation = deps.store.get(conversationId);
      if (conversation === null) {
        throw new Error(`Conversation not found: ${conversationId}`);
      }
      const abortController = new AbortController();
      abortControllers.set(conversationId, abortController);
      deps.store.markStreaming(conversationId);
      try {
        for await (const event of deps.provider.streamChat(
          {
            selection: conversation.selection,
            messages: conversation.messages,
            profile: conversation.profile
          },
          abortController.signal
        )) {
          if (event.type === "delta") {
            deps.store.appendAssistantDelta(conversationId, event.text);
          }
        }
        deps.store.complete(conversationId);
      } catch (error) {
        if (abortController.signal.aborted) {
          deps.store.cancel(conversationId);
        } else {
          deps.store.fail(conversationId, error instanceof Error ? error.message : String(error));
        }
      } finally {
        abortControllers.delete(conversationId);
      }
    }
    return {
      explain,
      cancel(conversationId) {
        abortControllers.get(conversationId)?.abort();
        deps.store.cancel(conversationId);
      },
      retry: explain,
      continueInSidebar(conversationId) {
        deps.store.moveToSidebar(conversationId);
      }
    };
  }

  // src/ui/sidebar-controller.ts
  function createSidebarController(deps) {
    return {
      async sendFollowUp(conversationId, message) {
        const trimmed = message.trim();
        if (trimmed.length === 0) {
          return;
        }
        const conversation = deps.store.get(conversationId);
        if (conversation === null) {
          throw new Error(`Conversation not found: ${conversationId}`);
        }
        deps.store.appendUserMessage(conversationId, trimmed);
        deps.store.markStreaming(conversationId);
        try {
          for await (const event of deps.provider.streamChat(
            {
              selection: conversation.selection,
              messages: deps.store.get(conversationId)?.messages ?? conversation.messages,
              profile: conversation.profile
            },
            new AbortController().signal
          )) {
            if (event.type === "delta") {
              deps.store.appendAssistantDelta(conversationId, event.text);
            }
          }
          deps.store.complete(conversationId);
        } catch (error) {
          deps.store.fail(conversationId, error instanceof Error ? error.message : String(error));
        }
      }
    };
  }

  // src/bootstrap.ts
  var runtime = null;
  function describeDisclosure(profile) {
    return `Selected text will be sent to ${profile.displayName} using ${profile.model}.`;
  }
  async function startup(context) {
    context.Zotero.debug("Zotero AI Explain startup");
    const settings = createDefaultOllamaSettings();
    const profile = ollamaSettingsToProfile(settings);
    const store = createConversationStore();
    const ollamaProvider = createOllamaProvider({ fetch: globalThis.fetch.bind(globalThis) });
    const registry = createProviderRegistry([ollamaProvider]);
    const provider = registry.resolve(profile);
    runtime = createZoteroRuntime({
      settings,
      indexStatus: createInitialIndexingStatus(),
      ui: createZoteroUiAdapter({ Zotero: context.Zotero, pluginId: context.pluginId }),
      store,
      profile,
      popupController: createPopupController({ store, provider }),
      sidebarController: createSidebarController({ store, provider }),
      disclosure: describeDisclosure
    });
    await runtime.startup();
  }
  async function shutdown(context) {
    context.Zotero.debug("Zotero AI Explain shutdown");
    await runtime?.shutdown();
    runtime = null;
  }
  return __toCommonJS(bootstrap_exports);
})();
