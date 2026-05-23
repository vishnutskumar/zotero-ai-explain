import type { StringPrefReader, StringPrefWriter } from "./ollama-profile.js";

/**
 * Pref key tracking whether the first-run onboarding dialog has been
 * shown. Persisted as the literal string "true" once dismissed.
 */
export const ONBOARDING_SHOWN_PREF = "extensions.zotero-ai-explain.onboarding-shown";

/** True only when the pref equals "true". Any other value → false. */
export function readOnboardingShown(prefs: StringPrefReader): boolean {
  try {
    return prefs.get(ONBOARDING_SHOWN_PREF) === "true";
  } catch {
    return false;
  }
}

/** Persist the dismissal flag. Idempotent. */
export function markOnboardingShown(writer: StringPrefWriter): void {
  writer.set(ONBOARDING_SHOWN_PREF, "true");
}

/** Clear the flag so the next startup probes again ("Show again" affordance). */
export function clearOnboardingShown(writer: StringPrefWriter): void {
  if (typeof writer.clear === "function") {
    writer.clear(ONBOARDING_SHOWN_PREF);
    return;
  }
  writer.set(ONBOARDING_SHOWN_PREF, "");
}
