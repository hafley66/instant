// The strip's data, wrapped from the server's push. Where a square sits on the
// strip, how big it is and which one is being read are the server's numbers:
// `boop-turnstrip` measures them from the pane it already watches, so nothing
// here re-derives a row, estimates a height, or reads a buffer. What is left is
// what only a view can decide — the hue a turn is drawn in, its popover header,
// the preview slice of text the frame already carries, and the px the server's
// own units land on once the pane's row height is known: a row for the mode that
// counts rows, and a restacking of the recent block around the square the reader
// is inside.
//
// The chain, and where this module sits in it:
//
//   pane capture + tags          server (`squares_update` push)
//     -> `Strip`                 src/1_agentSquaresFeed.ts   (the wire shape)
//     -> `AgentSquaresProps`     this module: the view's own fields, in px
//     -> `<AgentSquaresView/>`   the strip, which draws what it is given
import { turnHue } from "./0_turnDebugOverlay"
import { SQUARE_STEP, type SquareKind } from "./0_agentSquareVisual"
import type { Strip, StripTurn } from "./1_agentSquaresFeed"

/** How many characters of a turn the *popover* carries, and what the frame
 *  slices per square. A projection runs several times a second while the pane
 *  writes, so this is a per-frame cost and stays small: the card, which is what
 *  a reader opens to actually read a turn, draws the whole turn it was handed
 *  (`TurnPanelTarget.turn`), and only falls back to this slice when the caller
 *  has no turn. */
export const PREVIEW_CHARS = 4000

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
  gap?: { y: number }
  squares: AgentSquare[]
  /** Index of the active square, or -1 when the strip is empty. */
  active: number
  /** How many of `squares` are the band's. They come first, oldest first. */
  band: number
  /** The strip's own height in px, which the view writes to `--asq-track`. */
  track: number
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

/** One square's px along the track in the mode that counts rows: a row inside
 *  the reader's window, so a square moves with the scroll. `recent` counts
 *  places in a block instead, and `ridingY` places that block. */
function rowY(y: number, geometry: SquareGeometry): number {
  return y * geometry.cellHeight
}

/** The reader's own line: where the square for the turn they are reading sits,
 *  and the line the rest of the block is stacked around. The pane's bottom edge,
 *  because that is where a live reader's attention is — the newest turn's square
 *  belongs on it — and a reader who scrolls back into history takes the block
 *  with them. */

/** A recent square's px on the track: the active one sits on the reader's line
 *  and every other is `SQUARE_STEP` away from it, older above and newer below,
 *  so a scroll drags the whole block instead of leaving it where it was. The
 *  block is pushed down when it would run off the pane's top, which is the one
 *  edge a reader cannot scroll past: the older turns stay on the strip while the
 *  newer ones the reader has left behind fall off the bottom. */

/**
 * One square per turn the server placed, in the order it placed them. Only the
 * conversation's own turns reach it: the server drops tool and meta turns from
 * the layout, so nothing here re-filters a kind or a role.
 *
 * A frame with no layout — the pane's height could not be read — draws nothing
 * rather than guessing a position. A placed turn the frame does not carry is
 * dropped rather than drawn blank: the layout is derived from these turns, so
 * that combination is a server bug, not a state to render.
 */
export function squaresOf(frame: Strip, geometry: SquareGeometry): AgentSquaresProps {
  const layout = frame.layout
  if (!layout) return { squares: [], active: -1, band: 0, track: geometry.track }
  // A band square refers to a turn the matcher never saw, so the frame carries
  // those separately; both sets are the frame's turns as far as a square is
  // concerned. Only `relative` has a band.
  const band = layout.mode === "relative" ? layout.band : 0
  const turns = new Map([...frame.turns, ...frame.pinned].map((turn) => [turn.id, turn]))
  const squares: AgentSquare[] = []
  layout.squares.forEach((square, index) => {
    const turn = turns.get(square.id)
    if (!turn) return
    const pinned = index < band
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
      y: pinned ? index * SQUARE_STEP : rowY(square.y, geometry),
      scale: square.scale,
      active: square.active,
      pinned,
    })
  })
  // The recency block rides the reader: it is restacked around whichever square
  // the reader's window is inside, which is the one fact a frame carries that a
  // place in the block does not. Without an active square — a bug rather than a
  // state — the newest is the anchor, which is where a live reader stands.
  if (layout.mode === "recent") {
    const start = Math.max(0, (geometry.track - (squares.length - 1) * SQUARE_STEP) / 2)
    squares.forEach((square, index) => {
      square.y = start + index * SQUARE_STEP
    })
  }
  const before = squares.find((square) => square.id === layout.gap?.beforeId)
  const after = squares.find((square) => square.id === layout.gap?.afterId)
  const gapY = before && after ? (before.y + after.y) / 2
    : before ? before.y + SQUARE_STEP / 2 : after ? after.y - SQUARE_STEP / 2 : geometry.track / 2
  return {
    ...(layout.gap ? { gap: { y: gapY } } : {}),
    squares,
    active: squares.findIndex((square) => square.active),
    band,
    track: layout.mode === "relative" ? layout.rows * geometry.cellHeight : geometry.track,
  }
}
