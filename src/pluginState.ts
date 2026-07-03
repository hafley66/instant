// Namespaced persistence surface for plugins, backed by the central store's
// `pluginState` field (src/state.ts) instead of ad hoc localStorage keys.
// Each plugin gets its own slice, keyed by plugin id.
import { store } from "./state";

export function readPluginState<T>(pluginId: string, fallback: T): T {
  const v = store.get().pluginState[pluginId];
  return (v as T | undefined) ?? fallback;
}

export function savePluginState<T extends object>(pluginId: string, patch: Partial<T>): void {
  const cur = store.get().pluginState;
  const prev = (cur[pluginId] as T | undefined) ?? ({} as T);
  const next = { ...prev, ...patch };
  store.set({ pluginState: { ...cur, [pluginId]: next } });
}
