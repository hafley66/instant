import { setting } from "./0_persistedSetting"

/** The legal values are the single source: the type below derives from them.
 *  index.html repeats the same two in the toolbar's `<select>` by hand, since
 *  the toolbar is markup, not a component. */
export const SQUARES_MODES = ["relative", "map"] as const
export type SquaresMode = (typeof SQUARES_MODES)[number]

/// The right-margin turn squares: one square per turn the server placed, oldest
/// at the top. `on` is the toolbar toggle. How many squares are kept is the
/// server's, not a setting here: the cap is part of the placement
/// (`boop-turnstrip::Options::max_squares`), since trimming the list changes the
/// window's total and therefore every square's `y`.
export const agentSquares = {
  on: setting<boolean>("agentSquares.on", false),
  /** "relative" places a square by its row inside the reader's window, "map" by
   *  its row in the whole estimated buffer. */
  mode: setting<SquaresMode>("agentSquares.mode", "relative"),
  /** Off drops tool turns from the layout entirely: no square, no band slot. */
  showTools: setting<boolean>("agentSquares.showTools", true),
  /** How many of the reader's own turns stay pinned above the capture, which is
   *  what the band squares in the gutter refer to. */
  userKeep: setting<number>("agentSquares.userKeep", 4),
}

/** Everything the strip needs to project a pane, in one value: the three
 *  options the watcher is started with, and what `retarget` compares to decide
 *  whether a settings change means a new watcher. */
export type SquaresOptions = { mode: SquaresMode; showTools: boolean; userKeep: number }

export function squaresOptions(): SquaresOptions {
  return {
    mode: agentSquares.mode.$(),
    showTools: agentSquares.showTools.$(),
    userKeep: agentSquares.userKeep.$(),
  }
}
