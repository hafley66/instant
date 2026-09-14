// The Boop roster's empty/loading/error decision, kept out of the component so
// the pending-versus-successful-empty distinction is testable without a DOM.
//
// The panel shows one `empty-help` block whenever the roster has no rows. Before
// this split the block was keyed on `lanes.length === 0` alone, so a graph read
// that was still in flight, or one that failed, both read as "no agents in the
// window" — the exact report from the live app while coordinator tabs were open.

import type { AsyncStatus } from "@hafley66/signals";

export type BoopRosterState =
  | { kind: "rows" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "hidden-by-active"; hidden: number }
  | { kind: "empty" };

export interface BoopRosterInput {
  /** Every graph node, filtered or not. Zero means the graph knows of no lanes. */
  laneCount: number;
  /** Rows the active-only filter left visible. */
  shownCount: number;
  /** Root lanes the active-only filter removed. */
  hiddenByActive: number;
  /** Graph query state; `idle`/`loading` mean the first read has not settled. */
  status: AsyncStatus;
  /** Invoke or query error, already stringified. Null when neither failed. */
  error: string | null;
}

export function boopRosterState(input: BoopRosterInput): BoopRosterState {
  if (input.laneCount > 0) {
    if (input.shownCount === 0 && input.hiddenByActive > 0) {
      return { kind: "hidden-by-active", hidden: input.hiddenByActive };
    }
    return { kind: "rows" };
  }
  if (input.error) return { kind: "error", message: input.error };
  if (input.status === "idle" || input.status === "loading") return { kind: "loading" };
  return { kind: "empty" };
}
