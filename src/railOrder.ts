// Pure ordering/visibility logic for the activity rail (src/rail.ts owns the
// DOM wiring that calls these). Kept import-free so rail.test.ts can cover it
// directly under vitest's node environment (see vitest.config.ts: no DOM, no
// localStorage) — importing rail.ts itself would drag in state.ts/chrome.ts/
// reactdock.tsx, which touch browser globals at module load.

export interface RailState {
  order: string[]; // panel ids, user order (may include ids no longer registered)
  hidden: string[]; // panel ids hidden from the rail (registration/palette untouched)
}

export const DEFAULT_RAIL_STATE: RailState = { order: [], hidden: [] };

// Merge a persisted order against the panels actually registered right now:
// ids still registered keep their saved relative order; ids no longer
// registered are dropped; newly-registered ids (never seen before) append at
// the end in registration order — VS Code's "new extension's icon lands at
// the bottom" behavior.
// `order`/`hidden` params tolerate undefined: a persisted rail slice written by
// a partial savePluginState patch (e.g. the user's first hide, before any drag)
// stores only the patched key, so the other one reads back undefined.
export function mergeOrder(order: string[] | undefined, registeredIds: string[]): string[] {
  const known = new Set(registeredIds);
  const kept = (order ?? []).filter((id) => known.has(id));
  const seen = new Set(kept);
  const appended = registeredIds.filter((id) => !seen.has(id));
  return [...kept, ...appended];
}

// Drop hidden ids from an (already-merged) order, in order.
export function visibleIds(order: string[], hidden: string[] | undefined): string[] {
  const hiddenSet = new Set(hidden ?? []);
  return order.filter((id) => !hiddenSet.has(id));
}

// One-shot resolve: registered ids -> merged order -> hidden filtered. Shared
// by the rail rebuild and by tests, so "new panel appends" + "hidden id drops
// its button" are checked as one pure pipeline.
export function resolveRailIds(registeredIds: string[], state: RailState): string[] {
  return visibleIds(mergeOrder(state.order, registeredIds), state.hidden);
}

// Move `dragId` to sit where `overId` currently is. No-op if either id is
// absent from `order` or they're the same id.
export function moveBefore(order: string[], dragId: string, overId: string): string[] {
  if (dragId === overId) return order;
  const from = order.indexOf(dragId);
  const to = order.indexOf(overId);
  if (from === -1 || to === -1) return order;
  const next = order.slice();
  next.splice(from, 1);
  const insertAt = next.indexOf(overId);
  next.splice(insertAt, 0, dragId);
  return next;
}

// Flip one id's membership in a hidden-id list.
export function toggleHidden(hidden: string[] | undefined, id: string): string[] {
  const h = hidden ?? [];
  return h.includes(id) ? h.filter((x) => x !== id) : [...h, id];
}
