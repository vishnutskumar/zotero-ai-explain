import type { SelectionContext, SourceMetadata } from "../selection/selection-context.js";

export type ReaderDomAdapter = {
  readonly attach: () => void;
  readonly detach: () => void;
};

export function createReaderDomAdapter(deps: {
  readonly document: Document;
  readonly getSelectionText: () => string;
  readonly getAnchor: () => SelectionContext["anchor"];
  readonly getSource: () => SourceMetadata;
  readonly onSelection: (selection: SelectionContext) => void;
}): ReaderDomAdapter {
  let attached = false;

  const handleMouseUp = () => {
    deps.onSelection({
      quote: deps.getSelectionText(),
      source: deps.getSource(),
      anchor: deps.getAnchor()
    });
  };

  return {
    attach() {
      if (attached) {
        return;
      }

      deps.document.addEventListener("mouseup", handleMouseUp);
      attached = true;
    },

    detach() {
      if (!attached) {
        return;
      }

      deps.document.removeEventListener("mouseup", handleMouseUp);
      attached = false;
    }
  };
}
