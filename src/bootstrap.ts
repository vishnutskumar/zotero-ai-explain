import { createInitialIndexingStatus } from "./indexing/indexing-status.js";
import { createZoteroRuntime, type ZoteroRuntime } from "./platform/zotero-runtime.js";
import { createZoteroUiAdapter, type ZoteroGlobal } from "./platform/zotero-ui-adapter.js";
import { createDefaultOllamaSettings } from "./preferences/ollama-profile.js";

export type ZoteroBootstrapContext = {
  readonly pluginId: string;
  readonly Zotero: ZoteroGlobal;
  readonly reason: number;
};

let runtime: ZoteroRuntime | null = null;

export async function startup(context: ZoteroBootstrapContext): Promise<void> {
  context.Zotero.debug("Zotero AI Explain startup");
  runtime = createZoteroRuntime({
    settings: createDefaultOllamaSettings(),
    indexStatus: createInitialIndexingStatus(),
    ui: createZoteroUiAdapter({ Zotero: context.Zotero, pluginId: context.pluginId }),
    onExplain(selection) {
      context.Zotero.debug(`Zotero AI Explain selected ${String(selection.quote.length)} chars`);
    }
  });
  await runtime.startup();
}

export async function shutdown(context: ZoteroBootstrapContext): Promise<void> {
  context.Zotero.debug("Zotero AI Explain shutdown");
  await runtime?.shutdown();
  runtime = null;
}
