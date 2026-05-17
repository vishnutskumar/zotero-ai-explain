"use strict";

// Loaded by Zotero via Services.scriptloader.loadSubScript. The plugin
// loader scope already exposes `Zotero` and `Services` globals.

var loadedScope;

async function startup(data, reason) {
  await Zotero.initializationPromise;
  if (Zotero.uiReadyPromise) {
    await Zotero.uiReadyPromise;
  }

  // The bundle uses bare `document` / `window` references in view-rendering
  // functions (renderSettingsView, renderAnchoredPopup, etc). In Zotero's
  // chrome ESM context, bare `document` does NOT resolve to a usable global,
  // so view functions throw ReferenceError at first call and click handlers
  // abort silently. Expose live getters so refs stay current.
  const scope = {
    Zotero,
    get document() {
      return Zotero.getMainWindow()?.document;
    },
    get window() {
      return Zotero.getMainWindow();
    }
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

  await scope.ZoteroAiExplain.startup({ Zotero, pluginId: data.id, reason });
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
