// Defaults OFF: the package overlay watches this signal before mounting.
import { setting } from "./0_persistedSetting"

export const turnDebug = {
  /** Paint per-row Boop turn attribution over every live terminal. */
  on: setting<boolean>("turnDebug.on", false),
}
