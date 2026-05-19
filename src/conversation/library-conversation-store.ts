/**
 * Minimal in-memory store for the NotebookLM-style library chat thread.
 *
 * Separate from `ConversationStore` (which is keyed by selection-spawned
 * IDs) because the library chat is a singleton surface that persists
 * across selections and across sidebar mount/unmount. Keeping it free of
 * the SelectionContext / ProviderProfile fields lets the view code stay
 * narrow — the only state it needs to render is `messages`, `status`,
 * and an optional `errorMessage`.
 */

import type { ChatMessage } from "../providers/provider-types.js";

export type LibraryChatStatus = "idle" | "streaming" | "completed" | "failed";

export type LibraryChatState = {
  readonly status: LibraryChatStatus;
  readonly messages: readonly ChatMessage[];
  readonly errorMessage: string | null;
};

export type LibraryChatListener = (state: LibraryChatState) => void;

export type LibraryConversationStore = {
  getState(): LibraryChatState;
  appendUserMessage(content: string): void;
  appendAssistantDelta(text: string): void;
  markStreaming(): void;
  complete(): void;
  fail(message: string): void;
  reset(): void;
  subscribe(listener: LibraryChatListener): () => void;
};

function initialState(): LibraryChatState {
  return { status: "idle", messages: [], errorMessage: null };
}

export function createLibraryConversationStore(): LibraryConversationStore {
  let state: LibraryChatState = initialState();
  const listeners = new Set<LibraryChatListener>();

  const notify = (): void => {
    for (const listener of listeners) {
      listener(state);
    }
  };

  const set = (next: LibraryChatState): void => {
    state = next;
    notify();
  };

  return {
    getState() {
      return state;
    },
    appendUserMessage(content) {
      set({
        ...state,
        messages: [...state.messages, { role: "user", content }]
      });
    },
    appendAssistantDelta(text) {
      const last = state.messages.at(-1);
      if (last?.role === "assistant") {
        set({
          ...state,
          messages: [
            ...state.messages.slice(0, -1),
            { role: "assistant", content: `${last.content}${text}` }
          ]
        });
        return;
      }
      set({
        ...state,
        messages: [...state.messages, { role: "assistant", content: text }]
      });
    },
    markStreaming() {
      set({ ...state, status: "streaming", errorMessage: null });
    },
    complete() {
      set({ ...state, status: "completed", errorMessage: null });
    },
    fail(message) {
      set({ ...state, status: "failed", errorMessage: message });
    },
    reset() {
      set(initialState());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
