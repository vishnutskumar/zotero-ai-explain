import type { Conversation } from "./conversation-types.js";
import type { ChatMessage, ProviderProfile } from "../providers/provider-types.js";
import type { SelectionContext } from "../selection/selection-context.js";

export type ConversationListener = (conversation: Conversation) => void;

export type ConversationStore = {
  createFromSelection(selection: SelectionContext, profile: ProviderProfile): Conversation;
  get(id: string): Conversation | null;
  appendUserMessage(id: string, content: string): void;
  appendAssistantDelta(id: string, text: string): void;
  markStreaming(id: string): void;
  complete(id: string): void;
  fail(id: string, message: string): void;
  cancel(id: string): void;
  moveToSidebar(id: string): void;
  subscribe(id: string, listener: ConversationListener): () => void;
};

export function createConversationStore(): ConversationStore {
  const conversations = new Map<string, Conversation>();
  const listeners = new Map<string, Set<ConversationListener>>();
  let nextId = 1;

  const notify = (id: string): void => {
    const conversation = conversations.get(id);
    if (conversation === undefined) {
      return;
    }
    const subscribers = listeners.get(id);
    if (subscribers === undefined) {
      return;
    }
    for (const listener of subscribers) {
      listener(conversation);
    }
  };

  const update = (id: string, updater: (conversation: Conversation) => Conversation): void => {
    const conversation = conversations.get(id);
    if (conversation === undefined) {
      throw new Error(`Conversation not found: ${id}`);
    }
    conversations.set(id, updater(conversation));
    notify(id);
  };

  return {
    createFromSelection(selection, profile) {
      const conversation: Conversation = {
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
      if (subscribers === undefined) {
        subscribers = new Set();
        listeners.set(id, subscribers);
      }
      subscribers.add(listener);
      return () => {
        const current = listeners.get(id);
        if (current === undefined) {
          return;
        }
        current.delete(listener);
        if (current.size === 0) {
          listeners.delete(id);
        }
      };
    }
  };

  function appendMessage(id: string, message: ChatMessage): void {
    update(id, (conversation) => ({
      ...conversation,
      messages: [...conversation.messages, message]
    }));
  }
}
