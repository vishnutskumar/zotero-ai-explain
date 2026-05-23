"use strict";

// Loaded by Zotero via Services.scriptloader.loadSubScript. The plugin
// loader scope already exposes `Zotero` and `Services` globals.

var loadedScope;

async function startup(data, reason) {
  await Zotero.initializationPromise;
  if (Zotero.uiReadyPromise) {
    await Zotero.uiReadyPromise;
  }

  // In Zotero's chrome ESM context, `fetch` and a few other web platform
  // globals are NOT auto-exposed. We must explicitly import them via
  // Cu.importGlobalProperties so the bundle's `globalThis.fetch.bind(...)`
  // call resolves to a working network primitive. Without this, the
  // Ollama provider's first `await deps.fetch(...)` throws a TypeError
  // ("globalThis.fetch is undefined") and the explain flow falls through
  // into the connection-error path silently.
  //
  // We capture into local bindings here so the same fetch is the one
  // we hand to the bundle scope below. `AbortController` is generally
  // available on the chrome global, but we expose it defensively.
  let chromeFetch;
  let ChromeAbortController;
  try {
    Components.utils.importGlobalProperties(["fetch", "AbortController"]);
    // After importGlobalProperties, the named symbols are bound on this
    // module's chrome scope; harden against either being missing.
    chromeFetch = typeof fetch === "function" ? fetch : globalThis.fetch;
    ChromeAbortController =
      typeof AbortController === "function" ? AbortController : globalThis.AbortController;
  } catch (err) {
    Zotero.debug(
      `Zotero AI Explain: importGlobalProperties failed: ${err && err.message ? err.message : String(err)}`
    );
    chromeFetch = globalThis.fetch;
    ChromeAbortController = globalThis.AbortController;
  }

  // The bundle uses bare `document` / `window` / `fetch` references. In
  // Zotero's chrome ESM context, bare `document` / `fetch` do NOT resolve
  // to usable globals unless explicitly placed on the loadSubScript scope.
  // We expose live getters for document/window (chrome window can change)
  // and a direct binding for fetch (a stable function reference).
  const scope = {
    Zotero,
    get document() {
      return Zotero.getMainWindow()?.document;
    },
    get window() {
      return Zotero.getMainWindow();
    },
    fetch: chromeFetch,
    AbortController: ChromeAbortController
  };

  // Synchronously evaluate our bundle (built as an IIFE that assigns to
  // `ZoteroAiExplain` on the scope global). loadSubScript executes the
  // script in the given scope, so the IIFE writes its export onto `scope`.
  Services.scriptloader.loadSubScript(`${data.rootURI}content/zotero-ai-explain.js`, scope);
  loadedScope = scope;

  if (!scope.ZoteroAiExplain || typeof scope.ZoteroAiExplain.startup !== "function") {
    Zotero.debug(
      "Zotero AI Explain: bundle did not expose startup function; aborting initialization"
    );
    return;
  }

  await scope.ZoteroAiExplain.startup({
    Zotero,
    pluginId: data.id,
    reason,
    // Hand the plugin's install URL (chrome:// or jar:file://) through
    // to the bundle. The bundle resolves the bundled llm-proxy script
    // path from this; without it the bundle would have to hard-code an
    // absolute checkout path, which only works on the developer's
    // machine.
    rootURI: data.rootURI
  });
}

async function shutdown(_data, reason) {
  if (typeof APP_SHUTDOWN !== "undefined" && reason === APP_SHUTDOWN) {
    return;
  }
  if (!loadedScope?.ZoteroAiExplain?.shutdown) {
    return;
  }
  try {
    await loadedScope.ZoteroAiExplain.shutdown({ Zotero, reason });
  } finally {
    loadedScope = null;
  }
}

function install() {}
function uninstall() {}
