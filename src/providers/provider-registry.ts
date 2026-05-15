import type { ModelProvider, ProviderProfile } from "./provider-types.js";

export type ProviderRegistry = {
  resolve(profile: ProviderProfile): ModelProvider;
};

export function createProviderRegistry(providers: readonly ModelProvider[]): ProviderRegistry {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  return {
    resolve(profile) {
      if (!profile.enabled) {
        throw new Error("Provider profile is disabled.");
      }

      const provider = byId.get(profile.kind);
      if (provider === undefined) {
        throw new Error(`No provider adapter registered for ${profile.kind}.`);
      }

      return provider;
    }
  };
}
