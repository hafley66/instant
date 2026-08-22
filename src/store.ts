// The app store, backed by a Signal. Components subscribe to a slice (a set of
// keys) and are notified only when one of those keys changes.
//
// `$` is the Signal itself, so a field is reachable as a signal of its own:
// `store.$.mode.$()` reads it, `store.$.mode.$(next)` writes it, and
// `store.$.mode.$.subscribe(fn)` is an rxjs stream of that one field. get/set/
// subscribe stay as they were for the call sites that predate this.
import { Signal } from "@hafley66/signals";
import { Observable, Subject } from "rxjs";

export type Listener<S> = (state: S) => void;

export interface Store<S extends object> {
  get(): S;
  /** Shallow-merge a patch. Listeners fire only for keys whose value changed. */
  set(patch: Partial<S>): void;
  /** Subscribe; pass `keys` to be notified only for those fields. Returns an unsubscribe. */
  subscribe(fn: Listener<S>, keys?: (keyof S)[]): () => void;
  /** The Signal behind the store: nested proxy access and per-field streams. */
  readonly $: Signal<S>;
  /** The keys that changed, one emission per set(). Lets a listener act on the
   *  delta rather than re-reading everything it cares about. */
  readonly changed$: Observable<(keyof S)[]>;
}

export function createStore<S extends object>(initial: S): Store<S> {
  const state = Signal(initial);
  const changed = new Subject<(keyof S)[]>();

  return {
    get: () => state.$(),
    set(patch) {
      const current = state.$();
      const dirty = (Object.keys(patch) as (keyof S)[]).filter(
        (k) => current[k] !== patch[k],
      );
      if (dirty.length === 0) return;
      state.$({ ...current, ...patch });
      changed.next(dirty);
    },
    subscribe(fn, keys) {
      const sub = changed.subscribe((dirty) => {
        if (!keys || keys.some((k) => dirty.includes(k))) fn(state.$());
      });
      return () => sub.unsubscribe();
    },
    $: state,
    changed$: changed.asObservable(),
  };
}
