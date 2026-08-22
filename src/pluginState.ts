// Namespaced persistence surface for plugins, backed by the central store's
// `pluginState` field (src/state.ts) instead of ad hoc localStorage keys.
// Each plugin gets its own slice, keyed by plugin id.
import { settings } from "./0_settings";

export function readPluginState<T>(pluginId: string, fallback: T): T {
  const v = settings.pluginState.$()[pluginId];
  return (v as T | undefined) ?? fallback;
}

export function savePluginState<T extends object>(pluginId: string, patch: Partial<T>): void {
  const cur = settings.pluginState.$();
  const prev = (cur[pluginId] as T | undefined) ?? ({} as T);
  const next = { ...prev, ...patch };
  settings.pluginState.$({ ...cur, [pluginId]: next });
}
