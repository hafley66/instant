import { setting } from "./0_persistedSetting"

/// The right-margin turn squares: one square per turn the server placed, oldest
/// at the top. `on` is the toolbar toggle. How many squares are kept is the
/// server's, not a setting here: the cap is part of the placement
/// (`boop-turnstrip::Options::max_squares`), since trimming the list changes the
/// window's total and therefore every square's `y`.
export const agentSquares = {
  on: setting<boolean>("agentSquares.on", false),
}
