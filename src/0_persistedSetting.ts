// One durable setting = one declaration. Replaces the four-part wiring a
// persisted key used to need: a field on AppState, an entry in PERSIST, a
// loadKey call, and a store.subscribe plus an initial sync call.
//
// Serialization is JSON under the same localStorage key loadKey used, so values
// written by earlier builds load unchanged and a key can migrate on its own.
// Storage is per key, so writing one setting writes one key; the PERSIST
// subscriber in state.ts rewrites all of its keys on every set().
import { storageSignal, type Signal } from "@hafley66/signals"
import { Observable } from "rxjs"
import { SAFE_BOOT } from "./state"

/** localStorage bound to one key, plus cross-tab updates where the environment
 *  has them. The library's own adapter calls addEventListener unconditionally,
 *  which is absent under the node test environment. */
function adapter(key: string) {
  return {
    read: new Observable<string>((subscriber) => {
      const emit = () => subscriber.next(localStorage.getItem(key) ?? "")
      if (typeof addEventListener === "function") {
        addEventListener("storage", (event) => {
          if (event.storageArea === localStorage && event.key === key) emit()
        })
      }
      emit()
    }),
    write: {
      next: (value: string) => localStorage.setItem(key, value),
      error() {},
      complete() {},
    },
  }
}

export function setting<T>(key: string, fallback: T) {
  // SAFE_BOOT drops the persisted copy rather than reading it back, then the
  // first write puts the default over the bad value. See SAFE_BOOT in state.ts.
  if (SAFE_BOOT) localStorage.removeItem(key)
  return storageSignal(adapter(key), fallback, {
    // Values written by the pre-JSON persistence are bare strings, so JSON.parse
    // throws on them. Keep loadKey's behaviour: hand back the raw string when
    // the default is a string, migrating skin/mode/scanRoot in place.
    parse: (raw) => {
      try {
        return JSON.parse(raw) as T
      } catch {
        return (typeof fallback === "string" ? raw : fallback) as T
      }
    },
  })
}

/** Advance a setting to the next entry in its own list of legal values. */
export function cycleSetting<T extends string>(s: Signal<T>, values: readonly T[]) {
  s.$(values[(values.indexOf(s.$()) + 1) % values.length])
}
