import { Subject, type Observable, type Subscription } from "rxjs";
import { projectTurnRegions, regionAtBufferRow, type ProjectedTurnRegion } from "./00_terminalTurnRegions";
import type { LogicalLine, TmuxPane, XtermViewport } from "./00a_terminalIntersection";

export type BoopTurn = {
  session: string;
  harness: string;
  turn: number;
  ts: number;
  role: string;
  said: string;
};

export type VisibleTurn = BoopTurn & {
  id: string;
  bufferStart: number;
  bufferEnd: number;
  regions: ProjectedTurnRegion[];
  confidence: "anchored" | "extended";
  provenance: "xterm+boop" | "xterm+tmux+boop";
};

export type TurnVisibilityEvent = {
  visible: VisibleTurn[];
  entered: VisibleTurn[];
  exited: VisibleTurn[];
};

const turnId = (turn: Pick<BoopTurn, "session" | "turn">) => `${turn.session}:${turn.turn}`;

export function normalizeTurnLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/^\s*[│┃┆┊╎╏┌└├┬╭╰>*•●◉⏺⏵◆›❯»▶🭬]+\s*/, "")
    .replace(/[`_*~#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function locateVisibleTurns(lines: LogicalLine[], turns: BoopTurn[], tmuxCapture = ""): VisibleTurn[] {
  if (typeof tmuxCapture !== "string") tmuxCapture = "";
  const screen = lines.map((line) => ({ ...line, normalized: normalizeTurnLine(line.text) }));
  const tmuxLines = new Set(tmuxCapture.split("\n").map(normalizeTurnLine).filter(Boolean));
  const tmuxBacked = screen.some((line) => line.normalized && tmuxLines.has(line.normalized));
  const owners = new Map<string, Set<string>>();
  const sources = turns.map((turn) => {
    const id = turnId(turn);
    const normalized = turn.said
      .split("\n")
      .map(normalizeTurnLine)
      .filter(Boolean);
    for (const line of new Set(normalized)) {
      const set = owners.get(line) ?? new Set<string>();
      set.add(id);
      owners.set(line, set);
    }
    return { turn, id, normalized };
  });

  const visible: VisibleTurn[] = [];
  for (const source of sources) {
    const hits = screen.flatMap((row) => {
      const sourceIndex = source.normalized.findIndex((anchor) =>
        owners.get(anchor)?.size === 1 && (
          row.normalized === anchor || anchor.length >= 8 && (
            row.normalized.includes(anchor) || anchor.includes(row.normalized) && row.normalized.length >= 12
          )
        )
      );
      return sourceIndex < 0 ? [] : [{ ...row, sourceIndex }];
    });
    if (!hits.length) continue;
    visible.push({
      ...source.turn,
      id: source.id,
      bufferStart: Math.min(...hits.map((hit) => hit.start)),
      bufferEnd: Math.max(...hits.map((hit) => hit.end)),
      regions: [],
      confidence: "anchored",
      provenance: tmuxBacked ? "xterm+tmux+boop" : "xterm+boop",
    });
  }
  const sorted = visible.sort((a, b) => a.bufferStart - b.bufferStart || a.turn - b.turn);
  if (!lines.length) return sorted;
  const viewportStart = lines[0].start;
  const viewportEnd = lines[lines.length - 1].end;
  return sorted.map((turn, index) => {
    const span = {
      bufferStart: index === 0 ? viewportStart : turn.bufferStart,
      bufferEnd: index + 1 < sorted.length ? sorted[index + 1].bufferStart - 1 : viewportEnd,
    };
    const extended = span.bufferStart !== turn.bufferStart || span.bufferEnd !== turn.bufferEnd;
    return {
      ...turn,
      ...span,
      confidence: extended ? "extended" : "anchored",
      regions: projectTurnRegions(turn.id, turn.said, span, lines, normalizeTurnLine),
    };
  });
}

export class TerminalTurnVisibilityV2 {
  updates = new Subject<TurnVisibilityEvent>();
  readonly changes: Observable<TurnVisibilityEvent> = this.updates;
  visible: VisibleTurn[] = [];
  generation = 0;
  frame = 0;
  disposed = false;
  scanning = false;
  rescanPending = false;
  subscription: Subscription;

  constructor(
    readonly viewport: XtermViewport,
    readonly turns: () => Promise<BoopTurn[]>,
    readonly tmux?: TmuxPane,
  ) {
    this.subscription = viewport.changes.subscribe(() => this.schedule());
    this.schedule();
  }

  schedule() {
    if (this.scanning) {
      this.rescanPending = true;
      return;
    }
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.scanning = true;
      void this.scan().finally(() => {
        this.scanning = false;
        if (!this.rescanPending) return;
        this.rescanPending = false;
        this.schedule();
      });
    });
  }

  async scan(supplied?: BoopTurn[]) {
    const generation = ++this.generation;
    const [turns, tmuxCapture] = await Promise.all([
      supplied ? Promise.resolve(supplied) : this.turns(),
      this.tmux?.captureVisible().catch(() => "") ?? Promise.resolve(""),
    ]);
    if (this.disposed || generation !== this.generation) return;
    const next = locateVisibleTurns(this.viewport.readVisibleLogicalLines(), turns, tmuxCapture);
    const before = new Map(this.visible.map((turn) => [turn.id, turn]));
    const after = new Map(next.map((turn) => [turn.id, turn]));
    const entered = next.filter((turn) => !before.has(turn.id));
    const exited = this.visible.filter((turn) => !after.has(turn.id));
    const moved = next.some((turn) => {
      const prior = before.get(turn.id);
      return prior && (prior.bufferStart !== turn.bufferStart || prior.bufferEnd !== turn.bufferEnd);
    });
    this.visible = next;
    if (entered.length || exited.length || moved) this.updates.next({ visible: next, entered, exited });
  }

  bufferRowAtClientPoint(clientY: number): number | null {
    return this.viewport.bufferRowAtClientY(clientY);
  }

  turnAtBufferRow(bufferRow: number): VisibleTurn | null {
    return this.visible.find((turn) => turn.bufferStart <= bufferRow && bufferRow <= turn.bufferEnd) ?? null;
  }

  turnAtClientPoint(_clientX: number, clientY: number): VisibleTurn | null {
    const row = this.bufferRowAtClientPoint(clientY);
    return row === null ? null : this.turnAtBufferRow(row);
  }

  regionAtClientPoint(clientX: number, clientY: number): ProjectedTurnRegion | null {
    const row = this.bufferRowAtClientPoint(clientY);
    const turn = this.turnAtClientPoint(clientX, clientY);
    return row === null || !turn ? null : regionAtBufferRow(turn.regions, row);
  }

  dispose() {
    this.disposed = true;
    this.generation++;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.subscription.unsubscribe();
    this.updates.complete();
  }
}
