// The strip's data, wrapped from the server's push. Where a square sits, how
// big it is and which one is being read are the server's numbers: `boop-turnstrip`
// measures them from the pane it already watches, so nothing here re-derives a
// row, estimates a height, or reads a buffer. What is left is what only a view
// can decide — the hue a turn is drawn in, its popover header, and the preview
// slice of text the frame already carries.
//
// The chain, and where this module sits in it:
//
//   pane capture + tags          server (`squares_update` push)
//     -> `Strip`                 src/1_agentSquaresFeed.ts   (the wire shape)
//     -> `AgentSquaresProps`     this module: the view's own fields
//     -> `<AgentSquaresView/>`   the strip, which draws what it is given
import { turnHue } from "./0_turnDebugOverlay"
import type { SquareKind } from "./0_agentSquareVisual"
import type { Strip, StripTurn } from "./1_agentSquaresFeed"

/** How many characters of a turn a popover carries. The text is already in
 *  memory, so a big cap costs nothing at hover time and never fetches. */
export const PREVIEW_CHARS = 900

/** One square, ready to draw: the server's placement plus the view's own
 *  dressing. `kind` and the three geometry fields come off the wire unchanged. */
export type AgentSquare = {
  id: string
  kind: SquareKind
  role: string
  turn: number
  hue: number
  at: string
  preview: string
  y: number
  scale: number
  active: boolean
}

export type AgentSquaresProps = {
  squares: AgentSquare[]
  /** Index of the active square, or -1 when the strip is empty. */
  active: number
}

function label(turn: StripTurn): string {
  const when = new Date(turn.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return `${turn.role} · turn ${turn.turn} · ${when}`
}

/**
 * One square per turn the server placed, in the order it placed them.
 *
 * A frame with no layout — the pane's height could not be read — draws nothing
 * rather than guessing a position. A placed turn the frame does not carry is
 * dropped rather than drawn blank: the layout is derived from these turns, so
 * that combination is a server bug, not a state to render.
 */
export function squaresOf(frame: Strip): AgentSquaresProps {
  const layout = frame.layout
  if (!layout) return { squares: [], active: -1 }
  const turns = new Map(frame.turns.map((turn) => [turn.id, turn]))
  const squares: AgentSquare[] = []
  for (const square of layout.squares) {
    const turn = turns.get(square.id)
    if (!turn) continue
    squares.push({
      id: square.id,
      kind: square.kind,
      role: turn.role,
      turn: turn.turn,
      hue: turnHue(square.id),
      at: label(turn),
      preview: turn.said.slice(0, PREVIEW_CHARS),
      y: square.y,
      scale: square.scale,
      active: square.active,
    })
  }
  return { squares, active: squares.findIndex((square) => square.active) }
}
