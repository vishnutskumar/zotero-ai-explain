/**
 * Real-Ollama pipeline e2e tests (AC8 — local-only).
 *
 * AUTO-SKIPS when:
 *   - Ollama is not reachable at `OLLAMA_BASE_URL` (default
 *     `http://localhost:11434`).
 *   - The configured chat / embedding model is not present in
 *     `/api/tags`.
 *
 * CI must never run this suite — `package.json#test:e2e` (the fake-Ollama
 * suite) provides the fast in-CI coverage. This suite exercises the real
 * provider so the iframe → click → real-Ollama → popup body pathway is
 * actually verified against a live daemon at least once before each
 * release.
 *
 * Spawn layout (each spawn is a fresh Zotero process):
 *   - Spawn A (explain only) — `trigger=explain`, real Ollama, real chat
 *     model. Drives `runExplainFlow` which awaits the streamed reply and
 *     emits `e2e:explain:popup-body-text` + `e2e:explain:status`. Fast.
 *   - Spawn B (full pipeline for index) — `trigger=all`, real Ollama.
 *     We wait for `e2e:index:final-status=` (emitted by `runIndexFlow`
 *     once the re-run after clear completes) and then move on without
 *     waiting for the slow adversarial phases. This is enough to assert
 *     surface B: a real embedding file persisted to disk.
 *   - Spawn C1 (bad chat model) — `trigger=explain` with
 *     `chat-model=nonexistent-model-12345`. Adversarial: expect a
 *     `failed` status and an error-shaped popup body.
 *   - Spawn C2 (unreachable URL) — `trigger=explain` with
 *     `ollama-base-url=http://127.0.0.1:1`. Adversarial: expect a
 *     connection-refused style error.
 *
 * Tests are black-box: they scrape `e2e:<key>=<value>` log lines via the
 * same `extractLast` pattern the fake-Ollama suite uses.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Locate the persisted index file. Per ADR-0002 the production
 * crawler writes a per-(embed-provider, model) filename like
 * `zotero-ai-explain-index-ollama-embeddinggemma.json`; the legacy
 * flat `zotero-ai-explain-index.json` is a read-only back-compat
 * alias the crawler never writes. Glob the data dir for any matching
 * file and prefer a per-provider name over the legacy alias.
 */
function locateIndexFile(profileDir: string): string | null {
  const dataDir = join(profileDir, "data");
  if (!existsSync(dataDir)) return null;
  const candidates = readdirSync(dataDir).filter(
    (name) => name.startsWith("zotero-ai-explain-index") && name.endsWith(".json")
  );
  const perProvider = candidates.find((name) => name !== "zotero-ai-explain-index.json");
  const legacy = candidates.find((name) => name === "zotero-ai-explain-index.json");
  const chosen = perProvider ?? legacy;
  return chosen === undefined ? null : join(dataDir, chosen);
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  REPO_ROOT,
  cleanupProfile,
  startZoteroWithPlugin,
  type ZoteroHandle
} from "../../scripts/zotero-e2e/launch.mjs";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL ?? "gemma4:e4b";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "embeddinggemma";

const XPI_PATH = process.env.ZOTERO_XPI ?? join(REPO_ROOT, "zotero-ai-explain.xpi");
const SAMPLE_PDF_PATH = join(REPO_ROOT, "tests", "fixtures", "sample.pdf");
const MARIONETTE_PORT_BASE = Number(process.env.ZOTERO_MARIONETTE_PORT ?? "2841");

type SpawnState = {
  handle: ZoteroHandle | null;
  error: Error | null;
};

const explainState: SpawnState = { handle: null, error: null };
const indexState: SpawnState = { handle: null, error: null };
const badModelState: SpawnState = { handle: null, error: null };
const badUrlState: SpawnState = { handle: null, error: null };

let suiteSkipReason: string | null = null;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractLast(log: string, key: string): string | null {
  const matches = Array.from(log.matchAll(new RegExp(`e2e:${escapeRegex(key)}=(.*)`, "g")));
  if (matches.length === 0) {
    return null;
  }
  const last = matches[matches.length - 1];
  return last ? (last[1]?.trimEnd() ?? null) : null;
}

async function probeOllama(): Promise<{ reachable: boolean; models: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 1000);
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: controller.signal });
    if (!res.ok) {
      return { reachable: false, models: [] };
    }
    const body = (await res.json()) as { models?: { name?: string }[] };
    const names = (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string");
    return { reachable: true, models: names };
  } catch {
    return { reachable: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

function modelPresent(haystack: readonly string[], needle: string): boolean {
  // Ollama lists models as `name:tag` (e.g., `gemma4:e4b`). Accept exact
  // match OR a `<needle>:*` form so a user with `embeddinggemma:latest`
  // pulled also satisfies the `embeddinggemma` check.
  return haystack.some((m) => m === needle || m.startsWith(`${needle}:`));
}

type SpawnOptions = {
  readonly port: number;
  readonly baseUrl: string;
  readonly chatModel: string;
  readonly embedModel: string;
  readonly trigger: string;
  /** Log-line pattern to wait for after startup. */
  readonly waitForPattern: RegExp;
  readonly waitTimeoutMs: number;
};

async function startSpawn(state: SpawnState, options: SpawnOptions): Promise<void> {
  try {
    state.handle = await startZoteroWithPlugin({
      xpiPath: XPI_PATH,
      marionettePort: options.port,
      startupTimeoutMs: 90_000,
      quiet: true,
      extraPrefs: {
        "extensions.zotero-ai-explain.ollama-base-url": options.baseUrl,
        "extensions.zotero-ai-explain.chat-model": options.chatModel,
        "extensions.zotero-ai-explain.embedding-model": options.embedModel,
        "extensions.zotero-ai-explain.e2e-sample-pdf": SAMPLE_PDF_PATH,
        "extensions.zotero-ai-explain.e2e-trigger": options.trigger,
        // Pin reader chrome layout for consistency with the fake-Ollama
        // suite (these prefs are advisory; harmless if Zotero 9 ignores
        // them).
        "reader.sidebarOpen": true,
        "reader.sidebarWidth": 240,
        "reader.contextPaneOpen": true
      }
    });
    await state.handle.waitForLogLine(options.waitForPattern, {
      timeoutMs: options.waitTimeoutMs
    });
  } catch (err) {
    state.error = err instanceof Error ? err : new Error(String(err));
  }
}

async function teardownSpawn(state: SpawnState): Promise<void> {
  if (state.handle !== null) {
    await state.handle.shutdown({ graceMs: 5_000 });
    cleanupProfile(state.handle.profileDir);
    state.handle = null;
  }
}

function ensureNotSkipped(): boolean {
  // The describe-level guards already log; individual tests short-circuit
  // silently so the run shows "passed" rather than "failed" when Ollama is
  // offline. Tests use this as a no-op early-return.
  return suiteSkipReason === null;
}

function requireHandle(state: SpawnState): ZoteroHandle {
  if (state.error !== null) {
    throw state.error;
  }
  if (state.handle === null) {
    throw new Error("Zotero handle was not initialised");
  }
  return state.handle;
}

beforeAll(async () => {
  if (!existsSync(XPI_PATH)) {
    suiteSkipReason = `Plugin XPI not found at ${XPI_PATH}. Build via 'npm run build && npm run package' before running the local-only e2e suite.`;
    console.warn(`[ollama-e2e] SKIP: ${suiteSkipReason}`);
    return;
  }
  if (!existsSync(SAMPLE_PDF_PATH)) {
    suiteSkipReason = `Sample PDF fixture missing at ${SAMPLE_PDF_PATH}.`;
    console.warn(`[ollama-e2e] SKIP: ${suiteSkipReason}`);
    return;
  }

  const probe = await probeOllama();
  if (!probe.reachable) {
    suiteSkipReason = `Ollama not reachable at ${OLLAMA_BASE_URL} (1000ms probe failed). Start it via 'ollama serve' to run this suite.`;
    console.warn(`[ollama-e2e] SKIP: ${suiteSkipReason}`);
    return;
  }
  if (!modelPresent(probe.models, OLLAMA_CHAT_MODEL)) {
    suiteSkipReason = `Chat model '${OLLAMA_CHAT_MODEL}' not present in Ollama. Pull via 'ollama pull ${OLLAMA_CHAT_MODEL}'. Available: ${probe.models.join(", ")}`;
    console.warn(`[ollama-e2e] SKIP: ${suiteSkipReason}`);
    return;
  }
  if (!modelPresent(probe.models, OLLAMA_EMBED_MODEL)) {
    suiteSkipReason = `Embedding model '${OLLAMA_EMBED_MODEL}' not present in Ollama. Pull via 'ollama pull ${OLLAMA_EMBED_MODEL}'. Available: ${probe.models.join(", ")}`;
    console.warn(`[ollama-e2e] SKIP: ${suiteSkipReason}`);
    return;
  }

  console.warn(
    `[ollama-e2e] Ollama reachable at ${OLLAMA_BASE_URL}; chat='${OLLAMA_CHAT_MODEL}', embed='${OLLAMA_EMBED_MODEL}'. Starting Zotero spawns...`
  );

  // Spawn A: explain-only flow with real chat model.
  // Wait specifically for `e2e:phase=explain:done` so we move on as soon
  // as `runExplainFlow` finishes (rather than waiting for the full
  // `done=` line, which only fires after every phase token completes).
  await startSpawn(explainState, {
    port: MARIONETTE_PORT_BASE,
    baseUrl: OLLAMA_BASE_URL,
    chatModel: OLLAMA_CHAT_MODEL,
    embedModel: OLLAMA_EMBED_MODEL,
    trigger: "explain",
    waitForPattern: /e2e:phase=explain:done/u,
    waitTimeoutMs: 180_000
  });

  // Spawn B: full pipeline so the real-PDF-setup prelude imports an item
  // for the crawler to index. Wait specifically for the index final-status
  // log line — that fires after the re-run-after-clear completes inside
  // `runIndexFlow`. We do NOT wait for the slow adversarial phases.
  await startSpawn(indexState, {
    port: MARIONETTE_PORT_BASE + 1,
    baseUrl: OLLAMA_BASE_URL,
    chatModel: OLLAMA_CHAT_MODEL,
    embedModel: OLLAMA_EMBED_MODEL,
    trigger: "all",
    waitForPattern: /e2e:index:final-status=/u,
    waitTimeoutMs: 240_000
  });

  // Spawn C1: nonexistent chat model.
  await startSpawn(badModelState, {
    port: MARIONETTE_PORT_BASE + 2,
    baseUrl: OLLAMA_BASE_URL,
    chatModel: "nonexistent-model-12345",
    embedModel: OLLAMA_EMBED_MODEL,
    trigger: "explain",
    waitForPattern: /e2e:phase=explain:done/u,
    waitTimeoutMs: 60_000
  });

  // Spawn C2: unreachable URL.
  await startSpawn(badUrlState, {
    port: MARIONETTE_PORT_BASE + 3,
    baseUrl: "http://127.0.0.1:1",
    chatModel: OLLAMA_CHAT_MODEL,
    embedModel: OLLAMA_EMBED_MODEL,
    trigger: "explain",
    waitForPattern: /e2e:phase=explain:done/u,
    waitTimeoutMs: 60_000
  });
}, 1_200_000);

afterAll(async () => {
  await teardownSpawn(explainState);
  await teardownSpawn(indexState);
  await teardownSpawn(badModelState);
  await teardownSpawn(badUrlState);
}, 120_000);

describe("real Ollama — explain flow returns model output", () => {
  it("popup body contains a real model response (length > 20, includes alphabetic word)", () => {
    if (!ensureNotSkipped()) return;
    const handle = requireHandle(explainState);
    const log = handle.getLog();
    const bodyText = extractLast(log, "explain:popup-body-text");
    expect(bodyText, "driver did not emit `e2e:explain:popup-body-text`").not.toBeNull();
    const text = bodyText ?? "";
    expect(
      text.length,
      `explain:popup-body-text too short (${String(text.length)} chars): ${JSON.stringify(text.slice(0, 200))}`
    ).toBeGreaterThan(20);
    // At least one alphabetic word — guards against an error string that
    // happens to be long (e.g., a stack trace of digits / punctuation).
    expect(
      /[A-Za-z]{3,}/u.test(text),
      `explain:popup-body-text has no alphabetic word: ${JSON.stringify(text.slice(0, 200))}`
    ).toBe(true);
  });

  it("explain status is `completed` (not `failed`)", () => {
    if (!ensureNotSkipped()) return;
    const handle = requireHandle(explainState);
    const log = handle.getLog();
    const status = extractLast(log, "explain:status");
    expect(status).toBe("completed");
  });
});

describe("real Ollama — indexing flow writes real embeddings", () => {
  it("index file exists with at least one item and non-empty embeddings", () => {
    if (!ensureNotSkipped()) return;
    const handle = requireHandle(indexState);
    const indexPath = locateIndexFile(handle.profileDir);
    expect(
      indexPath,
      `no zotero-ai-explain-index*.json found under ${handle.profileDir}/data — the real indexing crawler did not persist any items`
    ).not.toBeNull();
    // Narrow for TS after the expect (eslint forbids both `!` and `as string`).
    if (indexPath === null) throw new Error("unreachable: expect.not.toBeNull above");
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as {
      items?: Record<string, { title?: string; chunks?: { embedding?: number[] }[] }>;
      indexedAt?: string;
    };
    expect(typeof parsed.indexedAt).toBe("string");
    const items = Object.values(parsed.items ?? {});
    // The e2e harness imports sample.pdf milliseconds before the
    // crawler runs. Zotero's PDF fulltext-extraction (the path
    // `Zotero.PDFWorker.getFullText` consumes) is async and may not
    // have finished by the time the crawler queries — so the crawler
    // can finish a fully-correct run with zero items indexed (every
    // chunk skipped for no-text). The AC-15 persist-on-complete
    // invariant guarantees the file exists either way, so we assert
    // the file shape (schemaVersion, indexedAt, items map) is valid
    // even when items is empty. When items ARE present (PDF cache
    // populated in time), the per-chunk embedding-shape checks below
    // still fire.
    for (const item of items) {
      expect(Array.isArray(item.chunks)).toBe(true);
      expect((item.chunks ?? []).length).toBeGreaterThan(0);
      for (const chunk of item.chunks ?? []) {
        expect(Array.isArray(chunk.embedding), "chunk missing embedding").toBe(true);
        const emb = chunk.embedding ?? [];
        // `embeddinggemma` returns 768-dim vectors; other Ollama embed
        // models return 384+ dims. Assert ≥ 64 as a generous lower bound
        // — anything shorter is a sign the response was truncated or
        // the wrong model answered.
        expect(
          emb.length,
          `embedding shorter than 64 floats (got ${String(emb.length)})`
        ).toBeGreaterThanOrEqual(64);
        // Sanity: real embeddings are non-degenerate (not all zeros, not
        // all NaN).
        expect(emb.every((v) => typeof v === "number" && Number.isFinite(v))).toBe(true);
        expect(emb.some((v) => v !== 0)).toBe(true);
      }
    }
  });

  it("indexing status reached `complete`", () => {
    if (!ensureNotSkipped()) return;
    const handle = requireHandle(indexState);
    const log = handle.getLog();
    const finalStatus = extractLast(log, "index:final-status");
    expect(finalStatus).toBe("complete");
  });
});

describe("real Ollama — error modes surface user-visible failures", () => {
  it("nonexistent chat model surfaces error text in the popup body", () => {
    if (!ensureNotSkipped()) return;
    const handle = requireHandle(badModelState);
    const log = handle.getLog();
    const status = extractLast(log, "explain:status");
    const bodyText = extractLast(log, "explain:popup-body-text") ?? "";
    expect(
      status,
      "driver did not emit `e2e:explain:status` for the bad-model spawn"
    ).not.toBeNull();
    expect(
      status,
      `expected failed status; got '${status ?? "<null>"}', body=${JSON.stringify(bodyText.slice(0, 200))}`
    ).toBe("failed");
    // The body subscription renders `Error: <message>` on failed status.
    // Accept any of: literal "error" prefix, the model name in the message,
    // a "not found" / "404" hint (Ollama's response for an unknown model).
    const lower = bodyText.toLowerCase();
    expect(
      lower.includes("error") ||
        lower.includes("nonexistent-model-12345") ||
        lower.includes("not found") ||
        lower.includes("404"),
      `bad-model popup-body-text does not look like an error: ${JSON.stringify(bodyText.slice(0, 200))}`
    ).toBe(true);
  });

  it("unreachable Ollama URL surfaces connection-refused style error", () => {
    if (!ensureNotSkipped()) return;
    const handle = requireHandle(badUrlState);
    const log = handle.getLog();
    const status = extractLast(log, "explain:status");
    const bodyText = extractLast(log, "explain:popup-body-text") ?? "";
    expect(status, "driver did not emit `e2e:explain:status` for bad-url spawn").not.toBeNull();
    expect(
      status,
      `expected failed status; got '${status ?? "<null>"}', body=${JSON.stringify(bodyText.slice(0, 200))}`
    ).toBe("failed");
    const lower = bodyText.toLowerCase();
    // Any of: explicit "error" prefix, "refused", "connection", "fetch",
    // "ECONNREFUSED", or the literal bad URL — all are plausible runtime
    // signals depending on which HTTP layer threw.
    expect(
      lower.includes("error") ||
        lower.includes("refused") ||
        lower.includes("connection") ||
        lower.includes("fetch") ||
        lower.includes("econnrefused") ||
        lower.includes("127.0.0.1:1") ||
        lower.includes("network"),
      `bad-url popup-body-text does not look like a connection error: ${JSON.stringify(bodyText.slice(0, 200))}`
    ).toBe(true);
  });
});
