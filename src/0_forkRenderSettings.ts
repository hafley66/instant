// Defaults to the overlay: while `livePane` reads false no fork polls tmux.
import { setting } from "./0_persistedSetting"

export const forkRender = {
  /** false: click-to-expand overlay on the mark row. true: a child pane bound
   *  to the fork lane's tmux session. */
  livePane: setting<boolean>("forkRender.livePane", false),
  /** The preset the Fork row last ran, so the next fork repeats it. */
  lastPreset: setting<string>("fork.lastPreset", ""),
}
