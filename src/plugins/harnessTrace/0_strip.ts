// Pure chrome rules for the in-tab strip: what a toggle press writes and when
// the shell renders. No React and no store import, so vitest covers them in the
// node environment the way the rest of the 0_ modules are covered.
import type { IStripPolicy } from "./0_types";

export const StripPolicy: IStripPolicy = {
  toggle(entry) {
    return { open: !(entry?.open ?? true) };
  },

  visible(entry, rowCount, hasCurrent) {
    return (entry?.open ?? true) && (rowCount > 0 || hasCurrent);
  },
};
