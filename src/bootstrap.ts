import { createPluginLifecycle } from "./platform/plugin-lifecycle.js";

export type ZoteroBootstrapContext = {
  readonly Zotero: {
    debug(message: string): void;
  };
  readonly reason: number;
};

const lifecycle = createPluginLifecycle({
  startup: () => Promise.resolve(),
  shutdown: () => Promise.resolve()
});

export async function startup(context: ZoteroBootstrapContext): Promise<void> {
  context.Zotero.debug("Zotero AI Explain startup");
  await lifecycle.startup();
}

export async function shutdown(context: ZoteroBootstrapContext): Promise<void> {
  context.Zotero.debug("Zotero AI Explain shutdown");
  await lifecycle.shutdown();
}
