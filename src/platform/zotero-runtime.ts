import type { IndexingStatus } from "../indexing/indexing-status.js";
import type { OllamaSettings } from "../preferences/ollama-profile.js";
import type { SelectionContext } from "../selection/selection-context.js";
import { renderSettingsView } from "../ui/settings-view.js";
import type { Unsubscribe, ZoteroUiAdapter } from "./zotero-ui-types.js";

export type ZoteroRuntime = {
  startup(): Promise<void>;
  shutdown(): Promise<void>;
};

export function createZoteroRuntime(deps: {
  readonly settings: OllamaSettings;
  readonly indexStatus: IndexingStatus;
  readonly ui: ZoteroUiAdapter;
  readonly onExplain: (selection: SelectionContext) => void;
}): ZoteroRuntime {
  const cleanup: Unsubscribe[] = [];

  return {
    startup() {
      cleanup.push(
        deps.ui.addMenuItem("Zotero AI Explain Settings", () => {
          deps.ui.openDialog(
            "Zotero AI Explain",
            renderSettingsView({ settings: deps.settings, indexStatus: deps.indexStatus })
          );
        })
      );
      cleanup.push(deps.ui.addReaderCommand("Explain with AI", deps.onExplain));
      return Promise.resolve();
    },
    shutdown() {
      while (cleanup.length > 0) {
        cleanup.shift()?.();
      }
      return Promise.resolve();
    }
  };
}
