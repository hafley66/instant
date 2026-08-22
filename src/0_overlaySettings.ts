// Window-presentation settings: how instant sits alongside another app. Each is
// one StorageSignal; see 0_persistedSetting.ts for what that replaces.
import { setting } from "./0_persistedSetting"

/** The legal values are the single source: the type below derives from them. */
export const OVERLAY_MODES = ["off", "follow"] as const
export type OverlayMode = (typeof OVERLAY_MODES)[number]

export const overlay = {
  /** "off" = normal summon window, "follow" = track `target`'s focus. */
  mode: setting<OverlayMode>("overlayMode", "off"),
  /** CGWindow owner name whose focus drives "follow", e.g. "Code". */
  target: setting("overlayTarget", "Code"),
  /** Dim the window so it reads as a faded panel. */
  fade: setting("overlayFade", false),
  /** Compact single-column layout and a smaller window. */
  mini: setting("miniMode", false),
}
