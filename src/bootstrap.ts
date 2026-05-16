import { createReaderIntegration } from "./platform/reader-integration.js";
import { createPluginLifecycle } from "./platform/plugin-lifecycle.js";

export type ZoteroBootstrapContext = {
  readonly Zotero: {
    debug(message: string): void;
  };
  readonly reason: number;
};

export const readerIntegration = createReaderIntegration({
  onExplain(selection) {
    void selection;
  }
});

const lifecycle = createPluginLifecycle({
  startup: () => Promise.resolve(),
  shutdown: () => Promise.resolve()
});

export async function startup(context: ZoteroBootstrapContext): Promise<void> {
  context.Zotero.debug("Zotero AI Explain startup");
  context.Zotero.debug("Zotero AI Explain reader hooks ready");
  await lifecycle.startup();
}

export async function shutdown(context: ZoteroBootstrapContext): Promise<void> {
  context.Zotero.debug("Zotero AI Explain shutdown");
  await lifecycle.shutdown();
}
