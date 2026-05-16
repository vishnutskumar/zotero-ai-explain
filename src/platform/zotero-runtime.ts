import type { ConversationStore } from "../conversation/conversation-store.js";
import type { Conversation } from "../conversation/conversation-types.js";
import type { IndexingStatus } from "../indexing/indexing-status.js";
import type { OllamaSettings } from "../preferences/ollama-profile.js";
import type { ProviderProfile } from "../providers/provider-types.js";
import type { SelectionContext } from "../selection/selection-context.js";
import { renderAnchoredPopup } from "../ui/anchored-popup-view.js";
import type { PopupController } from "../ui/popup-controller.js";
import { renderSettingsView } from "../ui/settings-view.js";
import type { SidebarController } from "../ui/sidebar-controller.js";
import { renderSidebarConversation } from "../ui/sidebar-view.js";
import type { Unsubscribe, ZoteroUiAdapter } from "./zotero-ui-types.js";

export type ZoteroRuntime = {
  startup(): Promise<void>;
  shutdown(): Promise<void>;
};

export type DisclosureFormatter = (profile: ProviderProfile) => string;

export function createZoteroRuntime(deps: {
  readonly settings: OllamaSettings;
  readonly indexStatus: IndexingStatus;
  readonly ui: ZoteroUiAdapter;
  readonly store: ConversationStore;
  readonly profile: ProviderProfile;
  readonly popupController: PopupController;
  readonly sidebarController: SidebarController;
  readonly disclosure: DisclosureFormatter;
}): ZoteroRuntime {
  const cleanup: Unsubscribe[] = [];

  function describeSource(selection: SelectionContext): string {
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

  function lastAssistantContent(conversation: Conversation): string {
    return conversation.messages.findLast((message) => message.role === "assistant")?.content ?? "";
  }

  function startExplain(selection: SelectionContext): void {
    const conversation = deps.store.createFromSelection(selection, deps.profile);
    deps.store.appendUserMessage(conversation.id, `Explain this: ${selection.quote}`);

    const popup = renderAnchoredPopup({
      disclosure: deps.disclosure(deps.profile),
      anchor: selection.anchor,
      text: ""
    });
    const body = popup.querySelector<HTMLElement>(".zotero-ai-explain-popup__body");

    let popupUnmount: Unsubscribe | null = null;
    let popupUnsubscribe: Unsubscribe | null = null;
    let sidebarUnmount: Unsubscribe | null = null;
    let sidebarUnsubscribe: Unsubscribe | null = null;
    let sidebarMessages: HTMLOListElement | null = null;

    const cleanupExplain = (): void => {
      popupUnsubscribe?.();
      popupUnmount?.();
      sidebarUnsubscribe?.();
      sidebarUnmount?.();
    };

    const mountSidebar = (): void => {
      const current = deps.store.get(conversation.id) ?? conversation;
      const view = renderSidebarConversation({
        quote: selection.quote,
        sourceLabel: describeSource(selection),
        messages: current.messages
      });

      sidebarMessages = view.querySelector<HTMLOListElement>(
        ".zotero-ai-explain-sidebar__messages"
      );

      const form = view.querySelector<HTMLFormElement>(".zotero-ai-explain-sidebar__form");
      const textarea = view.querySelector<HTMLTextAreaElement>('[name="followUp"]');
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

    const continueButton = popup.querySelector<HTMLButtonElement>(
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

    const retryButton = popup.querySelector<HTMLButtonElement>('[data-action="retry"]');
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
