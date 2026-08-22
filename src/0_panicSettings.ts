// Panic-button settings, one StorageSignal per key. Each declaration carries the
// type, the default and the localStorage key together, so adding a setting is
// one line instead of a field on AppState plus a PERSIST entry plus a loadKey
// call plus a store.subscribe. Serialization is JSON, matching the loadKey these
// replaced, so values persisted by earlier builds load unchanged.
import { StorageSignal, type Signal } from "@hafley66/signals"
import { PANIC_BODY_DEFAULT } from "./0_stfuButton"
import { SAFE_BOOT } from "./state"

/** The legal values are the single source: the types below are derived from them. */
export const PANIC_MODES = ["clear", "paste", "escape"] as const
export const PANIC_SUBS = ["below", "cap", "both", "off"] as const
export type PanicMode = (typeof PANIC_MODES)[number]
export type PanicSub = (typeof PANIC_SUBS)[number]

function setting<T>(key: string, fallback: T) {
  // SAFE_BOOT drops the persisted copy rather than reading it back, then the
  // first write puts the default over the bad value. See SAFE_BOOT in state.ts.
  if (SAFE_BOOT) localStorage.removeItem(key)
  return StorageSignal(key, fallback)
}

export const panic = {
  on: setting("panicButton", true),
  body: setting("panicBody", PANIC_BODY_DEFAULT),
  pos: setting("panicPos", { x: 0, y: 0 }),
  mode: setting<PanicMode>("panicMode", "clear"),
  sub: setting<PanicSub>("panicSub", "below"),
}

/** Advance a setting to the next entry in its own list of legal values. */
export function cyclePanic<T extends string>(s: Signal<T>, values: readonly T[]) {
  s.$(values[(values.indexOf(s.$()) + 1) % values.length])
}
