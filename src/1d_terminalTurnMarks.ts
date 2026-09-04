import type { Signal as SignalOf } from "@hafley66/signals";
import { Subscription } from "rxjs";
import type { VisibleTerminalLine } from "./00b_terminalLineAnchors";
import { gutterLeft, rowOnScreen, rowTop } from "./0_terminalRowGeometry";
import type { VisibleTurn } from "./0_terminalTurnVisibility";
import type { TerminalContextQueue } from "./1a_terminalContextQueue";
import { gutter_offset_px, type GutterPaint } from "./1a2_terminalContextGutter";
import type { BoopTurnComment } from "./1b_terminalContextSync";

/// A sent comment placed on screen: the turn it quoted and the row its quote
/// starts on.
export type PlacedAnnotation = { comment: BoopTurnComment; turn: VisibleTurn; bufferRow: number };

function normalize(line: string): string {
  return line.toLowerCase().replace(/[`_*~#|]/g, " ").replace(/\s+/g, " ").trim();
}

/// The visible row a comment's quote starts on inside `turn`, by text; the
/// turn's own first anchored row when the quote is scrolled off or reflowed
/// past recognition. `null` when nothing of the turn is on screen.
export function markRowFor(
  comment: BoopTurnComment,
  turn: Pick<VisibleTurn, "bufferStart" | "bufferEnd" | "anchorStart">,
  lines: VisibleTerminalLine[],
): number | null {
  const first = normalize(comment.quote.split("\n").find((line) => line.trim()) ?? "");
  const inTurn = lines.filter((line) => line.bufferEnd >= turn.bufferStart && line.bufferStart <= turn.bufferEnd);
  if (first.length >= 3) {
    const hit = inTurn.find((line) => normalize(line.text).includes(first));
    if (hit) return hit.bufferStart;
  }
  const fallback = inTurn.find((line) => line.bufferStart >= turn.anchorStart) ?? inTurn[0];
  return fallback ? fallback.bufferStart : null;
}

/// Every sent comment that targets a visible turn, placed on a row.
export function placeAnnotations(
  comments: BoopTurnComment[],
  turns: VisibleTurn[],
  lines: VisibleTerminalLine[],
): PlacedAnnotation[] {
  return comments.flatMap((comment) => comment.targets.flatMap((target) => {
    const turn = turns.find((candidate) => candidate.id === `${target.session}:${target.turn}`);
    if (!turn) return [];
    const bufferRow = markRowFor(comment, turn, lines);
    return bufferRow === null ? [] : [{ comment, turn, bufferRow }];
  }));
}

/// The tooltip for the marks stacked on one row: each note, its quote's first
/// line, and the turn that answered it.
export function markTitle(placed: PlacedAnnotation[]): string {
  return placed.map(({ comment, turn }) => {
    const target = comment.targets.find((candidate) => `${candidate.session}:${candidate.turn}` === turn.id);
    const reply = target?.replyTurn == null ? "reply: not ingested yet" : `reply: turn ${target.replyTurn}`;
    const quote = comment.quote.split("\n").find((line) => line.trim())?.trim() ?? "";
    return `${comment.note?.trim() || "(no note)"}\n> ${quote}\n${reply}`;
  }).join("\n\n");
}

/// Sent comments painted back onto the turns they quoted: a pencil in the
/// gutter on the quote's row, the note and reply turn on hover, and a click
/// that re-queues the slice with its note for a follow-up.
export class TerminalTurnMarks {
  readonly layer = document.createElement("div");
  /// One button per stack of marks, keyed by the comments it carries and
  /// reused across paints so a hovered tooltip survives the next frame.
  readonly marks = new Map<string, HTMLButtonElement>();
  private placedByKey = new Map<string, PlacedAnnotation[]>();
  private lifetime = new Subscription();
  private follow = (paint: GutterPaint) => this.paint(paint);

  constructor(
    readonly queue: TerminalContextQueue,
    readonly annotations: SignalOf<BoopTurnComment[]>,
  ) {
    this.layer.className = "term-context-marks";
    queue.gutter.appendChild(this.layer);
    this.lifetime.add(annotations.$.subscribe(() => queue.gutterPaint.schedule()));
    queue.gutterPaint.followers.add(this.follow);
  }

  markFor(key: string): HTMLButtonElement {
    const existing = this.marks.get(key);
    if (existing) return existing;
    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = "term-context-mark";
    mark.dataset.commentIds = key;
    mark.addEventListener("mousedown", (event) => event.stopPropagation());
    mark.addEventListener("click", () => {
      const entries = this.placedByKey.get(key);
      if (entries) this.requeue(entries);
    });
    this.layer.appendChild(mark);
    this.marks.set(key, mark);
    return mark;
  }

  paint({ geometry, turns, lines }: GutterPaint) {
    const placed = this.queue.enabled() ? placeAnnotations(this.annotations.$(), turns, lines) : [];
    const byRow = new Map<number, PlacedAnnotation[]>();
    for (const entry of placed) byRow.set(entry.bufferRow, [...byRow.get(entry.bufferRow) ?? [], entry]);
    const left = gutterLeft(geometry, gutter_offset_px + 18);
    this.placedByKey.clear();
    for (const [row, entries] of byRow) {
      const key = entries.map((entry) => entry.comment.clientId).join(" ");
      this.placedByKey.set(key, entries);
      const mark = this.markFor(key);
      const label = entries.length > 1 ? `✎${entries.length}` : "✎";
      if (mark.textContent !== label) mark.textContent = label;
      mark.title = markTitle(entries);
      mark.dataset.bufferRow = String(row);
      mark.hidden = !rowOnScreen(geometry, row);
      mark.style.left = `${left}px`;
      mark.style.top = `${rowTop(geometry, row)}px`;
    }
    for (const [key, mark] of this.marks) {
      if (this.placedByKey.has(key)) continue;
      mark.remove();
      this.marks.delete(key);
    }
  }

  /// Put the annotated slices back in the queue, notes prefilled, and land
  /// the caret in the first note.
  requeue(entries: PlacedAnnotation[]) {
    let first: string | null = null;
    for (const { comment, turn } of entries) {
      const id = this.queue.addSelection({
        text: comment.quote,
        turnIds: [turn.id],
        note: comment.note ?? undefined,
      });
      first ??= id;
    }
    if (first) this.queue.focusNote(first);
  }

  dispose() {
    this.queue.gutterPaint.followers.delete(this.follow);
    this.lifetime.unsubscribe();
    this.marks.clear();
    this.placedByKey.clear();
    this.layer.remove();
  }
}
