import { normalizeSelection } from "../selection/normalize-selection.js";
import type { SelectionContext } from "../selection/selection-context.js";

export type ReaderIntegration = {
  readonly handleSelection: (selection: SelectionContext) => void;
};

export function createReaderIntegration(deps: {
  readonly onExplain: (selection: SelectionContext) => void;
}): ReaderIntegration {
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
