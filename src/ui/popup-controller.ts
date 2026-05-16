import type { ConversationStore } from "../conversation/conversation-store.js";
import type { ModelProvider } from "../providers/provider-types.js";

export type PopupController = {
  explain(conversationId: string): Promise<void>;
  cancel(conversationId: string): void;
  retry(conversationId: string): Promise<void>;
  continueInSidebar(conversationId: string): void;
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
