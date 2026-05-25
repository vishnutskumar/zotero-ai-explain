import { createConversationStore } from "./conversation/conversation-store.js";
import { createIndexStorage, type CreateIndexStorageDeps } from "./indexing/index-storage.js";
import { createIndexingController } from "./indexing/indexing-controller.js";
import type { LibraryCrawlerDeps } from "./indexing/library-crawler.js";
import { openCitationInReader, type CitationReaderZotero } from "./platform/citation-open.js";
import { runE2eDriver } from "./platform/e2e-driver.js";
import type { SubprocessLike } from "./platform/proxy-lifecycle.js";
import { dumpZoteroTokens } from "./platform/token-dump.js";
import { wireProxyLifecycle, type WiredProxy } from "./platform/wire-proxy-lifecycle.js";
import {
  createPopupRetrievalChannel,
  createZoteroRuntime,
  type ZoteroRuntime
} from "./platform/zotero-runtime.js";
import { createZoteroUiAdapter, type ZoteroGlobal } from "./platform/zotero-ui-adapter.js";
import {
  loadOllamaSettingsFromPrefs,
  ollamaSettingsToProfile,
  type OllamaSettings,
  type StringPrefReader,
  type StringPrefWriter
} from "./preferences/ollama-profile.js";
import { markOnboardingShown, readOnboardingShown } from "./preferences/onboarding-state.js";
import {
  loadProviderProfileSettingsFromPrefs,
  providerProfileToDisclosure,
  type ProviderProfileSettings
} from "./preferences/provider-profile.js";
import { createClaudeApiProvider } from "./providers/adapters/claude-api.js";
import {
  GEMINI_EMBED_DIMENSIONS,
  createGeminiEmbedProvider
} from "./providers/adapters/gemini-embed.js";
import { createOllamaProvider } from "./providers/adapters/ollama.js";
import { createRagAugmentedProvider } from "./providers/rag-augmented-provider.js";
import { createOpenAIChatProvider } from "./providers/adapters/openai-chat.js";
import {
  OPENAI_EMBED_DIMENSIONS,
  createOpenAIEmbedProvider
} from "./providers/adapters/openai-embed.js";
import { createProviderRegistry } from "./providers/provider-registry.js";
import type {
  EmbeddingProvider,
  ModelProvider,
  ProviderProfile
} from "./providers/provider-types.js";
import {
  detectPlatform,
  probeOllamaForOnboarding,
  renderOnboardingView,
  wireOnboardingView,
  type OllamaProbeResult
} from "./ui/onboarding-view.js";
import { createPopupController } from "./ui/popup-controller.js";
import { providerDisclosure } from "./ui/privacy-label.js";
import { createSidebarController } from "./ui/sidebar-controller.js";

/**
 * Zotero's `Zotero.Prefs.get(pref, global)` interface:
 *   - if `global` is truthy, the pref is read from the global Mozilla pref
 *     tree (`extensions.zotero-ai-explain.*` lives here)
 *   - otherwise Zotero prepends `extensions.zotero.` and reads from there
 *
 * We always pass `global=true` for our own prefs. Returns `undefined` when
 * the pref does not exist; otherwise the value typed per the pref kind
 * (string / boolean / number).
 */
type ZoteroPrefs = {
  get(name: string, global?: boolean): boolean | string | number | undefined;
  /**
   * Zotero.Prefs.set(pref, value, global): writes the value to the
   * underlying Mozilla pref tree. When `global` is true the key is
   * stored as-is (our convention); otherwise Zotero prepends
   * `extensions.zotero.`. `value` may be string / number / boolean —
   * the settings UI only writes strings.
   */
  set(name: string, value: boolean | string | number, global?: boolean): void;
  /**
   * Zotero.Prefs.clear(pref, global): remove a pref entry so the next
   * `get` returns `undefined`. Used when the user blanks an override
   * and we want the next read to fall back to the bundled defaults.
   * Some Zotero builds expose this on the `Prefs` object; others on
   * `Zotero.Prefs.prefBranch.clearUserPref`. We optionally call it
   * here and fall back to writing the empty string when missing — the
   * pref reader treats both as "no override".
   */
  clear?(name: string, global?: boolean): void;
};

/**
 * Minimal subset of the chrome-platform `IOUtils` API we depend on for
 * IndexFile persistence. Zotero exposes IOUtils as a chrome global; on
 * non-chrome hosts the bootstrap falls back to a no-op IO so the
 * controller still constructs cleanly (the user simply can't persist
 * an index without a real file system).
 */
type ChromeIOUtils = {
  readonly read: (path: string) => Promise<Uint8Array>;
  readonly writeUTF8?: (path: string, contents: string) => Promise<number>;
  readonly write: (path: string, contents: Uint8Array) => Promise<number>;
  readonly remove: (
    path: string,
    options?: { ignoreAbsent?: boolean; recursive?: boolean }
  ) => Promise<void>;
  readonly exists: (path: string) => Promise<boolean>;
  // Atomic move; backs `IndexStorage`'s migration `.tmp` → primary swap.
  readonly move: (source: string, dest: string) => Promise<void>;
  // Cheap file metadata probe; backs the AC-12 index-cache fingerprint.
  // `size` is bytes; `lastModified` is epoch-ms (absent on some hosts).
  readonly stat?: (
    path: string
  ) => Promise<{ readonly size?: number; readonly lastModified?: number }>;
  // AC-23: create a directory. Optional — present on Zotero 7+ chrome.
  // The storage layer treats absence as "host without filesystem" and
  // degrades to legacy single-file mode.
  readonly makeDirectory?: (
    path: string,
    options?: { ignoreExisting?: boolean; createAncestors?: boolean }
  ) => Promise<void>;
  // AC-23: enumerate children of a directory (returns full absolute
  // paths on Zotero 7+ chrome).
  readonly getChildren?: (path: string) => Promise<readonly string[]>;
};

/**
 * Minimal subset of Zotero's library + items API consumed by the
 * library crawler.
 */
type ZoteroLibrariesAndItems = LibraryCrawlerDeps["zotero"];

type ZoteroWithPrefs = ZoteroGlobal & {
  readonly Prefs?: ZoteroPrefs;
  readonly DataDirectory?: { readonly dir: string };
  readonly Libraries?: ZoteroLibrariesAndItems["Libraries"];
  readonly Items?: ZoteroLibrariesAndItems["Items"];
  // Phase 4 (PDF fulltext): optional Zotero.FullText + Zotero.File
  // handles the crawler uses to read `.zotero-ft-cache` synchronously.
  // Absent on hosts that stripped the modules (tests, custom bundles);
  // the crawler degrades to title+abstract only.
  readonly FullText?: ZoteroLibrariesAndItems["FullText"];
  readonly File?: ZoteroLibrariesAndItems["File"];
  // Phase 4 (per-page PDF text): the chrome-side PDF.js worker bridge.
  // When present the crawler extracts per-page text via
  // `Zotero.PDFWorker.getFullText` and stamps `sourceKind: "pdf-page"` +
  // `pageIndex` on every chunk. Absent on hosts that stripped the module
  // (tests, custom bundles); the crawler then falls back to reading the
  // `.zotero-ft-cache` blob and stamps `sourceKind: "attachment"`.
  readonly PDFWorker?: ZoteroLibrariesAndItems["PDFWorker"];
};

/**
 * Bridge Zotero.Prefs.get (which returns the value typed per the pref
 * kind, or `undefined` when missing) to the narrow `StringPrefReader`
 * contract the preferences module uses for testability.
 */
function asStringPrefReader(prefs: ZoteroPrefs | undefined): StringPrefReader {
  return {
    get(name) {
      if (prefs === undefined) {
        return undefined;
      }
      try {
        const value = prefs.get(name, true);
        return typeof value === "string" ? value : undefined;
      } catch {
        return undefined;
      }
    }
  };
}

/**
 * Bridge Zotero.Prefs.set to the narrow `StringPrefWriter` contract.
 * Always passes `global: true` so the write lands in the same key the
 * reader pulls from (otherwise Zotero would prepend
 * `extensions.zotero.` and the next `loadOllamaSettingsFromPrefs` would
 * not see the value — the exact persistence-gap that triggered this fix).
 *
 * Returns a no-op writer when `prefs` is undefined so the runtime can
 * be wired up in test environments without conditionally constructing
 * a writer.
 */
/**
 * Wire Zotero.Notifier so newly-added items (or items whose
 * title/abstract changed) trigger an incremental re-index. The crawler
 * skips items already in the persisted IndexFile, so this is cheap
 * relative to a clear+full re-index — only the changed items hit the
 * embedding endpoint.
 *
 * Debounced because Zotero fires a notifier event per item; a batch
 * import (50 papers at once) would otherwise spawn 50 simultaneous
 * `start()` calls. The controller no-ops when not idle, so the
 * debounce is the cheap way to coalesce.
 *
 * E2E hermeticity (AC-8a): when the diagnostic e2e driver is active —
 * signalled by a non-empty `extensions.zotero-ai-explain.e2e-trigger`
 * pref — the auto-reindex observer is NOT registered. The driver's
 * `runIndexFlow` drives the indexing controller deterministically
 * (start → pause → resume → clear → re-index) and scrapes the
 * controller status at precise points; an auto-reindex `start()`
 * firing on its own debounce timer mid-flow would mutate the
 * controller out from under those scrapes. Production installs never
 * set `e2e-trigger`, so this gate is inert outside the e2e harness.
 */
export function attachAutoReindex(deps: {
  readonly zotero: ZoteroGlobal;
  readonly indexingController: {
    readonly start: () => void;
    readonly getStatus: () => { state: string };
  };
  readonly debounceMs: number;
  /**
   * Value of the `extensions.zotero-ai-explain.e2e-trigger` pref.
   * `undefined` (and the empty string) mean "not running under the
   * e2e driver" → the observer registers normally. Any non-empty
   * value disables auto-reindex for the session.
   */
  readonly e2eTriggerPref: string | undefined;
}): () => void {
  // Gate FIRST — before touching Zotero.Notifier — so the e2e harness
  // gets a guaranteed no-op unsubscribe and zero observer registration.
  if (deps.e2eTriggerPref !== undefined && deps.e2eTriggerPref.trim().length > 0) {
    deps.zotero.debug(
      "Zotero AI Explain: e2e-trigger pref set; auto-reindex disabled for the e2e session."
    );
    return () => undefined;
  }
  type NotifierLike = {
    registerObserver?: (
      observer: {
        notify: (event: string, type: string, ids: readonly (number | string)[]) => void;
      },
      types: readonly string[],
      id: string
    ) => string | number;
    unregisterObserver?: (id: string | number) => void;
  };
  const zoteroAny = deps.zotero as unknown as { Notifier?: NotifierLike };
  const notifier = zoteroAny.Notifier;
  if (notifier === undefined || typeof notifier.registerObserver !== "function") {
    deps.zotero.debug("Zotero AI Explain: Zotero.Notifier unavailable; auto-reindex disabled.");
    return () => undefined;
  }
  let pending: ReturnType<typeof setTimeout> | null = null;
  const scheduleReindex = (): void => {
    if (pending !== null) {
      clearTimeout(pending);
    }
    pending = setTimeout(() => {
      pending = null;
      const status = deps.indexingController.getStatus();
      // Restart from `idle`, `complete`, or `failed`. `running` and
      // `paused` are still skipped — the in-flight run will pick up
      // any items it hasn't seen yet on its current sweep.
      if (status.state === "running" || status.state === "paused") {
        deps.zotero.debug(
          `Zotero AI Explain: auto-reindex deferred — controller state=${status.state}`
        );
        return;
      }
      deps.zotero.debug("Zotero AI Explain: auto-reindex starting (new/modified items detected)");
      deps.indexingController.start();
    }, deps.debounceMs);
  };
  const observerId = notifier.registerObserver(
    {
      notify(event, _type, ids) {
        // Trigger on add OR modify (a re-titled paper needs a re-embed).
        // Notifier fires `delete` too but those are handled by clear/skip.
        if ((event === "add" || event === "modify") && ids.length > 0) {
          scheduleReindex();
        }
      }
    },
    ["item"],
    "zotero-ai-explain-auto-reindex"
  );
  return () => {
    if (pending !== null) {
      clearTimeout(pending);
      pending = null;
    }
    if (typeof notifier.unregisterObserver === "function") {
      try {
        notifier.unregisterObserver(observerId);
      } catch (err) {
        deps.zotero.debug(
          `Zotero AI Explain: unregisterObserver failed ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  };
}

function asStringPrefWriter(prefs: ZoteroPrefs | undefined): StringPrefWriter {
  return {
    set(name, value) {
      if (prefs === undefined) {
        return;
      }
      prefs.set(name, value, true);
    },
    clear(name) {
      if (prefs === undefined) {
        return;
      }
      if (typeof prefs.clear === "function") {
        prefs.clear(name, true);
        return;
      }
      // Fallback: writing an empty string is treated as "missing" by
      // `loadOllamaSettingsFromPrefs` (see `readNonEmpty`), so the user's
      // next read sees the bundled default.
      prefs.set(name, "", true);
    }
  };
}

/**
 * `openCitationInReader` + the `ResolvedCitation` / `CitationReaderZotero`
 * types live in `./platform/citation-open.js`. They are re-exported here
 * for back-compat with any caller still importing them from the bootstrap
 * entrypoint; new code should import from the platform module directly.
 */
export { openCitationInReader } from "./platform/citation-open.js";
export type { ResolvedCitation, CitationReaderZotero } from "./platform/citation-open.js";

export type ZoteroBootstrapContext = {
  readonly pluginId: string;
  readonly Zotero: ZoteroGlobal;
  readonly reason: number;
  /**
   * Plugin install root URI from Zotero's bootstrap `data.rootURI`.
   * Optional because non-chrome hosts (tests, custom embed) do not
   * provide it. When present the proxy lifecycle resolves the bundled
   * `llm-proxy/server.mjs` script relative to it; when absent we fall
   * back to a developer-checkout default so a local dev build still
   * works.
   */
  readonly rootURI?: string;
};

let runtime: ZoteroRuntime | null = null;
/**
 * Active proxy lifecycle handle, captured in startup() and torn down in
 * shutdown() BEFORE the runtime so the child process gets a clean
 * SIGTERM rather than being orphaned. Null when:
 *   - the plugin hasn't started yet,
 *   - the Subprocess.sys.mjs import failed (rare; non-chrome hosts),
 *   - the plugin has already shut down.
 */
let proxyWired: WiredProxy | null = null;
let detachAutoReindex: (() => void) | null = null;

function describeDisclosureFor(readProviderProfile: () => ProviderProfileSettings): () => string {
  return () => providerDisclosure(providerProfileToDisclosure(readProviderProfile()));
}

function maybeDumpTokens(zotero: ZoteroWithPrefs): void {
  let enabled = false;
  try {
    enabled = zotero.Prefs?.get("extensions.zotero-ai-explain.dump-tokens", true) === true;
    // The `true` above is the `global` flag for Zotero.Prefs.get — it asks
    // the API to read from the global Mozilla pref tree rather than
    // prepending `extensions.zotero.`. Our pref lives in the global tree.
  } catch {
    enabled = false;
  }
  if (!enabled) {
    return;
  }
  try {
    const mainWindow = zotero.getMainWindow?.();
    if (!mainWindow) {
      zotero.debug("Zotero AI Explain dump-tokens: no main window");
      return;
    }
    const dump = dumpZoteroTokens(mainWindow);
    zotero.debug(`Zotero AI Explain token dump: ${JSON.stringify(dump)}`);
  } catch (err) {
    zotero.debug(
      `Zotero AI Explain dump-tokens failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function loadOllamaSettings(zotero: ZoteroWithPrefs): OllamaSettings {
  return loadOllamaSettingsFromPrefs(asStringPrefReader(zotero.Prefs));
}

/**
 * Build an IndexStorage IO adapter backed by chrome's `IOUtils`. When
 * `IOUtils` is not available (e.g., a test harness or a stripped-down
 * host) the adapter degrades to safe no-ops: read/write/remove resolve
 * normally and `exists` reports false, so `IndexStorage.read()` returns
 * `null` and the controller proceeds as if no persisted file existed.
 */
function buildIndexStorageIo(zotero: ZoteroGlobal): CreateIndexStorageDeps["io"] {
  const utils = (globalThis as { IOUtils?: ChromeIOUtils }).IOUtils;
  if (utils === undefined) {
    zotero.debug(
      "Zotero AI Explain: IOUtils not available in this scope; IndexStorage will operate as a no-op."
    );
    return {
      // eslint-disable-next-line @typescript-eslint/require-await
      async readString() {
        throw new Error("IOUtils not available");
      },
      async writeString() {
        // Swallow — the caller's error path will surface a debug log
        // via the controller's `clear-storage-error` branch.
      },
      async remove() {
        // Swallow.
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async exists() {
        return false;
      },
      async rename() {
        // Swallow — no real filesystem to move within.
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async stat() {
        // AC-12: the no-op fallback returns the "unstattable" sentinel
        // so the index cache degrades to never-cache (never stale).
        return null;
      },
      // AC-23: no-op directory primitives so the storage layer falls
      // back to its legacy single-file path on hosts without IOUtils.
      async makeDirectory() {
        // Swallow.
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async listChildren() {
        return null;
      },
      async removeDirectory() {
        // Swallow.
      }
    };
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  return {
    async readString(path) {
      const bytes = await utils.read(path);
      return decoder.decode(bytes);
    },
    async writeString(path, contents) {
      if (typeof utils.writeUTF8 === "function") {
        await utils.writeUTF8(path, contents);
        return;
      }
      await utils.write(path, encoder.encode(contents));
    },
    async remove(path) {
      await utils.remove(path, { ignoreAbsent: true });
    },
    exists(path) {
      return utils.exists(path);
    },
    async rename(source, dest) {
      // `IOUtils.move` is an atomic same-volume rename — the AC-5
      // migration commit relies on this atomicity for crash safety.
      await utils.move(source, dest);
    },
    async stat(path) {
      // AC-12: cheap stat for the index-cache fingerprint. Resolves
      // `null` when the file is absent OR the host's `IOUtils` lacks
      // `stat` — either way the cache degrades to never-cache rather
      // than risking a stale read.
      if (typeof utils.stat !== "function") {
        return null;
      }
      try {
        const info = await utils.stat(path);
        return {
          size: typeof info.size === "number" ? info.size : 0,
          ...(typeof info.lastModified === "number" ? { lastModified: info.lastModified } : {})
        };
      } catch {
        // ENOENT (or any stat failure) → treat as absent.
        return null;
      }
    },
    // AC-23: per-item directory primitives. Optional on the storage type
    // — when the host's `IOUtils` lacks the method we surface the
    // absence so the storage layer can fall back to the legacy
    // single-file path.
    ...((): {
      readonly makeDirectory?: (path: string) => Promise<void>;
    } => {
      const makeDir = utils.makeDirectory;
      if (typeof makeDir !== "function") return {};
      return {
        async makeDirectory(path: string): Promise<void> {
          try {
            await makeDir(path, { ignoreExisting: true, createAncestors: true });
          } catch {
            // Idempotent: an existing-dir race is a no-op.
          }
        }
      };
    })(),
    ...((): {
      readonly listChildren?: (path: string) => Promise<readonly string[] | null>;
    } => {
      const getChildren = utils.getChildren;
      if (typeof getChildren !== "function") return {};
      return {
        async listChildren(path: string): Promise<readonly string[] | null> {
          try {
            const children = await getChildren(path);
            // `IOUtils.getChildren` returns absolute paths — strip the
            // directory prefix so the storage layer sees bare file names.
            return children.map((p) => {
              const slash = p.lastIndexOf("/");
              const back = p.lastIndexOf("\\");
              const cut = Math.max(slash, back);
              return cut >= 0 ? p.substring(cut + 1) : p;
            });
          } catch {
            // ENOENT — the directory does not exist yet.
            return null;
          }
        }
      };
    })(),
    async removeDirectory(path: string): Promise<void> {
      try {
        await utils.remove(path, { ignoreAbsent: true, recursive: true });
      } catch {
        // The per-file fallback in `IndexStorage.clear()` will handle
        // whatever survives.
      }
    }
  };
}

/**
 * Resolve the Zotero library + items handle the crawler needs. We fall
 * back to a "no items" stub if the chrome host does not expose
 * `Zotero.Libraries` / `Zotero.Items` (defensive; in production both
 * are always present once Zotero.initializationPromise resolves).
 */
function resolveZoteroLibraries(zotero: ZoteroWithPrefs): ZoteroLibrariesAndItems {
  if (zotero.Libraries !== undefined && zotero.Items !== undefined) {
    return {
      Libraries: zotero.Libraries,
      Items: zotero.Items,
      // Phase 4: thread Zotero.FullText + Zotero.File through to the
      // crawler so it can read cached PDF/EPUB fulltext for both
      // standalone attachments and child attachments of bibliographic
      // items. Both fields are optional — when absent the crawler still
      // indexes title+abstract.
      ...(zotero.FullText !== undefined ? { FullText: zotero.FullText } : {}),
      ...(zotero.File !== undefined ? { File: zotero.File } : {}),
      // Phase 4 (FINDING-1): thread Zotero.PDFWorker through so the
      // PRODUCTION crawler takes the per-page PDF extraction path —
      // emitting `sourceKind: "pdf-page"` chunks with `pageIndex` —
      // instead of falling back to the `.zotero-ft-cache` blob (which
      // stamps `sourceKind: "attachment"` and carries no page). Optional:
      // a host that stripped `Zotero.PDFWorker` (tests, custom bundles)
      // degrades to the cache-blob path with no crash.
      ...(zotero.PDFWorker !== undefined ? { PDFWorker: zotero.PDFWorker } : {})
    };
  }
  zotero.debug(
    "Zotero AI Explain: Zotero.Libraries or Zotero.Items missing; indexing controller will operate against an empty library."
  );
  return {
    Libraries: { userLibraryID: 1 },
    Items: {
      // eslint-disable-next-line @typescript-eslint/require-await
      getAll: async () => [],
      get: () => null
    }
  };
}

/**
 * Pull the Zotero data-directory path. Falls back to `.` when missing
 * (the IndexStorage path becomes `./zotero-ai-explain-index.json`); on
 * a host without IOUtils the file never actually lands on disk anyway.
 */
function resolveDataDirectory(zotero: ZoteroWithPrefs): { readonly dir: string } {
  if (zotero.DataDirectory !== undefined && typeof zotero.DataDirectory.dir === "string") {
    return zotero.DataDirectory;
  }
  zotero.debug(
    "Zotero AI Explain: Zotero.DataDirectory.dir missing; IndexStorage will fall back to cwd."
  );
  return { dir: "." };
}

/**
 * Chrome-side shape we need from the running Zotero instance to surface
 * the onboarding dialog. `launchURL` exists on every Zotero 7+ build
 * (`Zotero.launchURL` opens the URL in the user's default browser,
 * NOT inside the Zotero chrome window). `getMainWindow()` is required
 * for clipboard access via the chrome window's `navigator.clipboard`
 * (the bundle scope's `navigator` does not exist).
 */
type ZoteroWithLaunch = ZoteroWithPrefs & {
  readonly launchURL?: (url: string) => void;
  readonly platformVersion?: string;
  readonly oscpu?: string;
};

/**
 * Probe Ollama once on startup and, when the result indicates a
 * deficiency the user can fix, present the first-run onboarding
 * dialog. Returns immediately if:
 *   1. The `onboarding-shown` pref is already "true" (user dismissed),
 *      OR
 *   2. The probe returns `ready` (nothing to do).
 *
 * The probe uses a 1500ms timeout so a stalled startup doesn't keep
 * the user waiting indefinitely. We deliberately swallow probe errors
 * — a probe failure is treated as "ollama-missing", which is the
 * correct UI state. The dialog itself runs in the background; failing
 * to mount it (no main window) is logged via `Zotero.debug` and the
 * pref is left untouched so a subsequent launch can retry.
 */
async function maybeRunOnboarding(deps: {
  readonly zotero: ZoteroWithPrefs;
  readonly runtime: ZoteroRuntime;
  readonly settings: OllamaSettings;
  readonly boundFetch: typeof fetch | undefined;
  readonly prefs: StringPrefReader;
  readonly prefsWriter: StringPrefWriter;
}): Promise<void> {
  const { zotero, runtime, settings, boundFetch, prefs, prefsWriter } = deps;
  if (readOnboardingShown(prefs)) {
    return;
  }
  if (typeof boundFetch !== "function") {
    zotero.debug("Zotero AI Explain onboarding: fetch unavailable; skipping probe.");
    return;
  }
  let result: OllamaProbeResult;
  try {
    result = await probeOllamaForOnboarding({
      baseUrl: settings.baseUrl,
      chatModel: settings.chatModel,
      embeddingModel: settings.embeddingModel,
      fetch: boundFetch
    });
  } catch (err) {
    zotero.debug(
      `Zotero AI Explain onboarding: probe threw ${err instanceof Error ? err.message : String(err)}; treating as ollama-missing`
    );
    result = { state: "ollama-missing", reason: "probe-threw" };
  }
  if (result.state === "ready") {
    // Nothing to onboard. Mark shown so a future broken state doesn't
    // re-trigger the dialog on a host where the user has already had
    // a successful run.
    markOnboardingShown(prefsWriter);
    return;
  }
  const launch = deps.zotero as ZoteroWithLaunch;
  const hostServices = (globalThis as unknown as { Services?: { appinfo?: { OS?: string } } })
    .Services;
  const platform = detectPlatform({
    Zotero: {
      ...(launch.platformVersion !== undefined ? { platformVersion: launch.platformVersion } : {}),
      ...(launch.oscpu !== undefined ? { oscpu: launch.oscpu } : {})
    },
    ...(hostServices !== undefined ? { Services: hostServices } : {})
  });

  const view = renderOnboardingView({
    state: result.state,
    platform,
    chatModel: settings.chatModel,
    embeddingModel: settings.embeddingModel,
    ...(result.state === "models-missing" ? { missingModels: result.missing } : {})
  });

  // openDialog returns a handle whose `.close()` is idempotent. We mark
  // the pref BEFORE invoking close so a buggy adapter that calls close
  // twice still only writes the pref once (the writer is also
  // idempotent, but tightening the order makes the contract crisp).
  const dialogWindow = zotero.getMainWindow?.();
  if (dialogWindow === undefined) {
    zotero.debug("Zotero AI Explain onboarding: no main window; skipping dialog mount.");
    return;
  }

  // Mount the dialog via the runtime's ui adapter. We don't have direct
  // access to the adapter here, but the `openDialog` helper lives on
  // the runtime's UI surface — we re-create one via the same Zotero
  // global. To avoid duplicating that wiring, we ask the runtime to
  // surface a hook (added in this phase): `runtime.openSettings()` for
  // the "Open Settings" affordance, and `createZoteroUiAdapter` for
  // mounting the onboarding dialog directly. The simplest path: build
  // a one-off ui adapter from the same Zotero global the runtime
  // already uses.
  const { createZoteroUiAdapter } = await import("./platform/zotero-ui-adapter.js");
  const ui = createZoteroUiAdapter({
    Zotero: zotero,
    pluginId: "zotero-ai-explain-onboarding"
  });
  const handle = ui.openDialog("Set up Ollama", view);
  const close = (): void => {
    handle.close();
    markOnboardingShown(prefsWriter);
  };
  const mainWin = zotero.getMainWindow?.();
  const navClipboard = (
    mainWin as unknown as
      | { navigator?: { clipboard?: { writeText(text: string): Promise<void> } } }
      | undefined
  )?.navigator?.clipboard;
  wireOnboardingView({
    view,
    effects: {
      copyToClipboard: async (text) => {
        if (navClipboard === undefined) {
          zotero.debug("Zotero AI Explain onboarding: navigator.clipboard unavailable");
          return;
        }
        try {
          await navClipboard.writeText(text);
        } catch (err) {
          zotero.debug(
            `Zotero AI Explain onboarding: clipboard write failed ${err instanceof Error ? err.message : String(err)}`
          );
        }
      },
      launchUrl: (url) => {
        try {
          launch.launchURL?.(url);
        } catch (err) {
          zotero.debug(
            `Zotero AI Explain onboarding: launchURL failed ${err instanceof Error ? err.message : String(err)}`
          );
        }
      },
      recheck: async () => {
        if (typeof boundFetch !== "function") {
          return { state: "ollama-missing", reason: "no-fetch" };
        }
        try {
          return await probeOllamaForOnboarding({
            baseUrl: settings.baseUrl,
            chatModel: settings.chatModel,
            embeddingModel: settings.embeddingModel,
            fetch: boundFetch
          });
        } catch (err) {
          return {
            state: "ollama-missing",
            reason: err instanceof Error ? err.message : String(err)
          };
        }
      },
      close,
      openSettings: () => {
        close();
        runtime.openSettings();
      }
    }
  });
}

/**
 * Build a production `SubprocessLike` adapter around chrome's
 * `Subprocess.sys.mjs` ESM module. Returns null when the import fails
 * (non-chrome hosts; tests). The adapter is a one-line passthrough —
 * chrome's `Subprocess.call(...)` already returns an object with `pid`,
 * `wait()`, and `kill(signal?)` so we can hand it back unmodified, but
 * we go through an explicit wrap so the returned shape matches the
 * narrow `SubprocessHandle` contract exactly (chrome's real shape has
 * additional fields we don't use).
 */
function createSubprocessAdapter(zotero: ZoteroGlobal): SubprocessLike | null {
  type ChromeSubprocessModule = {
    readonly Subprocess: {
      call(spec: {
        readonly command: string;
        readonly arguments: readonly string[];
        readonly environment?: Readonly<Record<string, string>>;
        readonly environmentAppend?: boolean;
        readonly stderr?: "pipe" | "ignore" | "stdout";
      }): Promise<{
        readonly pid: number;
        wait(): Promise<{ readonly exitCode: number | null }>;
        kill(signal?: string): void;
      }>;
    };
  };
  const chromeUtils = (
    globalThis as unknown as {
      readonly ChromeUtils?: {
        importESModule(spec: string): ChromeSubprocessModule;
      };
    }
  ).ChromeUtils;
  if (chromeUtils === undefined) {
    zotero.debug("Zotero AI Explain: ChromeUtils unavailable; proxy lifecycle disabled.");
    return null;
  }
  let Subprocess: ChromeSubprocessModule["Subprocess"];
  try {
    const mod = chromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    Subprocess = mod.Subprocess;
  } catch (err) {
    zotero.debug(
      `Zotero AI Explain: Subprocess.sys.mjs import failed; proxy disabled: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
  return {
    async call(args) {
      const proc = await Subprocess.call({
        command: args.command,
        arguments: args.arguments,
        ...(args.environment !== undefined ? { environment: args.environment } : {}),
        ...(args.environmentAppend !== undefined
          ? { environmentAppend: args.environmentAppend }
          : {}),
        stderr: args.stderr ?? "pipe"
      });
      return {
        pid: proc.pid,
        wait: () => proc.wait(),
        kill: (sig?: string) => {
          proc.kill(sig);
        }
      };
    }
  };
}

/**
 * Convert a Zotero plugin install URL into an absolute filesystem
 * path for the bundled `llm-proxy/server.mjs`.
 *
 * `data.rootURI` typically looks like `file:///.../plugin-uuid/` for an
 * unpacked extension; for a packed XPI it's `jar:file:///.../foo.xpi!/`
 * (we don't handle that path because Subprocess can't execute scripts
 * from inside a jar). Returns a developer-checkout fallback if
 * `rootURI` is undefined or malformed so a local dev build still works.
 */
function resolveBundledServerScriptPath(rootURI: string | undefined): string {
  // Dev fallback: empty string. Production always has `rootURI` from
  // Zotero's bootstrap data. When `rootURI` is missing (a stripped
  // chrome host), downstream `subprocess.call` fails with a clear
  // empty-path error rather than silently spawning the wrong file.
  const FALLBACK = "";
  if (rootURI === undefined || rootURI.length === 0) {
    return FALLBACK;
  }
  // Strip the `file://` prefix and percent-decode. `jar:` URLs are not
  // supported (Subprocess can't reach files inside an unzipped jar), so
  // we drop back to the dev fallback if we see one.
  if (rootURI.startsWith("jar:")) {
    return FALLBACK;
  }
  let trimmed = rootURI;
  if (trimmed.startsWith("file://")) {
    trimmed = trimmed.substring("file://".length);
  }
  // rootURI usually ends with `/`; ensure we don't end up with `//`.
  if (!trimmed.endsWith("/")) {
    trimmed = `${trimmed}/`;
  }
  try {
    trimmed = decodeURI(trimmed);
  } catch {
    // Fall through with the raw value.
  }
  return `${trimmed}llm-proxy/server.mjs`;
}

/**
 * Sync file-exists check used by `wireProxyLifecycle` to auto-detect the
 * Node binary. Wraps `nsIFile.initWithPath(...).exists()` which is the
 * only sync path-exists in chrome. Returns false on any error so the
 * detector falls through to the next candidate (`detectNodeBinary` in
 * `wire-proxy-lifecycle.ts`).
 */
/**
 * Resolve the current user's home directory via Mozilla's directory
 * service (`Services.dirsvc.get("Home", ...)`). Returns `undefined` on
 * any failure so the detector skips home-relative shim paths instead
 * of crashing — production should always succeed, but tests and
 * stripped builds may not have a directory service.
 */
function readChromeHomeDir(zotero: ZoteroGlobal): string | undefined {
  type ServicesLike = {
    readonly dirsvc: {
      get(key: string, iface: unknown): { readonly path: string };
    };
  };
  type ComponentsLike = {
    readonly interfaces: Record<string, unknown>;
  };
  const services = (globalThis as unknown as { readonly Services?: ServicesLike }).Services;
  const components = (globalThis as unknown as { readonly Components?: ComponentsLike }).Components;
  if (services === undefined || components === undefined) return undefined;
  try {
    const file = services.dirsvc.get("Home", components.interfaces.nsIFile);
    const path = file.path.trim();
    return path.length > 0 ? path : undefined;
  } catch (err) {
    zotero.debug(
      `Zotero AI Explain: readChromeHomeDir failed ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

function makeChromePathExists(zotero: ZoteroGlobal): (path: string) => boolean {
  type FileFactory = {
    createInstance(iface: unknown): {
      initWithPath(p: string): void;
      exists(): boolean;
    };
  };
  type ComponentsLike = {
    readonly classes: Record<string, FileFactory>;
    readonly interfaces: Record<string, unknown>;
  };
  const components = (globalThis as unknown as { readonly Components?: ComponentsLike }).Components;
  if (components === undefined) {
    return () => false;
  }
  return (path: string): boolean => {
    try {
      const factory = components.classes["@mozilla.org/file/local;1"];
      if (factory === undefined) return false;
      const nsIFile = components.interfaces.nsIFile;
      const file = factory.createInstance(nsIFile);
      file.initWithPath(path);
      return file.exists();
    } catch (err) {
      zotero.debug(
        `Zotero AI Explain: pathExists(${path}) failed ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  };
}

/**
 * Build the chat provider based on the active settings. The returned
 * ModelProvider drives the popup + sidebar streamChat path. For
 * URL-based providers (Ollama / proxy-routed CLI providers) we reuse
 * `createOllamaProvider` because the proxy uses Ollama's wire format
 * for forwarding; for direct-API providers we build the OpenAI / Claude
 * adapters with a getApiKey closure that reads the latest pref each
 * call (so a save-then-chat flow uses the new key without a restart).
 */
function buildChatProvider(deps: {
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly providerProfile: ProviderProfileSettings;
  readonly readProviderProfile: () => ProviderProfileSettings;
  readonly ollamaProvider: ReturnType<typeof createOllamaProvider>;
}): ModelProvider {
  const { fetch: fetchFn, providerProfile, readProviderProfile, ollamaProvider } = deps;
  switch (providerProfile.chatProvider) {
    case "ollama":
    case "codex-cli":
    case "claude-cli":
      // The proxy speaks Ollama's wire format so the CLI providers
      // route through the same adapter; the user's `chatBaseUrl` field
      // points at the proxy when needed.
      return ollamaProvider;
    case "codex-api":
      return createOpenAIChatProvider({
        fetch: fetchFn,
        getApiKey: () => {
          const latest = readProviderProfile();
          return latest.openaiApiKey.length > 0 ? latest.openaiApiKey : null;
        }
      });
    case "claude-api":
      return createClaudeApiProvider({
        fetch: fetchFn,
        getApiKey: () => {
          const latest = readProviderProfile();
          return latest.anthropicApiKey.length > 0 ? latest.anthropicApiKey : null;
        }
      });
  }
}

/**
 * Build the embedding provider. Mirrors `buildChatProvider`: Ollama
 * routes through the existing local adapter; OpenAI/Gemini build
 * direct-API adapters with expectedDimensions cross-checks so a typo
 * in the model name surfaces as a dim-mismatch error instead of
 * silently corrupting the index.
 */
function buildEmbeddingProvider(deps: {
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly providerProfile: ProviderProfileSettings;
  readonly readProviderProfile: () => ProviderProfileSettings;
  readonly ollamaProvider: ReturnType<typeof createOllamaProvider>;
}): EmbeddingProvider {
  const { fetch: fetchFn, providerProfile, readProviderProfile, ollamaProvider } = deps;
  switch (providerProfile.embedProvider) {
    case "ollama":
      return ollamaProvider;
    case "openai": {
      const expected = OPENAI_EMBED_DIMENSIONS[providerProfile.ollama.embeddingModel];
      const baseDeps = {
        fetch: fetchFn,
        getApiKey: (): string | null => {
          const latest = readProviderProfile();
          return latest.openaiApiKey.length > 0 ? latest.openaiApiKey : null;
        }
      };
      return createOpenAIEmbedProvider(
        expected !== undefined ? { ...baseDeps, expectedDimensions: expected } : baseDeps
      );
    }
    case "gemini": {
      const expected = GEMINI_EMBED_DIMENSIONS[providerProfile.ollama.embeddingModel];
      const baseDeps = {
        fetch: fetchFn,
        getApiKey: (): string | null => {
          const latest = readProviderProfile();
          return latest.geminiApiKey.length > 0 ? latest.geminiApiKey : null;
        }
      };
      return createGeminiEmbedProvider(
        expected !== undefined ? { ...baseDeps, expectedDimensions: expected } : baseDeps
      );
    }
  }
}

export async function startup(context: ZoteroBootstrapContext): Promise<void> {
  context.Zotero.debug("Zotero AI Explain startup");
  const zotero = context.Zotero as ZoteroWithPrefs;
  maybeDumpTokens(zotero);

  const settings = loadOllamaSettings(zotero);
  // AC-8b: log the SPLIT chat/embed URLs (the fields the provider and
  // indexing controller actually consume) rather than only the legacy
  // single `baseUrl`. `chatBaseUrl` falls through to the legacy
  // `ollama-base-url` pref when no modern `chat-base-url` is set
  // (`ollama-profile.ts:105`), so a legacy install still surfaces a
  // meaningful chat URL here. `baseUrl` stays in the line as the
  // legacy mirror for back-reference.
  context.Zotero.debug(
    `Zotero AI Explain ollama config: chatBaseUrl=${settings.chatBaseUrl} ` +
      `embedBaseUrl=${settings.embedBaseUrl} (legacy baseUrl=${settings.baseUrl})`
  );
  // Live profile read (fix codex review #5): the popup explain path
  // and library-chat path both invoke this to get the URL/model active
  // RIGHT NOW. Previously a startup snapshot was bound in and never
  // refreshed, so a preset change after launch left the request hitting
  // the old endpoint even after the disclosure was fixed (Bug A1/A2).
  // Cross-family swaps (ollama ↔ claude-api) still need a restart
  // because the chat adapter is built once at startup.
  const getProfile = (): ProviderProfile => ollamaSettingsToProfile(loadOllamaSettings(zotero));
  const store = createConversationStore();

  // Phase 4 direct-API: load provider-profile settings (chat backend,
  // embed backend, API keys). The reader function below is captured
  // by the adapter closures so a user-saved API key takes effect on the
  // very next request without requiring a Zotero restart.
  const prefReader = asStringPrefReader(zotero.Prefs);
  const readProviderProfile = (): ProviderProfileSettings =>
    loadProviderProfileSettingsFromPrefs(prefReader);
  const providerProfile = readProviderProfile();
  context.Zotero.debug(
    `Zotero AI Explain provider config: chat=${providerProfile.chatProvider} embed=${providerProfile.embedProvider}`
  );

  // The bundle runs inside a loadSubScript scope where `fetch` is exposed
  // explicitly by `addon/bootstrap.js` (via Cu.importGlobalProperties). If
  // a host doesn't expose it, the explain flow can't reach Ollama; we log
  // a loud error so the e2e log surfaces the regression instead of failing
  // silently inside the provider.
  const fetchFn = globalThis.fetch as typeof fetch | undefined;
  if (typeof fetchFn !== "function") {
    context.Zotero.debug(
      "Zotero AI Explain: globalThis.fetch is not a function; explain flow will fail. " +
        "Ensure addon/bootstrap.js imports the fetch global into the bundle scope."
    );
  }
  const boundFetch = typeof fetchFn === "function" ? fetchFn.bind(globalThis) : globalThis.fetch;

  // Build the proxy auth-header closure BEFORE the ollama adapter so
  // both can capture it. The closure must be lazy because
  // `proxyWired` is assigned later (the subprocess adapter is built
  // a few hundred lines down once the runtime context is ready); it
  // also stays null on non-chrome hosts where the proxy was never
  // wired. The accessor returns undefined on either of those branches
  // — exactly the "no auth header" case the adapter's spread relies
  // on.
  const getProxyAuthHeader = (requestBaseUrl: string): Record<string, string> | undefined => {
    const wired = proxyWired;
    if (wired === null) return undefined;
    const token = wired.getProxyAuthToken();
    if (token === null) return undefined;
    // Match against the proxy's currently-configured port. The
    // settings dialog can rebind the port at runtime via
    // applyValues(), and `snapshot().port` is the single source of
    // truth that follows those edits.
    const proxyPort = wired.snapshot().port;
    const proxyPrefix = `http://127.0.0.1:${String(proxyPort)}`;
    if (!requestBaseUrl.startsWith(proxyPrefix)) return undefined;
    return { Authorization: `Bearer ${token}` };
  };
  const ollamaProvider = createOllamaProvider({
    fetch: boundFetch,
    getProxyAuthHeader
  });
  const registry = createProviderRegistry([ollamaProvider]);
  // Resolve the prior single-chat-provider for the popup / sidebar
  // entry points. Direct-API providers replace `provider` with the
  // OpenAI/Claude adapter; URL-based providers continue to use the
  // ollama adapter (which is what the proxy expects on the wire).
  const fetchForAdapters = boundFetch as unknown as (
    input: string,
    init: RequestInit
  ) => Promise<Response>;
  const provider = buildChatProvider({
    fetch: fetchForAdapters,
    providerProfile,
    readProviderProfile,
    ollamaProvider
  });
  // Keep the registry around so it can still resolve a profile lookup;
  // not all call-sites use the registry yet but it stays so future
  // callers don't need to re-build the wiring.
  void registry;

  // AC4: wire the IndexingController to the real library crawler. The
  // controller owns its own AbortController + in-flight task; here we
  // hand it everything the crawler needs (zotero items API, embedding
  // provider, IndexStorage, settings) so the start/pause/resume/clear
  // buttons in the settings panel drive a real index.
  //
  // Phase 4: index storage is now per-(provider, model) so a user
  // switching from Ollama to OpenAI doesn't blend incompatible
  // dimensions into a single corrupt file.
  const indexStorageIo = buildIndexStorageIo(context.Zotero);
  const indexStorageDataDir = resolveDataDirectory(zotero);
  const indexEmbedProvider = {
    kind: providerProfile.embedProvider,
    model: settings.embeddingModel
  };
  const indexStorage = createIndexStorage({
    zotero: { DataDirectory: indexStorageDataDir },
    io: indexStorageIo,
    embedProvider: indexEmbedProvider
  });
  const embeddingProvider = buildEmbeddingProvider({
    fetch: fetchForAdapters,
    providerProfile,
    readProviderProfile,
    ollamaProvider
  });
  const crawlerZotero = resolveZoteroLibraries(zotero);
  // Crawler hits the EMBEDDING endpoint (Ollama `/api/embeddings`), so
  // it must use `embedBaseUrl`. After the split-URL change, `baseUrl`
  // semantically mirrors `chatBaseUrl` and would route embed traffic
  // through the chat proxy — wrong destination, slow at best, broken
  // at worst. For direct-API providers the `baseUrl` field is ignored
  // by the adapter (we hard-code the canonical host).
  const crawlerSettings = {
    baseUrl: settings.embedBaseUrl,
    embeddingModel: settings.embeddingModel
  };
  const indexingController = createIndexingController({
    logger: context.Zotero,
    zotero: crawlerZotero,
    provider: embeddingProvider,
    settings: crawlerSettings,
    storage: indexStorage
  });
  // Seed `previouslyIndexed` before the settings dialog opens.
  void indexingController.hydrate();
  const ui = createZoteroUiAdapter({ Zotero: context.Zotero, pluginId: context.pluginId });
  // Wrap the chat provider with library RAG so popup + sidebar explain
  // requests carry retrieval context — especially valuable for local
  // models (Ollama) that can't reach the internet. Augmentation is
  // best-effort: missing/empty index, embedding failures, or dim-mismatch
  // all fall through to the unwrapped provider so the popup never blocks
  // on retrieval problems.
  // Pub/sub channel for retrieved chunks. The rag provider publishes
  // here on each request; the runtime's popup/sidebar conversations
  // subscribe to populate per-conversation citation lookups for
  // linkifying `[itemKey#chunkIndex]` tokens in assistant text.
  const popupRetrievalChannel = createPopupRetrievalChannel();
  const ragProvider = createRagAugmentedProvider({
    inner: provider,
    embeddingProvider,
    indexStorage,
    embedSettings: { baseUrl: settings.embedBaseUrl, model: settings.embeddingModel },
    debug: (msg) => {
      context.Zotero.debug(`Zotero AI Explain: ${msg}`);
    },
    onRetrieved: (chunks) => {
      popupRetrievalChannel.publish(chunks);
    }
  });
  const popupController = createPopupController({ store, provider: ragProvider });
  const sidebarController = createSidebarController({ store, provider: ragProvider });

  // Wire the local llm-proxy lifecycle BEFORE the runtime so the
  // settings dialog can surface Start/Stop affordances on first open.
  // The Subprocess.sys.mjs import fails on non-chrome hosts (tests,
  // stripped builds); when it does, we skip the proxy wiring entirely
  // and the settings dialog renders without the proxy section.
  const subprocessAdapter = createSubprocessAdapter(context.Zotero);
  if (subprocessAdapter !== null) {
    const prefReader = asStringPrefReader(zotero.Prefs);
    const prefWriter = asStringPrefWriter(zotero.Prefs);
    const proxyFetch = boundFetch as unknown as Parameters<typeof wireProxyLifecycle>[0]["fetch"];
    const detectedHomeDir = readChromeHomeDir(context.Zotero);
    proxyWired = wireProxyLifecycle({
      subprocess: subprocessAdapter,
      prefs: {
        get: (name) => prefReader.get(name),
        set: (name, value) => {
          prefWriter.set(name, value);
        }
      },
      pathExists: makeChromePathExists(context.Zotero),
      ...(detectedHomeDir !== undefined ? { homeDir: detectedHomeDir } : {}),
      // Developer-friendly default: the user's checkout. End users can
      // override via the settings dialog; the XPI does not ship the
      // scripts/ tree.
      defaultServerScriptPath: resolveBundledServerScriptPath(context.rootURI),
      ...(proxyFetch !== undefined ? { fetch: proxyFetch } : {}),
      // /api/diagnostics fetch (Bug B2). Same boundFetch as the probe,
      // wrapped so the type matches DiagnosticsFetch (needs .json()).
      ...(typeof boundFetch === "function"
        ? {
            diagnosticsFetch: async (
              url: string,
              init?: { readonly signal?: AbortSignal | undefined; readonly method?: string }
            ) => {
              const forwarded: RequestInit = {};
              if (init?.signal !== undefined) forwarded.signal = init.signal;
              if (init?.method !== undefined) forwarded.method = init.method;
              const response = await boundFetch(url, forwarded);
              return {
                ok: response.ok,
                status: response.status,
                json: () => response.json()
              };
            }
          }
        : {}),
      debug: (msg) => {
        context.Zotero.debug(`zotero-ai-proxy: ${msg}`);
      },
      onStateChange: (state) => {
        // Push asynchronous status updates (crash, auto-restart, post-
        // shutdown exit) into any currently-rendered settings dialog so
        // the pill / buttons stay in sync without a full re-render. The
        // selector matches the form root produced by `renderSettingsView`.
        try {
          const mainWindow = zotero.getMainWindow?.();
          if (mainWindow === undefined) {
            return;
          }
          const doc = (mainWindow as unknown as { document: Document }).document;
          const root = doc.querySelector(".zotero-ai-settings");
          if (root === null) {
            return;
          }
          void import("./ui/settings-view.js").then(({ updateProxyStatus }) => {
            updateProxyStatus(root, {
              running: state.running,
              port: state.port,
              // Surface the buffered stderr / exit code as a dedicated
              // red error line (Bug C). The legacy `message` field
              // remains for any non-error status hints in the future.
              ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
              ...(state.externallyManaged ? { externallyManaged: true } : {}),
              ...(state.diagnostics !== undefined ? { diagnostics: state.diagnostics } : {})
            });
          });
        } catch (err) {
          context.Zotero.debug(
            `zotero-ai-proxy: onStateChange UI sync failed ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    });
  }

  const runtimeFetch = boundFetch as unknown as Parameters<typeof createZoteroRuntime>[0]["fetch"];
  // Wire the NotebookLM-style library chat. It reuses the same Ollama
  // provider (chat + embed) and the same IndexStorage the indexing
  // controller writes to. The `openItem` callback uses the active Zotero
  // pane to select the cited item; defensive fall-throughs let the
  // chat still work on hosts without a fully wired Zotero global.
  const libraryChatDeps: Parameters<typeof createZoteroRuntime>[0]["libraryChat"] = {
    provider,
    embeddingProvider,
    indexStorage,
    embedSettings: { baseUrl: settings.embedBaseUrl, model: settings.embeddingModel },
    openItem: (citation) => {
      try {
        const result = openCitationInReader(citation, zotero as unknown as CitationReaderZotero);
        if (result.outcome === "not-found") {
          zotero.debug(`Zotero AI Explain: library-chat citation ${citation.itemKey} not found`);
        }
      } catch (err) {
        zotero.debug(
          `Zotero AI Explain: openItem(${citation.itemKey}) failed ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  };
  runtime = createZoteroRuntime({
    settings,
    indexingController,
    ui,
    store,
    profile: getProfile,
    popupController,
    sidebarController,
    disclosure: describeDisclosureFor(readProviderProfile),
    prefsWriter: asStringPrefWriter(zotero.Prefs),
    libraryChat: libraryChatDeps,
    zotero: context.Zotero,
    popupRetrievalChannel,
    providerProfile,
    onProviderProfileChange: (next) => {
      context.Zotero.debug(
        `Zotero AI Explain provider profile saved: chat=${next.chatProvider} embed=${next.embedProvider}. New providers take effect after a Zotero restart.`
      );
    },
    // exactOptionalPropertyTypes: assign undefined only when fetch
    // really is missing (the typecheck rejects `T | undefined` for a
    // `T | undefined` optional under strict optional).
    ...(runtimeFetch !== undefined ? { fetch: runtimeFetch } : {}),
    // Thread the proxy handle so the settings dialog's "Local LLM
    // proxy" section drives the running child process. Omitted when
    // the Subprocess import failed (the dialog then renders without
    // the section, preserving the prior shape). We capture the handle
    // into a non-nullable local so the spread doesn't need non-null
    // assertions on every method.
    ...(proxyWired !== null
      ? (() => {
          const wired = proxyWired;
          return {
            proxy: {
              snapshot: () => wired.snapshot(),
              applyValues: (values) => wired.applyValues(values),
              start: () => wired.start(),
              stop: () => wired.stop(),
              redetectNode: () => wired.redetectNode(),
              setAutoStart: (enabled) => wired.setAutoStart(enabled)
            }
          };
        })()
      : {}),
    onSettingsChange: (next) => {
      // The persisted prefs take effect on the next plugin startup
      // (when `loadOllamaSettingsFromPrefs` reads them back). The
      // already-constructed provider + indexing controller hold the
      // values from this session; we log the new ones so the user can
      // confirm in the Browser Console that the write happened.
      context.Zotero.debug(
        `Zotero AI Explain settings saved: baseUrl=${next.baseUrl} chatModel=${next.chatModel} ` +
          `embeddingModel=${next.embeddingModel}. New values take effect after a Zotero restart.`
      );
    }
  });
  await runtime.startup();

  // Auto-reindex on Zotero item add. Registers a Notifier observer so a
  // newly-imported paper gets embedded without the user having to hit
  // "Index library" manually. The crawler's already-indexed skip means
  // re-running is cheap — only new items are embedded. We debounce so
  // batch imports (50 items at once) don't fire 50 starts.
  detachAutoReindex = attachAutoReindex({
    zotero: context.Zotero,
    indexingController,
    debounceMs: 5_000,
    // AC-8a e2e hermeticity: disable auto-reindex when the diagnostic
    // driver is active so it can't race the driver's deterministic
    // index-flow scrapes. The pref is read through the same narrow
    // `StringPrefReader` bridge the rest of bootstrap uses; `undefined`
    // (production) leaves auto-reindex fully enabled.
    e2eTriggerPref: asStringPrefReader(zotero.Prefs).get("extensions.zotero-ai-explain.e2e-trigger")
  });

  // First-run onboarding probe. Runs asynchronously so it never blocks
  // startup; the dialog appears only when (a) Ollama is unreachable or
  // a required model is absent AND (b) the user hasn't already dismissed
  // the dialog in a prior session. See `src/ui/onboarding-view.ts` for
  // the state machine and `src/preferences/onboarding-state.ts` for the
  // persistence contract.
  void maybeRunOnboarding({
    zotero,
    runtime,
    settings,
    boundFetch,
    prefs: asStringPrefReader(zotero.Prefs),
    prefsWriter: asStringPrefWriter(zotero.Prefs)
  });

  // Optional diagnostic-driven user journey. Gated on the
  // `extensions.zotero-ai-explain.e2e-trigger` pref; when unset this is a
  // no-op. Production code, but tiny and harmless when prefs aren't set.
  void runE2eDriver({
    zotero,
    prefs: asStringPrefReader(zotero.Prefs),
    ui,
    store,
    profile: getProfile,
    settings,
    popupController,
    sidebarController,
    indexingController,
    disclosure: describeDisclosureFor(readProviderProfile),
    // AC-5 migration-resume harness: the raw pieces the diagnostic
    // driver needs to build a fresh storage + controller on a spy io
    // adapter. No effect in production (the driver flow is pref-gated).
    migrationHarness: {
      io: indexStorageIo,
      dataDir: indexStorageDataDir.dir,
      embedProvider: indexEmbedProvider,
      crawlerZotero,
      crawlerProvider: embeddingProvider,
      crawlerSettings
    }
  });
}

export async function shutdown(context: ZoteroBootstrapContext): Promise<void> {
  context.Zotero.debug("Zotero AI Explain shutdown");
  // Detach the notifier observer FIRST so a Zotero item event in-flight
  // during shutdown doesn't schedule a controller.start() against a
  // controller that's about to be discarded.
  if (detachAutoReindex !== null) {
    try {
      detachAutoReindex();
    } catch (err) {
      context.Zotero.debug(
        `Zotero AI Explain: auto-reindex detach threw ${err instanceof Error ? err.message : String(err)}`
      );
    }
    detachAutoReindex = null;
  }
  // Tear down the proxy BEFORE the runtime so the child llm-proxy
  // process gets a clean SIGTERM (with SIGKILL fallback after the
  // grace period) rather than being orphaned by Firefox's plugin
  // unload — orphan node processes are the failure mode that
  // motivated wiring this teardown explicitly.
  if (proxyWired !== null) {
    try {
      await proxyWired.shutdown();
    } catch (err) {
      context.Zotero.debug(
        `Zotero AI Explain: proxy shutdown threw ${err instanceof Error ? err.message : String(err)}`
      );
    }
    proxyWired = null;
  }
  await runtime?.shutdown();
  runtime = null;
}
