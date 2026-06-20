// Tiny observable store. Components subscribe to a slice (a set of keys) and are
// notified only when one of those keys changes. No deps; this is the seam every
// future panel (sessions, clipboard, ai-turns, tables) hangs off of.
export type Listener<S> = (state: S) => void;

export interface Store<S> {
  get(): S;
  /** Shallow-merge a patch. Listeners fire only for keys whose value changed. */
  set(patch: Partial<S>): void;
  /** Subscribe; pass `keys` to be notified only for those fields. Returns an unsubscribe. */
  subscribe(fn: Listener<S>, keys?: (keyof S)[]): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const subs = new Set<{ fn: Listener<S>; keys?: (keyof S)[] }>();

  return {
    get: () => state,
    set(patch) {
      const changed = (Object.keys(patch) as (keyof S)[]).filter(
        (k) => state[k] !== patch[k],
      );
      if (changed.length === 0) return;
      state = { ...state, ...patch };
      for (const sub of subs) {
        if (!sub.keys || sub.keys.some((k) => changed.includes(k))) sub.fn(state);
      }
    },
    subscribe(fn, keys) {
      const sub = { fn, keys };
      subs.add(sub);
      return () => subs.delete(sub);
    },
  };
}
