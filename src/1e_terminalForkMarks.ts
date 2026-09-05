import type { BoopTurnCommentFork } from "./1b_terminalContextSync";
import type { PlacedAnnotation } from "./1d_terminalTurnMarks";

/// One fork placed on the same row as the comment it spawned, keyed by the
/// comment's internal id.
export type PlacedFork = PlacedAnnotation & { fork: BoopTurnCommentFork };

/// One `PlacedFork` per `(comment_id, lane)`, anchored on the row the comment
/// already placed on (the fork's own markRow is the comment's quote row).
export function placeForks(
  placed: PlacedAnnotation[],
  forks: BoopTurnCommentFork[],
): PlacedFork[] {
  const byComment = new Map<number, PlacedAnnotation>();
  for (const entry of placed) byComment.set(entry.comment.commentId, entry);
  const out: PlacedFork[] = [];
  for (const fork of forks) {
    const annotation = byComment.get(fork.commentId);
    if (annotation) out.push({ ...annotation, fork });
  }
  return out;
}

/// The fork lane's preset from `boop beep fork --preset flash4`; not carried on
/// the fork row, so the block hardcodes it in the header.
const FORK_PRESET = "flash4";

/// Wrap `text` at `cols` on word boundaries, dropping blank runs.
export function wrapText(text: string, cols: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= cols) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/// Rows appended under the quoted turn in the buffer: a header line naming the
/// lane, preset, state and rc, then the lane's reply wrapped to `cols`. A lane
/// that has not replied renders the header only.
export type ForkBlock = { afterBufferRow: number; lines: string[] };

export function forkBlock(fork: PlacedFork, cols: number): ForkBlock {
  const state = fork.fork.state;
  const rc = fork.fork.rc == null ? "" : ` rc=${fork.fork.rc}`;
  const lines = [`└ ${fork.fork.lane} (${FORK_PRESET}) ${state}${rc}`];
  const reply = fork.fork.reply;
  if (reply && state === "done") {
    for (const line of wrapText(reply.said, cols)) lines.push(`  ${line}`);
  }
  return { afterBufferRow: fork.bufferRow, lines };
}
