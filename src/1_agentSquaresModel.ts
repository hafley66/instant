// The strip's data, wrapped from the server's push. Where a square sits on the
// strip, how big it is and which one is being read are the server's numbers:
// `boop-turnstrip` measures them from the pane it already watches, so nothing
// here re-derives a row, estimates a height, or reads a buffer. What is left is
// what only a view can decide — the hue a turn is drawn in, its popover header,
// the preview slice of text the frame already carries, and the px the server's
// own units land on once the pane's row height is known.
//
// The chain, and where this module sits in it:
//
//   pane capture + tags          server (`squares_update` push)
//     -> `Strip`                 src/1_agentSquaresFeed.ts   (the wire shape)
//     -> `AgentSquaresProps`     this module: the view's own fields, in px
//     -> `<AgentSquaresView/>`   the strip, which draws what it is given
import { turnHue } from "./0_turnDebugOverlay"
import { SQUARE_STEP, type SquareKind } from "./0_agentSquareVisual"
import type { Strip, StripLayout, StripTurn } from "./1_agentSquaresFeed"

/** How many characters of a turn a popover carries. The text is already in
 *  memory, so a big cap costs nothing at hover time and never fetches. */
export const PREVIEW_CHARS = 900

/** How tall the reader's window draws in the map, least. A window one row tall
 *  would otherwise be a hairline the reader cannot find. */
const BLOCK_MIN = 6

/** The pane's own px, which only the view can measure: one row's height, and
 *  how tall the strip itself draws. */
export type SquareGeometry = { cellHeight: number; track: number }

/** One square, ready to draw: the server's placement in px, plus the view's own
 *  dressing. */
export type AgentSquare = {
  id: string
  kind: SquareKind
  role: string
  turn: number
  hue: number
  at: string
  preview: string
  /** Offset along the strip in px, animated by CSS. A band square's offset is
   *  its place in the band's own lane, not a row. */
  y: number
  scale: number
  active: boolean
  /** True for a turn the mode placed nothing for: it draws in the band lane,
   *  where `y` counts places in the band and nothing counts as the reader's
   *  position. */
  pinned: boolean
}

export type AgentSquaresProps = {
  squares: AgentSquare[]
  /** Index of the active square, or -1 when the strip is empty. */
  active: number
  /** How many of `squares` are the band's. They come first, oldest first. */
  band: number
  /** The strip's own height in px, which the view writes to `--asq-track`. */
  track: number
  /** The reader's rows in the same px, or `null` in relative mode, where the
   *  whole track *is* the window. */
  block: { top: number; height: number } | null
}

function label(turn: StripTurn): string {
  const when = new Date(turn.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return `${turn.role} · turn ${turn.turn} · ${when}`
}

/** The popover's slice of a turn. The store keeps whatever the pane wrote, so
 *  the escape text and the two-character `\n` are turned back into what they
 *  mean before the slice: a preview full of `\u001b[0m` reads as nothing at any
 *  width. Both spellings of the escape are stripped, the decoded control byte
 *  the JSON carries and the written form a pane can quote. */
export function previewOf(said: string): string {
  return said
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\\u001b\[[0-9;]*[A-Za-z]|\\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\\n/g, "\n")
    .slice(0, PREVIEW_CHARS)
}

/** One square's px along the track, from the units its mode counts in. Relative
 *  counts rows inside the reader's window, map counts estimated buffer rows, so
 *  the same square moves with the scroll in one mode and not the other. The
 *  crate never sends a span of 0; a frame from a server that did would divide
 *  the whole strip away, so a bad denominator degrades to 1. */
function trackY(layout: StripLayout, y: number, geometry: SquareGeometry): number {
  if (layout.mode === "relative") return y * geometry.cellHeight
  return (y / (layout.span > 0 ? layout.span : 1)) * geometry.track
}

/** The reader's rows on the map's track, kept visible even when the window is a
 *  sliver of the map. */
function blockOf(layout: StripLayout, geometry: SquareGeometry): { top: number; height: number } | null {
  if (layout.mode === "relative") return null
  const denominator = layout.span > 0 ? layout.span : 1
  return {
    top: (layout.block.top / denominator) * geometry.track,
    height: Math.max(BLOCK_MIN, (layout.block.height / denominator) * geometry.track),
  }
}

/**
 * One square per turn the server placed, in the order it placed them.
 *
 * A frame with no layout — the pane's height could not be read — draws nothing
 * rather than guessing a position. A placed turn the frame does not carry is
 * dropped rather than drawn blank: the layout is derived from these turns, so
 * that combination is a server bug, not a state to render.
 */
export function squaresOf(frame: Strip, geometry: SquareGeometry): AgentSquaresProps {
  const layout = frame.layout
  if (!layout) return { squares: [], active: -1, band: 0, track: geometry.track, block: null }
  // A band square refers to a turn the matcher never saw, so the frame carries
  // those separately; both sets are the frame's turns as far as a square is
  // concerned.
  const turns = new Map([...frame.turns, ...frame.pinned].map((turn) => [turn.id, turn]))
  const squares: AgentSquare[] = []
  layout.squares.forEach((square, index) => {
    const turn = turns.get(square.id)
    if (!turn) return
    const pinned = index < layout.band
    squares.push({
      id: square.id,
      kind: square.kind,
      role: turn.role,
      turn: turn.turn,
      hue: turnHue(square.id),
      at: label(turn),
      preview: previewOf(turn.said),
      // A band square is a place in the band, not a row: the server counts it in
      // band positions, so it lands that many steps down its own lane.
      y: pinned ? index * SQUARE_STEP : trackY(layout, square.y, geometry),
      scale: square.scale,
      active: square.active,
      pinned,
    })
  })
  return {
    squares,
    active: squares.findIndex((square) => square.active),
    band: layout.band,
    track: layout.mode === "relative" ? layout.rows * geometry.cellHeight : geometry.track,
    block: blockOf(layout, geometry),
  }
}