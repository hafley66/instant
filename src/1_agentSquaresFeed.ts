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
 *  answers for every turn in the frame, empty list included. */
export type Strip = {
  session: string
  at: number
  rows: number
  turns: StripTurn[]
  tags: Record<string, string[]>
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
