import { createConversationStore } from "./conversation/conversation-store.js";
import { createInitialIndexingStatus } from "./indexing/indexing-status.js";
import { dumpZoteroTokens } from "./platform/token-dump.js";
import { createZoteroRuntime, type ZoteroRuntime } from "./platform/zotero-runtime.js";
import { createZoteroUiAdapter, type ZoteroGlobal } from "./platform/zotero-ui-adapter.js";
import {
  createDefaultOllamaSettings,
  ollamaSettingsToProfile
} from "./preferences/ollama-profile.js";
import { createOllamaProvider } from "./providers/adapters/ollama.js";
import { createProviderRegistry } from "./providers/provider-registry.js";
import type { ProviderProfile } from "./providers/provider-types.js";
import { createPopupController } from "./ui/popup-controller.js";
import { createSidebarController } from "./ui/sidebar-controller.js";

type ZoteroPrefs = {
  get(name: string, defaultValue?: boolean): boolean | undefined;
};

type ZoteroWithPrefs = ZoteroGlobal & {
  readonly Prefs?: ZoteroPrefs;
};

export type ZoteroBootstrapContext = {
  readonly pluginId: string;
  readonly Zotero: ZoteroGlobal;
  readonly reason: number;
};

let runtime: ZoteroRuntime | null = null;

function describeDisclosure(profile: ProviderProfile): string {
  return `Selected text will be sent to ${profile.displayName} using ${profile.model}.`;
}

function maybeDumpTokens(zotero: ZoteroWithPrefs): void {
  let enabled = false;
  try {
    enabled = zotero.Prefs?.get("extensions.zotero-ai-explain.dump-tokens", true) === true;
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

export async function startup(context: ZoteroBootstrapContext): Promise<void> {
  context.Zotero.debug("Zotero AI Explain startup");
  maybeDumpTokens(context.Zotero);

  const settings = createDefaultOllamaSettings();
  const profile = ollamaSettingsToProfile(settings);
  const store = createConversationStore();
  const ollamaProvider = createOllamaProvider({ fetch: globalThis.fetch.bind(globalThis) });
  const registry = createProviderRegistry([ollamaProvider]);
  const provider = registry.resolve(profile);

  runtime = createZoteroRuntime({
    settings,
    indexStatus: createInitialIndexingStatus(),
    ui: createZoteroUiAdapter({ Zotero: context.Zotero, pluginId: context.pluginId }),
    store,
    profile,
    popupController: createPopupController({ store, provider }),
    sidebarController: createSidebarController({ store, provider }),
    disclosure: describeDisclosure
  });
  await runtime.startup();
}

export async function shutdown(context: ZoteroBootstrapContext): Promise<void> {
  context.Zotero.debug("Zotero AI Explain shutdown");
  await runtime?.shutdown();
  runtime = null;
}
