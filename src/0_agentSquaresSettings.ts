import { setting } from "./0_persistedSetting"

/// The right-margin turn squares: one square per turn on screen, oldest at the
/// top. `on` is the toolbar toggle; `max` caps how many are drawn, keeping the
/// newest end, so a busy pane cannot grow the strip past the viewport.
export const agentSquares = {
  on: setting<boolean>("agentSquares.on", false),
  max: setting<number>("agentSquares.max", 24),
}
