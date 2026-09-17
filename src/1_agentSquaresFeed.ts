// The strip's feed. The server watches the pane and pushes; the strip listens
// and asks for nothing on scroll and nothing per square.
//
//   watchSquares(...)  ->  squares_watch  ->  the server's own pane reader
//   squaresFeed(...)   <-  "squares-update"  <-  one frame per projection
//
// The event channel is the same one `pty-data-batch` and the activity pushes
// ride, so the serve binary and the Tauri window deliver it the same way.
import { filter, type Observable } from "rxjs"
import { invoke } from "./generated/native"
import { nativeEvent$ } from "./reactive/nativeTransport"
import type { SquareKind } from "./0_agentSquareVisual"

/** The event the server pushes a projection on. Mirrors `SQUARES_EVENT` in
 *  `src-tauri/src/1_squares.rs` — change both. */
export const SQUARES_EVENT = "squares-update"

/** One turn as the push carries it: the matcher's span plus the turn's text.
 *  `said`'s newline count is the turn's size in the rolling window, so the
 *  strip never reads the store to size a square. */
export type StripTurn = {
  session: string
  harness: string
  turn: number
  ts: number
  role: string
  said: string
  id: string
  bufferStart: number
  bufferEnd: number
  anchorStart: number
  anchorEnd: number
  confidence: "anchored" | "extended"
}

/** One pushed frame. `tags` is keyed by source (`turn:<session>:<turn>`) and
 *  answers for every turn in the frame, empty list included.
 *
 *  `layout` is the server's own placement of those turns, computed by
 *  `boop-turnstrip` from the pane capture plus tmux's `#{pane_height}` (a
 *  scrolled pane is a copy-mode view, so the window is the capture's last
 *  `pane_height` rows and the client reports nothing). `null` means the height
 *  could not be read: the frame still carries spans and marks, and the strip
 *  draws nothing. */
export type Strip = {
  session: string
  at: number
  rows: number
  turns: StripTurn[]
  tags: Record<string, string[]>
  layout: StripLayout | null
}

/** One square's place in the strip, in the server's own numbers. */
export type SquareLayout = {
  id: string
  kind: SquareKind
  /** Where the square sits on the strip's track, oldest at 0. */
  y: number
  scale: number
  active: boolean
}

/** The strip itself: every square, the window's total, and the on-screen range. */
export type StripLayout = {
  squares: SquareLayout[]
  /** Estimated rows the whole window occupies: the strip's denominator. */
  span: number
  block: { top: number; height: number }
}

export type SquaresWatch = {
  /** The pane's own id: the pty stream wakes the feed on this. */
  pty: string
  /** The boop session the turns are read for. */
  session: string
  /** The tmux target the pane is captured by. */
  target: string
  socket?: string
}

/** The projections for one session. A frame for another session is dropped
 *  here, so a tab never draws a neighbour's strip. */
export function squaresFeed(session: string, frames: Observable<Strip> = nativeEvent$<Strip>(SQUARES_EVENT)): Observable<Strip> {
  return frames.pipe(filter((frame) => frame.session === session))
}

/**
 * Start the server watching a pane. The returned function stops it, and the
 * caller owns it: a disposed tab must not leave a thread capturing its pane.
 */
export async function watchSquares(input: SquaresWatch, send: typeof invoke = invoke): Promise<() => Promise<void>> {
  await send("squares_watch", { ...input })
  return () => send("squares_unwatch", { pty: input.pty })
}
