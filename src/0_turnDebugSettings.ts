// Defaults OFF: while `on` reads false the overlay object is never constructed,
// so 0_turnDebugOverlay.ts holds no subscription and no listener.
import { setting } from "./0_persistedSetting"

export const turnDebug = {
  /** Paint per-row Boop turn attribution over every live terminal. */
  on: setting<boolean>("turnDebug.on", false),
}
