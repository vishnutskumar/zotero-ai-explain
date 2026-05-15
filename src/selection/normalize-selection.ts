import type { SelectionContext } from "./selection-context.js";

export type NormalizeSelectionResult =
  | { readonly ok: true; readonly selection: SelectionContext }
  | { readonly ok: false; readonly reason: string };

export function normalizeSelection(selection: SelectionContext): NormalizeSelectionResult {
  const quote = selection.quote.trim();
  if (quote.length === 0) {
    return { ok: false, reason: "Select text before asking for an explanation." };
  }

  return { ok: true, selection: { ...selection, quote } };
}
