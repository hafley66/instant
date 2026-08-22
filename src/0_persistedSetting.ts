// One durable setting = one declaration. Replaces the four-part wiring a
// persisted key used to need: a field on AppState, an entry in PERSIST, a
// loadKey call, and a store.subscribe plus an initial sync call.
//
// Serialization is JSON under the same localStorage key loadKey used, so values
// written by earlier builds load unchanged and a key can migrate on its own.
// Storage is per key, so writing one setting writes one key; the PERSIST
// subscriber in state.ts rewrites all of its keys on every set().
import { StorageSignal, type Signal } from "@hafley66/signals"
import { SAFE_BOOT } from "./state"

export function setting<T>(key: string, fallback: T) {
  // SAFE_BOOT drops the persisted copy rather than reading it back, then the
  // first write puts the default over the bad value. See SAFE_BOOT in state.ts.
  if (SAFE_BOOT) localStorage.removeItem(key)
  return StorageSignal(key, fallback)
}

/** Advance a setting to the next entry in its own list of legal values. */
export function cycleSetting<T extends string>(s: Signal<T>, values: readonly T[]) {
  s.$(values[(values.indexOf(s.$()) + 1) % values.length])
}
