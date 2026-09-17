// The turn strip's data, derived from data the terminal already has: the
// visible-turn projection it computes on activity. Nothing here reads the DOM,
// the store or IPC, so the whole widget is a pure function of its input and a
// test can pin it without a browser.
import { turnHue } from "./0_turnDebugOverlay"
import type { VisibleTurn } from "./0_terminalTurnVisibility"

/** How many characters of a turn a popover carries. The text is already in
 *  memory, so a big cap costs nothing at hover time and never fetches. */
export const PREVIEW_CHARS = 900

/** One square. `kind` picks the side and the shape; `role` keeps the harness's
 *  own word for it. */
export type AgentSquare = {
  id: string
  kind: "user" | "agent" | "tool" | "other"
  role: string
  turn: number
  hue: number
  at: string
  preview: string
  active: boolean
}

export type AgentSquaresProps = {
  squares: AgentSquare[]
  /** Index of the active square, or -1 when the strip is empty. */
  active: number
}

export function kindOf(role: string): AgentSquare["kind"] {
  if (role === "user") return "user"
  if (role === "tool") return "tool"
  if (role === "assistant") return "agent"
  return "other"
}

function label(turn: VisibleTurn): string {
  const when = new Date(turn.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return `${turn.role} · turn ${turn.turn} · ${when}`
}

/**
 * The strip for one terminal: the newest `max` visible turns, oldest first, with
 * the one covering `focusRow` marked active.
 *
 * `focusRow` is the terminal's top visible buffer row, so the active square is
 * the message being looked at, and it follows a scroll without any extra
 * bookkeeping. A row past the last message, or no row at all, falls back to the
 * newest square, which is what a live pane is looking at anyway.
 */
export function squaresOf(
  visible: VisibleTurn[],
  focusRow: number | null,
  max: number,
): AgentSquaresProps {
  const ordered = [...visible].sort((a, b) => a.bufferStart - b.bufferStart)
  const kept = max > 0 ? ordered.slice(Math.max(0, ordered.length - max)) : ordered
  let active = kept.length - 1
  if (focusRow !== null) {
    const hit = kept.findIndex((turn) => focusRow >= turn.bufferStart && focusRow <= turn.bufferEnd)
    // A row above the first kept square means the cap trimmed the message that
    // is actually being read; the oldest square is the closest answer left.
    active = hit >= 0 ? hit : focusRow < (kept[0]?.bufferStart ?? 0) ? 0 : kept.length - 1
  }
  return {
    active,
    squares: kept.map((turn, index) => ({
      id: turn.id,
      kind: kindOf(turn.role),
      role: turn.role,
      turn: turn.turn,
      hue: turnHue(turn.id),
      at: label(turn),
      preview: turn.said.slice(0, PREVIEW_CHARS),
      active: index === active,
    })),
  }
}
