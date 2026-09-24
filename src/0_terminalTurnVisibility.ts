import { debounceTime, filter, interval, share, Subject, type Observable, Subscription } from "rxjs";
import { projectTurnRegions, regionAtBufferRow, type ProjectedTurnRegion } from "./00_terminalTurnRegions";
import type { LogicalLine, TmuxPane, XtermViewport } from "./00a_terminalIntersection";
import {
  growAnchors,
  hasDiscriminatingHit,
  lineMatches,
  matchRowOwners,
  monotonicTurnMatch,
  normalizeTurnLine,
  sourceLines,
  type TurnMatch,
} from "./0a_terminalTurnMatching";

export { normalizeTurnLine } from "./0a_terminalTurnMatching";

export type BoopTurn = {
  session: string;
  harness: string;
  turn: number;
  ts: number;
  role: string;
  said: string;
  session_scope?: "root" | "child" | "unknown";
  parent_session?: string | null;
};

export type VisibleTurn = BoopTurn & {
  id: string;
  bufferStart: number;
  bufferEnd: number;
  anchorStart: number;
  anchorEnd: number;
  regions: ProjectedTurnRegion[];
  confidence: "anchored" | "extended";
  source: "xterm+boop" | "xterm+tmux+boop";
  clippedAbove?: boolean;
  clippedBelow?: boolean;
};

export type TurnVisibilityEvent = {
  visible: VisibleTurn[];
  entered: VisibleTurn[];
  exited: VisibleTurn[];
};

/** A root pane binding is stronger evidence than cwd-wide text candidates.
 * Bindings left on harness-internal children are repaired through their
 * parent identity; the remaining fallback covers unbound/uningested panes. */
export function selectProjectionTurns(direct: BoopTurn[], candidates: BoopTurn[]): BoopTurn[] {
  const directRoots = direct.filter((turn) => turn.session_scope !== "child");
  const child = direct.find((turn) => turn.session_scope === "child");
  const parentCandidates = child?.parent_session
    ? candidates.filter((turn) => turn.session === child.parent_session)
    : [];
  const candidateRoots = candidates.filter((turn) => turn.session_scope === "root");
  const source = directRoots.length
    ? directRoots
    : parentCandidates.length
      ? parentCandidates
      : candidateRoots.length
        ? candidateRoots
        : direct.length ? direct : candidates;
  const unique = new Map<string, BoopTurn>();
  for (const turn of source) unique.set(`${turn.session}:${turn.turn}`, turn);
  return [...unique.values()].sort((left, right) => left.ts - right.ts || left.turn - right.turn);
}

const turnId = (turn: Pick<BoopTurn, "session" | "turn">) => `${turn.session}:${turn.turn}`;

// A pane tmux also sees is a pane whose rows two readers agree on.
export function tmuxConfirms(lines: LogicalLine[], tmuxCapture: string): boolean {
  const tmuxLines = new Set(tmuxCapture.split("\n").map(normalizeTurnLine).filter(Boolean));
  return lines.some((line) => {
    const normalized = normalizeTurnLine(line.text);
    return normalized.length > 0 && tmuxLines.has(normalized);
  });
}

/// tmux paints its status line on the last row of the client screen, so an
/// xterm row exists that is not pane content. `capture-pane` returns the pane
/// and never that row, which is what makes the two readers disagree by exactly
/// one row at the bottom.
///
/// A locator handed the status row treats it as content. It is never blank, so
/// `extendTo` walks the last turn's span one row down into it and every span
/// boundary below the anchor names a row the reader sees one line lower.
///
/// Only the last row is a candidate, only when tmux gave us a capture to check
/// against, and only when that capture does not contain it. With `status off`
/// the last row is pane content, tmux captured it, and nothing is dropped.
export function dropTmuxStatusRow(lines: LogicalLine[], tmuxCapture: string): LogicalLine[] {
  if (!tmuxCapture || lines.length < 2) return lines;
  const last = lines[lines.length - 1];
  const normalized = normalizeTurnLine(last.text);
  if (!normalized) return lines; // a blank row carries no text to disagree about
  const captured = new Set(tmuxCapture.split("\n").map(normalizeTurnLine).filter(Boolean));
  if (captured.has(normalized)) return lines;
  return lines.slice(0, -1);
}

export type TerminalInputRegion = { start: number; end: number };

function lastIndexWhere<T>(rows: T[], predicate: (row: T) => boolean): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (predicate(rows[index])) return index;
  }
  return -1;
}

/** Frontend mirror of boop-harness `Harness::terminal_input_region`. Native
 * matching applies the trait detector too; this copy keeps the local fallback
 * and region projection on the same row set when IPC is unavailable. */
export function terminalInputRegion(harness: string, lines: LogicalLine[]): TerminalInputRegion | null {
  const rows = lines.map((line) => line.text);
  if (harness === "codex") {
    const end = lastIndexWhere(rows, (text) => {
      const row = text.trim();
      return row.includes(" · ") && (
        row.includes("Approve for me") || row.includes(" changes") || row.includes("Context")
      );
    });
    const start = lastIndexWhere(rows.slice(0, end), (text) => text.trimStart().startsWith("›"));
    return start >= 0 && end >= 0 ? { start, end } : null;
  }
  if (harness === "claude") {
    const border = (text: string) => {
      const row = text.trim();
      return [...row].length >= 8 && [...row].every((character) => "─━═".includes(character));
    };
    const end = lastIndexWhere(rows, border);
    const start = lastIndexWhere(rows.slice(0, end), border);
    return start >= 0 && end >= 0
      && rows.slice(start + 1, end).some((text) => text.trimStart().startsWith("❯"))
      ? { start, end }
      : null;
  }
  if (harness === "kimi") {
    const end = lastIndexWhere(rows, (text) => text.trimStart().startsWith("╰"));
    const start = lastIndexWhere(rows.slice(0, end), (text) => text.trimStart().startsWith("╭"));
    return start >= 0 && end >= 0 ? { start, end } : null;
  }
  if (harness === "opencode") {
    const end = lastIndexWhere(rows, (text) => text.trimStart().startsWith("╹▀"));
    if (end < 0) return null;
    let start = end;
    while (start > 0) {
      const prior = rows[start - 1].trimStart();
      if (prior && !prior.startsWith("┃")) break;
      start -= 1;
    }
    return start < end ? { start, end } : null;
  }
  return null;
}

export function dropTerminalInputRows(lines: LogicalLine[], harness: string): LogicalLine[] {
  const region = terminalInputRegion(harness, lines);
  return region
    ? lines.filter((_, index) => index < region.start || index > region.end)
    : lines;
}

export function locateVisibleTurns(lines: LogicalLine[], turns: BoopTurn[], tmuxCapture = ""): VisibleTurn[] {
  if (typeof tmuxCapture !== "string") tmuxCapture = "";
  const screen = lines.map((line) => ({ ...line, normalized: normalizeTurnLine(line.text) }));
  const tmuxBacked = tmuxConfirms(lines, tmuxCapture);
  const sources = turns.map((turn) => {
    const id = turnId(turn);
    const normalized = sourceLines(turn)
      .map(normalizeTurnLine)
      .filter(Boolean);
    return { turn, id, normalized };
  });

  const isMarkedUser = (match: TurnMatch) => match.source.turn.role === "user"
    && match.hits.some((hit) => hit.text.trimStart().startsWith("❯"));
  const matches = sources
    .map((source) => monotonicTurnMatch(screen, source))
    .filter((match): match is TurnMatch => match !== null)
    .sort((left, right) => {
      return Number(isMarkedUser(right)) - Number(isMarkedUser(left))
        || right.hits.length - left.hits.length
        || left.sourceSpan - right.sourceSpan
        || left.source.normalized.length - right.source.normalized.length
        || right.source.turn.ts - left.source.turn.ts;
    });
  const rowOwners = matchRowOwners(matches);
  const claimedRows = new Set<number>();
  const visible: VisibleTurn[] = [];
  for (const { source, hits } of matches) {
    const unclaimed = hits.filter((hit) => !claimedRows.has(hit.start));
    if (unclaimed.length * 2 < hits.length
      || (source.turn.role === "tool" && !hasDiscriminatingHit(unclaimed, screen, source, rowOwners))) continue;
    const anchorStart = Math.min(...unclaimed.map((hit) => hit.start));
    const anchorEnd = Math.max(...unclaimed.map((hit) => hit.end));
    if (visible.some((turn) => anchorStart <= turn.anchorEnd && turn.anchorStart <= anchorEnd)) continue;
    for (const hit of unclaimed) claimedRows.add(hit.start);
    visible.push({
      ...source.turn,
      id: source.id,
      bufferStart: anchorStart,
      bufferEnd: anchorEnd,
      anchorStart,
      anchorEnd,
      regions: [],
      confidence: "anchored",
      source: tmuxBacked ? "xterm+tmux+boop" : "xterm+boop",
    });
  }
  growAnchors(visible, screen, sources);
  const sorted = visible.sort((a, b) => a.bufferStart - b.bufferStart || a.turn - b.turn);
  if (!lines.length) return sorted;
  return attachTurnRegions(
    sorted.map((turn, index) => {
      const ceiling = index === 0 ? lines[0].start : sorted[index - 1].bufferEnd + 1;
      const floor = index + 1 < sorted.length
        ? sorted[index + 1].bufferStart - 1
        : lines[lines.length - 1].end;
      const span = {
        bufferStart: extendTo(screen, turn.bufferStart, ceiling, -1),
        bufferEnd: extendTo(screen, turn.bufferEnd, floor, 1),
      };
      const extended = span.bufferStart !== turn.bufferStart || span.bufferEnd !== turn.bufferEnd;
      return { ...turn, ...span, confidence: extended ? "extended" : "anchored" } satisfies TurnSpan;
    }),
    lines,
    tmuxBacked,
  );
}

/// A blank row is where one message stops being the other. Extending a span
/// across one merged two on-screen turns into a single attributed block.
export function extendTo(
  screen: { start: number; end: number; normalized: string }[],
  anchor: number,
  limit: number,
  step: 1 | -1,
): number {
  let reached = anchor;
  const inside = (row: number) => (step === 1 ? row <= limit : row >= limit);
  for (let index = screen.findIndex((line) => line.start <= anchor && anchor <= line.end) + step;
       index >= 0 && index < screen.length;
       index += step) {
    const line = screen[index];
    const edge = step === 1 ? line.end : line.start;
    if (!inside(edge)) break;
    if (!line.normalized || line.normalized === "output") break;
    reached = edge;
  }
  return reached;
}

// What `locateVisibleTurns` and the Rust port in boop-turnvis both produce.
// Regions stay on this side, since only the frontend renders them.
export type TurnSpan = Omit<VisibleTurn, "regions" | "source">;

export type TurnLocator = (lines: LogicalLine[], turns: BoopTurn[]) => Promise<TurnSpan[]>;

// One clock serves every terminal projection. A write or scroll leases scans
// for five seconds; each leased projection performs at most one clock-driven
// scan per second. The per-instance schedule gate below coalesces this with
// immediate viewport events and serializes scans already in flight.
export const TURN_ACTIVITY_POLL_MS = 1_000;
export const TURN_ACTIVITY_LEASE_MS = 5_000;
const turnActivityClock = interval(TURN_ACTIVITY_POLL_MS).pipe(share());

export function attachTurnRegions(
  spans: TurnSpan[],
  lines: LogicalLine[],
  tmuxBacked = false,
): VisibleTurn[] {
  return spans.map((span) => {
    const source = span.said.split("\n").map(normalizeTurnLine).filter(Boolean);
    const anchors = lines
      .filter((line) => line.start <= span.anchorEnd && line.end >= span.anchorStart)
      .map((line) => normalizeTurnLine(line.text))
      .filter(Boolean);
    const clippedAbove = !!source.length && !!anchors.length && !lineMatches(anchors[0], source[0]);
    const clippedBelow = !!source.length && !!anchors.length
      && !lineMatches(anchors[anchors.length - 1], source[source.length - 1]);
    return {
      ...span,
      ...(clippedAbove ? { clippedAbove: true } : {}),
      ...(clippedBelow ? { clippedBelow: true } : {}),
      regions: projectTurnRegions(span.id, span.said, span, lines, normalizeTurnLine),
      source: tmuxBacked ? "xterm+tmux+boop" : "xterm+boop",
    };
  });
}

export class TerminalTurnVisibilityV2 {
  updates = new Subject<TurnVisibilityEvent>();
  readonly changes: Observable<TurnVisibilityEvent> = this.updates;
  visible: VisibleTurn[] = [];
  generation = 0;
  viewportRevision = 0;
  frame = 0;
  disposed = false;
  scanning = false;
  rescanPending = false;
  activityAt = Number.NEGATIVE_INFINITY;
  subscription = new Subscription();

  constructor(
    readonly viewport: XtermViewport,
    readonly turns: () => Promise<BoopTurn[]>,
    readonly tmux?: TmuxPane,
    // boop-turnvis runs the same algorithm off the render thread. Absent it,
    // and whenever it errors, the TypeScript matcher answers instead.
    readonly locate?: TurnLocator,
    // Transcript ingestion for this pane's session. It rides the same write
    // and activity-lease streams as the scans, so a pane that is writing
    // ingests its own turns while it writes and for the lease after it stops.
    readonly ingest?: () => void,
  ) {
    const changes = viewport.changes.pipe(share());
    this.subscription.add(changes.subscribe(() => { this.viewportRevision += 1; }));
    this.subscription.add(changes.pipe(
      filter((event) => event.kind === "write" || event.kind === "scroll"),
    ).subscribe(() => {
      this.activityAt = performance.now();
    }));
    this.subscription.add(changes.pipe(
      filter((event) => event.kind !== "write"),
    ).subscribe(() => this.schedule()));
    this.subscription.add(changes.pipe(
      filter((event) => event.kind === "write"),
      debounceTime(120),
    ).subscribe(() => {
      this.ingestVisible();
      this.schedule();
    }));
    // Transcript ingestion and the one-second turn cache can trail the parsed
    // terminal output. Keep reconciling while output or scrolling is active,
    // then stop after five quiet seconds.
    this.subscription.add(turnActivityClock.pipe(
      filter(() => performance.now() - this.activityAt <= TURN_ACTIVITY_LEASE_MS),
    ).subscribe(() => {
      this.ingestVisible();
      this.schedule();
    }));
    this.schedule();
  }

  // Same visibility gate as a scan: a hidden pane keeps its lease and ingests
  // nothing until it shows again.
  ingestVisible() {
    if (this.disposed || this.viewport.visible?.() === false) return;
    this.ingest?.();
  }

  schedule() {
    if (this.scanning) {
      this.rescanPending = true;
      return;
    }
    if (this.disposed || this.frame) return;
    // A hidden terminal keeps its lease (its pane may still be writing) but
    // performs no scan; the next clock tick or viewport event after it shows
    // again schedules one. Thirty open tabs then cost one tab's scans.
    if (this.viewport.visible?.() === false) return;
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
    // The tmux status row is trimmed before either locator sees the rows. The
    // composer is dropped by exactly one side per locator: boop-turnvis drops
    // it natively (`locate_turns` in src-tauri/src/0_boop.rs), so `located`
    // hands it the untrimmed rows and trims only for the local fallback.
    const viewportRevision = this.viewportRevision;
    const paneLines = dropTmuxStatusRow(this.viewport.readVisibleLogicalLines(), tmuxCapture);
    const harness = turns.reduce((latest, turn) => turn.ts >= latest.ts ? turn : latest, turns[0])?.harness ?? "";
    const next = await this.located(paneLines, turns, tmuxCapture, harness);
    if (this.disposed || generation !== this.generation || viewportRevision !== this.viewportRevision) return;
    const before = new Map(this.visible.map((turn) => [turn.id, turn]));
    const after = new Map(next.map((turn) => [turn.id, turn]));
    const entered = next.filter((turn) => !before.has(turn.id));
    const exited = this.visible.filter((turn) => !after.has(turn.id));
    const changed = next.some((turn) => {
      const prior = before.get(turn.id);
      return prior && JSON.stringify(prior) !== JSON.stringify(turn);
    });
    this.visible = next;
    if (entered.length || exited.length || changed) this.updates.next({ visible: next, entered, exited });
  }

  // A second composer drop over already-trimmed rows finds the next matching
  // frame above it — a kimi tool card (╭…╰), a claude prompt between two rules
  // — and deletes real transcript rows. The native locator gets the pane's
  // rows as they are; the composer-trimmed rows serve only the local matcher
  // and region projection.
  async located(paneLines: LogicalLine[], turns: BoopTurn[], tmuxCapture: string, harness = ""): Promise<VisibleTurn[]> {
    const lines = dropTerminalInputRows(paneLines, harness);
    if (!this.locate) return locateVisibleTurns(lines, turns, tmuxCapture);
    return this.locate(paneLines, turns)
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
