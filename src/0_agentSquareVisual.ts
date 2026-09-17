// The square itself: its geometry, its colour, its animation, and the state the
// animation interpolates from. Framework-free on purpose — a `SignalCreator`
// tree, so a React component, a canvas painter or a test can all drive the same
// square without this module knowing any of them.
//
// The rule that keeps the popovers off the main thread: the pointer never writes
// here. Hover and focus are CSS-only, so moving the mouse re-renders nothing and
// the popover is on screen in the same frame the pointer arrives.
import { SignalCreator, type Signal } from "@hafley66/signals"

/** One square's edge in px. */
export const SQUARE_SIZE = 9
/** Space between two squares. */
export const SQUARE_GAP = 5
/** Distance between two square origins. */
export const SQUARE_STEP = SQUARE_SIZE + SQUARE_GAP
/** The active square's scale. Everything else is 1. */
export const SQUARE_SCALE = 1.55
/** Right margin the terminal gives up while the strip is mounted. */
export const SQUARE_GUTTER = 32
/** A square whose turn is neither active nor adjacent. */
export const SQUARE_DIM = 0.42
/** How many squares either side of the active one stay at full strength. */
export const SQUARE_NEIGHBOURS = 1
/** The strip's animation. Mirrored in 1_agentSquares.css — change both. */
export const SQUARE_EASE = "cubic-bezier(.22,.9,.24,1)"
export const SQUARE_MOVE_MS = 260

export type SquareKind = "user" | "agent" | "tool" | "other"

/** What identifies a square before it has a position or an active flag. */
export type SquareSeed = {
  id: string
  kind: SquareKind
  role: string
  turn: number
  /** Stable identity colour, 0-360. */
  hue: number
  /** The hover line: role, turn number, time. */
  at: string
  /** Popover body. Already resident, so a hover never waits on a read. */
  preview: string
}

export type SquareState = SquareSeed & {
  active: boolean
  /** Offset along the strip, in px, animated by CSS. */
  y: number
  /** 1 at full strength, SQUARE_DIM away from the active square. */
  strength: number
}

export type SquareVisual = Signal<SquareState>

/** One square's reactive state tree. Nested paths (`visual.y.$(next)`) are the
 *  write surface, so a caller moves one field and leaves the rest alone. */
export function createSquareVisual(seed: SquareSeed): SquareVisual {
  return SignalCreator<SquareState>({
    initialState: { ...seed, active: false, y: 0, strength: SQUARE_DIM },
  })
}

/** Move a square to its slot without disturbing the rest of its state. */
export function placeSquare(visual: SquareVisual, y: number, strength: number) {
  if (visual.y.$() !== y) visual.y.$(y)
  if (visual.strength.$() !== strength) visual.strength.$(strength)
}

export function activateSquare(visual: SquareVisual, active: boolean) {
  if (visual.active.$() !== active) visual.active.$(active)
}

/** Every field but the position, replaced in one write. Used when a cap or a
 *  re-projection changes what a square says while its slot stays put. */
export function reseedSquare(visual: SquareVisual, seed: SquareSeed) {
  const current = visual.$()
  if (
    current.kind === seed.kind &&
    current.role === seed.role &&
    current.turn === seed.turn &&
    current.hue === seed.hue &&
    current.at === seed.at &&
    current.preview === seed.preview
  ) {
    return
  }
  visual.$({ ...current, ...seed })
}

/**
 * How strong a square sits relative to the active one. The active square is
 * full, its immediate neighbours are full, and everything past them dims, which
 * is what makes the strip read as a stack with a position rather than a list.
 */
export function strengthAt(index: number, active: number): number {
  if (active < 0) return SQUARE_DIM
  return Math.abs(index - active) <= SQUARE_NEIGHBOURS ? 1 : SQUARE_DIM
}

/** The square's fill. `kind` sets the tone, the turn's own hue sets the shade,
 *  so two turns of the same role never read as the same square. */
export function squareColor(kind: SquareKind, hue: number): string {
  switch (kind) {
    case "user":
      return `hsl(${hue} 82% 62%)`
    case "agent":
      return `hsl(${hue} 58% 54%)`
    case "tool":
      return `hsl(${hue} 24% 46%)`
    default:
      return `hsl(${hue} 12% 52%)`
  }
}

/** The CSS custom properties one square needs. The element's own rules own the
 *  transition; this only states where the square is and what it looks like. */
export function squareVars(state: SquareState): Record<string, string> {
  return {
    "--asq-y": `${state.y}px`,
    "--asq-scale": `${state.active ? SQUARE_SCALE : 1}`,
    "--asq-strength": `${state.strength}`,
    "--asq-color": squareColor(state.kind, state.hue),
    "--asq-shape": state.kind === "tool" ? "1.6px" : "2.4px",
  }
}
