import { setting } from "./0_persistedSetting"

/** The legal values are the single source: the type below derives from them.
 *  index.html repeats the same two in the toolbar's `<select>` by hand, since
 *  the toolbar is markup, not a component. */
export const SQUARES_MODES = ["relative", "recent"] as const
export type SquaresMode = (typeof SQUARES_MODES)[number]

/// The right-margin turn squares: one square per conversation turn, oldest at
/// the top. `on` is the toolbar toggle. How many squares are kept is the
/// server's, not a setting here: the cap is part of the placement
/// (`boop-turnstrip::Options::max_squares`), since trimming the list changes
/// every square's `y`.
export const agentSquares = {
  on: setting<boolean>("agentSquares.on", false),
  /** "relative" places a square by its row inside the reader's window, "recent"
   *  by its place among the session's newest turns: uniform, oldest first,
   *  newest at the bottom, and the block centred on the strip. */
  mode: setting<SquaresMode>("agentSquares.mode", "relative"),
  /** How many of the reader's own turns stay pinned above the capture, which is
   *  what the band squares in the gutter refer to. */
  userKeep: setting<number>("agentSquares.userKeep", 4),
}

/** Everything the strip needs to project a pane, in one value: the options the
 *  watcher is started with, and what `retarget` compares to decide whether a
 *  settings change means a new watcher. */
export type SquaresOptions = { mode: SquaresMode; userKeep: number }

export function squaresOptions(): SquaresOptions {
  return {
    mode: agentSquares.mode.$(),
    userKeep: agentSquares.userKeep.$(),
  }
}
