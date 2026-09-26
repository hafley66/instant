// Turn visibility read off the strip's Rust push ("squares-update"), so overlays,
// gutter and debug labels show the same turns as the squares instead of a polled query.
import type { Terminal } from "@xterm/xterm"
import { Signal } from "@hafley66/signals"
import { filter, map, type Observable } from "rxjs"
import { attachTurnRegions, type LogicalLine, type TurnSpan, type TurnVisibilityModel, type VisibleTurn } from "@hafley66/boop-xterm"
import { SQUARES_EVENT, type Strip } from "./1_agentSquaresFeed"
import { nativeEvent$ } from "./reactive/nativeTransport"

/** The frame's turns on xterm buffer rows: capture row `window.top` is xterm's
 *  first viewport row; pinned and off-window turns have no rows. */
export function stripSpans(frame: Strip, viewportY: number): TurnSpan[] {
  const window = frame.window
  if (!window) return []
  const shift = viewportY - window.top
  return frame.turns
    .filter((turn) => turn.confidence !== "pinned" && turn.buffer_end >= window.top && turn.buffer_start <= window.bottom)
    .map((turn) => ({
      session: turn.session,
      harness: turn.harness,
      turn: turn.turn,
      ts: turn.ts,
      role: turn.role,
      said: turn.said,
      id: turn.id,
      bufferStart: turn.buffer_start + shift,
      bufferEnd: turn.buffer_end + shift,
      anchorStart: turn.anchor_start + shift,
      anchorEnd: turn.anchor_end + shift,
      confidence: turn.confidence as "anchored" | "extended",
      clippedAbove: turn.buffer_start < window.top,
      clippedBelow: turn.buffer_end > window.bottom,
    }))
}

function viewportLines(term: Terminal): LogicalLine[] {
  const buffer = term.buffer.active
  return Array.from({ length: term.rows }, (_, index) => {
    const row = buffer.viewportY + index
    return { text: buffer.getLine(row)?.translateToString(true) ?? "", start: row, end: row }
  })
}

/** The pane's turn visibility, fed by the strip's frames for `session()`. */
export function stripVisibility(
  term: Terminal,
  session: () => string | undefined,
  frames: Observable<Strip> = nativeEvent$<Strip>(SQUARES_EVENT),
): TurnVisibilityModel {
  const state = Signal<{ visible: VisibleTurn[] }>({ visible: [] })
  const changes = Signal<{ visible: VisibleTurn[]; entered: VisibleTurn[]; exited: VisibleTurn[] } | undefined>(undefined)
  const settled = Signal<void | undefined>(undefined)
  const effects = frames.pipe(
    filter((frame) => frame.session === session()),
    map((frame) => {
      const before = state.$().visible
      const visible = attachTurnRegions(stripSpans(frame, term.buffer.active.viewportY), viewportLines(term), true)
      const beforeIds = new Set(before.map((turn) => turn.id))
      const afterIds = new Set(visible.map((turn) => turn.id))
      state.$({ visible })
      changes.$({
        visible,
        entered: visible.filter((turn) => !beforeIds.has(turn.id)),
        exited: before.filter((turn) => !afterIds.has(turn.id)),
      })
      settled.$(undefined)
    }),
  )
  return { state, scanning: Signal(false), changes, settled, effects }
}
