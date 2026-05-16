# Ollama Explain Zotero UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed Zotero plugin visibly usable with local Ollama settings, selected-text
explain, anchored popup output, sidebar follow-up chat, and indexing controls that are ready for the
next whole-library indexing plan.

**Architecture:** Add a thin Zotero-facing runtime layer that registers UI entry points and
delegates to testable TypeScript modules. Ollama becomes the default local provider, with chat and
embedding interfaces separated so document indexing can use the same profile without rewriting
provider code.

**Tech Stack:** Zotero plugin bootstrap, TypeScript, DOM APIs, Ollama HTTP API, Vitest, jsdom,
ESLint, Prettier, existing pre-commit hooks.

---

## Scope

This plan implements Phase 1 from
`docs/superpowers/specs/2026-05-16-ollama-local-library-rag-design.md` and creates only the indexing
interfaces/status UI needed for the next phase. It does not implement whole-library crawling,
embedding persistence, vector search, or online embedding providers.

## File Structure

```text
src/
  providers/
    provider-types.ts              # Add ollama kind and embedding provider contracts
    adapters/ollama.ts             # Ollama chat and embedding adapter
  preferences/
    ollama-profile.ts              # Default Ollama profile and settings normalization
    provider-profile-validation.ts # Accept Ollama local profiles
  platform/
    zotero-ui-types.ts             # Narrow Zotero UI adapter interfaces
    zotero-ui-adapter.ts           # Zotero Menu/Reader API adapter
    zotero-runtime.ts              # Menu, settings, reader command, popup/sidebar orchestration
  indexing/
    indexing-status.ts             # Index status model and reducer-style actions
  ui/
    settings-view.ts               # Provider/index settings DOM
    index-controls-view.ts         # Index controls DOM fragment
    anchored-popup-view.ts         # Add action buttons for sidebar/cancel/retry
    sidebar-view.ts                # Add follow-up form rendering
  bootstrap.ts                     # Compose Ollama defaults and Zotero runtime
tests/
  providers/adapters/ollama.test.ts
  preferences/ollama-profile.test.ts
  platform/zotero-runtime.test.ts
  indexing/indexing-status.test.ts
  ui/settings-view.test.ts
  ui/index-controls-view.test.ts
```

## Task 1: Ollama Provider Contracts And Adapter

**Files:**

- Modify: `src/providers/provider-types.ts`
- Create: `src/providers/adapters/ollama.ts`
- Test: `tests/providers/adapters/ollama.test.ts`

- [ ] **Step 1: Write failing Ollama adapter tests**

Create `tests/providers/adapters/ollama.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createOllamaProvider } from "../../../src/providers/adapters/ollama.js";
import type { ChatRequest, ProviderProfile } from "../../../src/providers/provider-types.js";

const profile: ProviderProfile = {
  id: "ollama",
  displayName: "Ollama",
  kind: "ollama",
  baseUrl: "http://localhost:11434",
  model: "llama3.1",
  secret: { kind: "none" },
  sendMode: "local",
  enabled: true
};

const request: ChatRequest = {
  selection: {
    quote: "Dense paragraph",
    source: {
      itemKey: "ITEM",
      itemTitle: "Paper",
      attachmentKey: "ATTACH",
      pageLabel: "4",
      location: "page 4"
    },
    anchor: null
  },
  messages: [{ role: "user", content: "Explain this" }],
  profile
};

describe("createOllamaProvider", () => {
  it("streams chat deltas from Ollama /api/chat", async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const provider = createOllamaProvider({
      fetch: async (input, init) => {
        calls.push({ input, init });
        return new Response(
          [
            JSON.stringify({ message: { content: "First " }, done: false }),
            JSON.stringify({ message: { content: "second" }, done: true })
          ].join("\n")
        );
      }
    });

    const events = [];
    for await (const event of provider.streamChat(request, new AbortController().signal)) {
      events.push(event);
    }

    expect(calls[0]?.input).toBe("http://localhost:11434/api/chat");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: "llama3.1",
      stream: true,
      messages: [{ role: "user", content: "Explain this" }]
    });
    expect(events).toEqual([
      { type: "message_start", providerId: "ollama", model: "llama3.1" },
      { type: "delta", text: "First " },
      { type: "delta", text: "second" },
      { type: "message_end" }
    ]);
  });

  it("creates embeddings through Ollama /api/embed", async () => {
    const provider = createOllamaProvider({
      fetch: async (input, init) => {
        expect(input).toBe("http://localhost:11434/api/embed");
        expect(JSON.parse(String(init.body))).toEqual({
          model: "nomic-embed-text",
          input: ["chunk one", "chunk two"]
        });
        return new Response(
          JSON.stringify({
            embeddings: [
              [1, 2],
              [3, 4]
            ]
          })
        );
      }
    });

    await expect(
      provider.embedTexts({
        baseUrl: "http://localhost:11434",
        model: "nomic-embed-text",
        texts: ["chunk one", "chunk two"],
        signal: new AbortController().signal
      })
    ).resolves.toEqual([
      [1, 2],
      [3, 4]
    ]);
  });

  it("reports connection failures as retryable chat errors", async () => {
    const provider = createOllamaProvider({
      fetch: async () => {
        throw new TypeError("fetch failed");
      }
    });

    const events = [];
    for await (const event of provider.streamChat(request, new AbortController().signal)) {
      events.push(event);
    }

    expect(events.at(-1)).toEqual({
      type: "error",
      message: "Could not reach Ollama at http://localhost:11434.",
      retryable: true
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test -- tests/providers/adapters/ollama.test.ts
```

Expected: fail because `src/providers/adapters/ollama.ts` does not exist and `ProviderKind` does not
include `ollama`.

- [ ] **Step 3: Add provider contracts**

Modify `src/providers/provider-types.ts`:

```ts
export type ProviderKind =
  | "ollama"
  | "openai-responses"
  | "openai-compatible"
  | "anthropic"
  | "gemini"
  | "custom-http"
  | "local-agent-bridge";

export type EmbeddingRequest = {
  readonly baseUrl: string;
  readonly model: string;
  readonly texts: readonly string[];
  readonly signal: AbortSignal;
};

export type EmbeddingProvider = {
  embedTexts(request: EmbeddingRequest): Promise<readonly (readonly number[])[]>;
};

export type ModelProvider = {
  readonly id: string;
  readonly displayName: string;
  streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
};
```

Keep the existing `ProviderProfile`, `ChatMessage`, `ChatRequest`, and `ChatEvent` definitions.

- [ ] **Step 4: Implement Ollama adapter**

Create `src/providers/adapters/ollama.ts`:

```ts
import { eventFromDelta, messageEndEvent, parseJsonPayload, readString } from "../stream-events.js";
import type { EmbeddingProvider, ModelProvider } from "../provider-types.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function baseUrl(profileBaseUrl: string | null): string {
  return (profileBaseUrl ?? "http://localhost:11434").replace(/\/+$/u, "");
}

function connectionError(url: string) {
  return {
    type: "error" as const,
    message: `Could not reach Ollama at ${url}.`,
    retryable: true
  };
}

export function createOllamaProvider(deps: {
  readonly fetch: FetchLike;
}): ModelProvider & EmbeddingProvider {
  const id = "ollama";

  return {
    id,
    displayName: "Ollama",
    async *streamChat(request, signal) {
      const url = baseUrl(request.profile.baseUrl);
      yield { type: "message_start", providerId: id, model: request.profile.model };

      try {
        const response = await deps.fetch(`${url}/api/chat`, {
          method: "POST",
          signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: request.profile.model,
            stream: true,
            messages: request.messages
          })
        });

        for (const line of (await response.text())
          .split("\n")
          .filter((entry) => entry.trim().length > 0)) {
          const payload = parseJsonPayload(line);
          const text = readString(payload, ["message", "content"]);
          if (text !== null) {
            yield eventFromDelta(text);
          }
        }

        yield messageEndEvent();
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        yield connectionError(url);
      }
    },
    async embedTexts(request) {
      const url = baseUrl(request.baseUrl);
      const response = await deps.fetch(`${url}/api/embed`, {
        method: "POST",
        signal: request.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: request.model, input: request.texts })
      });
      const payload = parseJsonPayload(await response.text());
      const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : null;
      if (embeddings === null) {
        throw new Error("Ollama embedding response did not include embeddings.");
      }
      return embeddings as readonly (readonly number[])[];
    }
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
npm run test -- tests/providers/adapters/ollama.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/providers/provider-types.ts src/providers/adapters/ollama.ts tests/providers/adapters/ollama.test.ts
git commit -m "feat: add ollama provider adapter"
```

## Task 2: Ollama Settings Defaults And Validation

**Files:**

- Create: `src/preferences/ollama-profile.ts`
- Modify: `src/preferences/provider-profile-validation.ts`
- Test: `tests/preferences/ollama-profile.test.ts`
- Test: `tests/preferences/provider-profile-validation.test.ts`

- [ ] **Step 1: Write failing default profile tests**

Create `tests/preferences/ollama-profile.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  createDefaultOllamaSettings,
  ollamaSettingsToProfile
} from "../../src/preferences/ollama-profile.js";

describe("ollama profile defaults", () => {
  it("creates a local-only Ollama profile", () => {
    const settings = createDefaultOllamaSettings();

    expect(settings).toEqual({
      baseUrl: "http://localhost:11434",
      chatModel: "llama3.1",
      embeddingModel: "nomic-embed-text",
      localOnly: true
    });

    expect(ollamaSettingsToProfile(settings)).toEqual({
      id: "ollama",
      displayName: "Ollama",
      kind: "ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3.1",
      secret: { kind: "none" },
      sendMode: "local",
      enabled: true
    });
  });
});
```

- [ ] **Step 2: Extend validation test for Ollama**

Append this case to `tests/preferences/provider-profile-validation.test.ts`:

```ts
it("accepts local Ollama profiles without a secret", () => {
  expect(
    validateProviderProfile({
      id: "ollama",
      displayName: "Ollama",
      kind: "ollama",
      baseUrl: "http://localhost:11434",
      model: "llama3.1",
      secret: { kind: "none" },
      sendMode: "local",
      enabled: true
    })
  ).toEqual({ ok: true });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test -- tests/preferences/ollama-profile.test.ts tests/preferences/provider-profile-validation.test.ts
```

Expected: fail because `ollama-profile.ts` does not exist and `ProviderKind` validation does not yet
know about `ollama`.

- [ ] **Step 4: Implement Ollama settings helpers**

Create `src/preferences/ollama-profile.ts`:

```ts
import type { ProviderProfile } from "../providers/provider-types.js";

export type OllamaSettings = {
  readonly baseUrl: string;
  readonly chatModel: string;
  readonly embeddingModel: string;
  readonly localOnly: boolean;
};

export function createDefaultOllamaSettings(): OllamaSettings {
  return {
    baseUrl: "http://localhost:11434",
    chatModel: "llama3.1",
    embeddingModel: "nomic-embed-text",
    localOnly: true
  };
}

export function ollamaSettingsToProfile(settings: OllamaSettings): ProviderProfile {
  return {
    id: "ollama",
    displayName: "Ollama",
    kind: "ollama",
    baseUrl: settings.baseUrl,
    model: settings.chatModel,
    secret: { kind: "none" },
    sendMode: "local",
    enabled: true
  };
}
```

- [ ] **Step 5: Keep validation explicit**

Modify `src/preferences/provider-profile-validation.ts` so the existing model validation applies to
Ollama and custom HTTP still requires a base URL:

```ts
import type { ProviderProfile } from "../providers/provider-types.js";

export type ProviderProfileValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function validateProviderProfile(profile: ProviderProfile): ProviderProfileValidationResult {
  if (profile.kind === "custom-http" && profile.baseUrl === null) {
    return { ok: false, reason: "custom-http providers require a base URL." };
  }

  if (profile.kind === "ollama" && profile.baseUrl === null) {
    return { ok: false, reason: "Ollama profiles require a base URL." };
  }

  if (profile.model.trim().length === 0) {
    return { ok: false, reason: "Provider profiles require a model." };
  }

  return { ok: true };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
npm run test -- tests/preferences/ollama-profile.test.ts tests/preferences/provider-profile-validation.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/preferences/ollama-profile.ts src/preferences/provider-profile-validation.ts tests/preferences/ollama-profile.test.ts tests/preferences/provider-profile-validation.test.ts
git commit -m "feat: add ollama settings defaults"
```

## Task 3: Settings And Index Controls DOM

**Files:**

- Create: `src/indexing/indexing-status.ts`
- Create: `src/ui/index-controls-view.ts`
- Create: `src/ui/settings-view.ts`
- Test: `tests/indexing/indexing-status.test.ts`
- Test: `tests/ui/index-controls-view.test.ts`
- Test: `tests/ui/settings-view.test.ts`

- [ ] **Step 1: Write failing indexing status tests**

Create `tests/indexing/indexing-status.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  createInitialIndexingStatus,
  reduceIndexingStatus
} from "../../src/indexing/indexing-status.js";

describe("indexing status", () => {
  it("tracks start, pause, resume, and clear", () => {
    const started = reduceIndexingStatus(createInitialIndexingStatus(), {
      type: "started",
      totalItems: 10
    });
    expect(started).toMatchObject({ state: "running", totalItems: 10, indexedItems: 0 });

    const paused = reduceIndexingStatus(started, { type: "paused" });
    expect(paused.state).toBe("paused");

    const resumed = reduceIndexingStatus(paused, { type: "resumed" });
    expect(resumed.state).toBe("running");

    const cleared = reduceIndexingStatus(resumed, { type: "cleared" });
    expect(cleared).toEqual(createInitialIndexingStatus());
  });
});
```

- [ ] **Step 2: Write failing view tests**

Create `tests/ui/settings-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createDefaultOllamaSettings } from "../../src/preferences/ollama-profile.js";
import { renderSettingsView } from "../../src/ui/settings-view.js";

describe("renderSettingsView", () => {
  it("renders Ollama settings and local-only disclosure", () => {
    const view = renderSettingsView({
      settings: createDefaultOllamaSettings(),
      indexStatus: {
        state: "idle",
        totalItems: 0,
        indexedItems: 0,
        failedItems: 0
      }
    });

    expect(view.querySelector<HTMLInputElement>('[name="baseUrl"]')?.value).toBe(
      "http://localhost:11434"
    );
    expect(view.querySelector<HTMLInputElement>('[name="chatModel"]')?.value).toBe("llama3.1");
    expect(view.querySelector<HTMLInputElement>('[name="embeddingModel"]')?.value).toBe(
      "nomic-embed-text"
    );
    expect(view.textContent).toContain("Local only");
    expect(view.textContent).toContain("Index library");
  });
});
```

Create `tests/ui/index-controls-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { renderIndexControls } from "../../src/ui/index-controls-view.js";

describe("renderIndexControls", () => {
  it("renders status and control buttons", () => {
    const view = renderIndexControls({
      state: "running",
      totalItems: 20,
      indexedItems: 4,
      failedItems: 1
    });

    expect(view.textContent).toContain("4 / 20 indexed");
    expect(view.textContent).toContain("1 failed");
    expect(view.querySelector('[data-action="pause-index"]')).not.toBeNull();
    expect(view.querySelector('[data-action="clear-index"]')).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test -- tests/indexing/indexing-status.test.ts tests/ui/settings-view.test.ts tests/ui/index-controls-view.test.ts
```

Expected: fail because the modules do not exist.

- [ ] **Step 4: Implement indexing status**

Create `src/indexing/indexing-status.ts`:

```ts
export type IndexingState = "idle" | "running" | "paused" | "complete" | "failed";

export type IndexingStatus = {
  readonly state: IndexingState;
  readonly totalItems: number;
  readonly indexedItems: number;
  readonly failedItems: number;
};

export type IndexingAction =
  | { readonly type: "started"; readonly totalItems: number }
  | { readonly type: "progress"; readonly indexedItems: number; readonly failedItems: number }
  | { readonly type: "paused" }
  | { readonly type: "resumed" }
  | { readonly type: "completed" }
  | { readonly type: "failed" }
  | { readonly type: "cleared" };

export function createInitialIndexingStatus(): IndexingStatus {
  return { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 };
}

export function reduceIndexingStatus(
  status: IndexingStatus,
  action: IndexingAction
): IndexingStatus {
  switch (action.type) {
    case "started":
      return { state: "running", totalItems: action.totalItems, indexedItems: 0, failedItems: 0 };
    case "progress":
      return { ...status, indexedItems: action.indexedItems, failedItems: action.failedItems };
    case "paused":
      return { ...status, state: "paused" };
    case "resumed":
      return { ...status, state: "running" };
    case "completed":
      return { ...status, state: "complete" };
    case "failed":
      return { ...status, state: "failed" };
    case "cleared":
      return createInitialIndexingStatus();
  }
}
```

- [ ] **Step 5: Implement index controls view**

Create `src/ui/index-controls-view.ts`:

```ts
import type { IndexingStatus } from "../indexing/indexing-status.js";

export function renderIndexControls(status: IndexingStatus): HTMLElement {
  const element = document.createElement("section");
  element.className = "zotero-ai-index-controls";

  const summary = document.createElement("p");
  summary.textContent = `${String(status.indexedItems)} / ${String(status.totalItems)} indexed, ${String(
    status.failedItems
  )} failed`;

  const start = document.createElement("button");
  start.type = "button";
  start.dataset.action = "start-index";
  start.textContent = "Index library";

  const pause = document.createElement("button");
  pause.type = "button";
  pause.dataset.action = "pause-index";
  pause.textContent = "Pause";

  const resume = document.createElement("button");
  resume.type = "button";
  resume.dataset.action = "resume-index";
  resume.textContent = "Resume";

  const clear = document.createElement("button");
  clear.type = "button";
  clear.dataset.action = "clear-index";
  clear.textContent = "Clear index";

  element.append(summary, start, pause, resume, clear);
  return element;
}
```

- [ ] **Step 6: Implement settings view**

Create `src/ui/settings-view.ts`:

```ts
import type { IndexingStatus } from "../indexing/indexing-status.js";
import type { OllamaSettings } from "../preferences/ollama-profile.js";
import { renderIndexControls } from "./index-controls-view.js";

function input(name: string, labelText: string, value: string): HTMLLabelElement {
  const label = document.createElement("label");
  label.textContent = labelText;
  const field = document.createElement("input");
  field.name = name;
  field.value = value;
  label.append(field);
  return label;
}

export function renderSettingsView(inputData: {
  readonly settings: OllamaSettings;
  readonly indexStatus: IndexingStatus;
}): HTMLElement {
  const element = document.createElement("form");
  element.className = "zotero-ai-settings";

  const title = document.createElement("h2");
  title.textContent = "Zotero AI Explain";

  const privacy = document.createElement("p");
  privacy.textContent = inputData.settings.localOnly
    ? "Local only: document text stays on this machine."
    : "Online embeddings are enabled.";

  element.append(
    title,
    input("baseUrl", "Ollama URL", inputData.settings.baseUrl),
    input("chatModel", "Chat model", inputData.settings.chatModel),
    input("embeddingModel", "Embedding model", inputData.settings.embeddingModel),
    privacy,
    renderIndexControls(inputData.indexStatus)
  );

  return element;
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run:

```bash
npm run test -- tests/indexing/indexing-status.test.ts tests/ui/settings-view.test.ts tests/ui/index-controls-view.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add src/indexing/indexing-status.ts src/ui/index-controls-view.ts src/ui/settings-view.ts tests/indexing/indexing-status.test.ts tests/ui/settings-view.test.ts tests/ui/index-controls-view.test.ts
git commit -m "feat: add ollama settings views"
```

## Task 4: Zotero Runtime Adapter

**Files:**

- Create: `src/platform/zotero-ui-types.ts`
- Create: `src/platform/zotero-ui-adapter.ts`
- Create: `src/platform/zotero-runtime.ts`
- Modify: `src/bootstrap.ts`
- Modify: `addon/bootstrap.js`
- Test: `tests/platform/zotero-runtime.test.ts`

- [ ] **Step 1: Write failing runtime test**

Create `tests/platform/zotero-runtime.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import { createZoteroRuntime } from "../../src/platform/zotero-runtime.js";
import { createDefaultOllamaSettings } from "../../src/preferences/ollama-profile.js";

describe("createZoteroRuntime", () => {
  it("registers settings and explain commands on startup", async () => {
    const calls: string[] = [];
    const runtime = createZoteroRuntime({
      settings: createDefaultOllamaSettings(),
      indexStatus: { state: "idle", totalItems: 0, indexedItems: 0, failedItems: 0 },
      ui: {
        addMenuItem(label, action) {
          calls.push(`menu:${label}`);
          if (label === "Zotero AI Explain Settings") {
            action();
          }
          return () => calls.push(`remove-menu:${label}`);
        },
        addReaderCommand(label) {
          calls.push(`reader:${label}`);
          return () => calls.push(`remove-reader:${label}`);
        },
        openDialog(title, content) {
          calls.push(`dialog:${title}:${content.className}`);
        },
        mountPopup() {
          calls.push("popup");
          return () => calls.push("remove-popup");
        },
        mountSidebar() {
          calls.push("sidebar");
          return () => calls.push("remove-sidebar");
        }
      },
      onExplain: vi.fn()
    });

    await runtime.startup();
    await runtime.shutdown();

    expect(calls).toEqual([
      "menu:Zotero AI Explain Settings",
      "dialog:Zotero AI Explain:zotero-ai-settings",
      "reader:Explain with AI",
      "remove-menu:Zotero AI Explain Settings",
      "remove-reader:Explain with AI"
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test -- tests/platform/zotero-runtime.test.ts
```

Expected: fail because `zotero-runtime.ts` does not exist.

- [ ] **Step 3: Add Zotero UI types**

Create `src/platform/zotero-ui-types.ts`:

```ts
import type { SelectionContext } from "../selection/selection-context.js";

export type Unsubscribe = () => void;

export type ZoteroUiAdapter = {
  addMenuItem(label: string, action: () => void): Unsubscribe;
  addReaderCommand(label: string, action: (selection: SelectionContext) => void): Unsubscribe;
  openDialog(title: string, content: HTMLElement): void;
  mountPopup(content: HTMLElement): Unsubscribe;
  mountSidebar(content: HTMLElement): Unsubscribe;
};
```

- [ ] **Step 4: Implement testable runtime orchestration**

Create `src/platform/zotero-runtime.ts`:

```ts
import type { IndexingStatus } from "../indexing/indexing-status.js";
import type { OllamaSettings } from "../preferences/ollama-profile.js";
import type { SelectionContext } from "../selection/selection-context.js";
import { renderSettingsView } from "../ui/settings-view.js";
import type { Unsubscribe, ZoteroUiAdapter } from "./zotero-ui-types.js";

export type ZoteroRuntime = {
  startup(): Promise<void>;
  shutdown(): Promise<void>;
};

export function createZoteroRuntime(deps: {
  readonly settings: OllamaSettings;
  readonly indexStatus: IndexingStatus;
  readonly ui: ZoteroUiAdapter;
  readonly onExplain: (selection: SelectionContext) => void;
}): ZoteroRuntime {
  const cleanup: Unsubscribe[] = [];

  return {
    async startup() {
      cleanup.push(
        deps.ui.addMenuItem("Zotero AI Explain Settings", () => {
          deps.ui.openDialog(
            "Zotero AI Explain",
            renderSettingsView({ settings: deps.settings, indexStatus: deps.indexStatus })
          );
        })
      );
      cleanup.push(deps.ui.addReaderCommand("Explain with AI", deps.onExplain));
    },
    async shutdown() {
      while (cleanup.length > 0) {
        cleanup.pop()?.();
      }
    }
  };
}
```

- [ ] **Step 5: Wire bootstrap to runtime**

Create `src/platform/zotero-ui-adapter.ts`. This adapter uses Zotero's reader event API for the text
selection popup and a conservative Tools-menu DOM insertion for settings. If a Zotero surface is not
available, it logs and returns a no-op cleanup instead of breaking plugin startup.

```ts
import type { SelectionContext } from "../selection/selection-context.js";
import type { Unsubscribe, ZoteroUiAdapter } from "./zotero-ui-types.js";

type ReaderEvent = {
  readonly doc: Document;
  readonly params?: { readonly annotation?: { readonly text?: string } };
  append(content: HTMLElement | { readonly label: string; readonly onCommand: () => void }): void;
};

export type ZoteroGlobal = {
  readonly MenuManager?: {
    unregisterMenu(id: string): void;
  };
  readonly Reader?: {
    registerEventListener(
      type: string,
      handler: (event: ReaderEvent) => void,
      pluginID: string
    ): void;
    unregisterEventListener(type: string, handler: (event: ReaderEvent) => void): void;
  };
  debug(message: string): void;
  getMainWindow?(): Window & typeof globalThis;
};

function noOp(): void {
  return undefined;
}

export function createZoteroUiAdapter(input: {
  readonly Zotero: ZoteroGlobal;
  readonly pluginId: string;
}): ZoteroUiAdapter {
  return {
    addMenuItem(label, action) {
      const mainWindow = input.Zotero.getMainWindow?.();
      const document = mainWindow?.document;
      const toolsPopup =
        document?.getElementById("menu_ToolsPopup") ?? document?.getElementById("menuToolsPopup");
      if (!document || !toolsPopup) {
        input.Zotero.debug("Zotero AI Explain could not find the Tools menu popup.");
        return noOp;
      }

      const item = document.createXULElement?.("menuitem") ?? document.createElement("menuitem");
      item.setAttribute("label", label);
      item.addEventListener("command", action);
      toolsPopup.append(item);

      return () => item.remove();
    },
    addReaderCommand(label, action) {
      const handler = (event: ReaderEvent) => {
        const quote = event.params?.annotation?.text?.trim() ?? "";
        const button = event.doc.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => {
          const selection: SelectionContext = {
            quote,
            source: {
              itemKey: null,
              itemTitle: null,
              attachmentKey: null,
              pageLabel: null,
              location: null
            },
            anchor: null
          };
          action(selection);
        });
        event.append(button);
      };

      input.Zotero.Reader?.registerEventListener(
        "renderTextSelectionPopup",
        handler,
        input.pluginId
      );
      return () =>
        input.Zotero.Reader?.unregisterEventListener("renderTextSelectionPopup", handler);
    },
    openDialog(title, content) {
      const mainWindow = input.Zotero.getMainWindow?.();
      const document = mainWindow?.document;
      if (!document?.body) {
        input.Zotero.debug(`Zotero AI Explain could not open dialog: ${title}`);
        return;
      }
      const dialog = document.createElement("section");
      dialog.className = "zotero-ai-dialog";
      dialog.setAttribute("aria-label", title);
      dialog.append(content);
      document.body.append(dialog);
    },
    mountPopup(content) {
      const mainWindow = input.Zotero.getMainWindow?.();
      mainWindow?.document.body.append(content);
      return () => content.remove();
    },
    mountSidebar(content) {
      const mainWindow = input.Zotero.getMainWindow?.();
      mainWindow?.document.body.append(content);
      return () => content.remove();
    }
  };
}
```

Modify `src/bootstrap.ts` so startup creates a runtime with default settings and the real adapter.

```ts
import { createInitialIndexingStatus } from "./indexing/indexing-status.js";
import { createZoteroUiAdapter } from "./platform/zotero-ui-adapter.js";
import { createZoteroRuntime } from "./platform/zotero-runtime.js";
import { createDefaultOllamaSettings } from "./preferences/ollama-profile.js";

export type ZoteroBootstrapContext = {
  readonly pluginId: string;
  readonly Zotero: Parameters<typeof createZoteroUiAdapter>[0]["Zotero"];
  readonly reason: number;
};

let runtime: ReturnType<typeof createZoteroRuntime> | null = null;

export async function startup(context: ZoteroBootstrapContext): Promise<void> {
  context.Zotero.debug("Zotero AI Explain startup");
  runtime = createZoteroRuntime({
    settings: createDefaultOllamaSettings(),
    indexStatus: createInitialIndexingStatus(),
    ui: createZoteroUiAdapter({ Zotero: context.Zotero, pluginId: context.pluginId }),
    onExplain(selection) {
      context.Zotero.debug(`Zotero AI Explain selected ${String(selection.quote.length)} chars`);
    }
  });
  await runtime.startup();
}

export async function shutdown(context: ZoteroBootstrapContext): Promise<void> {
  context.Zotero.debug("Zotero AI Explain shutdown");
  await runtime?.shutdown();
  runtime = null;
}
```

Modify `addon/bootstrap.js` to pass plugin metadata into the ESM bundle:

```js
async function startup(data, reason) {
  moduleUrl = `${data.rootURI}content/zotero-ai-explain.sys.mjs`;
  const module = ChromeUtils.importESModule(moduleUrl);
  await module.startup({ Zotero, pluginId: data.id, reason });
}
```

- [ ] **Step 6: Run runtime tests**

Run:

```bash
npm run test -- tests/platform/zotero-runtime.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/platform/zotero-ui-types.ts src/platform/zotero-ui-adapter.ts src/platform/zotero-runtime.ts src/bootstrap.ts addon/bootstrap.js tests/platform/zotero-runtime.test.ts
git commit -m "feat: add zotero runtime orchestration"
```

## Task 5: Popup And Sidebar Interaction Upgrade

**Files:**

- Modify: `src/ui/anchored-popup-view.ts`
- Modify: `src/ui/sidebar-view.ts`
- Test: `tests/ui/anchored-popup-view.test.ts`
- Test: `tests/ui/sidebar-view.test.ts`

- [ ] **Step 1: Extend popup view test**

Modify `tests/ui/anchored-popup-view.test.ts` to assert action buttons:

```ts
expect(element.querySelector('[data-action="continue-sidebar"]')?.textContent).toBe(
  "Open in sidebar"
);
expect(element.querySelector('[data-action="retry"]')?.textContent).toBe("Retry");
```

- [ ] **Step 2: Extend sidebar view test**

Modify `tests/ui/sidebar-view.test.ts` to assert follow-up form:

```ts
expect(element.querySelector<HTMLTextAreaElement>('[name="followUp"]')).not.toBeNull();
expect(element.querySelector('[data-action="send-follow-up"]')?.textContent).toBe("Send");
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test -- tests/ui/anchored-popup-view.test.ts tests/ui/sidebar-view.test.ts
```

Expected: fail because the views do not render action controls yet.

- [ ] **Step 4: Add popup controls**

In `src/ui/anchored-popup-view.ts`, append these controls before returning `element`:

```ts
const actions = document.createElement("div");
actions.className = "zotero-ai-explain-popup__actions";

const sidebar = document.createElement("button");
sidebar.type = "button";
sidebar.dataset.action = "continue-sidebar";
sidebar.textContent = "Open in sidebar";

const retry = document.createElement("button");
retry.type = "button";
retry.dataset.action = "retry";
retry.textContent = "Retry";

actions.append(sidebar, retry);
element.append(disclosure, body, actions);
```

Replace the existing `element.append(disclosure, body);` call with the final append above.

- [ ] **Step 5: Add sidebar follow-up form**

In `src/ui/sidebar-view.ts`, append this form after messages:

```ts
const form = document.createElement("form");
form.className = "zotero-ai-explain-sidebar__form";

const followUp = document.createElement("textarea");
followUp.name = "followUp";

const send = document.createElement("button");
send.type = "submit";
send.dataset.action = "send-follow-up";
send.textContent = "Send";

form.append(followUp, send);
element.append(quote, source, messages, form);
```

Replace the existing `element.append(quote, source, messages);` call with the final append above.

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
npm run test -- tests/ui/anchored-popup-view.test.ts tests/ui/sidebar-view.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/ui/anchored-popup-view.ts src/ui/sidebar-view.ts tests/ui/anchored-popup-view.test.ts tests/ui/sidebar-view.test.ts
git commit -m "feat: add popup and sidebar controls"
```

## Task 6: Provider Registry And Controllers Use Ollama

**Files:**

- Modify: `src/providers/provider-registry.ts`
- Modify: `tests/providers/provider-registry.test.ts`
- Modify: `tests/ui/popup-controller.test.ts`
- Modify: `tests/ui/sidebar-controller.test.ts`

- [ ] **Step 1: Extend provider registry test**

Modify the provider kind list in `tests/providers/provider-registry.test.ts` so it includes
`"ollama"`:

```ts
expect(
  [
    "ollama",
    "openai-responses",
    "openai-compatible",
    "anthropic",
    "gemini",
    "custom-http",
    "local-agent-bridge"
  ].map((kind) => registry.resolve(profile(kind as ProviderProfile["kind"])).id)
).toEqual([
  "ollama",
  "openai-responses",
  "openai-compatible",
  "anthropic",
  "gemini",
  "custom-http",
  "local-agent-bridge"
]);
```

- [ ] **Step 2: Add Ollama controller smoke tests**

In `tests/ui/popup-controller.test.ts`, add a profile with `kind: "ollama"` and assert
`createPopupController` appends provider deltas exactly like existing providers. In
`tests/ui/sidebar-controller.test.ts`, add the same profile shape to the follow-up test.

Use this profile:

```ts
const ollamaProfile: ProviderProfile = {
  id: "ollama",
  displayName: "Ollama",
  kind: "ollama",
  baseUrl: "http://localhost:11434",
  model: "llama3.1",
  secret: { kind: "none" },
  sendMode: "local",
  enabled: true
};
```

- [ ] **Step 3: Run tests**

Run:

```bash
npm run test -- tests/providers/provider-registry.test.ts tests/ui/popup-controller.test.ts tests/ui/sidebar-controller.test.ts
```

Expected: fail until provider test helpers understand the `ollama` kind.

- [ ] **Step 4: Update tests/helpers only as needed**

If a local `profile()` helper enumerates remote providers for `sendMode`, make `ollama` local:

```ts
sendMode: kind === "openai-compatible" || kind === "ollama" ? "local" : "remote";
```

The source `createProviderRegistry` should not need behavior changes if it resolves by provider id.

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
npm run test -- tests/providers/provider-registry.test.ts tests/ui/popup-controller.test.ts tests/ui/sidebar-controller.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add tests/providers/provider-registry.test.ts tests/ui/popup-controller.test.ts tests/ui/sidebar-controller.test.ts
git commit -m "test: cover ollama controller flow"
```

## Task 7: Build, Package, And Manual Zotero Verification Notes

**Files:**

- Modify: `docs/manual-verification/zotero.md`
- Modify: `README.md`
- Generated: `addon/content/zotero-ai-explain.sys.mjs`

- [ ] **Step 1: Update manual verification checklist**

Add this section to `docs/manual-verification/zotero.md`:

```md
## Ollama Smoke Test

- [ ] Start Ollama locally: `ollama serve`
- [ ] Pull a chat model: `ollama pull llama3.1`
- [ ] Pull an embedding model: `ollama pull nomic-embed-text`
- [ ] Open Zotero and confirm `Zotero AI Explain Settings` is visible.
- [ ] Confirm settings show `http://localhost:11434`, `llama3.1`, and `nomic-embed-text`.
- [ ] Select text in a PDF reader and trigger `Explain with AI`.
- [ ] Confirm the popup shows an Ollama response or an actionable connection/model error.
- [ ] Open the conversation in the sidebar and send one follow-up.
- [ ] Confirm index controls are visible but whole-library indexing is not started automatically.
```

- [ ] **Step 2: Update README testing note**

In `README.md`, add a short local testing block:

````md
### Test With Ollama

```bash
ollama serve
ollama pull llama3.1
ollama pull nomic-embed-text
npm run build
node scripts/package-xpi.mjs v0.1.0
```

Install `zotero-ai-explain.xpi` in Zotero, open the plugin settings, and keep local-only mode
enabled for the first smoke test.
````

- [ ] **Step 3: Build the Zotero bundle**

Run:

```bash
npm run build
```

Expected: `addon/content/zotero-ai-explain.sys.mjs` is regenerated and `tsc --noEmit` passes.

- [ ] **Step 4: Package the XPI**

Run:

```bash
node scripts/package-xpi.mjs v0.1.0
unzip -p zotero-ai-explain.xpi manifest.json
unzip -l zotero-ai-explain.xpi
```

Expected: manifest includes `applications.zotero.update_url`, `strict_min_version`, and
`strict_max_version`; archive contains only `manifest.json`, `bootstrap.js`, and `content/`.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm run verify
pre-commit run --all-files
pre-commit run --all-files --hook-stage pre-push
```

Expected: all commands pass.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/manual-verification/zotero.md addon/content/zotero-ai-explain.sys.mjs
git commit -m "docs: add ollama smoke testing"
```

## Follow-Up Plans

After this plan is complete and manually smoke-tested in Zotero, write separate plans for:

1. Whole-library local indexing implementation.
2. Local vector persistence and retrieval.
3. Online embedding provider opt-in.

## Self-Review Checklist

- Spec coverage: This plan covers settings, Ollama chat, Ollama embeddings interface, selected-text
  command registration, popup/sidebar controls, and index controls. It intentionally defers
  whole-library crawling and vector search.
- Marker scan: No task contains incomplete-work markers. Each code-changing step names exact files
  and commands.
- Type consistency: `ProviderKind` includes `ollama`; `OllamaSettings` maps to `ProviderProfile`;
  `ZoteroUiAdapter` accepts `SelectionContext`; indexing status uses explicit union states.
