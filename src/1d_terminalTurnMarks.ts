import type { Signal as SignalOf } from "@hafley66/signals";
import { debounceTime, merge, Subscription } from "rxjs";
import type { VisibleTerminalLine } from "./00b_terminalLineAnchors";
import type { VisibleTurn } from "./0_terminalTurnVisibility";
import type { TerminalContextQueue } from "./1a_terminalContextQueue";
import type { BoopTurnComment } from "./1b_terminalContextSync";
import { gutter_offset_px } from "./1c_terminalHoverCheck";

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
  private lifetime = new Subscription();

  constructor(
    readonly queue: TerminalContextQueue,
    readonly annotations: SignalOf<BoopTurnComment[]>,
  ) {
    this.layer.className = "term-context-marks";
    queue.gutter.appendChild(this.layer);
    this.lifetime.add(
      merge(annotations.$, queue.anchors.visible.$, queue.projection.changes)
        .pipe(debounceTime(150))
        .subscribe(() => this.paint()),
    );
  }

  paint() {
    this.layer.replaceChildren();
    if (!this.queue.enabled()) return;
    const placed = placeAnnotations(this.annotations.$(), this.queue.projection.visible, this.queue.anchors.visible.$());
    if (!placed.length) return;
    const screen = this.queue.host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const hostRect = this.queue.host.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const byRow = new Map<number, PlacedAnnotation[]>();
    for (const entry of placed) byRow.set(entry.bufferRow, [...byRow.get(entry.bufferRow) ?? [], entry]);
    for (const [row, entries] of byRow) {
      const anchor = this.queue.anchors.elementForBufferRow(row);
      if (!anchor) continue;
      const mark = document.createElement("button");
      mark.type = "button";
      mark.className = "term-context-mark";
      mark.textContent = entries.length > 1 ? `✎${entries.length}` : "✎";
      mark.title = markTitle(entries);
      mark.dataset.bufferRow = String(row);
      mark.dataset.commentIds = entries.map((entry) => entry.comment.clientId).join(" ");
      mark.addEventListener("mousedown", (event) => event.stopPropagation());
      mark.addEventListener("click", () => this.requeue(entries));
      const anchorRect = anchor.getBoundingClientRect();
      Object.assign(mark.style, {
        left: `${Math.max(2, screenRect.left - hostRect.left - gutter_offset_px - 18)}px`,
        top: `${anchorRect.top - hostRect.top}px`,
      });
      this.layer.appendChild(mark);
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
    this.lifetime.unsubscribe();
    this.layer.remove();
  }
}
