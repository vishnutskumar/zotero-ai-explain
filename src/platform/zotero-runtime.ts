import type { ConversationStore } from "../conversation/conversation-store.js";
import type { Conversation } from "../conversation/conversation-types.js";
import {
  createLibraryConversationStore,
  type LibraryConversationStore
} from "../conversation/library-conversation-store.js";
import type { IndexStorage } from "../indexing/index-storage.js";
import type { IndexingController } from "../indexing/indexing-controller.js";
import {
  EmbeddingDimensionMismatchError,
  loadIndex,
  topKChunks
} from "../indexing/index-search.js";
import {
  saveOllamaSettingsToPrefs,
  type OllamaSettings,
  type StringPrefWriter
} from "../preferences/ollama-profile.js";
import {
  saveProviderProfileSettingsToPrefs,
  type ProviderProfileSettings
} from "../preferences/provider-profile.js";
import type {
  ChatMessage,
  EmbeddingProvider,
  ModelProvider,
  ProviderProfile
} from "../providers/provider-types.js";
import type { SelectionContext } from "../selection/selection-context.js";
import { renderAnchoredPopup } from "../ui/anchored-popup-view.js";
import { attachIndexControls } from "../ui/index-controls-view.js";
import {
  buildLibraryPrompt,
  renderLibraryChatView,
  wireLibraryChatView,
  type CitationClick
} from "../ui/library-chat-view.js";
import { attachCitationClickHandler } from "../ui/citation-click.js";
import { buildCitationLookup, type CitationLookup } from "../ui/citation-lookup.js";
import { renderMarkdown, renderMarkdownWithCitations } from "../ui/markdown.js";
import type { RetrievedChunk } from "../indexing/index-search.js";
import { openCitationInReader, type CitationReaderZotero } from "./citation-open.js";
import type { PopupController } from "../ui/popup-controller.js";
import { discoverModels, type DiscoveryFetch } from "../preferences/model-discovery.js";
import {
  renderSettingsView,
  wireSettingsView,
  type ModelDiscoveryContext,
  type ProxySettingsFormValues,
  type ProxySettingsState,
  type SettingsFormValues,
  type SettingsValidationFailure,
  type SettingsValidationResult
} from "../ui/settings-view.js";
import type { SidebarController } from "../ui/sidebar-controller.js";
import { renderSidebarConversation } from "../ui/sidebar-view.js";
import type { ZoteroGlobal } from "./zotero-ui-adapter.js";
import type { Unsubscribe, ZoteroUiAdapter } from "./zotero-ui-types.js";

export type ZoteroRuntime = {
  startup(): Promise<void>;
  shutdown(): Promise<void>;
  /**
   * Imperatively open the settings dialog from outside the menu callback.
   * Used by the first-run onboarding flow to hand the user off into
   * Settings when they click "Open Settings". Idempotent — safe to call
   * multiple times; each call mounts a fresh dialog.
   */
  openSettings(): void;
};

/**
 * Build the disclosure banner string at the moment the popup is rendered.
 * Zero-arg so the formatter can read live settings (provider + model) on
 * every call — the previous `(profile) => string` shape locked in a
 * startup snapshot and the banner went stale whenever the user changed
 * the active chat provider in settings.
 */
export type DisclosureFormatter = () => string;

/**
 * Settings-save side-effect: callback the runtime invokes after a
 * successful validate+persist so the rest of the host (bootstrap) can
 * rebuild the provider/indexing-controller with the new endpoint.
 * Tests pass a spy; production wires it to a function that rebuilds the
 * provider with the new baseUrl/models.
 */
export type SettingsChangeListener = (settings: OllamaSettings) => void;

/**
 * Listener fired after a successful Save when the dialog includes the
 * provider section. Receives the persisted provider profile so the
 * bootstrap can rebuild the chat / embedding providers in-place.
 */
export type ProviderProfileChangeListener = (settings: ProviderProfileSettings) => void;

/**
 * Minimal fetch surface the runtime needs to validate Ollama settings
 * and direct-API keys.
 *
 * Mirrors the global `fetch` signature so tests can substitute a stub
 * and production wiring is a one-line pass-through. The optional
 * `headers` field exists because Phase-4 direct-API validation must
 * send `Authorization: Bearer <key>` (OpenAI/Codex) and
 * `x-api-key` + `anthropic-version` (Anthropic). Without it, the
 * /v1/models probe gets a 401 and a valid key is rejected (H3).
 */
export type RuntimeFetch = (
  input: string,
  init?: {
    readonly signal?: AbortSignal;
    readonly headers?: Record<string, string>;
  }
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

/**
 * Optional proxy lifecycle handle the runtime threads into the settings
 * dialog. When omitted, the dialog renders without the "Local LLM proxy"
 * section (matches the prior behavior). When supplied, the runtime:
 *
 *   - calls `snapshot()` once per `openSettings()` so the dialog renders
 *     the current Node/script/port and running state,
 *   - calls `applyValues()` with the form's values before `start()` so
 *     user edits to the Node/script/port inputs take effect on the next
 *     spawn,
 *   - delegates Start/Stop button clicks to `start()` / `stop()`.
 *
 * Production wires this to the `WiredProxy` returned by
 * `wireProxyLifecycle`; tests inject a fake to assert dispatch order.
 */
export type ProxyRuntimeHandle = {
  snapshot(): ProxySettingsState;
  applyValues(values: ProxySettingsFormValues): ProxySettingsState;
  start(): Promise<
    { readonly pid: number } | { readonly external: true } | { readonly error: string }
  >;
  stop(): Promise<void>;
  redetectNode(): ProxySettingsState;
  setAutoStart(enabled: boolean): ProxySettingsState;
};

/**
 * Dependencies required to power the "Ask your library" panel.
 *
 *   - `provider` streams the chat completion.
 *   - `embeddingProvider` embeds the user's question with the same model
 *     the crawler used (the caller is responsible for keeping them in
 *     sync); a dim-mismatch surfaces as an in-band error.
 *   - `indexStorage` exposes the persisted IndexFile.
 *   - `embedSettings` carries the `baseUrl`/`model` the embedding
 *     provider needs for `embedTexts(...)`.
 *   - `openItem(citation)` is invoked when the user clicks a citation
 *     link. It receives the RESOLVED citation — `itemKey` plus the
 *     chunk-scoped `attachmentKey`/`pageIndex` when the click hit a
 *     lookup entry. Production wires it to `Zotero.Reader.open`, jumping
 *     straight to `pageIndex` when one is present.
 */
export type LibraryChatDeps = {
  readonly provider: ModelProvider;
  readonly embeddingProvider: EmbeddingProvider;
  readonly indexStorage: IndexStorage;
  readonly embedSettings: { readonly baseUrl: string; readonly model: string };
  readonly openItem: (citation: CitationClick) => void;
};

/**
 * Per-startup pub/sub channel for the RAG-augmented popup/sidebar
 * provider's `onRetrieved` callback. Bootstrap constructs an instance
 * and wires it into BOTH the rag provider deps (publisher side) and the
 * runtime deps (subscriber side). The runtime's `startExplain` /
 * `startAskQuestion` subscribe ONCE per conversation, snapshot the most
 * recent chunks into a per-conversation `CitationLookup`, and feed that
 * lookup into the popup/sidebar render path so `[itemKey#chunkIndex]`
 * tokens linkify to live clickable anchors.
 *
 * Single shared publisher + per-conversation subscribers is correct
 * because the popup/sidebar serve a single conversation per active
 * stream — when the user starts a new explain the old subscriber is
 * still attached, but it's filtering by conversation-creation order
 * (the last subscriber to attach wins for the next published event).
 * Concurrent explain requests are not supported today (one popup at a
 * time); when they are, this channel will need request-ID dispatch.
 *
 * FOLLOW-UP (P5 quality H1 / MEDIUM-4): the channel exists only to
 * bridge the bootstrap-runtime indirection — the rag provider is built
 * in bootstrap and consumed by the runtime. A cleaner shape would move
 * the per-message lookup into `ConversationStore` (mirroring
 * `LibraryConversationStore.attachCitationLookup`) so the rag provider
 * can mutate the store directly and the channel disappears. Deferred —
 * the present implementation is correct for the one-popup-at-a-time
 * UI and tearing it down properly (see Fix 1 in this patch) closes
 * the only concrete bug it shipped with.
 */
export type PopupRetrievalChannel = {
  /** Publish the chunks retrieved for the most recent popup/sidebar
   * request. Called by bootstrap's wiring to the rag provider's
   * `onRetrieved`. Idempotent — the latest call wins. */
  publish(chunks: readonly RetrievedChunk[]): void;
  /** Subscribe to retrieval publications. The returned function
   * detaches the subscriber. Subscribers are invoked synchronously
   * inside `publish`, matching the rag provider's "must complete
   * synchronously" contract. */
  subscribe(handler: (chunks: readonly RetrievedChunk[]) => void): Unsubscribe;
};

/**
 * Construct a fresh `PopupRetrievalChannel`. The channel keeps a small
 * subscriber set and synchronously fans out each published event.
 * Exported so bootstrap (production) and tests can both build one
 * without depending on the runtime construction.
 */
export function createPopupRetrievalChannel(): PopupRetrievalChannel {
  const subscribers = new Set<(chunks: readonly RetrievedChunk[]) => void>();
  return {
    publish(chunks) {
      for (const handler of subscribers) {
        try {
          handler(chunks);
        } catch {
          // A subscriber throw must not poison the publish loop or break
          // the rag provider's streaming contract. Swallow defensively.
        }
      }
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    }
  };
}

/** Number of top-ranked chunks to include as context in the prompt. */
const LIBRARY_CHAT_TOP_K = 8;

/**
 * Synthesize a SelectionContext stub for the library-chat flow. The
 * provider request signature requires a SelectionContext, but library
 * chat has no in-reader selection; the `quote` carries the question for
 * any provider that logs it but no provider mutates the prompt based on
 * source metadata when `messages` already includes the grounded prompt.
 */
function blankSelection(question: string): SelectionContext {
  return {
    quote: question,
    source: {
      itemKey: null,
      itemTitle: null,
      attachmentKey: null,
      pageLabel: null
    },
    anchor: null
  };
}

const SETTINGS_VALIDATION_TIMEOUT_MS = 1500;

export function createZoteroRuntime(deps: {
  readonly settings: OllamaSettings;
  readonly indexingController: IndexingController;
  readonly ui: ZoteroUiAdapter;
  readonly store: ConversationStore;
  /**
   * Resolve the active provider profile (URL + model + secret) at the
   * moment a popup explain or library-chat request is built. Previously
   * a `ProviderProfile` snapshot captured at startup; that left the
   * popup banner AND request routing stale after the user changed
   * presets/models mid-session (see Bug A1/A2 + codex review #5).
   *
   * The closure is invoked per request rather than per session so the
   * conversation store records the profile that was active when the
   * conversation began. Cross-family swaps (ollama → claude-api) still
   * need a Zotero restart because the chat adapter is built once at
   * startup; URL/model changes within the ollama-family (ollama →
   * codex-cli → claude-cli) all share the same Ollama-wire adapter and
   * take effect immediately.
   */
  readonly profile: () => ProviderProfile;
  readonly popupController: PopupController;
  readonly sidebarController: SidebarController;
  readonly disclosure: DisclosureFormatter;
  /** Optional pref writer. Omitted means "no persistence" (e.g. tests
   * that don't exercise the save path). When provided, the runtime calls
   * `saveOllamaSettingsToPrefs(prefsWriter, validatedSettings)` on
   * successful save. */
  readonly prefsWriter?: StringPrefWriter;
  /** Optional fetch override. Defaults to `globalThis.fetch`. The runtime
   * uses it to GET `${baseUrl}/api/tags` on Save and check the chat /
   * embedding model are listed. */
  readonly fetch?: RuntimeFetch;
  /** Optional listener fired after a successful Save. Production wires
   * this to a callback that rebuilds the provider with the new baseUrl
   * + models. */
  readonly onSettingsChange?: SettingsChangeListener;
  /**
   * Optional proxy lifecycle handle. When provided, the settings dialog
   * renders the "Local LLM proxy" section and the Start/Stop buttons are
   * wired to drive the lifecycle. Omitted in tests that do not exercise
   * the proxy surface and in hosts where Subprocess.sys.mjs is missing.
   */
  readonly proxy?: ProxyRuntimeHandle;
  /**
   * Phase 4 direct-API: snapshot of the provider profile settings
   * (chat backend, embed backend, API keys). When omitted, the settings
   * dialog renders without the provider section so older callers and
   * the e2e driver still get the legacy shape.
   */
  readonly providerProfile?: ProviderProfileSettings;
  /** Optional listener fired with the persisted provider profile after a Save. */
  readonly onProviderProfileChange?: ProviderProfileChangeListener;
  /**
   * Optional NotebookLM-style library chat dependencies. When provided,
   * the runtime registers an "Ask your library" Tools menu item that
   * opens a dialog hosting the library chat view. When omitted, the
   * menu item is not registered (covers tests that don't exercise the
   * surface).
   */
  readonly libraryChat?: LibraryChatDeps;
  /**
   * Optional chrome Zotero global. When provided, the runtime registers
   * Cmd/Ctrl+Shift+E (Explain) + Cmd/Ctrl+Shift+L (Library) keyboard
   * shortcuts on the main window. Omitted in tests that don't exercise
   * the keyboard path so they don't need to stub the Zotero global.
   */
  readonly zotero?: ZoteroGlobal;
  /**
   * Optional retrieval channel that the popup + sidebar conversations
   * subscribe to so they can linkify `[itemKey#chunkIndex]` citations
   * against the same retrieval that the rag-augmented provider used.
   * Bootstrap pairs this with `onRetrieved:` on `createRagAugmentedProvider`.
   * Omitted in tests that don't exercise the citation rendering path —
   * the popup then falls back to legacy `renderMarkdown` (citations
   * render as literal `[ABCD1234]` text without anchors).
   */
  readonly popupRetrievalChannel?: PopupRetrievalChannel;
}): ZoteroRuntime {
  const cleanup: Unsubscribe[] = [];
  // Mutable cache so the next "open settings" click reflects the values
  // the user just saved. Without this, the dialog re-renders from the
  // immutable `deps.settings` snapshot and the user sees their saved
  // value disappear on reopen — exactly the bug we are fixing.
  let currentSettings: OllamaSettings = deps.settings;
  // Mutable cache for the optional provider profile so save → reopen
  // shows the freshly-saved selectors instead of the dialog's startup
  // snapshot. Mirrors the `currentSettings` pattern above.
  let currentProviderProfile: ProviderProfileSettings | undefined = deps.providerProfile;
  const fetchImpl: RuntimeFetch | undefined = deps.fetch ?? globalThis.fetch;

  /**
   * Resolve the human page reference for a selection: the reader's
   * `pageLabel` verbatim when present, otherwise the 1-based
   * `pageIndex + 1`. `pageIndex: 0` yields "1" — a valid first page,
   * checked via `typeof === "number"` so it is never dropped as falsy.
   * Returns `undefined` when the selection carries no page at all.
   */
  function resolvePageReference(source: SelectionContext["source"]): string | undefined {
    const label = source.pageLabel?.trim();
    if (label !== undefined && label.length > 0) {
      return label;
    }
    const pageIndex = source.pageIndex;
    return typeof pageIndex === "number" ? String(pageIndex + 1) : undefined;
  }

  function describeSource(selection: SelectionContext): string {
    const title = selection.source.itemTitle?.trim();
    const page = resolvePageReference(selection.source);
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

  /**
   * AC-2: render the PDF-identity prompt frame for a reader-triggered
   * selection. The plan (L409-420) requires `itemKey`, `itemTitle`,
   * `attachmentKey`, `pageIndex` and the `pageLabel ?? String(pageIndex + 1)`
   * page reference to reach the LLM "in the prompt frame" — they are
   * captured on `selection.source` but were never put into the actual
   * provider messages.
   *
   * Returns `null` when the selection carries no identity at all (a
   * non-reader selection, or a reader event whose params were all
   * missing) so the caller can simply skip the frame — the explain /
   * ask-question request then degrades gracefully to quote-only, exactly
   * as before this fix.
   */
  function describeSourceFrame(selection: SelectionContext): string | null {
    const source = selection.source;
    const title = source.itemTitle?.trim();
    const itemKey = typeof source.itemKey === "string" ? source.itemKey.trim() : "";
    const attachmentKey =
      typeof source.attachmentKey === "string" ? source.attachmentKey.trim() : "";
    const page = resolvePageReference(source);

    const lines: string[] = [];
    if (title !== undefined && title.length > 0) {
      lines.push(`Document: ${title}`);
    }
    if (page !== undefined) {
      lines.push(`Page: ${page}`);
    }
    if (itemKey.length > 0) {
      lines.push(`Zotero item key: ${itemKey}`);
    }
    if (attachmentKey.length > 0) {
      lines.push(`Zotero attachment key: ${attachmentKey}`);
    }
    if (lines.length === 0) {
      return null;
    }
    return `The selected text comes from this source:\n${lines.join("\n")}`;
  }

  /**
   * AC-3: stamp the request-scoped RAG scope onto a reader-triggered
   * selection. When the reader resolved a parent item key, in-PDF RAG
   * retrieval is scoped to that item; non-PDF readers (and shortcut
   * selections that resolved no item) leave `scopedItemKey` undefined so
   * retrieval stays library-wide. Idempotent — re-applying is a no-op.
   */
  function withReaderScope(selection: SelectionContext): SelectionContext {
    const itemKey = selection.source.itemKey;
    if (typeof itemKey !== "string" || itemKey.length === 0) {
      return selection;
    }
    return {
      ...selection,
      source: { ...selection.source, scopedItemKey: itemKey }
    };
  }

  function firstAssistantMessage(conversation: Conversation): ChatMessage | undefined {
    return conversation.messages.find((message) => message.role === "assistant");
  }

  function followUpTurns(conversation: Conversation): readonly ChatMessage[] {
    // First user + first assistant belong to the primary body. Everything
    // after is the follow-up Q&A stream and gets rendered into the turns
    // container.
    const firstAssistantIndex = conversation.messages.findIndex((m) => m.role === "assistant");
    if (firstAssistantIndex < 0) {
      return [];
    }
    return conversation.messages.slice(firstAssistantIndex + 1);
  }

  /**
   * Render a conversation update into an anchored popup's DOM. Shared by
   * the explain and ask-question flows — both render the first assistant
   * turn into the body, follow-up turns into the turns container, and
   * manage the loading + error affordances identically.
   *
   * `citationLookup` (optional) is the per-conversation lookup table
   * built from the RAG retrieval. When present, citations in assistant
   * text linkify to clickable `<a data-item-key>` anchors via
   * `renderMarkdownWithCitations`; when absent (no RAG retrieval ran
   * for this conversation, or the runtime was constructed without a
   * `popupRetrievalChannel`), citations render as literal `[itemKey]`
   * text via `renderMarkdown`. Either way the result is XSS-safe — no
   * `innerHTML` interpolation.
   */
  function renderPopupConversation(
    updated: Conversation,
    refs: {
      readonly body: HTMLElement;
      readonly loading: HTMLElement | null;
      readonly errorBlock: HTMLElement | null;
      readonly errorMessageEl: HTMLElement | null;
      readonly turnsContainer: HTMLElement | null;
    },
    citationLookup?: CitationLookup
  ): void {
    const firstAssistant = firstAssistantMessage(updated);
    const followTurns = followUpTurns(updated);
    // Loading indicator visibility: shown whenever the stream is running
    // AND the currently-streaming turn has not yet produced text.
    const streaming = updated.status === "streaming";
    const failed = updated.status === "failed" && updated.errorMessage !== null;
    const trailingAssistantPending = (() => {
      if (followTurns.length === 0) {
        return (firstAssistant?.content.length ?? 0) === 0;
      }
      const last = followTurns[followTurns.length - 1];
      if (last === undefined) return false;
      if (last.role !== "assistant") return true;
      return last.content.length === 0;
    })();
    if (refs.loading !== null) {
      refs.loading.hidden = !(streaming && trailingAssistantPending);
    }
    if (refs.errorBlock !== null && refs.errorMessageEl !== null) {
      if (failed) {
        refs.errorMessageEl.textContent = updated.errorMessage;
        refs.errorBlock.hidden = false;
      } else {
        refs.errorBlock.hidden = true;
        refs.errorMessageEl.textContent = "";
      }
    }
    // The error block owns the failure UX — keep the body free of an
    // "Error:" prefix so a retry leaves a clean tree behind.
    const renderText = (host: HTMLElement, text: string): void => {
      if (citationLookup !== undefined) {
        renderMarkdownWithCitations(host, text, { lookup: citationLookup });
      } else {
        renderMarkdown(host, text);
      }
    };
    if (firstAssistant !== undefined && firstAssistant.content.length > 0) {
      renderText(refs.body, firstAssistant.content);
    } else {
      renderText(refs.body, "");
    }
    const turnsContainer = refs.turnsContainer;
    if (turnsContainer !== null) {
      const fragments = followTurns.map((message) => {
        const article = turnsContainer.ownerDocument.createElement("article");
        article.className = `zotero-ai-explain-popup__turn`;
        article.dataset.role = message.role;
        article.setAttribute(
          "style",
          "margin: 0; font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-break: break-word;"
        );
        const attribution = turnsContainer.ownerDocument.createElement("span");
        attribution.className = "zotero-ai-explain-popup__turn-role";
        attribution.textContent = `${message.role}: `;
        const turnBody = turnsContainer.ownerDocument.createElement("div");
        turnBody.className = "zotero-ai-explain-popup__turn-body";
        // Assistant follow-ups can also carry citations; user turns
        // render through the same path (their text contains no citations
        // and falls through both renderers unchanged).
        renderText(turnBody, message.content);
        article.append(attribution, turnBody);
        return article;
      });
      turnsContainer.replaceChildren(...fragments);
    }
  }

  /**
   * Dispatch a citation click through `openCitationInReader`. Used as
   * the callback supplied to `attachCitationClickHandler` at the popup
   * and sidebar DOM roots. The chrome Zotero global is read off the
   * runtime deps so the same routing the library-chat dialog uses
   * carries through; tests that omit `deps.zotero` see the dispatch
   * resolve to a no-op rather than throwing.
   */
  function dispatchPopupCitation(citation: CitationClick): void {
    const zoteroForCitation = deps.zotero as unknown as CitationReaderZotero | undefined;
    if (zoteroForCitation !== undefined) {
      openCitationInReader(citation, zoteroForCitation);
    }
  }

  function startExplain(rawSelection: SelectionContext): void {
    const selection = withReaderScope(rawSelection);
    const conversation = deps.store.createFromSelection(selection, deps.profile());
    // Per-conversation citation lookup. Populated by the rag-augmented
    // provider's `onRetrieved` callback (plumbed through bootstrap +
    // popupRetrievalChannel) the moment the first retrieval lands.
    // Mutable so render passes after retrieval pick up the live table.
    const lookupRef: { current: CitationLookup | undefined } = { current: undefined };
    const retrievalUnsubscribe = deps.popupRetrievalChannel?.subscribe((chunks) => {
      lookupRef.current = buildCitationLookup(chunks);
    });
    // AC-2: seed the PDF-identity prompt frame as a leading system
    // message so the model sees the document title + page reference +
    // Zotero keys alongside the quote. Skipped when the selection has no
    // identity (a non-reader selection) — the request then degrades to
    // quote-only exactly as before.
    const sourceFrame = describeSourceFrame(selection);
    if (sourceFrame !== null) {
      deps.store.appendSystemMessage(conversation.id, sourceFrame);
    }
    deps.store.appendUserMessage(conversation.id, `Explain this: ${selection.quote}`);

    const popup = renderAnchoredPopup({
      disclosure: deps.disclosure(),
      anchor: selection.anchor,
      text: ""
    });
    const body = popup.querySelector<HTMLElement>(".zotero-ai-explain-popup__body");
    const loading = popup.querySelector<HTMLElement>(".zotero-ai-explain-popup__loading");
    const errorBlock = popup.querySelector<HTMLElement>(".zotero-ai-explain-popup__error");
    const errorMessageEl = popup.querySelector<HTMLElement>(
      ".zotero-ai-explain-popup__error-message"
    );
    const turnsContainer = popup.querySelector<HTMLElement>(".zotero-ai-explain-popup__turns");

    let popupUnmount: Unsubscribe | null = null;
    let popupUnsubscribe: Unsubscribe | null = null;
    let detachPopupCitationClicks: (() => void) | null = null;
    let sidebarUnmount: Unsubscribe | null = null;
    let sidebarUnsubscribe: Unsubscribe | null = null;
    let detachSidebarCitationClicks: (() => void) | null = null;
    let sidebarMessages: HTMLOListElement | null = null;
    // Single owner for the channel subscription. Tear down once at the
    // first of: popup dismissal (when no sidebar was ever mounted),
    // sidebar dismissal (after the popup→sidebar transition), or runtime
    // shutdown. Nulling the local on first teardown makes the helper
    // idempotent so a later teardown call is a no-op.
    let teardownRetrieval: (() => void) | null = () => {
      retrievalUnsubscribe?.();
    };
    const tearDownRetrieval = (): void => {
      const fn = teardownRetrieval;
      teardownRetrieval = null;
      fn?.();
    };

    const cleanupExplain = (): void => {
      popupUnsubscribe?.();
      detachPopupCitationClicks?.();
      detachPopupCitationClicks = null;
      popupUnmount?.();
      sidebarUnsubscribe?.();
      detachSidebarCitationClicks?.();
      detachSidebarCitationClicks = null;
      sidebarUnmount?.();
      tearDownRetrieval();
    };

    const dismissPopup = (): void => {
      popupUnsubscribe?.();
      popupUnsubscribe = null;
      popupUnmount = null; // adapter already removed the element on dismiss
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

      sidebarUnmount = deps.ui.mountSidebar(view, {
        onDismiss: () => {
          // The close button dismisses the wrapper; tear down EVERY
          // subscription that this conversation owned. After the
          // popup→sidebar transition the sidebar is the sole owner of
          // the retrieval channel subscription, so we tear that down
          // here too — `tearDownRetrieval` is idempotent if the popup
          // dismissal path already ran it.
          sidebarUnsubscribe?.();
          sidebarUnsubscribe = null;
          detachSidebarCitationClicks?.();
          detachSidebarCitationClicks = null;
          sidebarUnmount = null; // adapter already removed the element
          sidebarMessages = null;
          tearDownRetrieval();
        }
      });
      sidebarUnsubscribe = deps.store.subscribe(conversation.id, (updated) => {
        const list = sidebarMessages;
        if (list === null) {
          return;
        }
        // Skip system messages — see `renderMessage` in sidebar-view.ts.
        // The CSS bubble layout keys off `.__turn[data-role]`, so the row
        // classes here must stay in sync with the initial render.
        const rows = updated.messages
          .filter((message) => message.role !== "system")
          .map((message) => {
            const row = list.ownerDocument.createElement("li");
            row.className = "zotero-ai-explain-sidebar__turn";
            row.dataset.role = message.role;
            const attribution = list.ownerDocument.createElement("span");
            attribution.className = "zotero-ai-explain-sidebar__role";
            attribution.textContent = `${message.role}: `;
            const body = list.ownerDocument.createElement("div");
            body.className = "zotero-ai-explain-sidebar__body";
            // Sidebar gets the same citation linkification as the popup:
            // when retrieval ran for this conversation, citations are
            // clickable; otherwise they're literal text. `lookupRef.current`
            // is the same shared ref the popup reads.
            if (lookupRef.current !== undefined) {
              renderMarkdownWithCitations(body, message.content, {
                lookup: lookupRef.current
              });
            } else {
              renderMarkdown(body, message.content);
            }
            row.append(attribution, body);
            return row;
          });
        list.replaceChildren(...rows);
      });
      // Delegated citation-click handler on the sidebar view root, same
      // pattern as the popup. Re-attached per remount because the view
      // element itself is new each time. The teardown reference lives
      // in `detachSidebarCitationClicks` so `cleanupExplain` / the
      // sidebar's `onDismiss` can unwind the listener symmetrically.
      detachSidebarCitationClicks = attachCitationClickHandler(view, dispatchPopupCitation);
    };

    const continueButton = popup.querySelector<HTMLButtonElement>(
      '[data-action="continue-sidebar"]'
    );
    continueButton?.addEventListener("click", () => {
      // Tear down popup-specific state but keep `teardownRetrieval`
      // ALIVE — ownership of the retrieval subscription transfers to
      // the sidebar, which calls `tearDownRetrieval` from its
      // `onDismiss`. Without the click-handler detach here the popup
      // root (about to be removed by the adapter) would briefly keep a
      // listener attached; the explicit `detach` is symmetric with the
      // popup's `onDismiss` teardown path.
      popupUnsubscribe?.();
      popupUnsubscribe = null;
      detachPopupCitationClicks?.();
      detachPopupCitationClicks = null;
      popupUnmount?.();
      popupUnmount = null;
      deps.popupController.continueInSidebar(conversation.id);
      mountSidebar();
    });

    const retryButton = popup.querySelector<HTMLButtonElement>('[data-action="retry"]');
    retryButton?.addEventListener("click", () => {
      // Re-show the loading indicator since retry restarts the stream;
      // clear the previous error block too so the popup doesn't show a
      // stale red banner above the fresh stream.
      if (loading !== null) {
        loading.hidden = false;
      }
      if (errorBlock !== null) {
        errorBlock.hidden = true;
      }
      if (body !== null) {
        renderMarkdown(body, "");
      }
      void deps.popupController.retry(conversation.id);
    });

    // AC5: inline follow-up. Wire the form submit before mounting so the
    // first paint already has the listener attached.
    const followForm = popup.querySelector<HTMLFormElement>(".zotero-ai-explain-popup__form");
    const followTextarea = popup.querySelector<HTMLTextAreaElement>(
      '.zotero-ai-explain-popup__form [name="followUp"]'
    );
    followForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = followTextarea?.value ?? "";
      if (followTextarea) {
        followTextarea.value = "";
      }
      void deps.popupController.sendFollowUp(conversation.id, value);
    });
    // Enter submits; Shift+Enter inserts a newline. Matches the chat-app
    // convention so the user doesn't have to mouse to the Send button
    // for every follow-up. We trigger requestSubmit() so the form's
    // submit listener above runs (preserving the preventDefault path).
    followTextarea?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        followForm?.requestSubmit();
      }
    });

    // Delegated click handler — listens on the popup root so render
    // passes that replace the body subtree don't unbind. Shared
    // `attachCitationClickHandler` helper keeps the delegation shape
    // single-sourced with `library-chat-view.ts` and the sidebar wiring.
    detachPopupCitationClicks = attachCitationClickHandler(popup, dispatchPopupCitation);
    popupUnmount = deps.ui.mountPopup(popup, {
      anchor: selection.anchor,
      onDismiss: () => {
        // AC2: when the user dismisses (Escape, backdrop, close button),
        // tear down the subscription so we don't leak listeners.
        // `tearDownRetrieval` is idempotent — when the user instead
        // clicked "Continue in sidebar" the sidebar's `onDismiss` is
        // the owner; this path runs only on direct popup dismissal.
        popupUnsubscribe?.();
        popupUnsubscribe = null;
        popupUnmount = null;
        detachPopupCitationClicks?.();
        detachPopupCitationClicks = null;
        tearDownRetrieval();
      }
    });
    popupUnsubscribe = deps.store.subscribe(conversation.id, (updated) => {
      if (body === null) {
        return;
      }
      renderPopupConversation(
        updated,
        {
          body,
          loading,
          errorBlock,
          errorMessageEl,
          turnsContainer
        },
        lookupRef.current
      );
    });

    cleanup.push(cleanupExplain);
    // Reference to suppress unused-var lints when this helper is not invoked.
    void dismissPopup;

    void deps.popupController.explain(conversation.id);
  }

  /**
   * Build the sticky-quote system frame for an ask-question conversation.
   * Re-applied as `messages[0]` for the conversation's whole lifetime so
   * every provider request stays anchored to the user's selection.
   */
  function quoteSystemFrame(quote: string): string {
    return `The user is asking about this quoted passage: "${quote}"`;
  }

  /**
   * AC-1: "Ask a question" reader command. Opens the anchored popup with
   * the selection preloaded as a quote block and the textarea focused;
   * unlike `startExplain` it does NOT auto-stream. The first submitted
   * turn is framed `Quote: "<selection>"\n\nQuestion: <user-question>`;
   * the sticky-quote system message rides every later turn.
   */
  function startAskQuestion(rawSelection: SelectionContext): void {
    const selection = withReaderScope(rawSelection);
    const conversation = deps.store.createFromSelection(selection, deps.profile());
    // Per-conversation citation lookup, same pattern as startExplain.
    const lookupRef: { current: CitationLookup | undefined } = { current: undefined };
    const retrievalUnsubscribe = deps.popupRetrievalChannel?.subscribe((chunks) => {
      lookupRef.current = buildCitationLookup(chunks);
    });
    // Seed the sticky-quote system frame. It is `messages[0]` for the
    // conversation's lifetime, so it rides every provider request.
    deps.store.appendSystemMessage(conversation.id, quoteSystemFrame(selection.quote));
    // AC-2: seed the PDF-identity prompt frame as a second system message
    // so every ask-question turn carries the document title + page
    // reference + Zotero keys. Skipped when the selection has no identity.
    const sourceFrame = describeSourceFrame(selection);
    if (sourceFrame !== null) {
      deps.store.appendSystemMessage(conversation.id, sourceFrame);
    }

    const popup = renderAnchoredPopup({
      disclosure: deps.disclosure(),
      anchor: selection.anchor,
      text: "",
      mode: "ask-question",
      quote: selection.quote
    });
    const body = popup.querySelector<HTMLElement>(".zotero-ai-explain-popup__body");
    const loading = popup.querySelector<HTMLElement>(".zotero-ai-explain-popup__loading");
    const errorBlock = popup.querySelector<HTMLElement>(".zotero-ai-explain-popup__error");
    const errorMessageEl = popup.querySelector<HTMLElement>(
      ".zotero-ai-explain-popup__error-message"
    );
    const turnsContainer = popup.querySelector<HTMLElement>(".zotero-ai-explain-popup__turns");

    let popupUnmount: Unsubscribe | null = null;
    let popupUnsubscribe: Unsubscribe | null = null;
    let detachPopupCitationClicks: (() => void) | null = null;
    // Idempotent teardown for the retrieval subscription. Ask-question
    // has no "Continue in sidebar" affordance today, so the popup is
    // the sole owner — but mirror the explain helper anyway so a future
    // change that adds sidebar transitions doesn't reintroduce the
    // popup-correctness P5 efficiency leak.
    let teardownAskRetrieval: (() => void) | null = () => {
      retrievalUnsubscribe?.();
    };
    const tearDownAskRetrieval = (): void => {
      const fn = teardownAskRetrieval;
      teardownAskRetrieval = null;
      fn?.();
    };

    const cleanupAsk = (): void => {
      popupUnsubscribe?.();
      detachPopupCitationClicks?.();
      detachPopupCitationClicks = null;
      popupUnmount?.();
      tearDownAskRetrieval();
    };

    // The first submitted question is framed with the quote; later turns
    // are plain (the sticky-quote system message keeps them anchored).
    let firstTurnSent = false;

    const followForm = popup.querySelector<HTMLFormElement>(".zotero-ai-explain-popup__form");
    const followTextarea = popup.querySelector<HTMLTextAreaElement>(
      '.zotero-ai-explain-popup__form [name="followUp"]'
    );
    followForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const raw = followTextarea?.value ?? "";
      // Empty-textarea submit is a rejected no-op — matches library-chat's
      // empty-input behavior. `sendFollowUp` also trims/rejects, but we
      // bail here so the first-turn framing only consumes a real question.
      if (raw.trim().length === 0) {
        return;
      }
      if (followTextarea) {
        followTextarea.value = "";
      }
      if (!firstTurnSent) {
        firstTurnSent = true;
        void deps.popupController.sendFollowUp(
          conversation.id,
          `Quote: "${selection.quote}"\n\nQuestion: ${raw.trim()}`
        );
        return;
      }
      void deps.popupController.sendFollowUp(conversation.id, raw.trim());
    });
    followTextarea?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        followForm?.requestSubmit();
      }
    });

    detachPopupCitationClicks = attachCitationClickHandler(popup, dispatchPopupCitation);
    popupUnmount = deps.ui.mountPopup(popup, {
      anchor: selection.anchor,
      onDismiss: () => {
        popupUnsubscribe?.();
        popupUnsubscribe = null;
        popupUnmount = null;
        detachPopupCitationClicks?.();
        detachPopupCitationClicks = null;
        tearDownAskRetrieval();
      }
    });
    popupUnsubscribe = deps.store.subscribe(conversation.id, (updated) => {
      if (body === null) {
        return;
      }
      renderPopupConversation(
        updated,
        {
          body,
          loading,
          errorBlock,
          errorMessageEl,
          turnsContainer
        },
        lookupRef.current
      );
    });

    cleanup.push(cleanupAsk);
    // No auto-stream: ask-question waits for the user's first question.
  }

  /**
   * Validate the values typed into the settings dialog. Probes BOTH
   * the chat URL and the embed URL (`GET /api/tags`, 1500ms timeout
   * each, in parallel). For each URL it asserts the corresponding
   * model is listed in the server's tag manifest. Per-field failure
   * messages are returned so the dialog can highlight the offending
   * input — a chat-URL network failure flags `chatBaseUrl`, an
   * embed-URL failure flags `embedBaseUrl`, a missing model flags
   * `chatModel` / `embeddingModel`.
   *
   * Probing the same URL twice (when chat and embed share an endpoint)
   * is wasteful but cheap (~1ms localhost round-trip); the extra
   * complexity of a per-URL probe cache isn't worth it.
   */
  async function validateSettings(values: SettingsFormValues): Promise<SettingsValidationResult> {
    if (fetchImpl === undefined) {
      // No fetch in scope (rare; production always has one) — surface a
      // global error rather than silently accepting the save.
      return {
        ok: false,
        errors: [{ field: "global", message: "fetch is unavailable in this host." }]
      };
    }
    const errors: SettingsValidationFailure[] = [];

    // Phase 4 direct-API: skip URL probing when the user picked a
    // direct-API provider. We still probe the live API with a small
    // models-list request to confirm the key works before persisting.
    const chatIsApi = values.chatProvider === "codex-api" || values.chatProvider === "claude-api";
    const embedIsApi = values.embedProvider === "openai" || values.embedProvider === "gemini";

    if (chatIsApi) {
      const probe = await probeChatApi(fetchImpl, values);
      if (!probe.ok) {
        errors.push(probe.error);
      }
    } else {
      const chatProbe = await probeOneUrl(fetchImpl, values.chatBaseUrl);
      if (!chatProbe.ok) {
        errors.push({ field: "chatBaseUrl", message: chatProbe.message });
      } else if (!modelInstalled(chatProbe.models, values.chatModel)) {
        errors.push({
          field: "chatModel",
          message: `Model "${values.chatModel}" is not available at the chat URL.`
        });
      }
    }

    if (embedIsApi) {
      const probe = await probeEmbedApi(fetchImpl, values);
      if (!probe.ok) {
        errors.push(probe.error);
      }
    } else {
      const embedProbe = await probeOneUrl(fetchImpl, values.embedBaseUrl);
      if (!embedProbe.ok) {
        errors.push({
          field: "embedBaseUrl",
          message: embedProbe.message
        });
      } else if (!modelInstalled(embedProbe.models, values.embeddingModel)) {
        errors.push({
          field: "embeddingModel",
          message: `Model "${values.embeddingModel}" is not available at the embedding URL.`
        });
      }
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }
    return { ok: true };
  }

  /**
   * Probe the chat API provider with a lightweight test request. For
   * OpenAI we use `GET /v1/models` (cheap; verifies key is valid). For
   * Claude we POST a tiny `messages` request with `max_tokens=1`; that's
   * the canonical "key works" check Anthropic recommends since their
   * `/v1/models` endpoint requires the same auth.
   */
  async function probeChatApi(
    fetcher: RuntimeFetch,
    values: SettingsFormValues
  ): Promise<{ ok: true } | { ok: false; error: SettingsValidationFailure }> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, SETTINGS_VALIDATION_TIMEOUT_MS);
    try {
      if (values.chatProvider === "codex-api") {
        const apiKey = values.openaiApiKey ?? "";
        if (apiKey.length === 0) {
          return {
            ok: false,
            error: { field: "openaiApiKey", message: "OpenAI API key is required." }
          };
        }
        // H3 (Phase 4b codex review): pass Authorization header so
        // /v1/models returns 200 for a valid key. Without it, every
        // probe returned 401 even for working keys and the dialog
        // refused to save. Mirror the header shape used by
        // src/preferences/model-discovery.ts:143-145.
        const response = await fetcher("https://api.openai.com/v1/models", {
          signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        if (!response.ok) {
          return {
            ok: false,
            error: {
              field: "openaiApiKey",
              message: `OpenAI rejected the key (${String(response.status)}).`
            }
          };
        }
        return { ok: true };
      }
      if (values.chatProvider === "claude-api") {
        const apiKey = values.anthropicApiKey ?? "";
        if (apiKey.length === 0) {
          return {
            ok: false,
            error: { field: "anthropicApiKey", message: "Anthropic API key is required." }
          };
        }
        // Anthropic exposes /v1/models in newer versions; older versions only
        // support /v1/messages. We try /v1/models first; on a 404 we treat
        // it as "auth would otherwise work" and accept the key.
        // H3 (Phase 4b codex review): pass the canonical Anthropic
        // headers (x-api-key + anthropic-version) so /v1/models returns
        // 200 instead of 401. Mirror the header shape used by
        // src/preferences/model-discovery.ts:151-154.
        const response = await fetcher("https://api.anthropic.com/v1/models", {
          signal: controller.signal,
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          }
        });
        if (response.status === 401 || response.status === 403) {
          return {
            ok: false,
            error: {
              field: "anthropicApiKey",
              message: `Anthropic rejected the key (${String(response.status)}).`
            }
          };
        }
        return { ok: true };
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const field: SettingsValidationFailure["field"] =
        values.chatProvider === "claude-api" ? "anthropicApiKey" : "openaiApiKey";
      return { ok: false, error: { field, message: `Probe failed: ${message}` } };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Probe the embed API provider. For OpenAI we hit `/v1/models`; for
   * Gemini we hit `GET /v1beta/models?key=...` which Google explicitly
   * documents as a key-check endpoint.
   */
  async function probeEmbedApi(
    fetcher: RuntimeFetch,
    values: SettingsFormValues
  ): Promise<{ ok: true } | { ok: false; error: SettingsValidationFailure }> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, SETTINGS_VALIDATION_TIMEOUT_MS);
    try {
      if (values.embedProvider === "openai") {
        const apiKey = values.openaiApiKey ?? "";
        if (apiKey.length === 0) {
          return {
            ok: false,
            error: { field: "openaiApiKey", message: "OpenAI API key is required." }
          };
        }
        // H3 (Phase 4b codex review): same auth-header fix as the chat
        // probe — without Authorization, /v1/models 401s for every key.
        const response = await fetcher("https://api.openai.com/v1/models", {
          signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        if (!response.ok) {
          return {
            ok: false,
            error: {
              field: "openaiApiKey",
              message: `OpenAI rejected the key (${String(response.status)}).`
            }
          };
        }
        return { ok: true };
      }
      if (values.embedProvider === "gemini") {
        const apiKey = values.geminiApiKey ?? "";
        if (apiKey.length === 0) {
          return {
            ok: false,
            error: { field: "geminiApiKey", message: "Gemini API key is required." }
          };
        }
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
        const response = await fetcher(url, { signal: controller.signal });
        if (!response.ok) {
          return {
            ok: false,
            error: {
              field: "geminiApiKey",
              message: `Gemini rejected the key (${String(response.status)}).`
            }
          };
        }
        return { ok: true };
      }
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const field: SettingsValidationFailure["field"] =
        values.embedProvider === "gemini" ? "geminiApiKey" : "openaiApiKey";
      return { ok: false, error: { field, message: `Probe failed: ${message}` } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Helper: GET ${baseUrl}/api/tags with the runtime's timeout + AbortController. */
  async function probeOneUrl(
    fetcher: RuntimeFetch,
    rawBaseUrl: string
  ): Promise<
    | { ok: true; models: readonly string[] }
    | { ok: false; field: "url" | "transport"; message: string }
  > {
    let url: URL;
    try {
      // Preserve the path prefix of rawBaseUrl (e.g., `/codex` for the proxy
      // route) by appending `/api/tags` instead of using it as an absolute
      // path. `new URL("/api/tags", "http://host/codex")` would otherwise
      // resolve to `http://host/api/tags` — the wrong endpoint, which then
      // returns the wrong model list (the Ollama passthrough), letting
      // invalid combinations like URL=/codex + model=gemma slip past
      // validation.
      const trimmedBase = rawBaseUrl.replace(/\/+$/u, "");
      url = new URL(`${trimmedBase}/api/tags`);
    } catch {
      return { ok: false, field: "url", message: "Not a valid URL." };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, SETTINGS_VALIDATION_TIMEOUT_MS);
    try {
      const response = await fetcher(url.toString(), { signal: controller.signal });
      if (!response.ok) {
        return {
          ok: false,
          field: "transport",
          message: `Server responded ${String(response.status)} for /api/tags.`
        };
      }
      const payload: unknown = await response.json();
      return { ok: true, models: parseModelNames(payload) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        field: "transport",
        message: `Cannot reach ${rawBaseUrl}: ${message}`
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Match Ollama's CLI convention: a name without a tag is treated as
   * ":latest". E.g. `embeddinggemma` should match the installed tag
   * `embeddinggemma:latest`.
   */
  function modelInstalled(models: readonly string[], requested: string): boolean {
    if (models.includes(requested)) return true;
    if (!requested.includes(":")) return models.includes(`${requested}:latest`);
    return false;
  }

  function openSettingsDialog(): void {
    // Snapshot the proxy state once at open time; the wire-proxy module
    // pushes asynchronous updates into the rendered DOM via
    // `updateProxyStatus` (wired by bootstrap's `onStateChange`).
    const proxySnapshot = deps.proxy?.snapshot();
    const view = renderSettingsView({
      settings: currentSettings,
      indexStatus: deps.indexingController.getStatus(),
      ...(proxySnapshot !== undefined ? { proxy: proxySnapshot } : {}),
      ...(currentProviderProfile !== undefined ? { providerProfile: currentProviderProfile } : {})
    });
    // Wire the index control buttons before the dialog mounts so the
    // first render of the status line reflects current controller
    // state (and any clicks land while the dialog is visible).
    const detachIndex = attachIndexControls(view, deps.indexingController);
    const dialog = deps.ui.openDialog("Zotero AI Explain", view);
    const proxyHandle = deps.proxy;
    // Wire the live model picker. We adapt the runtime's RuntimeFetch
    // signature (which doesn't accept headers) into the discovery
    // module's DiscoveryFetch signature; both share enough surface that
    // the cast is safe at runtime (fetch + globalThis.fetch both
    // accept a headers init).
    const discoveryFetch: DiscoveryFetch | undefined = fetchImpl;
    const wired = wireSettingsView({
      view,
      validate: validateSettings,
      ...(discoveryFetch !== undefined
        ? {
            modelDiscovery: {
              discover: (ctx: ModelDiscoveryContext) =>
                discoverModels({
                  backend: ctx.backend,
                  url: ctx.url,
                  apiKey: ctx.apiKey,
                  fetch: discoveryFetch
                })
            }
          }
        : {}),
      onSave: (values) => {
        const next: OllamaSettings = {
          // Legacy mirror — the writer derives the legacy
          // `ollama-base-url` pref from this. Chat is the right default
          // for the legacy slot because any caller still reading the
          // legacy name is overwhelmingly the chat surface.
          baseUrl: values.chatBaseUrl,
          chatBaseUrl: values.chatBaseUrl,
          embedBaseUrl: values.embedBaseUrl,
          chatModel: values.chatModel,
          embeddingModel: values.embeddingModel,
          // localOnly is not a user-editable field in this dialog; preserve
          // whatever the current settings carry.
          localOnly: currentSettings.localOnly
        };
        if (deps.prefsWriter !== undefined) {
          saveOllamaSettingsToPrefs(deps.prefsWriter, next);
        }
        currentSettings = next;
        deps.onSettingsChange?.(next);

        // Phase 4 direct-API: persist provider profile changes when the
        // dialog rendered them. The values bundle carries optional
        // chat/embed selectors + API keys; merge them onto the cached
        // profile so untouched fields keep their prior state.
        if (currentProviderProfile !== undefined) {
          const nextProfile: ProviderProfileSettings = {
            ollama: next,
            chatProvider: values.chatProvider ?? currentProviderProfile.chatProvider,
            embedProvider: values.embedProvider ?? currentProviderProfile.embedProvider,
            openaiApiKey: values.openaiApiKey ?? currentProviderProfile.openaiApiKey,
            anthropicApiKey: values.anthropicApiKey ?? currentProviderProfile.anthropicApiKey,
            geminiApiKey: values.geminiApiKey ?? currentProviderProfile.geminiApiKey
          };
          if (deps.prefsWriter !== undefined) {
            saveProviderProfileSettingsToPrefs(deps.prefsWriter, nextProfile);
          }
          currentProviderProfile = nextProfile;
          deps.onProviderProfileChange?.(nextProfile);
        }
      },
      close: () => {
        detachIndex();
        wired.detach();
        dialog.close();
      },
      ...(proxyHandle !== undefined
        ? {
            proxy: {
              // The dialog reads back the live form values before each
              // start/stop click; we feed the proxy snapshot's
              // currently-known defaults so untouched inputs round-trip
              // the persisted values.
              readValues: () => {
                const snap = proxyHandle.snapshot();
                return {
                  nodeBinaryPath: snap.nodeBinaryPath,
                  serverScriptPath: snap.serverScriptPath,
                  port: snap.port
                };
              },
              start: async (values) => {
                // Persist the user's input edits first so the next spawn
                // sees the freshly-typed Node/script/port. applyValues
                // rebuilds the underlying ProxyLifecycle when the child
                // is not currently tracked — exactly the state the user
                // is in when they click Start.
                proxyHandle.applyValues(values);
                await proxyHandle.start();
              },
              stop: async () => {
                await proxyHandle.stop();
              },
              detect: () => {
                const snap = proxyHandle.redetectNode();
                return {
                  path: snap.nodeBinaryPath,
                  autoDetectFailed: snap.nodeAutoDetectFailed ?? false
                };
              },
              setAutoStart: (enabled) => {
                proxyHandle.setAutoStart(enabled);
              }
            }
          }
        : {})
    });
  }

  const libraryChat = deps.libraryChat;
  const libraryChatStore: LibraryConversationStore | null =
    libraryChat !== undefined ? createLibraryConversationStore() : null;

  /**
   * Open the "Ask your library" dialog. The dialog hosts a single
   * library-chat view whose entire children are replaced on every store
   * notification so the latest messages, streaming indicator, and error
   * message render without per-element diffing. Listener wiring is
   * recreated on each re-render because `replaceChildren` rebuilds the
   * form / button DOM that wireLibraryChatView attaches to.
   */
  function openLibraryChatDialog(): void {
    if (libraryChat === undefined || libraryChatStore === null) {
      return;
    }
    const chat = libraryChat;
    const store = libraryChatStore;

    // Tracks whether an IndexFile was found at open time. Starts false so
    // the first paint guards against the "no index" empty state; the
    // initial loadIndex resolves asynchronously and flips this when a
    // file is on disk.
    let hasIndex = false;
    let detach = (): void => undefined;
    // M4 (Phase 4b codex review) — concurrent-submit + reset guard.
    //
    // Token-based serialization replaces the prior boolean guard.
    // Each submit() captures a fresh token object before starting the
    // stream and aborts the stream's HTTP transfer via its own
    // AbortController. While the token is held, second-and-later
    // concurrent submits are rejected (matches the prior behavior).
    //
    // The token also lets reset() invalidate an in-flight submit:
    // reset() aborts the controller AND clears the current token. The
    // stream loop checks `currentSubmitToken !== myToken` after every
    // event and drops further deltas — without this, an old stream's
    // tail tokens land in the freshly-reset (empty) conversation and
    // appendAssistantDelta paints them as the first assistant turn of
    // a brand-new thread.
    //
    // We use an opaque object (`{}`) rather than an incrementing number
    // so concurrent submits cannot accidentally collide on the same
    // identifier across re-renders.
    let currentSubmitToken: object | null = null;
    let currentSubmitAbort: AbortController | null = null;

    const root = renderLibraryChatView({
      ...store.getState(),
      hasIndex
    });
    const dialog = deps.ui.openDialog("Ask your library", root);

    // Citation click: dim the dialog and dock it to the corner so the
    // Zotero pane behind comes back to focus while the conversation
    // stays visible. The minimize call is deferred to the next macrotask
    // because the click event that triggered us is still bubbling — the
    // dialog's own click-to-restore handler would otherwise fire on the
    // same event and undo the minimize immediately.
    const handleCitationClick = (citation: CitationClick): void => {
      const win = deps.zotero?.getMainWindow?.() ?? null;
      const scheduler =
        win !== null
          ? ((win as unknown as { readonly setTimeout?: typeof setTimeout }).setTimeout ??
            globalThis.setTimeout)
          : globalThis.setTimeout;
      scheduler(() => {
        try {
          dialog.minimize();
        } catch {
          // Defensive: minimize is idempotent in the adapter.
        }
      }, 0);
      chat.openItem(citation);
    };

    const submit = async (question: string): Promise<void> => {
      if (currentSubmitToken !== null) {
        return;
      }
      const myToken: object = {};
      const controller = new AbortController();
      currentSubmitToken = myToken;
      currentSubmitAbort = controller;
      // Helper: true when reset() (or another submit) has superseded the
      // submit identified by myToken. Used after every await to bail
      // before touching the store with a now-stale event.
      const isStale = (): boolean => currentSubmitToken !== myToken;
      store.appendUserMessage(question);
      store.markStreaming();
      try {
        const file = await loadIndex(chat.indexStorage);
        if (isStale()) return;
        if (file === null || Object.keys(file.items).length === 0) {
          store.fail("No indexed content found — index your library first.");
          return;
        }
        const [queryEmbedding] = await chat.embeddingProvider.embedTexts({
          baseUrl: chat.embedSettings.baseUrl,
          model: chat.embedSettings.model,
          texts: [question],
          signal: controller.signal
        });
        if (isStale()) return;
        if (queryEmbedding === undefined) {
          store.fail("Embedding provider returned no result.");
          return;
        }
        let retrieved;
        try {
          retrieved = topKChunks(file, queryEmbedding, LIBRARY_CHAT_TOP_K);
        } catch (err) {
          if (err instanceof EmbeddingDimensionMismatchError) {
            store.fail(err.message);
            return;
          }
          throw err;
        }
        if (retrieved.length === 0) {
          store.fail("No indexed content found — index your library first.");
          return;
        }
        // Pin the per-turn citation lookup to the assistant message's
        // index BEFORE streaming begins. The user message is already
        // appended, so the assistant turn lands at the current message
        // count; its first delta appends at exactly that index.
        store.attachCitationLookup(
          store.getState().messages.length,
          buildCitationLookup(retrieved)
        );
        const messages: readonly ChatMessage[] = [
          { role: "user", content: buildLibraryPrompt({ question, chunks: retrieved }) }
        ];
        let errored: string | null = null;
        for await (const event of chat.provider.streamChat(
          { selection: blankSelection(question), messages, profile: deps.profile() },
          controller.signal
        )) {
          // M4 iter 3: reset() invalidates the token and aborts the
          // controller. We re-check on every event so post-reset deltas
          // (whether arriving from a provider that ignores AbortSignal
          // or simply queued before the abort propagated) do not land
          // in the new conversation.
          if (isStale()) {
            return;
          }
          if (event.type === "delta") {
            store.appendAssistantDelta(event.text);
          } else if (event.type === "error") {
            errored ??= event.message;
          }
        }
        if (isStale()) return;
        if (errored !== null) {
          store.fail(errored);
        } else {
          store.complete();
        }
      } catch (err) {
        if (isStale()) return;
        store.fail(err instanceof Error ? err.message : String(err));
      } finally {
        // Release the guard only when *this* submit is still the
        // current one. A reset() or follow-up submit may have already
        // claimed the token; clearing unconditionally would let a
        // concurrent post-reset submit start a second parallel stream.
        if (currentSubmitToken === myToken) {
          currentSubmitToken = null;
          currentSubmitAbort = null;
        }
      }
    };

    const reset = (): void => {
      // Invalidate any in-flight submit so its remaining deltas (or
      // post-await store writes) drop on the floor instead of landing
      // in the freshly-reset conversation. abort() best-effort cancels
      // any HTTP work the provider's streamChat plumbing honors via
      // AbortSignal; the token check inside submit() handles providers
      // that ignore the signal.
      if (currentSubmitAbort !== null) {
        try {
          currentSubmitAbort.abort();
        } catch {
          // AbortController.abort() is documented as never throwing,
          // but defensive against host-injected polyfills.
        }
      }
      currentSubmitToken = null;
      currentSubmitAbort = null;
      store.reset();
    };

    const rewire = (): void => {
      detach();
      detach = wireLibraryChatView({
        view: root,
        onSubmit: submit,
        onReset: reset,
        onCitationClick: handleCitationClick
      });
    };

    const render = (): void => {
      const fresh = renderLibraryChatView({
        ...store.getState(),
        hasIndex
      });
      root.replaceChildren(...Array.from(fresh.childNodes));
      rewire();
    };

    rewire();
    void loadIndex(chat.indexStorage).then((file) => {
      hasIndex = file !== null;
      render();
    });

    const unsubscribe = store.subscribe(() => {
      render();
    });

    // Patch dialog.close so dismissal cleanly tears down the subscription
    // and the last attached listener set. Without this the next call to
    // openLibraryChatDialog would stack subscribers on the same store.
    const originalClose = dialog.close.bind(dialog);
    dialog.close = () => {
      unsubscribe();
      detach();
      originalClose();
    };
  }

  /**
   * Best-effort grab of "what the user has selected right now in the
   * active reader" so a keyboard shortcut can call startExplain without
   * needing the popup-button anchor. Returns null when no reader is
   * focused or no text is selected; callers should no-op in that case
   * rather than open an empty popup.
   */
  function readerSelectionForShortcut(): SelectionContext | null {
    if (deps.zotero === undefined) return null;
    try {
      const zoteroAny = deps.zotero as unknown as {
        readonly Reader?: {
          readonly getByTabID?: (id: string) => unknown;
        };
      };
      const win = deps.zotero.getMainWindow?.();
      if (!win) return null;
      const tabs = (win as unknown as { readonly Zotero_Tabs?: { readonly selectedID?: string } })
        .Zotero_Tabs;
      const tabId = tabs?.selectedID;
      if (typeof tabId !== "string" || tabId.length === 0) return null;
      const reader = zoteroAny.Reader?.getByTabID?.(tabId) as
        | {
            readonly _iframeWindow?: Window;
            readonly _iframe?: { getBoundingClientRect(): DOMRect };
          }
        | undefined;
      const iframeWindow = reader?._iframeWindow;
      const selection = iframeWindow?.getSelection() ?? null;
      const text = selection !== null ? selection.toString().trim() : "";
      if (text.length === 0) return null;
      const rect = reader?._iframe?.getBoundingClientRect() ?? null;
      return {
        quote: text,
        source: {
          itemKey: null,
          itemTitle: null,
          attachmentKey: null,
          pageLabel: null
        },
        anchor:
          rect === null
            ? null
            : { left: rect.left + rect.width / 2, top: rect.top + 60, width: 0, height: 0 }
      };
    } catch {
      return null;
    }
  }

  /**
   * Register Cmd/Ctrl+Shift+E (Explain) and Cmd/Ctrl+Shift+L (Library)
   * on the chrome window so the user can trigger both flows without
   * opening a menu. We deliberately use Shift+E/L rather than Alt — Alt
   * on Linux/Windows often triggers window-manager mnemonics, while
   * Shift is safer cross-platform. If a host application later binds
   * the same chord we'll surface a follow-up to rebind.
   */
  function registerKeyboardShortcuts(): Unsubscribe {
    if (deps.zotero === undefined) return () => undefined;
    const zotero = deps.zotero;
    const win = zotero.getMainWindow?.();
    const doc = (win as unknown as { readonly document?: Document } | undefined)?.document;
    if (!doc) return () => undefined;
    const onKeydown = (event: KeyboardEvent): void => {
      // Cross-platform "meta on mac, ctrl elsewhere" check. Using `event.metaKey ||
      // event.ctrlKey` keeps the binding intuitive on both — pressing the same
      // modifier-shape on whichever OS the user runs.
      const modOk = event.metaKey || event.ctrlKey;
      if (!modOk || !event.shiftKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "e") {
        const selection = readerSelectionForShortcut();
        if (selection === null) {
          zotero.debug("Zotero AI Explain: Cmd/Ctrl+Shift+E ignored — no reader selection.");
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        startExplain(selection);
        return;
      }
      if (key === "l" && libraryChat !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        openLibraryChatDialog();
      }
    };
    doc.addEventListener("keydown", onKeydown, true);
    return () => {
      doc.removeEventListener("keydown", onKeydown, true);
    };
  }

  return {
    startup() {
      cleanup.push(deps.ui.addMenuItem("Zotero AI Explain Settings", openSettingsDialog));
      if (libraryChat !== undefined) {
        cleanup.push(deps.ui.addMenuItem("Ask your library", openLibraryChatDialog));
      }
      cleanup.push(
        deps.ui.addReaderCommands([
          { label: "Explain with AI", mode: "explain", action: startExplain },
          { label: "Ask a question", mode: "ask-question", action: startAskQuestion }
        ])
      );
      cleanup.push(registerKeyboardShortcuts());
      return Promise.resolve();
    },
    shutdown() {
      while (cleanup.length > 0) {
        cleanup.shift()?.();
      }
      return Promise.resolve();
    },
    openSettings() {
      openSettingsDialog();
    }
  };
}

/**
 * Extract the `name` field of every model entry from an Ollama
 * `/api/tags` response. The Ollama API returns:
 *   { "models": [{ "name": "...", "model": "...", ... }, ...] }
 * but we duck-type the structure so a partial / changed payload doesn't
 * throw — anything missing simply yields an empty list, which the
 * caller surfaces as a validation error.
 *
 * Exported so tests can assert the parser handles each edge case
 * (empty, missing `models` key, non-string `name`).
 */
export function parseModelNames(payload: unknown): readonly string[] {
  if (payload === null || typeof payload !== "object") {
    return [];
  }
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of models) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) {
      names.push(name);
    }
  }
  return names;
}
