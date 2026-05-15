# Zotero AI Explain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Zotero 8-only plugin that explains selected reader text in an anchored popup and
continues the same conversation in a sidebar chat with broad model-provider support.

**Architecture:** Keep Zotero UI integration thin and place behavior behind testable TypeScript
interfaces. The core modules own selection normalization, conversation state, provider streaming,
secret resolution, and provider profile validation; Zotero-facing files adapt Zotero 8 events and
DOM surfaces into those interfaces.

**Tech Stack:** Zotero 8, TypeScript, WebExtension manifest v2 for Zotero, Vitest, ESLint, Prettier,
local pre-commit hooks.

---

## Acceptance Criteria Mapping

| AC                                          | Covered By       |
| ------------------------------------------- | ---------------- |
| AC-1 Zotero 8 only                          | Tasks 1, 8       |
| AC-2 selection to anchored popup            | Tasks 3, 5, 8, 9 |
| AC-3 streaming popup with cancel/retry      | Tasks 4, 5       |
| AC-4 popup to sidebar handoff               | Tasks 4, 6       |
| AC-5 sidebar follow-up chat                 | Tasks 4, 6       |
| AC-6 provider adapter families              | Tasks 2, 7       |
| AC-7 secret safety and redaction            | Tasks 2, 7       |
| AC-8 remote provider/model disclosure       | Tasks 5, 6       |
| AC-9 local provider configuration           | Tasks 2, 7       |
| AC-10 failure/cancel/retry preserve context | Tasks 4, 5, 6, 7 |
| AC-11 automated tests                       | Tasks 1-7        |
| AC-12 Zotero 8 manual verification          | Tasks 8, 9       |

## File Structure

```text
src/
  bootstrap.ts                    # Zotero startup/shutdown orchestration
  platform/
    zotero-env.ts                 # Narrow Zotero 8 environment interface
    plugin-lifecycle.ts           # Zotero lifecycle registration helpers
    reader-dom-adapter.ts         # DOM selection event adapter for reader windows
  selection/
    selection-context.ts          # Public selection/source types
    normalize-selection.ts        # Selection validation and normalization
  conversation/
    conversation-types.ts         # Public conversation/message/status types
    conversation-store.ts         # Reducer-style local conversation state
  providers/
    provider-types.ts             # ModelProvider contract and provider profiles
    provider-registry.ts          # Adapter resolution and profile validation
    stream-events.ts              # Shared streaming helpers
    adapters/
      openai-responses.ts         # OpenAI native Responses adapter
      openai-compatible.ts        # /v1/chat/completions compatible adapter
      anthropic.ts                # Anthropic native adapter
      gemini.ts                   # Gemini native adapter
      custom-http.ts              # Template-constrained custom HTTP adapter
      local-agent-bridge.ts       # Opt-in local bridge adapter
  secrets/
    secret-types.ts               # Secret references and redaction types
    secret-resolver.ts            # Secure/env/local secret resolution
  ui/
    popup-controller.ts           # Popup view model and streaming actions
    sidebar-controller.ts         # Sidebar view model and follow-up actions
    anchored-popup-view.ts        # DOM rendering for the selected-text popup
    sidebar-view.ts               # DOM rendering for the sidebar chat surface
    privacy-label.ts              # Provider/model disclosure text
  preferences/
    provider-profile-store.ts     # Provider profile persistence boundary
    provider-profile-validation.ts # Profile validation and safe defaults
addon/
  manifest.json                   # Zotero 8 plugin metadata
  bootstrap.js                    # Zotero bootstrap entry point
  content/zotero-ai-explain.sys.mjs # Built Zotero 8 ESM bundle
tests/
  selection/
  conversation/
  providers/
  secrets/
  ui/
  preferences/
docs/
  manual-verification/zotero-8.md # Zotero 8 manual smoke checklist
```

## Interface Contracts

These public interfaces are the contract between tests and implementation. Tests must import from
these modules and must not assert on private implementation details.

```ts
// src/selection/selection-context.ts
export type SourceMetadata = {
  readonly itemKey: string | null;
  readonly itemTitle: string | null;
  readonly attachmentKey: string | null;
  readonly pageLabel: string | null;
  readonly location: string | null;
};

export type SelectionContext = {
  readonly quote: string;
  readonly source: SourceMetadata;
  readonly anchor: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  } | null;
};
```

```ts
// src/providers/provider-types.ts
import type { SecretReference } from "../secrets/secret-types.js";
import type { SelectionContext } from "../selection/selection-context.js";

export type ProviderKind =
  | "openai-responses"
  | "openai-compatible"
  | "anthropic"
  | "gemini"
  | "custom-http"
  | "local-agent-bridge";

export type ProviderProfile = {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string | null;
  readonly model: string;
  readonly secret: SecretReference;
  readonly sendMode: "local" | "remote";
  readonly enabled: boolean;
};

export type ChatMessage = {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
};

export type ChatRequest = {
  readonly selection: SelectionContext;
  readonly messages: readonly ChatMessage[];
  readonly profile: ProviderProfile;
};

export type ChatEvent =
  | { readonly type: "message_start"; readonly providerId: string; readonly model: string }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "message_end" }
  | {
      readonly type: "usage";
      readonly inputTokens: number | null;
      readonly outputTokens: number | null;
    }
  | { readonly type: "error"; readonly message: string; readonly retryable: boolean };

export type ModelProvider = {
  readonly id: string;
  readonly displayName: string;
  streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
};
```

```ts
// src/conversation/conversation-types.ts
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
```

## Task 1: Zotero 8 Project Contract

**ACs:** AC-1, AC-11

**Files:**

- Modify: `addon/manifest.json`
- Modify: `src/project-info.ts`
- Modify: `tests/project-info.test.ts`
- Create: `src/platform/zotero-env.ts`
- Create: `tests/platform/zotero-env.test.ts`

- [ ] **Step 1: Write failing tests for Zotero 8-only metadata**

Add this test to `tests/project-info.test.ts`:

```ts
it("targets Zotero 8 only", () => {
  expect(projectInfo.zoteroMinimumVersion).toBe("8.0");
  expect(projectInfo.supportedZoteroMajor).toBe(8);
});
```

Create `tests/platform/zotero-env.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { assertZotero8Compatible } from "../../src/platform/zotero-env.js";

describe("assertZotero8Compatible", () => {
  it("accepts Zotero 8 versions", () => {
    expect(assertZotero8Compatible("8.0.5")).toEqual({ ok: true });
  });

  it("rejects Zotero 7 versions", () => {
    expect(assertZotero8Compatible("7.0.0")).toEqual({
      ok: false,
      reason: "Zotero AI Explain requires Zotero 8 or newer."
    });
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run test -- tests/project-info.test.ts tests/platform/zotero-env.test.ts
```

Expected: fail because `supportedZoteroMajor` and `assertZotero8Compatible` do not exist.

- [ ] **Step 3: Implement Zotero 8 contract**

Update `src/project-info.ts`:

```ts
export type ProjectInfo = {
  readonly displayName: string;
  readonly packageName: string;
  readonly zoteroMinimumVersion: string;
  readonly supportedZoteroMajor: number;
};

export const projectInfo: ProjectInfo = {
  displayName: "Zotero AI Explain",
  packageName: "zotero-ai-explain",
  zoteroMinimumVersion: "8.0",
  supportedZoteroMajor: 8
};
```

Create `src/platform/zotero-env.ts`:

```ts
export type ZoteroCompatibilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function assertZotero8Compatible(version: string): ZoteroCompatibilityResult {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (major >= 8) {
    return { ok: true };
  }

  return { ok: false, reason: "Zotero AI Explain requires Zotero 8 or newer." };
}
```

Update `addon/manifest.json` so `strict_min_version` is `"8.0"`.

- [ ] **Step 4: Run verification**

Run:

```bash
npm run verify
pre-commit run --all-files
```

Expected: all checks pass.

- [ ] **Step 5: Commit**

```bash
git add addon/manifest.json src/project-info.ts src/platform/zotero-env.ts tests/project-info.test.ts tests/platform/zotero-env.test.ts
git commit -m "feat: target zotero 8"
```

## Task 2: Provider Profiles, Registry, And Secret References

**ACs:** AC-6, AC-7, AC-9, AC-11

**Files:**

- Create: `src/providers/provider-types.ts`
- Create: `src/providers/provider-registry.ts`
- Create: `src/secrets/secret-types.ts`
- Create: `src/secrets/secret-resolver.ts`
- Create: `tests/providers/provider-registry.test.ts`
- Create: `tests/secrets/secret-resolver.test.ts`

- [ ] **Step 1: Write provider registry tests**

Create `tests/providers/provider-registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createProviderRegistry } from "../../src/providers/provider-registry.js";
import type { ModelProvider, ProviderProfile } from "../../src/providers/provider-types.js";

const profile = (kind: ProviderProfile["kind"], id = kind): ProviderProfile => ({
  id,
  displayName: id,
  kind,
  baseUrl:
    kind === "openai-responses" || kind === "anthropic" || kind === "gemini"
      ? null
      : "http://localhost:11434",
  model: "test-model",
  secret: { kind: "none" },
  sendMode: kind === "openai-compatible" ? "local" : "remote",
  enabled: true
});

const provider = (id: string): ModelProvider => ({
  id,
  displayName: id,
  async *streamChat() {
    yield { type: "message_start", providerId: id, model: "test-model" };
    yield { type: "message_end" };
  }
});

describe("createProviderRegistry", () => {
  it("resolves every required provider family", () => {
    const registry = createProviderRegistry([
      provider("openai-responses"),
      provider("openai-compatible"),
      provider("anthropic"),
      provider("gemini"),
      provider("custom-http"),
      provider("local-agent-bridge")
    ]);

    for (const kind of [
      "openai-responses",
      "openai-compatible",
      "anthropic",
      "gemini",
      "custom-http",
      "local-agent-bridge"
    ] as const) {
      expect(registry.resolve(profile(kind)).id).toBe(kind);
    }
  });

  it("rejects disabled profiles before resolving an adapter", () => {
    const registry = createProviderRegistry([provider("openai-compatible")]);
    expect(() => registry.resolve({ ...profile("openai-compatible"), enabled: false })).toThrow(
      "Provider profile is disabled."
    );
  });
});
```

- [ ] **Step 2: Write secret resolver tests**

Create `tests/secrets/secret-resolver.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createSecretResolver, redactSecrets } from "../../src/secrets/secret-resolver.js";

describe("createSecretResolver", () => {
  it("resolves environment variable references", async () => {
    const resolver = createSecretResolver({
      env: { OPENAI_API_KEY: "sk-test" },
      credentialStore: new Map(),
      localFiles: new Map()
    });

    await expect(resolver.resolve({ kind: "environment", name: "OPENAI_API_KEY" })).resolves.toBe(
      "sk-test"
    );
  });

  it("redacts resolved secrets from messages", () => {
    expect(redactSecrets("failed with sk-test token", ["sk-test"])).toBe(
      "failed with [REDACTED] token"
    );
  });
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
npm run test -- tests/providers/provider-registry.test.ts tests/secrets/secret-resolver.test.ts
```

Expected: fail because modules do not exist.

- [ ] **Step 4: Implement interfaces and registry**

Create `src/providers/provider-types.ts` with the interface contract from this plan. Import
`SecretReference` from `../secrets/secret-types.js`; do not define a duplicate secret-reference
union in the provider module.

Create `src/providers/provider-registry.ts`:

```ts
import type { ModelProvider, ProviderProfile } from "./provider-types.js";

export type ProviderRegistry = {
  resolve(profile: ProviderProfile): ModelProvider;
};

export function createProviderRegistry(providers: readonly ModelProvider[]): ProviderRegistry {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  return {
    resolve(profile) {
      if (!profile.enabled) {
        throw new Error("Provider profile is disabled.");
      }

      const provider = byId.get(profile.kind);
      if (provider === undefined) {
        throw new Error(`No provider adapter registered for ${profile.kind}.`);
      }

      return provider;
    }
  };
}
```

- [ ] **Step 5: Implement secret resolver**

Create `src/secrets/secret-types.ts`:

```ts
export type SecretReference =
  | { readonly kind: "credential-store"; readonly id: string }
  | { readonly kind: "environment"; readonly name: string }
  | { readonly kind: "local-file"; readonly path: string; readonly key: string }
  | { readonly kind: "none" };
```

Create `src/secrets/secret-resolver.ts`:

```ts
import type { SecretReference } from "./secret-types.js";

export type SecretResolverDeps = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly credentialStore: ReadonlyMap<string, string>;
  readonly localFiles: ReadonlyMap<string, Readonly<Record<string, string | undefined>>>;
};

export type SecretResolver = {
  resolve(reference: SecretReference): Promise<string | null>;
};

export function createSecretResolver(deps: SecretResolverDeps): SecretResolver {
  return {
    async resolve(reference) {
      switch (reference.kind) {
        case "none":
          return null;
        case "environment":
          return deps.env[reference.name] ?? null;
        case "credential-store":
          return deps.credentialStore.get(reference.id) ?? null;
        case "local-file":
          return deps.localFiles.get(reference.path)?.[reference.key] ?? null;
      }
    }
  };
}

export function redactSecrets(message: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), message);
}
```

- [ ] **Step 6: Run verification and commit**

Run:

```bash
npm run verify
pre-commit run --all-files
```

Expected: all checks pass.

Commit:

```bash
git add src/providers src/secrets tests/providers tests/secrets
git commit -m "feat: add provider registry and secret resolution"
```

## Task 3: Selection Normalization

**ACs:** AC-2, AC-11

**Files:**

- Create: `src/selection/selection-context.ts`
- Create: `src/selection/normalize-selection.ts`
- Create: `tests/selection/normalize-selection.test.ts`

- [ ] **Step 1: Write selection tests**

Create `tests/selection/normalize-selection.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { normalizeSelection } from "../../src/selection/normalize-selection.js";

describe("normalizeSelection", () => {
  it("trims selected text and preserves source metadata", () => {
    expect(
      normalizeSelection({
        quote: "  Photosynthesis converts light into chemical energy.  ",
        source: {
          itemKey: "ITEM1",
          itemTitle: "Biology Paper",
          attachmentKey: "ATT1",
          pageLabel: "12",
          location: "page=12"
        },
        anchor: { left: 10, top: 20, width: 100, height: 15 }
      })
    ).toEqual({
      ok: true,
      selection: {
        quote: "Photosynthesis converts light into chemical energy.",
        source: {
          itemKey: "ITEM1",
          itemTitle: "Biology Paper",
          attachmentKey: "ATT1",
          pageLabel: "12",
          location: "page=12"
        },
        anchor: { left: 10, top: 20, width: 100, height: 15 }
      }
    });
  });

  it("rejects empty selections", () => {
    expect(
      normalizeSelection({
        quote: "   ",
        source: {
          itemKey: null,
          itemTitle: null,
          attachmentKey: null,
          pageLabel: null,
          location: null
        },
        anchor: null
      })
    ).toEqual({ ok: false, reason: "Select text before asking for an explanation." });
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm run test -- tests/selection/normalize-selection.test.ts
```

Expected: fail because modules do not exist.

- [ ] **Step 3: Implement selection normalization**

Create `src/selection/selection-context.ts` using the interface contract in this plan.

Create `src/selection/normalize-selection.ts`:

```ts
import type { SelectionContext } from "./selection-context.js";

export type NormalizeSelectionResult =
  | { readonly ok: true; readonly selection: SelectionContext }
  | { readonly ok: false; readonly reason: string };

export function normalizeSelection(selection: SelectionContext): NormalizeSelectionResult {
  const quote = selection.quote.trim();
  if (quote.length === 0) {
    return { ok: false, reason: "Select text before asking for an explanation." };
  }

  return { ok: true, selection: { ...selection, quote } };
}
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm run verify
pre-commit run --all-files
```

Commit:

```bash
git add src/selection tests/selection
git commit -m "feat: normalize reader selections"
```

## Task 4: Conversation Store And Streaming State

**ACs:** AC-3, AC-4, AC-5, AC-10, AC-11

**Files:**

- Create: `src/conversation/conversation-types.ts`
- Create: `src/conversation/conversation-store.ts`
- Create: `tests/conversation/conversation-store.test.ts`

- [ ] **Step 1: Write conversation store tests**

Create `tests/conversation/conversation-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createConversationStore } from "../../src/conversation/conversation-store.js";
import type { ProviderProfile } from "../../src/providers/provider-types.js";
import type { SelectionContext } from "../../src/selection/selection-context.js";

const selection: SelectionContext = {
  quote: "A dense quote.",
  source: {
    itemKey: "I",
    itemTitle: "Paper",
    attachmentKey: "A",
    pageLabel: "3",
    location: "page=3"
  },
  anchor: null
};

const profile: ProviderProfile = {
  id: "local",
  displayName: "Local",
  kind: "openai-compatible",
  baseUrl: "http://localhost:11434",
  model: "llama",
  secret: { kind: "none" },
  sendMode: "local",
  enabled: true
};

describe("createConversationStore", () => {
  it("moves a popup conversation to the sidebar without losing context", () => {
    const store = createConversationStore();
    const created = store.createFromSelection(selection, profile);

    store.appendUserMessage(created.id, "Explain this.");
    store.appendAssistantDelta(created.id, "It means");
    store.moveToSidebar(created.id);

    expect(store.get(created.id)).toMatchObject({
      selection,
      profile,
      visibleSurface: "sidebar",
      messages: [
        { role: "user", content: "Explain this." },
        { role: "assistant", content: "It means" }
      ]
    });
  });

  it("preserves context when a stream is cancelled", () => {
    const store = createConversationStore();
    const created = store.createFromSelection(selection, profile);
    store.markStreaming(created.id);
    store.cancel(created.id);

    expect(store.get(created.id)).toMatchObject({
      selection,
      status: "cancelled",
      errorMessage: null
    });
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm run test -- tests/conversation/conversation-store.test.ts
```

Expected: fail because conversation modules do not exist.

- [ ] **Step 3: Implement store**

Create `src/conversation/conversation-types.ts` using the interface contract in this plan.

Create `src/conversation/conversation-store.ts` with methods:

```ts
export type ConversationStore = {
  createFromSelection(selection: SelectionContext, profile: ProviderProfile): Conversation;
  get(id: string): Conversation | null;
  appendUserMessage(id: string, content: string): void;
  appendAssistantDelta(id: string, text: string): void;
  markStreaming(id: string): void;
  complete(id: string): void;
  fail(id: string, message: string): void;
  cancel(id: string): void;
  moveToSidebar(id: string): void;
};
```

Implementation rule: update state immutably at the boundary and never drop `selection` or `profile`
on failure, cancellation, retry, or surface handoff.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm run verify
pre-commit run --all-files
```

Commit:

```bash
git add src/conversation tests/conversation
git commit -m "feat: add conversation store"
```

## Task 5: Popup Controller

**ACs:** AC-2, AC-3, AC-8, AC-10, AC-11

**Files:**

- Create: `src/ui/privacy-label.ts`
- Create: `src/ui/popup-controller.ts`
- Create: `tests/ui/privacy-label.test.ts`
- Create: `tests/ui/popup-controller.test.ts`

- [ ] **Step 1: Write privacy label tests**

Create `tests/ui/privacy-label.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { providerDisclosure } from "../../src/ui/privacy-label.js";

describe("providerDisclosure", () => {
  it("identifies remote provider/model before sending selected text", () => {
    expect(
      providerDisclosure({ displayName: "OpenAI", model: "gpt-test", sendMode: "remote" })
    ).toBe("Selected text will be sent to OpenAI using gpt-test.");
  });

  it("identifies local provider/model", () => {
    expect(providerDisclosure({ displayName: "Ollama", model: "llama3", sendMode: "local" })).toBe(
      "Selected text will be processed locally by Ollama using llama3."
    );
  });
});
```

- [ ] **Step 2: Write popup controller tests**

Create `tests/ui/popup-controller.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createConversationStore } from "../../src/conversation/conversation-store.js";
import type { ModelProvider, ProviderProfile } from "../../src/providers/provider-types.js";
import { createPopupController } from "../../src/ui/popup-controller.js";

const profile: ProviderProfile = {
  id: "openai",
  displayName: "OpenAI",
  kind: "openai-responses",
  baseUrl: null,
  model: "gpt-test",
  secret: { kind: "environment", name: "OPENAI_API_KEY" },
  sendMode: "remote",
  enabled: true
};

describe("createPopupController", () => {
  it("streams explanation deltas into the conversation", async () => {
    const provider: ModelProvider = {
      id: "openai-responses",
      displayName: "OpenAI",
      async *streamChat() {
        yield { type: "message_start", providerId: "openai-responses", model: "gpt-test" };
        yield { type: "delta", text: "Clear " };
        yield { type: "delta", text: "answer" };
        yield { type: "message_end" };
      }
    };

    const store = createConversationStore();
    const controller = createPopupController({ store, provider });
    const conversation = store.createFromSelection(
      {
        quote: "Dense text.",
        source: {
          itemKey: null,
          itemTitle: null,
          attachmentKey: null,
          pageLabel: null,
          location: null
        },
        anchor: null
      },
      profile
    );

    await controller.explain(conversation.id);

    expect(store.get(conversation.id)).toMatchObject({
      status: "completed",
      messages: [{ role: "assistant", content: "Clear answer" }]
    });
  });
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
npm run test -- tests/ui/privacy-label.test.ts tests/ui/popup-controller.test.ts
```

Expected: fail because UI modules do not exist.

- [ ] **Step 4: Implement popup controller and disclosure**

Create `src/ui/privacy-label.ts`:

```ts
export type ProviderDisclosureInput = {
  readonly displayName: string;
  readonly model: string;
  readonly sendMode: "local" | "remote";
};

export function providerDisclosure(input: ProviderDisclosureInput): string {
  if (input.sendMode === "local") {
    return `Selected text will be processed locally by ${input.displayName} using ${input.model}.`;
  }

  return `Selected text will be sent to ${input.displayName} using ${input.model}.`;
}
```

Create `src/ui/popup-controller.ts`:

```ts
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
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm run verify
pre-commit run --all-files
```

Commit:

```bash
git add src/ui tests/ui
git commit -m "feat: add popup explanation controller"
```

## Task 6: Sidebar Controller And Follow-Up Chat

**ACs:** AC-4, AC-5, AC-8, AC-10, AC-11

**Files:**

- Create: `src/ui/sidebar-controller.ts`
- Create: `tests/ui/sidebar-controller.test.ts`

- [ ] **Step 1: Write sidebar tests**

Create `tests/ui/sidebar-controller.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createConversationStore } from "../../src/conversation/conversation-store.js";
import type { ModelProvider, ProviderProfile } from "../../src/providers/provider-types.js";
import { createSidebarController } from "../../src/ui/sidebar-controller.js";

const profile: ProviderProfile = {
  id: "local",
  displayName: "Ollama",
  kind: "openai-compatible",
  baseUrl: "http://localhost:11434",
  model: "llama3",
  secret: { kind: "none" },
  sendMode: "local",
  enabled: true
};

describe("createSidebarController", () => {
  it("adds follow-up messages to the existing conversation", async () => {
    const provider: ModelProvider = {
      id: "openai-compatible",
      displayName: "Ollama",
      async *streamChat() {
        yield { type: "delta", text: "Follow-up answer" };
        yield { type: "message_end" };
      }
    };
    const store = createConversationStore();
    const conversation = store.createFromSelection(
      {
        quote: "Dense text.",
        source: {
          itemKey: "I",
          itemTitle: "Paper",
          attachmentKey: "A",
          pageLabel: "1",
          location: "page=1"
        },
        anchor: null
      },
      profile
    );
    store.moveToSidebar(conversation.id);

    await createSidebarController({ store, provider }).sendFollowUp(
      conversation.id,
      "Why does it matter?"
    );

    expect(store.get(conversation.id)?.messages).toEqual([
      { role: "user", content: "Why does it matter?" },
      { role: "assistant", content: "Follow-up answer" }
    ]);
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm run test -- tests/ui/sidebar-controller.test.ts
```

Expected: fail because sidebar controller does not exist.

- [ ] **Step 3: Implement sidebar controller**

Create `src/ui/sidebar-controller.ts`:

```ts
import type { ConversationStore } from "../conversation/conversation-store.js";
import type { ModelProvider } from "../providers/provider-types.js";

export type SidebarController = {
  sendFollowUp(conversationId: string, message: string): Promise<void>;
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
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm run verify
pre-commit run --all-files
```

Commit:

```bash
git add src/ui/sidebar-controller.ts tests/ui/sidebar-controller.test.ts
git commit -m "feat: add sidebar follow-up controller"
```

## Task 7: Provider Adapter Families And Profile Validation

**ACs:** AC-6, AC-7, AC-8, AC-9, AC-10, AC-11

**Files:**

- Create: `src/providers/stream-events.ts`
- Create: `src/providers/adapters/openai-responses.ts`
- Create: `src/providers/adapters/openai-compatible.ts`
- Create: `src/providers/adapters/anthropic.ts`
- Create: `src/providers/adapters/gemini.ts`
- Create: `src/providers/adapters/custom-http.ts`
- Create: `src/providers/adapters/local-agent-bridge.ts`
- Create: `src/preferences/provider-profile-validation.ts`
- Create: `tests/providers/adapters/*.test.ts`
- Create: `tests/preferences/provider-profile-validation.test.ts`

- [ ] **Step 1: Write adapter contract tests**

For each adapter test, use injected `fetch` to avoid network calls. Example for
`tests/providers/adapters/openai-compatible.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createOpenAICompatibleProvider } from "../../../src/providers/adapters/openai-compatible.js";

describe("createOpenAICompatibleProvider", () => {
  it("normalizes streaming deltas from chat completions format", async () => {
    const provider = createOpenAICompatibleProvider({
      fetch: async () =>
        new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\\n\\ndata: [DONE]\\n\\n')
    });

    const events = [];
    for await (const event of provider.streamChat(
      {
        selection: {
          quote: "Quote",
          source: {
            itemKey: null,
            itemTitle: null,
            attachmentKey: null,
            pageLabel: null,
            location: null
          },
          anchor: null
        },
        messages: [{ role: "user", content: "Explain" }],
        profile: {
          id: "local",
          displayName: "Local",
          kind: "openai-compatible",
          baseUrl: "http://localhost:11434",
          model: "llama",
          secret: { kind: "none" },
          sendMode: "local",
          enabled: true
        }
      },
      new AbortController().signal
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "delta", text: "Hi" });
    expect(events).toContainEqual({ type: "message_end" });
  });
});
```

Add the remaining adapter tests as explicit files with these payloads and expectations:

| Test File                                             | Provider Factory                 | Sample Payload                                                                                                       | Required Expectation                                                          |
| ----------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `tests/providers/adapters/openai-responses.test.ts`   | `createOpenAIResponsesProvider`  | `data: {"type":"response.output_text.delta","delta":"Hi"}\n\ndata: {"type":"response.completed"}\n\n`                | Events include `{ type: "delta", text: "Hi" }` and `{ type: "message_end" }`. |
| `tests/providers/adapters/anthropic.test.ts`          | `createAnthropicProvider`        | `event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"Hi"}}\n\nevent: message_stop\ndata: {}\n\n` | Events include `{ type: "delta", text: "Hi" }` and `{ type: "message_end" }`. |
| `tests/providers/adapters/gemini.test.ts`             | `createGeminiProvider`           | `[{"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}]`                                                           | Events include `{ type: "delta", text: "Hi" }` and `{ type: "message_end" }`. |
| `tests/providers/adapters/custom-http.test.ts`        | `createCustomHttpProvider`       | `{"text":"Hi"}`                                                                                                      | Events include `{ type: "delta", text: "Hi" }` and `{ type: "message_end" }`. |
| `tests/providers/adapters/local-agent-bridge.test.ts` | `createLocalAgentBridgeProvider` | `{"event":"delta","text":"Hi"}\n{"event":"done"}\n`                                                                  | Events include `{ type: "delta", text: "Hi" }` and `{ type: "message_end" }`. |

Each file must construct a complete `ChatRequest`, inject a fake `fetch`, collect events with
`for await`, and assert that no real network call is made.

- [ ] **Step 2: Write profile validation tests**

Create `tests/preferences/provider-profile-validation.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { validateProviderProfile } from "../../src/preferences/provider-profile-validation.js";

describe("validateProviderProfile", () => {
  it("accepts local OpenAI-compatible profiles without a secret", () => {
    expect(
      validateProviderProfile({
        id: "ollama",
        displayName: "Ollama",
        kind: "openai-compatible",
        baseUrl: "http://localhost:11434",
        model: "llama3",
        secret: { kind: "none" },
        sendMode: "local",
        enabled: true
      })
    ).toEqual({ ok: true });
  });

  it("requires a base URL for custom HTTP providers", () => {
    expect(
      validateProviderProfile({
        id: "custom",
        displayName: "Custom",
        kind: "custom-http",
        baseUrl: null,
        model: "x",
        secret: { kind: "none" },
        sendMode: "remote",
        enabled: true
      })
    ).toEqual({ ok: false, reason: "custom-http providers require a base URL." });
  });
});
```

- [ ] **Step 3: Implement adapters in minimum complete form**

Each adapter must:

- Export `create<AdapterName>Provider(deps: { fetch: typeof fetch })`.
- Return a `ModelProvider`.
- Build a request from `ChatRequest`.
- Use `AbortSignal`.
- Convert provider-specific streaming payloads into `ChatEvent`.
- Emit redacted, actionable errors through thrown `Error` objects or `ChatEvent` error events.

Implementation may start with streaming parser helpers in `src/providers/stream-events.ts` and share
SSE parsing across compatible providers.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm run verify
pre-commit run --all-files
```

Commit:

```bash
git add src/providers src/preferences tests/providers tests/preferences
git commit -m "feat: add provider adapter families"
```

## Task 8: Zotero 8 Build, Bootstrap, And Preferences Boundary

**ACs:** AC-1, AC-12

**Files:**

- Modify: `package.json`
- Create: `src/bootstrap.ts`
- Create: `src/platform/plugin-lifecycle.ts`
- Create: `src/preferences/provider-profile-store.ts`
- Create: `addon/bootstrap.js`
- Modify: `README.md`
- Create: `docs/manual-verification/zotero-8.md`
- Create: `tests/platform/plugin-lifecycle.test.ts`
- Create: `tests/preferences/provider-profile-store.test.ts`

- [ ] **Step 1: Write lifecycle boundary tests**

Create `tests/platform/plugin-lifecycle.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createPluginLifecycle } from "../../src/platform/plugin-lifecycle.js";

describe("createPluginLifecycle", () => {
  it("registers startup and shutdown actions in order", async () => {
    const calls: string[] = [];
    const lifecycle = createPluginLifecycle({
      startup: async () => calls.push("startup"),
      shutdown: async () => calls.push("shutdown")
    });

    await lifecycle.startup();
    await lifecycle.shutdown();

    expect(calls).toEqual(["startup", "shutdown"]);
  });
});
```

- [ ] **Step 2: Write profile store tests**

Create `tests/preferences/provider-profile-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createProviderProfileStore } from "../../src/preferences/provider-profile-store.js";

describe("createProviderProfileStore", () => {
  it("stores provider profiles without resolving or serializing secret values", () => {
    const memory = new Map<string, string>();
    const store = createProviderProfileStore({
      get: (key) => memory.get(key) ?? null,
      set: (key, value) => memory.set(key, value)
    });

    store.saveAll([
      {
        id: "openai",
        displayName: "OpenAI",
        kind: "openai-responses",
        baseUrl: null,
        model: "gpt-test",
        secret: { kind: "environment", name: "OPENAI_API_KEY" },
        sendMode: "remote",
        enabled: true
      }
    ]);

    expect(memory.get("providers")).toContain("OPENAI_API_KEY");
    expect(memory.get("providers")).not.toContain("sk-");
  });
});
```

- [ ] **Step 3: Implement lifecycle and store boundaries**

Create `src/platform/plugin-lifecycle.ts`:

```ts
export type PluginLifecycle = {
  startup(): Promise<void>;
  shutdown(): Promise<void>;
};

export function createPluginLifecycle(actions: PluginLifecycle): PluginLifecycle {
  return {
    startup: actions.startup,
    shutdown: actions.shutdown
  };
}
```

Create `src/preferences/provider-profile-store.ts`:

```ts
import type { ProviderProfile } from "../providers/provider-types.js";

export type PreferenceStore = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

export function createProviderProfileStore(store: PreferenceStore) {
  return {
    loadAll(): readonly ProviderProfile[] {
      const raw = store.get("providers");
      if (raw === null) {
        return [];
      }
      return JSON.parse(raw) as readonly ProviderProfile[];
    },
    saveAll(profiles: readonly ProviderProfile[]): void {
      store.set("providers", JSON.stringify(profiles));
    }
  };
}
```

Create `src/bootstrap.ts` as the composition root exported for the Zotero bootstrap loader:

```ts
import { createPluginLifecycle } from "./platform/plugin-lifecycle.js";

export type ZoteroBootstrapContext = {
  readonly Zotero: { debug(message: string): void; version?: string };
  readonly reason: number;
};

const lifecycle = createPluginLifecycle({
  async startup() {},
  async shutdown() {}
});

export async function startup(context: ZoteroBootstrapContext): Promise<void> {
  context.Zotero.debug("Zotero AI Explain startup");
  await lifecycle.startup();
}

export async function shutdown(context: ZoteroBootstrapContext): Promise<void> {
  context.Zotero.debug("Zotero AI Explain shutdown");
  await lifecycle.shutdown();
}
```

- [ ] **Step 4: Add Zotero-facing bridge**

Create `addon/bootstrap.js` as the Zotero-loaded entry point. In this implementation stride it is a
Zotero 8 bridge that imports the built ESM bundle:

```js
"use strict";

var { Services } = ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs");
var moduleUrl;

async function startup(data, reason) {
  moduleUrl = `${data.rootURI}content/zotero-ai-explain.sys.mjs`;
  const module = ChromeUtils.importESModule(moduleUrl);
  await module.startup({ Zotero, reason });
}

async function shutdown(data, reason) {
  if (typeof APP_SHUTDOWN !== "undefined" && reason === APP_SHUTDOWN) {
    return;
  }

  if (moduleUrl === undefined) {
    return;
  }

  const module = ChromeUtils.importESModule(moduleUrl);
  await module.shutdown({ Zotero, reason });
  Services.obs.notifyObservers(null, "startupcache-invalidate");
}
```

Update `package.json` scripts and dependencies so the bundle exists:

```json
{
  "scripts": {
    "build": "esbuild src/bootstrap.ts --bundle --format=esm --platform=browser --target=firefox140 --outfile=addon/content/zotero-ai-explain.sys.mjs && tsc --noEmit",
    "verify": "npm run build && npm run lint && npm run format && npm run test"
  },
  "devDependencies": {
    "esbuild": "^0.25.4"
  }
}
```

Run `npm install` after adding `esbuild`. If Zotero 8 manual verification shows this bridge is not
loadable, stop and perform RCA against the installed Zotero 8 loader before changing the bridge
shape.

- [ ] **Step 5: Add manual Zotero 8 verification checklist**

Create `docs/manual-verification/zotero-8.md` with:

```markdown
# Zotero 8 Manual Verification

## Environment

- Zotero version:
- Plugin build artifact:
- OS:

## Checks

- [ ] Plugin installs in Zotero 8 without Zotero 7 compatibility warnings.
- [ ] Plugin startup runs without console errors.
- [ ] Selecting text in a PDF or EPUB shows the Explain action.
- [ ] Explain opens an anchored popup near the selected text.
- [ ] Popup streams response text and can be cancelled.
- [ ] Continue in Sidebar preserves quote, source metadata, provider, and messages.
- [ ] Sidebar follow-up sends another request in the same conversation.
- [ ] Remote provider UI identifies provider/model before sending selected text.
- [ ] Local provider profile works without a cloud API key.
- [ ] Missing provider/secret shows an actionable error without exposing secrets.
```

- [ ] **Step 6: Update README**

Add a `Manual Verification` section pointing to `docs/manual-verification/zotero-8.md` and clarify
that the current target is Zotero 8 only.

- [ ] **Step 7: Verify and commit**

Run:

```bash
npm run verify
pre-commit run --all-files
pre-commit run --all-files --hook-stage pre-push
```

Commit:

```bash
git add package.json package-lock.json src/bootstrap.ts src/platform src/preferences addon/bootstrap.js addon/content README.md docs/manual-verification tests/platform tests/preferences
git commit -m "feat: add zotero integration boundaries"
```

## Task 9: Reader Selection UI, Anchored Popup View, And Sidebar View

**ACs:** AC-2, AC-3, AC-4, AC-5, AC-8, AC-10, AC-12

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/platform/reader-integration.ts`
- Create: `src/platform/reader-dom-adapter.ts`
- Create: `src/ui/anchored-popup-view.ts`
- Create: `src/ui/sidebar-view.ts`
- Create: `tests/platform/reader-integration.test.ts`
- Create: `tests/platform/reader-dom-adapter.test.ts`
- Create: `tests/ui/anchored-popup-view.test.ts`
- Create: `tests/ui/sidebar-view.test.ts`
- Modify: `src/bootstrap.ts`
- Modify: `docs/manual-verification/zotero-8.md`

- [ ] **Step 1: Write reader integration tests**

Create `tests/platform/reader-integration.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { createReaderIntegration } from "../../src/platform/reader-integration.js";

describe("createReaderIntegration", () => {
  it("registers a selection handler and triggers explain only for non-empty text", () => {
    const calls: string[] = [];
    const integration = createReaderIntegration({
      onExplain: (selection) => calls.push(selection.quote)
    });

    integration.handleSelection({
      quote: "  important text  ",
      source: {
        itemKey: null,
        itemTitle: null,
        attachmentKey: null,
        pageLabel: null,
        location: null
      },
      anchor: { left: 1, top: 2, width: 3, height: 4 }
    });
    integration.handleSelection({
      quote: " ",
      source: {
        itemKey: null,
        itemTitle: null,
        attachmentKey: null,
        pageLabel: null,
        location: null
      },
      anchor: null
    });

    expect(calls).toEqual(["important text"]);
  });
});
```

Create `tests/platform/reader-dom-adapter.test.ts`:

```ts
/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import { createReaderDomAdapter } from "../../src/platform/reader-dom-adapter.js";

describe("createReaderDomAdapter", () => {
  it("converts a reader mouseup selection into a SelectionContext", () => {
    const quotes: string[] = [];
    const adapter = createReaderDomAdapter({
      document,
      getSelectionText: () => " selected text ",
      getAnchor: () => ({ left: 10, top: 20, width: 30, height: 40 }),
      getSource: () => ({
        itemKey: "ITEM",
        itemTitle: "Paper",
        attachmentKey: "ATT",
        pageLabel: "5",
        location: "page=5"
      }),
      onSelection: (selection) => quotes.push(selection.quote)
    });

    adapter.attach();
    document.dispatchEvent(new MouseEvent("mouseup"));
    adapter.detach();

    expect(quotes).toEqual([" selected text "]);
  });
});
```

- [ ] **Step 2: Write popup and sidebar view tests**

Create `tests/ui/anchored-popup-view.test.ts`:

```ts
/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import { renderAnchoredPopup } from "../../src/ui/anchored-popup-view.js";

describe("renderAnchoredPopup", () => {
  it("renders provider disclosure and positions from the selection anchor", () => {
    const view = renderAnchoredPopup({
      disclosure: "Selected text will be sent to OpenAI using gpt-test.",
      anchor: { left: 10, top: 20, width: 100, height: 30 },
      text: "Explanation"
    });

    expect(view.style.left).toBe("10px");
    expect(view.style.top).toBe("20px");
    expect(view.textContent).toContain("Selected text will be sent to OpenAI using gpt-test.");
    expect(view.textContent).toContain("Explanation");
  });
});
```

Create `tests/ui/sidebar-view.test.ts`:

```ts
/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import { renderSidebarConversation } from "../../src/ui/sidebar-view.js";

describe("renderSidebarConversation", () => {
  it("renders pinned quote, source, and messages", () => {
    const view = renderSidebarConversation({
      quote: "Dense text.",
      sourceLabel: "Paper, p. 4",
      messages: [
        { role: "user", content: "Explain this." },
        { role: "assistant", content: "It means something specific." }
      ]
    });

    expect(view.textContent).toContain("Dense text.");
    expect(view.textContent).toContain("Paper, p. 4");
    expect(view.textContent).toContain("Explain this.");
    expect(view.textContent).toContain("It means something specific.");
  });
});
```

- [ ] **Step 3: Implement reader integration and DOM views**

Update `package.json` and run `npm install` so DOM view tests can run:

```json
{
  "devDependencies": {
    "jsdom": "^26.1.0"
  }
}
```

Create `src/platform/reader-integration.ts`:

```ts
import { normalizeSelection } from "../selection/normalize-selection.js";
import type { SelectionContext } from "../selection/selection-context.js";

export type ReaderIntegration = {
  handleSelection(selection: SelectionContext): void;
};

export function createReaderIntegration(deps: {
  readonly onExplain: (selection: SelectionContext) => void;
}): ReaderIntegration {
  return {
    handleSelection(selection) {
      const normalized = normalizeSelection(selection);
      if (!normalized.ok) {
        return;
      }
      deps.onExplain(normalized.selection);
    }
  };
}
```

Create `src/platform/reader-dom-adapter.ts`:

```ts
import type { SelectionContext, SourceMetadata } from "../selection/selection-context.js";

export type ReaderDomAdapter = {
  attach(): void;
  detach(): void;
};

export function createReaderDomAdapter(deps: {
  readonly document: Document;
  readonly getSelectionText: () => string;
  readonly getAnchor: () => SelectionContext["anchor"];
  readonly getSource: () => SourceMetadata;
  readonly onSelection: (selection: SelectionContext) => void;
}): ReaderDomAdapter {
  const handleMouseUp = () => {
    deps.onSelection({
      quote: deps.getSelectionText(),
      source: deps.getSource(),
      anchor: deps.getAnchor()
    });
  };

  return {
    attach() {
      deps.document.addEventListener("mouseup", handleMouseUp);
    },
    detach() {
      deps.document.removeEventListener("mouseup", handleMouseUp);
    }
  };
}
```

Create `src/ui/anchored-popup-view.ts`:

```ts
import type { SelectionContext } from "../selection/selection-context.js";

export function renderAnchoredPopup(input: {
  readonly disclosure: string;
  readonly anchor: SelectionContext["anchor"];
  readonly text: string;
}): HTMLElement {
  const element = document.createElement("section");
  element.className = "zotero-ai-explain-popup";
  element.style.position = "absolute";
  element.style.left = `${input.anchor?.left ?? 0}px`;
  element.style.top = `${input.anchor?.top ?? 0}px`;
  element.append(input.disclosure, document.createElement("br"), input.text);
  return element;
}
```

Create `src/ui/sidebar-view.ts`:

```ts
import type { ChatMessage } from "../providers/provider-types.js";

export function renderSidebarConversation(input: {
  readonly quote: string;
  readonly sourceLabel: string;
  readonly messages: readonly ChatMessage[];
}): HTMLElement {
  const element = document.createElement("aside");
  element.className = "zotero-ai-explain-sidebar";
  element.append(
    `Quote: ${input.quote}`,
    document.createElement("br"),
    `Source: ${input.sourceLabel}`
  );

  for (const message of input.messages) {
    const row = document.createElement("p");
    row.textContent = `${message.role}: ${message.content}`;
    element.append(row);
  }

  return element;
}
```

- [ ] **Step 4: Wire into bootstrap composition**

Modify `src/bootstrap.ts` so startup creates the reader integration and logs that reader hooks are
ready. Direct Zotero reader DOM attachment must stay behind `createReaderDomAdapter`:

```ts
import { createReaderIntegration } from "./platform/reader-integration.js";
import { createPluginLifecycle } from "./platform/plugin-lifecycle.js";

const readerIntegration = createReaderIntegration({
  onExplain(selection) {
    void selection;
  }
});
```

During Zotero manual testing, attach `createReaderDomAdapter` to the reader window document. The
adapter's `getSelectionText` must call the reader document selection API, `getAnchor` must derive
the first selection rectangle, and `getSource` must read Zotero item/page metadata available from
the reader context. If any of these Zotero 8 APIs differ from expectation, stop and perform RCA
before changing the boundary types.

- [ ] **Step 5: Update manual verification checklist**

Add a notes section to `docs/manual-verification/zotero-8.md`:

```markdown
## Reader API Notes

- Reader selection event/API used:
- Popup container element:
- Sidebar container element:
- Any Zotero 8 console warnings:
```

- [ ] **Step 6: Verify and commit**

Run:

```bash
npm run verify
pre-commit run --all-files
pre-commit run --all-files --hook-stage pre-push
```

Commit:

```bash
git add package.json package-lock.json src/platform/reader-integration.ts src/platform/reader-dom-adapter.ts src/ui/anchored-popup-view.ts src/ui/sidebar-view.ts src/bootstrap.ts docs/manual-verification/zotero-8.md tests/platform/reader-integration.test.ts tests/platform/reader-dom-adapter.test.ts tests/ui/anchored-popup-view.test.ts tests/ui/sidebar-view.test.ts
git commit -m "feat: add reader explain ui surfaces"
```

## Final Verification

- [ ] Run `npm run verify`.
- [ ] Run `pre-commit run --all-files`.
- [ ] Run `pre-commit run --all-files --hook-stage pre-push`.
- [ ] Execute every check in `docs/manual-verification/zotero-8.md` against the installed latest
      Zotero 8 application.
- [ ] Update `.forge/learnings.jsonl` with any novel Zotero 8 integration or provider-streaming
      patterns.
- [ ] Update README and `CLAUDE.md` if the implementation changes commands, architecture, or file
      layout.

## Plan Self-Review

- Spec coverage: AC-1 through AC-12 each map to at least one task, including real startup and reader
  UI surfaces in Tasks 8 and 9.
- Placeholder scan: no TODO/TBD markers or "implement later" instructions remain.
- Type consistency: interfaces use `SelectionContext`, `ProviderProfile`, `ChatRequest`,
  `ChatEvent`, `ModelProvider`, and `Conversation` consistently across tasks.
- Risk review: Zotero reader anchoring and packaging remain highest risk; Task 8 isolates Zotero
  globals and requires manual verification in Zotero 8.
- Scope review: full native adapter implementation is large but bounded behind one streaming
  contract, so UI/controller work can proceed without provider-specific coupling.

## Internal Review Results

### Reviewer Pass

- Spec coverage: passed. AC-1 through AC-12 are mapped in the acceptance-criteria table and covered
  by tasks with tests or manual verification.
- Type consistency: passed after moving `SecretReference` ownership to `src/secrets/secret-types.ts`
  and importing it from `src/providers/provider-types.ts`.
- File operation consistency: passed after changing `addon/bootstrap.js` from modify to create.
- Placeholder scan: passed. The plan contains no TODO/TBD placeholders or vague "repeat this"
  implementation instructions.

### Adversarial Review

- Finding: the first draft had a placeholder bootstrap that would intentionally throw at startup,
  which contradicted AC-12. Resolution: Task 8 now builds an ESM bundle and adds a Zotero 8
  `bootstrap.js` bridge that imports `addon/content/zotero-ai-explain.sys.mjs`.
- Finding: the first draft had controller logic but no concrete reader DOM event boundary, so AC-2
  was underspecified. Resolution: Task 9 now adds `reader-dom-adapter.ts`, `reader-integration.ts`,
  DOM view modules, and manual reader API notes.
- Finding: DOM view tests used `document` without a DOM test environment. Resolution: Task 9 now
  adds `jsdom` and `@vitest-environment jsdom` test headers.
- Finding: provider adapter tests were too terse for five adapter families. Resolution: Task 7 now
  lists exact test files, factories, payloads, and expected normalized events.
