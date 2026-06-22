// React binding for the observable store. useSyncExternalStore subscribes to the
// whole state; store.set replaces the state object (shallow-merge -> new ref) so
// React re-renders only when something actually changed. Components destructure
// what they need; for this app's size whole-state subscription is fine and, more
// importantly, loop-free (the snapshot ref is stable between changes).
import { useSyncExternalStore } from "react";
import { store, type AppState } from "./state";

export function useApp(): AppState {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    store.get,
  );
}
