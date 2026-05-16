// src/selection/normalize-selection.ts
function normalizeSelection(selection) {
  const quote = selection.quote.trim();
  if (quote.length === 0) {
    return { ok: false, reason: "Select text before asking for an explanation." };
  }
  return { ok: true, selection: { ...selection, quote } };
}

// src/platform/reader-integration.ts
function createReaderIntegration(deps) {
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

// src/platform/plugin-lifecycle.ts
function createPluginLifecycle(actions) {
  return actions;
}

// src/bootstrap.ts
var readerIntegration = createReaderIntegration({
  onExplain(selection) {
    void selection;
  }
});
var lifecycle = createPluginLifecycle({
  startup: () => Promise.resolve(),
  shutdown: () => Promise.resolve()
});
async function startup(context) {
  context.Zotero.debug("Zotero AI Explain startup");
  context.Zotero.debug("Zotero AI Explain reader hooks ready");
  await lifecycle.startup();
}
async function shutdown(context) {
  context.Zotero.debug("Zotero AI Explain shutdown");
  await lifecycle.shutdown();
}
export {
  readerIntegration,
  shutdown,
  startup
};
