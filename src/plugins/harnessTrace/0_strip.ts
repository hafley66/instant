// Pure chrome rules for the in-tab strip: what a toggle press writes and when
// the shell renders. No React and no store import, so vitest covers them in the
// node environment the way the rest of the 0_ modules are covered.
import type { IStripPolicy } from "./0_types";

export const StripPolicy: IStripPolicy = {
  // No entry means nothing is on screen for this terminal, so the first press
  // summons; only an existing entry flips.
  toggle(entry) {
    return { open: entry ? !entry.open : true };
  },

  // An entry is an explicit user decision and wins outright: open renders the
  // shell even with zero rows (the empty state names the sid). Without one the
  // strip auto-appears only when it has something to show.
  visible(entry, rowCount, hasCurrent) {
    if (entry) return entry.open;
    return rowCount > 0 || hasCurrent;
  },
};
