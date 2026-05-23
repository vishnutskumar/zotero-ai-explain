import type { ProviderProfile } from "../providers/provider-types.js";

export type ProviderProfileValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function validateProviderProfile(profile: ProviderProfile): ProviderProfileValidationResult {
  if (profile.kind === "custom-http" && profile.baseUrl === null) {
    return { ok: false, reason: "custom-http providers require a base URL." };
  }

  if (profile.kind === "ollama" && profile.baseUrl === null) {
    return { ok: false, reason: "Ollama profiles require a base URL." };
  }

  if (profile.model.trim().length === 0) {
    return { ok: false, reason: "Provider profiles require a model." };
  }

  return { ok: true };
}
