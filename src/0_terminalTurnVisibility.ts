import { debounceTime, filter, share, Subject, type Observable, Subscription } from "rxjs";
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
  anchorStart: number;
  anchorEnd: number;
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
    .replace(/^\s*[│┃┆┊╎╏┌└├┬╭╰>*•●◉⏺⏵◆›❯»▶🭬✨✳✻⎿━─┏┓┗┛┠┨┯┷┼╂╄╅╆╇╈╉╊═║╔╗╚╝╠╣╦╩╬]+\s*/, "")
    // Inline markdown markers vanish in the rendered pane: `x`, **x**, _x_,
    // ~~x~~, # heading. Deleting (not spacing) them keeps "(`5a38640`)" equal
    // to the on-screen "(5a38640)". Cell/border glyphs become spaces since the
    // renderer pads them out.
    .replace(/[`_*~#]/g, "")
    .replace(/[━─┏┓┗┛┠┨┯┷┼╂╄╅╆╇╈╉╊═║╔╗╚╝╠╣╦╩╬|│┃┆┊╎╏┌┐└┘├┤┬┴]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type TurnMatch = {
  source: { turn: BoopTurn; id: string; normalized: string[] };
  hits: Array<LogicalLine & { sourceIndex: number }>;
  sourceSpan: number;
};

// A short source line found inside a long rendered row is a coincidence, so
// containment either way must cover half the longer string.
function lineMatches(screen: string, source: string): boolean {
  return screen === source || source.length >= 8 && (
    screen.includes(source) && source.length * 2 >= screen.length
    || source.includes(screen) && screen.length >= 12
  );
}

function monotonicTurnMatch(
  screen: Array<LogicalLine & { normalized: string }>,
  source: TurnMatch["source"],
): TurnMatch | null {
  const rows = screen.filter((row) => row.normalized);
  const rowCount = rows.length;
  const sourceCount = source.normalized.length;
  const scores = Array.from({ length: rowCount + 1 }, () => new Uint32Array(sourceCount + 1));
  for (let row = 1; row <= rowCount; row += 1) {
    for (let column = 1; column <= sourceCount; column += 1) {
      const matchScore = lineMatches(rows[row - 1].normalized, source.normalized[column - 1])
        ? scores[row - 1][column - 1] + 1000
          + Math.min(rows[row - 1].normalized.length, source.normalized[column - 1].length)
        : 0;
      scores[row][column] = Math.max(matchScore, scores[row - 1][column], scores[row][column - 1]);
    }
  }
  if (scores[rowCount][sourceCount] === 0) return null;
  const hits: TurnMatch["hits"] = [];
  let row = rowCount;
  let column = sourceCount;
  while (row > 0 && column > 0) {
    if (lineMatches(rows[row - 1].normalized, source.normalized[column - 1])
      && scores[row][column] === scores[row - 1][column - 1] + 1000
        + Math.min(rows[row - 1].normalized.length, source.normalized[column - 1].length)) {
      hits.push({ ...rows[row - 1], sourceIndex: column - 1 });
      row -= 1;
      column -= 1;
    } else if (scores[row - 1][column] >= scores[row][column - 1]) {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  hits.reverse();
  const sourceSpan = hits[hits.length - 1].sourceIndex - hits[0].sourceIndex + 1;
  return { source, hits, sourceSpan };
}

// The monotonic match is 1:1, so a source line an app hard-wraps across
// several screen rows anchors only one of them; walk the rest back in.
function growAnchors(
  visible: VisibleTurn[],
  screen: Array<LogicalLine & { normalized: string }>,
  sources: TurnMatch["source"][],
) {
  const rows = screen.filter((row) => row.normalized);
  const anchored = new Map(visible.map((turn) => [turn.id, turn]));
  const ownerAt = new Map<number, string>();
  for (const turn of visible) {
    for (const row of rows) {
      if (row.start >= turn.anchorStart && row.end <= turn.anchorEnd) ownerAt.set(row.start, turn.id);
    }
  }
  for (const [id, turn] of anchored) {
    const source = sources.find((candidate) => candidate.id === id);
    if (!source) continue;
    const claims = (row: LogicalLine & { normalized: string }) =>
      (ownerAt.get(row.start) ?? id) === id
      && source.normalized.some((line) => lineMatches(row.normalized, line));
    const first = rows.findIndex((row) => row.start >= turn.anchorStart);
    if (first < 0) continue;
    let low = first;
    while (low > 0 && claims(rows[low - 1])) low -= 1;
    let high = rows.findIndex((row) => row.end >= turn.anchorEnd);
    if (high < 0) high = rows.length - 1;
    while (high + 1 < rows.length && claims(rows[high + 1])) high += 1;
    turn.anchorStart = Math.min(turn.anchorStart, rows[low].start);
    turn.anchorEnd = Math.max(turn.anchorEnd, rows[high].end);
    turn.bufferStart = turn.anchorStart;
    turn.bufferEnd = turn.anchorEnd;
    for (let index = low; index <= high; index += 1) ownerAt.set(rows[index].start, id);
  }
}

// A pane tmux also sees is a pane whose rows two readers agree on.
export function tmuxConfirms(lines: LogicalLine[], tmuxCapture: string): boolean {
  const tmuxLines = new Set(tmuxCapture.split("\n").map(normalizeTurnLine).filter(Boolean));
  return lines.some((line) => {
    const normalized = normalizeTurnLine(line.text);
    return normalized.length > 0 && tmuxLines.has(normalized);
  });
}

export function locateVisibleTurns(lines: LogicalLine[], turns: BoopTurn[], tmuxCapture = ""): VisibleTurn[] {
  if (typeof tmuxCapture !== "string") tmuxCapture = "";
  const screen = lines.map((line) => ({ ...line, normalized: normalizeTurnLine(line.text) }));
  const tmuxBacked = tmuxConfirms(lines, tmuxCapture);
  const sources = turns.map((turn) => {
    const id = turnId(turn);
    const normalized = turn.said
      .split("\n")
      .map(normalizeTurnLine)
      .filter(Boolean);
    return { turn, id, normalized };
  });

  const matches = sources
    .map((source) => monotonicTurnMatch(screen, source))
    .filter((match): match is TurnMatch => match !== null)
    .sort((left, right) =>
      right.hits.length - left.hits.length
      || left.sourceSpan - right.sourceSpan
      || left.source.normalized.length - right.source.normalized.length
      || right.source.turn.ts - left.source.turn.ts
    );
  const claimedRows = new Set<number>();
  const visible: VisibleTurn[] = [];
  for (const { source, hits } of matches) {
    const unclaimed = hits.filter((hit) => !claimedRows.has(hit.start));
    if (unclaimed.length * 2 < hits.length) continue;
    for (const hit of hits) claimedRows.add(hit.start);
    const anchorStart = Math.min(...hits.map((hit) => hit.start));
    const anchorEnd = Math.max(...hits.map((hit) => hit.end));
    visible.push({
      ...source.turn,
      id: source.id,
      bufferStart: anchorStart,
      bufferEnd: anchorEnd,
      anchorStart,
      anchorEnd,
      regions: [],
      confidence: "anchored",
      provenance: tmuxBacked ? "xterm+tmux+boop" : "xterm+boop",
    });
  }
  growAnchors(visible, screen, sources);
  const sorted = visible.sort((a, b) => a.bufferStart - b.bufferStart || a.turn - b.turn);
  if (!lines.length) return sorted;
  const viewportStart = lines[0].start;
  const viewportEnd = lines[lines.length - 1].end;
  return attachTurnRegions(
    sorted.map((turn, index) => {
      const span = {
        bufferStart: index === 0 ? viewportStart : turn.bufferStart,
        bufferEnd: index + 1 < sorted.length ? sorted[index + 1].bufferStart - 1 : viewportEnd,
      };
      const extended = span.bufferStart !== turn.bufferStart || span.bufferEnd !== turn.bufferEnd;
      return { ...turn, ...span, confidence: extended ? "extended" : "anchored" } satisfies TurnSpan;
    }),
    lines,
    tmuxBacked,
  );
}

// What `locateVisibleTurns` and the Rust port in boop-turnvis both produce.
// Regions stay on this side, since only the frontend renders them.
export type TurnSpan = Omit<VisibleTurn, "regions" | "provenance">;

export type TurnLocator = (lines: LogicalLine[], turns: BoopTurn[]) => Promise<TurnSpan[]>;

export function attachTurnRegions(
  spans: TurnSpan[],
  lines: LogicalLine[],
  tmuxBacked = false,
): VisibleTurn[] {
  return spans.map((span) => ({
    ...span,
    regions: projectTurnRegions(span.id, span.said, span, lines, normalizeTurnLine),
    provenance: tmuxBacked ? "xterm+tmux+boop" : "xterm+boop",
  }));
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
  subscription = new Subscription();

  constructor(
    readonly viewport: XtermViewport,
    readonly turns: () => Promise<BoopTurn[]>,
    readonly tmux?: TmuxPane,
    // boop-turnvis runs the same algorithm off the render thread. Absent it,
    // and whenever it errors, the TypeScript matcher answers instead.
    readonly locate?: TurnLocator,
  ) {
    const changes = viewport.changes.pipe(share());
    this.subscription.add(changes.pipe(
      filter((event) => event.kind !== "write"),
    ).subscribe(() => this.schedule()));
    this.subscription.add(changes.pipe(
      filter((event) => event.kind === "write"),
      debounceTime(120),
    ).subscribe(() => this.schedule()));
    // Transcript ingestion trails the terminal's final parsed write. The
    // immediate scan can therefore observe the pane before Boop has committed
    // the matching turn. Reconcile once after the one-second turn cache expires
    // so a completed message gains its regions without requiring user scroll.
    this.subscription.add(changes.pipe(
      filter((event) => event.kind === "write"),
      debounceTime(1200),
    ).subscribe(() => this.schedule()));
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
    const lines = this.viewport.readVisibleLogicalLines();
    const next = await this.located(lines, turns, tmuxCapture);
    if (this.disposed || generation !== this.generation) return;
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

  async located(lines: LogicalLine[], turns: BoopTurn[], tmuxCapture: string): Promise<VisibleTurn[]> {
    if (!this.locate) return locateVisibleTurns(lines, turns, tmuxCapture);
    return this.locate(lines, turns)
      .then((spans) => attachTurnRegions(spans, lines, tmuxConfirms(lines, tmuxCapture)))
      .catch(() => locateVisibleTurns(lines, turns, tmuxCapture));
  }

  bufferRowAtClientPoint(clientY: number): number | null {
    return this.viewport.bufferRowAtClientY(clientY);
  }

  // Identity answers from the rows a turn's own text matched. The extended
  // span exists to carry regions and would name a turn for terminal chrome.
  turnAtBufferRow(bufferRow: number): VisibleTurn | null {
    return this.visible.find((turn) => turn.anchorStart <= bufferRow && bufferRow <= turn.anchorEnd) ?? null;
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
