import type { ChatMessage, ProviderProfile } from "../providers/provider-types.js";
import type { SelectionContext } from "../selection/selection-context.js";

export type ConversationStatus = "idle" | "streaming" | "completed" | "failed" | "cancelled";

export type Conversation = {
  readonly id: string;
  readonly selection: SelectionContext;
  readonly profile: ProviderProfile;
  readonly messages: readonly ChatMessage[];
  readonly status: ConversationStatus;
  readonly visibleSurface: "popup" | "sidebar";
  readonly errorMessage: string | null;
};
