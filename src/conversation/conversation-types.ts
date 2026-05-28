import type { ChatMessage, ProviderProfile } from "../providers/provider-types.js";
import type { SelectionContext } from "../selection/selection-context.js";
import type { CitationLookup } from "../ui/citation-lookup.js";

export type ConversationStatus = "idle" | "streaming" | "completed" | "failed" | "cancelled";

export type Conversation = {
  readonly id: string;
  readonly selection: SelectionContext;
  readonly profile: ProviderProfile;
  readonly messages: readonly ChatMessage[];
  readonly status: ConversationStatus;
  readonly visibleSurface: "popup" | "sidebar";
  readonly errorMessage: string | null;
  /**
   * Per-assistant-message citation lookup tables (F3), keyed by the
   * assistant message's index in `messages`. Pinned per-turn so re-
   * rendering an OLDER assistant turn resolves its `[itemKey#chunkIndex]`
   * citations against THAT turn's retrieved chunks — not the most
   * recent turn's. Mirrors the shape on `LibraryChatState`
   * (`src/conversation/library-conversation-store.ts`) so popup,
   * sidebar, and library-chat all key citations by message index.
   *
   * Empty when no retrieval has run for the conversation (e.g. tests
   * that don't wire `popupRetrievalChannel`, or selections too short
   * for the rag-augmented provider to retrieve against). Render passes
   * fall back to plain markdown when the entry for an index is absent.
   */
  readonly citationLookups: ReadonlyMap<number, CitationLookup>;
};
