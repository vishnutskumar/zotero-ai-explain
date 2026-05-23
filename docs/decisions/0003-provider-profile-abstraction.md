# ADR 0003 — Provider profile abstraction

- **Status:** Accepted
- **Date:** 2026-05-17
- **Phase:** real-product-pipeline (Phase 4)

## Context

Pre-Phase-4 the settings dialog assumed one "Ollama profile" with one Base URL, one chat model, and
one embedding model. Phase 4 added five chat backends (ollama, codex-cli, claude-cli,
codex-api/OpenAI, claude-api) and three embedding backends (ollama, openai, gemini). Users typically
want **mixed** combinations — e.g. chat through Codex CLI (their ChatGPT subscription) while keeping
embeddings on Ollama (free, local, private). The dialog also needs a 1-click path for non-power
users.

## Decision

Three layers, most-opinionated to least:

1. **Preset dropdown** (`src/preferences/preset-profiles.ts`). Six presets — `local-ollama`,
   `codex-proxy`, `claude-proxy`, `openai-direct`, `anthropic-direct`, `custom`. Selecting one
   writes (chatProvider, embedProvider, chatBaseUrl, embedBaseUrl, chatModel, embeddingModel) into
   the form via `applyPreset(id, current)`. API keys carry through unchanged. "custom" returns the
   current snapshot as-is.

2. **Independent chat / embed selectors** (`src/preferences/provider-profile.ts`). Stored under
   separate prefs (`CHAT_PROVIDER_PREF`, `EMBED_PROVIDER_PREF`). The dialog renders each in its own
   section with URL / model / API-key fields visible per backend. Manually editing any preset-driven
   field flips the dropdown back to "custom" so it never silently misrepresents the live values.

3. **Per-provider API keys** stored verbatim under the Zotero pref tree (`openai-api-key`,
   `anthropic-api-key`, `gemini-api-key`). The dialog surfaces a privacy warning. `chatApiKeyFor` /
   `embedApiKeyFor` resolve the right key for the selected provider.

`detectPreset(snapshot)` reverse-lookups which preset matches a snapshot exactly so the first paint
of the dialog accurately reflects on-disk state.

## Consequences

- **1-click for the common case, surgical for the advanced case.** New users open settings, pick
  "Codex via Proxy", and the dialog populates URLs and models correctly. Power users pick "Custom"
  and configure any combination.
- **No coupling between chat and embed switches.** Switching chat does not force re-indexing because
  embed is orthogonal. Switching embed loads a different on-disk index (see ADR 0002).
- **The preset is a UI convenience only.** The persisted state is the tuple — preset id is never
  written. `detectPreset` re-derives on every dialog open. A future release that bumps a preset's
  default model automatically lights up for existing users on that preset.
- **Validation is per-provider.** `provider-profile-validation.ts` checks the right URL for the
  right provider; Save refuses to persist invalid values and flashes "Save failed".
- **Live model discovery is per-backend.** `model-discovery.ts` exposes
  `discoverModels({backend, url, apiKey, fetch})` with per-backend endpoints (Ollama `/api/tags`,
  OpenAI `/v1/models`, Anthropic `/v1/models`, Gemini `/v1beta/models`, proxy `/api/tags`). Probed
  on mount, on URL/key change (debounced 500 ms), on provider change, and on Refresh.

## Alternatives considered

- **Single profile with one URL.** Cannot express chat-codex + embed-ollama. Pre-Phase-4 shape.
- **One preset = one snapshot, no detection.** Goes stale immediately when the user edits a field.
- **Persist the preset id alongside the values.** Source-of-truth drift: an edited value would not
  match the persisted preset and the dialog would have to choose which to display.
- **Secrets references for the API keys** (per `src/secrets/`). Implemented for popup conversation
  history but not for provider keys — Zotero's `prefs.js` lives inside the OS-secured user profile,
  so plain text is acceptable for v1 with a privacy banner. May move to the secrets resolver in a
  future iteration.
