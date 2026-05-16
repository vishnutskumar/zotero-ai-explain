// src/platform/plugin-lifecycle.ts
function createPluginLifecycle(actions) {
  return {
    startup: actions.startup,
    shutdown: actions.shutdown
  };
}

// src/bootstrap.ts
var lifecycle = createPluginLifecycle({
  startup: () => Promise.resolve(),
  shutdown: () => Promise.resolve()
});
async function startup(context) {
  context.Zotero.debug("Zotero AI Explain startup");
  await lifecycle.startup();
}
async function shutdown(context) {
  context.Zotero.debug("Zotero AI Explain shutdown");
  await lifecycle.shutdown();
}
export {
  shutdown,
  startup
};
