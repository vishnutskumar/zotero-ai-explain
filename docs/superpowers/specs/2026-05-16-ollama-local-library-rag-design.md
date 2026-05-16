# Ollama Local Library RAG Design

## Goal

Make Zotero AI Explain usable inside Zotero with Ollama as the first supported end-to-end provider,
then add whole-library local indexing and retrieval-augmented chat. The default path is local-only:
selected text and document text stay on the machine unless the user explicitly enables an online
embedding provider.

## Scope

This design covers four implementation phases:

1. Usable Ollama explain/chat inside Zotero.
2. Whole-library local indexing through Ollama embeddings.
3. Retrieval-augmented chat over the local index.
4. Optional online embedding providers with explicit privacy confirmation.

The first implementation plan should prioritize phase 1 and create only the indexing interfaces
needed to avoid rewrites. Full online embedding support is intentionally deferred until local
indexing works.

## User Flow

- Zotero adds a `Zotero AI Explain > Settings` menu entry.
- Settings default to Ollama:
  - Chat base URL: `http://localhost:11434`
  - Chat model: user-entered, for example `llama3.1`, `qwen2.5`, or `mistral`
  - Embedding model: user-entered, for example `nomic-embed-text`
  - Local-only mode enabled by default
- In a Zotero reader tab, selecting text exposes an `Explain with AI` command.
- Triggering the command sends the selected text to the configured Ollama chat model.
- The explanation appears in an anchored popup near the selected text.
- The popup can move the conversation into a Zotero sidebar for follow-up chat.
- Settings include whole-library index controls: `Index library`, `Pause`, `Resume`, and
  `Clear index`, plus status counts.

## Architecture

### Zotero UI Layer

The Zotero-facing layer owns startup and shutdown integration:

- Register the settings menu entry.
- Register or expose the reader selection explain command.
- Mount and unmount the anchored popup.
- Mount and unmount the sidebar.
- Show index controls and provider configuration.

This layer should stay thin. It adapts Zotero windows, reader events, and preferences to testable
core modules.

### Provider Layer

Ollama is the primary provider for the next usable slice.

- Chat/explain calls use Ollama's local HTTP API.
- Embedding calls use Ollama's embedding API.
- The adapter reports clear errors for:
  - Ollama is not reachable.
  - The configured model is missing or returns an unsupported response.
  - The request is cancelled.

Existing provider abstractions remain, but the Zotero UI should make Ollama the default profile so
manual testing does not require remote credentials.

### Indexing Layer

The indexing layer builds a resumable whole-library queue:

- Enumerate Zotero library items with notes, PDFs, or supported attachments.
- Extract available text using Zotero-supported APIs where possible.
- Chunk text deterministically.
- Embed chunks through the configured local embedding provider by default.
- Persist chunk metadata, embedding model, source item identity, attachment identity, updated
  timestamp, and indexing status.
- Support pause, resume, clear, and restart recovery.

The first implementation may store vectors in a simple local persistence layer if it exposes a clean
repository interface. The repository boundary must allow replacing the storage engine later without
changing provider or UI code.

### Retrieval Layer

Retrieval uses the local index to add context to explain and follow-up chat:

- Retrieve top matching chunks for the selected text or user follow-up.
- Inject retrieved snippets into the provider request as bounded context.
- Show source items in the sidebar.
- Provide a `Use library context` toggle.
- Keep selected-text explain working even when the index is empty or disabled.

### Privacy Model

Local-only is the default. The plugin must not send document text to online embedding providers
unless the user explicitly enables an online provider and confirms that document text may leave the
machine. Provider settings should store secret references rather than raw API keys.

## Implementation Phases

### Phase 1: Usable Ollama Explain

- Add Zotero settings UI.
- Store the Ollama profile in Zotero preferences.
- Add the reader `Explain with AI` command.
- Call Ollama locally.
- Show an anchored popup with the explanation.
- Move the conversation to the sidebar for follow-up chat.
- Show actionable connection and model errors.

### Phase 2: Whole-Library Local Index

- Add index status UI.
- Enumerate the Zotero library.
- Extract item, attachment, and note text where available.
- Chunk text.
- Embed chunks through Ollama.
- Store vector rows locally with source metadata.
- Support pause, resume, clear, and restart recovery.

### Phase 3: RAG Chat

- Retrieve relevant chunks for selected text and follow-up questions.
- Add retrieved context to chat requests.
- Show cited source items in the sidebar.
- Add a `Use library context` toggle.
- Preserve explain/chat behavior when no index is available.

### Phase 4: Online Embeddings

- Add online embedding provider profiles.
- Keep them disabled by default.
- Require explicit privacy confirmation before first use.
- Store only secret references.

## Testing

- Unit tests for Ollama chat request and response handling.
- Unit tests for Ollama embedding request and response handling.
- Unit tests for settings persistence and default Ollama profile creation.
- Unit tests for reader command orchestration independent of Zotero internals.
- Unit tests for popup and sidebar mounting behavior.
- Unit tests for chunking, indexing state transitions, pause/resume, and clear.
- Unit tests for retrieval ranking and empty-index behavior.
- Manual Zotero smoke test for settings, reader command visibility, popup rendering, sidebar
  follow-up chat, and index controls.

## Acceptance Criteria

- AC-1: A fresh install exposes settings inside Zotero.
- AC-2: Settings default to an Ollama local profile.
- AC-3: The user can configure Ollama base URL, chat model, and embedding model.
- AC-4: Selecting text in a Zotero reader exposes an explain command.
- AC-5: The explain command calls Ollama and renders a popup near the selected text.
- AC-6: The popup can move the conversation to a sidebar.
- AC-7: Sidebar follow-up chat uses the same conversation context.
- AC-8: Connection and missing-model failures are visible and actionable.
- AC-9: Whole-library indexing is local-only by default.
- AC-10: Indexing can be started, paused, resumed, and cleared.
- AC-11: RAG chat can use local indexed chunks and show source items.
- AC-12: Online embedding providers require explicit opt-in before document text leaves the machine.

## Non-Goals

- Building a browser companion UI outside Zotero.
- Making online embeddings the default.
- Indexing every possible attachment format in the first indexing pass.
- Guaranteeing high-performance vector search for very large libraries before the repository
  boundary is proven.

## Risks

- Zotero reader APIs may differ across supported versions. Reader integration must be isolated and
  manually smoke-tested in Zotero.
- Whole-library indexing can be expensive. The queue needs pause/resume and progress reporting from
  the first local indexing phase.
- Ollama response shapes can differ by endpoint and version. The adapter should validate responses
  and surface clear errors.
- Full-library text extraction may expose documents the user forgot were in the library. Local-only
  defaults and explicit online opt-in mitigate this.
