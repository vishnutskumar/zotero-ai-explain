import type { ConversationStore } from "../conversation/conversation-store.js";
import type { ModelProvider } from "../providers/provider-types.js";

export type PopupController = {
  readonly explain: (conversationId: string) => Promise<void>;
  readonly cancel: (conversationId: string) => void;
  readonly retry: (conversationId: string) => Promise<void>;
  readonly continueInSidebar: (conversationId: string) => void;
  /**
   * AC5: inline follow-up. Append the user's message, stream the model
   * response, and let the popup view render the turns. Mirrors
   * `sidebarController.sendFollowUp`; either surface can host the
   * conversation.
   */
  readonly sendFollowUp: (conversationId: string, message: string) => Promise<void>;
};

export function createPopupController(deps: {
  readonly store: ConversationStore;
  readonly provider: ModelProvider;
}): PopupController {
  const abortControllers = new Map<string, AbortController>();

  async function explain(conversationId: string): Promise<void> {
    const conversation = deps.store.get(conversationId);
    if (conversation === null) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    const abortController = new AbortController();
    abortControllers.set(conversationId, abortController);
    deps.store.markStreaming(conversationId);

    try {
      let errorMessage: string | null = null;
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
        } else if (event.type === "error") {
          // Providers yield `error` for in-band failures (e.g. connection
          // refused) instead of throwing. Capture the first one so the
          // popup body can show it; do not call `complete` after.
          errorMessage ??= event.message;
        }
      }
      if (errorMessage !== null) {
        deps.store.fail(conversationId, errorMessage);
      } else {
        deps.store.complete(conversationId);
      }
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

  async function sendFollowUp(conversationId: string, message: string): Promise<void> {
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

    const abortController = new AbortController();
    abortControllers.set(conversationId, abortController);

    try {
      let errorMessage: string | null = null;
      for await (const event of deps.provider.streamChat(
        {
          selection: conversation.selection,
          messages: deps.store.get(conversationId)?.messages ?? conversation.messages,
          profile: conversation.profile
        },
        abortController.signal
      )) {
        if (event.type === "delta") {
          deps.store.appendAssistantDelta(conversationId, event.text);
        } else if (event.type === "error") {
          errorMessage ??= event.message;
        }
      }
      if (errorMessage !== null) {
        deps.store.fail(conversationId, errorMessage);
      } else {
        deps.store.complete(conversationId);
      }
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
    },
    sendFollowUp
  };
}
