export type ZoteroCompatibilityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function assertZotero8Compatible(version: string): ZoteroCompatibilityResult {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (major >= 8) {
    return { ok: true };
  }

  return { ok: false, reason: "Zotero AI Explain requires Zotero 8 or newer." };
}
