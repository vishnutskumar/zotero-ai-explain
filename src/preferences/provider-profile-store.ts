import type { ProviderProfile } from "../providers/provider-types.js";

export type PreferenceStore = {
  get(key: string): string | null;
  set(key: string, value: string): void;
};

export type ProviderProfileStore = {
  loadAll(): readonly ProviderProfile[];
  saveAll(profiles: readonly ProviderProfile[]): void;
};

const providerProfilesKey = "providers";

export function createProviderProfileStore(store: PreferenceStore): ProviderProfileStore {
  return {
    loadAll() {
      const rawProfiles = store.get(providerProfilesKey);

      if (rawProfiles === null) {
        return [];
      }

      return JSON.parse(rawProfiles) as readonly ProviderProfile[];
    },

    saveAll(profiles) {
      store.set(providerProfilesKey, JSON.stringify(profiles));
    }
  };
}
