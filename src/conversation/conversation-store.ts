import type { Conversation } from "./conversation-types.js";
import type { ChatMessage, ProviderProfile } from "../providers/provider-types.js";
import type { SelectionContext } from "../selection/selection-context.js";

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
};

export function createConversationStore(): ConversationStore {
  const conversations = new Map<string, Conversation>();
  let nextId = 1;

  const update = (id: string, updater: (conversation: Conversation) => Conversation): void => {
    const conversation = conversations.get(id);
    if (conversation === undefined) {
      throw new Error(`Conversation not found: ${id}`);
    }
    conversations.set(id, updater(conversation));
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
    }
  };

  function appendMessage(id: string, message: ChatMessage): void {
    update(id, (conversation) => ({
      ...conversation,
      messages: [...conversation.messages, message]
    }));
  }
}
