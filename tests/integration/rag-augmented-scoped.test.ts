/**
 * Adversarial integration tests for AC-3 — in-PDF RAG auto-scope routed
 * end-to-end through `createRagAugmentedProvider`.
 *
 * Plan: `docs/superpowers/plans/2026-05-19-pdf-context-features.md`
 *   AC-3 description           L422-433 (adversarial cases L430-433)
 *   AC-3 interface contracts   L629-660
 *   AC-3 Modify notes          L307-309 (rag-augmented-provider)
 *
 * --------------------------------------------------------------------
 * Fault Localization (Template 4 — AC-3 RAG scope wiring)
 * --------------------------------------------------------------------
 *
 * 1. Spec semantics (premises):
 *    P1.  `createRagAugmentedProvider(deps)` factory signature is
 *         UNCHANGED — same `RagAugmentedProviderDeps` shape as v0.2.0
 *         (contract L424, Modify note L309). No new constructor arg.
 *    P2.  At `streamChat` time the provider reads
 *         `request.selection.source.scopedItemKey`. When it is a string
 *         the retrieval is filtered to chunks of that itemKey by
 *         forwarding `topKChunks(file, queryEmbedding, topK,
 *         { scopedItemKey })` (Data Flow L51-52).
 *    P3.  When `scopedItemKey` is `undefined` the provider retrieves
 *         library-wide — identical to v0.2.0 behavior (Adv-2, L432).
 *    P4.  `scopedItemKey` set to a key with NO chunks in the index ⇒
 *         retrieval is `[]` ⇒ the provider falls through to its
 *         no-context branch and yields the inner provider's stream
 *         with the ORIGINAL (un-augmented) messages (Adv-1, L431 —
 *         matches the existing empty-retrieval handling).
 *    P5.  The scope is REQUEST-scoped: it lives on the per-call
 *         `ChatRequest`, not on the provider instance. Two concurrent
 *         `streamChat` calls with different `scopedItemKey` values
 *         each retrieve their own scope — no shared mutable state in
 *         `createRagAugmentedProvider` (Adv-3, L433).
 *    P6.  When scoped retrieval DOES hit, the augmented system message
 *         must contain ONLY excerpts from the scoped item (no
 *         cross-item leakage into the prompt).
 *
 * 2. Code path trace (against the contract — body NOT inspected):
 *    - createRagAugmentedProvider(deps) → streamChat(request, signal)
 *      → augmentMessages reads request.selection.source.scopedItemKey
 *      → topKChunks(file, emb, topK, {scopedItemKey})
 *      → if [] → yield inner.streamChat(original) else inject excerpts.
 *
 * 3. Divergence analysis (where the impl could fail the spec):
 *    D1 [HIGH]   provider ignores scopedItemKey → library-wide leak
 *                into the in-PDF popup prompt.
 *    D2 [HIGH]   scoped-but-empty does not fall through → prompt is
 *                built with zero excerpts or the call throws.
 *    D3 [HIGH]   scope cached on the provider instance → a later
 *                unscoped request inherits a stale scope (or vice
 *                versa) — the multi-window race.
 *    D4 [MEDIUM] factory signature changed → call sites break.
 *    D5 [MEDIUM] excerpt block leaks an out-of-scope item's text.
 *
 * 4. Test targets, ranked: D1 > D2 > D3 > D4 > D5.
 */

import { describe, expect, it } from "vitest";

import { createRagAugmentedProvider } from "../../src/providers/rag-augmented-provider.js";
import type { RagAugmentedProviderDeps } from "../../src/providers/rag-augmented-provider.js";
import type { IndexFile, IndexedItemChunk } from "../../src/indexing/library-crawler.js";
import type { IndexStorage } from "../../src/indexing/index-storage.js";
import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  EmbeddingProvider,
  ModelProvider,
  ProviderProfile
} from "../../src/providers/provider-types.js";
import type { SelectionContext } from "../../src/selection/selection-context.js";

// --------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------

function makeIndex(
  items: Record<string, { title: string; chunkTexts: string[]; embedding: number[] }>
): IndexFile {
  const stamped: IndexFile["items"] = {};
  for (const [key, item] of Object.entries(items)) {
    const chunks: IndexedItemChunk[] = item.chunkTexts.map((text) => ({
      text,
      embedding: item.embedding,
      sourceKind: "pdf-page" as const
    }));
    stamped[key] = { title: item.title, chunks };
  }
  return { schemaVersion: 2, items: stamped, indexedAt: new Date(0).toISOString() };
}

/** A read-only IndexStorage stub that always returns `file`. */
function fakeStorage(file: IndexFile | null): IndexStorage {
  return {
    read: () => Promise.resolve(file),
    readWithMigration: () => Promise.resolve({ file, migrationPending: false }),
    readItemCount: () => Promise.resolve(file === null ? 0 : Object.keys(file.items).length),
    write: () => Promise.resolve(),
    writeItem: () => Promise.resolve(),
    writeTmp: () => Promise.resolve(),
    commitMigration: () => Promise.resolve(),
    abandonMigration: () => Promise.resolve(),
    writeMarker: () => Promise.resolve(),
    removeMarker: () => Promise.resolve(),
    hasMarker: () => Promise.resolve(false),
    clear: () => Promise.resolve(),
    path: () => "/var/test-fixture/index.json"
  };
}

/** Embedding provider that always returns a fixed query vector. */
function fakeEmbeddingProvider(vector: number[]): EmbeddingProvider {
  return {
    embedTexts: () => Promise.resolve([vector])
  };
}

/**
 * Inner ModelProvider that records the messages array it was handed and
 * yields a trivial completion. The recorded messages are how the test
 * proves what the RAG layer injected.
 */
function recordingInnerProvider(): {
  provider: ModelProvider;
  lastMessages: () => readonly ChatMessage[];
  callCount: () => number;
} {
  let captured: readonly ChatMessage[] = [];
  let calls = 0;
  const provider: ModelProvider = {
    id: "inner",
    displayName: "Inner",
    // eslint-disable-next-line @typescript-eslint/require-await
    async *streamChat(request: ChatRequest): AsyncIterable<ChatEvent> {
      calls += 1;
      captured = request.messages;
      yield { type: "message_start", providerId: "inner", model: "test" };
      yield { type: "delta", text: "ok" };
      yield { type: "message_end" };
    }
  };
  return { provider, lastMessages: () => captured, callCount: () => calls };
}

const PROFILE: ProviderProfile = {
  id: "p",
  displayName: "P",
  kind: "ollama",
  baseUrl: "http://localhost:11434",
  model: "gemma",
  secret: { kind: "none" },
  sendMode: "local",
  enabled: true
};

/** Build a ChatRequest carrying an optional `scopedItemKey`. */
function chatRequest(userText: string, scopedItemKey?: string): ChatRequest {
  const source: SelectionContext["source"] = {
    itemKey: scopedItemKey ?? null,
    itemTitle: null,
    attachmentKey: null,
    pageLabel: null,
    ...(scopedItemKey !== undefined ? { scopedItemKey } : {})
  };
  const selection: SelectionContext = { quote: "", source, anchor: null };
  return {
    selection,
    messages: [{ role: "user", content: userText }],
    profile: PROFILE
  };
}

function baseDeps(file: IndexFile | null, inner: ModelProvider): RagAugmentedProviderDeps {
  return {
    inner,
    embeddingProvider: fakeEmbeddingProvider([1, 0, 0]),
    indexStorage: fakeStorage(file),
    embedSettings: { baseUrl: "http://localhost:11434", model: "embed" }
  };
}

async function drain(stream: AsyncIterable<ChatEvent>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _event of stream) {
    // exhaust the generator so augmentMessages runs to completion
  }
}

// --------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------

describe("createRagAugmentedProvider — AC-3 request-scoped RAG", () => {
  it("D4 (regression): the factory signature is unchanged — RagAugmentedProviderDeps still wires", () => {
    const { provider } = recordingInnerProvider();
    const file = makeIndex({
      AAAAAAAA: { title: "A", chunkTexts: ["alpha text"], embedding: [1, 0, 0] }
    });
    // If the factory grew a required arg this line would not type-check.
    const rag = createRagAugmentedProvider(baseDeps(file, provider));
    expect(rag.id).toBe("inner");
    expect(typeof rag.streamChat).toBe("function");
  });

  it("D1: a scoped request injects ONLY the scoped item's excerpts into the prompt", async () => {
    const inner = recordingInnerProvider();
    const file = makeIndex({
      SCOPEDAA: {
        title: "Scoped paper",
        chunkTexts: ["scoped excerpt body"],
        embedding: [1, 0, 0]
      },
      OTHERBBB: {
        title: "Other paper",
        // Identical embedding ⇒ identical cosine ⇒ would be retrieved
        // if the scope filter were missing.
        chunkTexts: ["other excerpt body"],
        embedding: [1, 0, 0]
      }
    });
    const rag = createRagAugmentedProvider(baseDeps(file, inner.provider));

    await drain(
      rag.streamChat(chatRequest("what does this say?", "SCOPEDAA"), new AbortController().signal)
    );

    const joined = inner
      .lastMessages()
      .map((m) => m.content)
      .join("\n");
    expect(joined).toContain("scoped excerpt body");
    expect(joined).not.toContain("other excerpt body");
  });

  it("D1: a scoped request includes the scoped item's key in the excerpt block", async () => {
    const inner = recordingInnerProvider();
    const file = makeIndex({
      SCOPEDAA: { title: "Scoped paper", chunkTexts: ["scoped excerpt body"], embedding: [1, 0, 0] }
    });
    const rag = createRagAugmentedProvider(baseDeps(file, inner.provider));

    await drain(rag.streamChat(chatRequest("question", "SCOPEDAA"), new AbortController().signal));

    const joined = inner
      .lastMessages()
      .map((m) => m.content)
      .join("\n");
    expect(joined).toContain("SCOPEDAA");
  });

  it("Adv-1: scopedItemKey with no chunks of that key falls through to the no-context branch", async () => {
    const inner = recordingInnerProvider();
    const file = makeIndex({
      // The index has content, but NOT for the scoped key.
      REALITEM: { title: "Real", chunkTexts: ["real excerpt"], embedding: [1, 0, 0] }
    });
    const rag = createRagAugmentedProvider(baseDeps(file, inner.provider));

    await drain(rag.streamChat(chatRequest("question", "GHOSTKEY"), new AbortController().signal));

    // Empty scoped retrieval ⇒ no system message injected; the inner
    // provider sees the ORIGINAL single user message untouched.
    const messages = inner.lastMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("question");
    // And it must NOT have leaked the unrelated item's excerpt.
    expect(messages[0]?.content).not.toContain("real excerpt");
  });

  it("Adv-1: scoped-but-empty still produces a working stream (no throw, inner is invoked)", async () => {
    const inner = recordingInnerProvider();
    const file = makeIndex({
      REALITEM: { title: "Real", chunkTexts: ["real excerpt"], embedding: [1, 0, 0] }
    });
    const rag = createRagAugmentedProvider(baseDeps(file, inner.provider));

    const events: ChatEvent[] = [];
    for await (const event of rag.streamChat(
      chatRequest("question", "GHOSTKEY"),
      new AbortController().signal
    )) {
      events.push(event);
    }
    expect(inner.callCount()).toBe(1);
    expect(events.map((e) => e.type)).toContain("message_end");
  });

  it("Adv-2 (regression): an unscoped request retrieves library-wide", async () => {
    const inner = recordingInnerProvider();
    const file = makeIndex({
      ITEMONEX: { title: "One", chunkTexts: ["excerpt one"], embedding: [1, 0, 0] },
      ITEMTWOX: { title: "Two", chunkTexts: ["excerpt two"], embedding: [1, 0, 0] }
    });
    const rag = createRagAugmentedProvider(baseDeps(file, inner.provider));

    // No scopedItemKey on the request — library-chat-style call.
    await drain(rag.streamChat(chatRequest("question", undefined), new AbortController().signal));

    const joined = inner
      .lastMessages()
      .map((m) => m.content)
      .join("\n");
    // Both items are eligible because retrieval is unscoped.
    expect(joined).toContain("excerpt one");
    expect(joined).toContain("excerpt two");
  });

  it("Adv-3 (no shared state): a scoped call followed by an unscoped call does not leak the scope", async () => {
    const inner = recordingInnerProvider();
    const file = makeIndex({
      SCOPEDAA: { title: "Scoped", chunkTexts: ["scoped only text"], embedding: [1, 0, 0] },
      OTHERBBB: { title: "Other", chunkTexts: ["other only text"], embedding: [1, 0, 0] }
    });
    const rag = createRagAugmentedProvider(baseDeps(file, inner.provider));

    // First request: scoped to SCOPEDAA.
    await drain(rag.streamChat(chatRequest("first", "SCOPEDAA"), new AbortController().signal));
    const scopedJoined = inner
      .lastMessages()
      .map((m) => m.content)
      .join("\n");
    expect(scopedJoined).toContain("scoped only text");
    expect(scopedJoined).not.toContain("other only text");

    // Second request through the SAME provider instance: unscoped.
    await drain(rag.streamChat(chatRequest("second", undefined), new AbortController().signal));
    const unscopedJoined = inner
      .lastMessages()
      .map((m) => m.content)
      .join("\n");
    // The second request must NOT inherit the first's scope.
    expect(unscopedJoined).toContain("scoped only text");
    expect(unscopedJoined).toContain("other only text");
  });

  it("Adv-3 (no shared state): an unscoped call followed by a scoped call still scopes correctly", async () => {
    const inner = recordingInnerProvider();
    const file = makeIndex({
      SCOPEDAA: { title: "Scoped", chunkTexts: ["scoped only text"], embedding: [1, 0, 0] },
      OTHERBBB: { title: "Other", chunkTexts: ["other only text"], embedding: [1, 0, 0] }
    });
    const rag = createRagAugmentedProvider(baseDeps(file, inner.provider));

    await drain(rag.streamChat(chatRequest("first", undefined), new AbortController().signal));
    await drain(rag.streamChat(chatRequest("second", "OTHERBBB"), new AbortController().signal));

    const joined = inner
      .lastMessages()
      .map((m) => m.content)
      .join("\n");
    expect(joined).toContain("other only text");
    expect(joined).not.toContain("scoped only text");
  });

  it("Adv-3 (multi-window): two concurrent scoped streams retrieve their own scopes", async () => {
    // Two separate provider instances (two reader windows) running
    // concurrently. Each must resolve its own request's scope.
    const innerA = recordingInnerProvider();
    const innerB = recordingInnerProvider();
    const file = makeIndex({
      WINDOWAA: { title: "A", chunkTexts: ["window A text"], embedding: [1, 0, 0] },
      WINDOWBB: { title: "B", chunkTexts: ["window B text"], embedding: [1, 0, 0] }
    });
    const ragA = createRagAugmentedProvider(baseDeps(file, innerA.provider));
    const ragB = createRagAugmentedProvider(baseDeps(file, innerB.provider));

    await Promise.all([
      drain(ragA.streamChat(chatRequest("qa", "WINDOWAA"), new AbortController().signal)),
      drain(ragB.streamChat(chatRequest("qb", "WINDOWBB"), new AbortController().signal))
    ]);

    const joinedA = innerA
      .lastMessages()
      .map((m) => m.content)
      .join("\n");
    const joinedB = innerB
      .lastMessages()
      .map((m) => m.content)
      .join("\n");
    expect(joinedA).toContain("window A text");
    expect(joinedA).not.toContain("window B text");
    expect(joinedB).toContain("window B text");
    expect(joinedB).not.toContain("window A text");
  });

  it("a scoped request with an empty index falls through (graceful degrade)", async () => {
    const inner = recordingInnerProvider();
    const emptyFile = makeIndex({});
    const rag = createRagAugmentedProvider(baseDeps(emptyFile, inner.provider));

    await drain(rag.streamChat(chatRequest("question", "ANYKEYXX"), new AbortController().signal));
    const messages = inner.lastMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("question");
  });

  it("a scoped request with a missing index (storage returns null) falls through", async () => {
    const inner = recordingInnerProvider();
    const rag = createRagAugmentedProvider(baseDeps(null, inner.provider));

    await drain(rag.streamChat(chatRequest("question", "ANYKEYXX"), new AbortController().signal));
    const messages = inner.lastMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("question");
  });
});
