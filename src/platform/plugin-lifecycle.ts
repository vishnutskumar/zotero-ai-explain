export type PluginLifecycle = {
  readonly startup: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
};

export function createPluginLifecycle(actions: PluginLifecycle): PluginLifecycle {
  return actions;
}
