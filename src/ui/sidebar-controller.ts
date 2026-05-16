import type { ConversationStore } from "../conversation/conversation-store.js";
import type { ModelProvider } from "../providers/provider-types.js";

export type SidebarController = {
  readonly sendFollowUp: (conversationId: string, message: string) => Promise<void>;
};

export function createSidebarController(deps: {
  readonly store: ConversationStore;
  readonly provider: ModelProvider;
}): SidebarController {
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
