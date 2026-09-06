import type { Signal as SignalOf } from "@hafley66/signals";
import { Subscription } from "rxjs";
import { rowOnScreen, rowTop, type TerminalRowGeometry } from "./0_terminalRowGeometry";
import type { GutterPaint } from "./1a2_terminalContextGutter";
import type { BoopTurnCommentFork } from "./1b_terminalContextSync";
import type { PlacedAnnotation } from "./1d_terminalTurnMarks";
import { FORK_PRESET, wrapText, type PlacedFork } from "./1e_terminalForkMarks";

/// Which shape a fork draws in: the overlay on the mark row, or a child pane
/// bound to the lane's tmux session.
export type ForkShape = "overlay" | "pane";

export function forkShape(livePane: boolean): ForkShape {
  return livePane ? "pane" : "overlay";
}

/// One element per `(comment_id, lane)`, the same key the fork table holds.
export function forkKey(fork: BoopTurnCommentFork): string {
  return `${fork.commentId}:${fork.lane}`;
}

/// Fork rows carry seconds on lanes registered before the ms columns landed.
function createdMs(createdTs: number): number {
  return createdTs > 0 && createdTs < 1e12 ? createdTs * 1000 : createdTs;
}

export function forkAge(createdTs: number, nowMs: number): string {
  const created = createdMs(createdTs);
  if (!created) return "";
  const seconds = Math.max(0, Math.floor((nowMs - created) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/// The collapsed line: the disclosure arrow, the lane, its preset, its state
/// with rc when the lane finished, and how long ago it was forked.
export function forkHeaderText(fork: BoopTurnCommentFork, expanded: boolean, nowMs: number): string {
  const rc = fork.rc == null ? "" : ` rc=${fork.rc}`;
  const age = forkAge(fork.createdTs, nowMs);
  return [`${expanded ? "▾" : "▸"} ${fork.lane}`, FORK_PRESET, `${fork.state}${rc}`, age]
    .filter((part) => part.length)
    .join("  ");
}

/// The expanded body: the lane's reply wrapped to `cols`, then the brief it
/// read. A running lane has no reply yet, so the body is the brief alone.
export function forkBodyLines(fork: BoopTurnCommentFork, cols: number): string[] {
  const width = Math.max(20, cols - 2);
  const lines = fork.reply ? wrapText(fork.reply.said, width).map((line) => `│ ${line}`) : [];
  return [...lines, `└ ${fork.branch}  ${fork.brief}`];
}

/// How far right of the cell grid's left edge a child pane starts: the mock's
/// four-column indent at instant's cell width.
export const fork_indent_px = 26;
/// A child pane's height in terminal rows.
export const fork_pane_rows = 8;

export type ForkPlacement = {
  key: string;
  /// The row the fork draws under: the comment's mark row plus one.
  bufferRow: number;
  top: number;
  left: number;
  right: number;
  onScreen: boolean;
};

export function placeForkOverlays(
  geometry: TerminalRowGeometry,
  forks: PlacedFork[],
): ForkPlacement[] {
  return forks.map((fork) => {
    const bufferRow = fork.bufferRow + 1;
    return {
      key: forkKey(fork.fork),
      bufferRow,
      top: rowTop(geometry, bufferRow),
      left: geometry.left,
      right: geometry.right,
      onScreen: rowOnScreen(geometry, bufferRow),
    };
  });
}

export type ForkPanePlacement = ForkPlacement & {
  height: number;
  /// Pixels this pane sits below its anchor row because the pane above it ends
  /// there; the spacer the stack had to absorb.
  spacer: number;
};

/// Each pane starts at its own row or at the bottom of the pane above it,
/// whichever is lower, so two forks close together never draw on top of each other.
export function placeForkPanes(
  geometry: TerminalRowGeometry,
  forks: PlacedFork[],
  paneRows = fork_pane_rows,
): ForkPanePlacement[] {
  const height = paneRows * geometry.cellHeight;
  const sorted = [...forks].sort((left, right) => left.bufferRow - right.bufferRow);
  let bottom = Number.NEGATIVE_INFINITY;
  return sorted.map((fork) => {
    const bufferRow = fork.bufferRow + 1;
    const anchor = rowTop(geometry, bufferRow);
    const top = Math.max(anchor, bottom);
    bottom = top + height;
    return {
      key: forkKey(fork.fork),
      bufferRow,
      top,
      left: geometry.left + fork_indent_px,
      right: geometry.right,
      onScreen: rowOnScreen(geometry, bufferRow),
      height,
      spacer: top - anchor,
    };
  });
}

/// The last `rows` non-empty-tail lines of a tmux capture, what a fixed-height
/// child pane shows of a lane that has scrolled past it.
export function tailLines(capture: string, rows: number): string[] {
  const lines = capture.replace(/\s+$/, "").split("\n");
  return lines.slice(Math.max(0, lines.length - rows));
}

/// `boop beep fork` is the one verb that opens a lane off a stored comment; a
/// comment the store has never seen has id 0 and cannot be forked.
export function forkCommand(commentId: number, preset: string): string {
  return `boop beep fork ${commentId} --preset ${preset}`;
}

export type ForkTarget = { commentId: number; label: string };

export function forkMenuTargets(entries: PlacedAnnotation[]): ForkTarget[] {
  const seen = new Set<number>();
  const targets: ForkTarget[] = [];
  for (const { comment } of entries) {
    if (comment.commentId <= 0 || seen.has(comment.commentId)) continue;
    seen.add(comment.commentId);
    const quote = comment.quote.split("\n").find((line) => line.trim())?.trim() ?? "";
    targets.push({
      commentId: comment.commentId,
      label: comment.note?.trim() || quote.slice(0, 48) || `comment ${comment.commentId}`,
    });
  }
  return targets;
}

type ForkNode = {
  root: HTMLDivElement;
  header: HTMLButtonElement;
  body: HTMLPreElement;
  expanded: boolean;
  capturedAt: number;
  capturing: boolean;
};

/// What the renderer needs off the context queue, structural so this module
/// never imports the queue's class.
export type ForkRenderHost = {
  gutter: HTMLElement;
  gutterPaint: { followers: Set<(paint: GutterPaint) => void>; schedule: () => void };
  term: { cols: number };
};

export type ForkRenderDeps = {
  livePane: SignalOf<boolean>;
  placedForks: () => PlacedFork[];
  capture?: (target: string) => Promise<string>;
  now?: () => number;
};

/// How long a child pane's capture stays fresh.
export const fork_capture_ms = 1_200;

/// Both fork shapes on one paint tick, switched by `livePane`. The overlay
/// covers the rows under the mark when expanded; the pane mirrors the lane.
export class TerminalForkRender {
  readonly layer = document.createElement("div");
  readonly nodes = new Map<string, ForkNode>();
  private lifetime = new Subscription();
  private follow = (paint: GutterPaint) => this.paint(paint);
  private now: () => number;

  constructor(readonly queue: ForkRenderHost, readonly deps: ForkRenderDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.layer.className = "term-fork-layer";
    queue.gutter.appendChild(this.layer);
    this.lifetime.add(deps.livePane.$.subscribe(() => queue.gutterPaint.schedule()));
    queue.gutterPaint.followers.add(this.follow);
  }

  nodeFor(key: string): ForkNode {
    const existing = this.nodes.get(key);
    if (existing) return existing;
    const root = document.createElement("div");
    root.className = "term-fork";
    root.dataset.forkKey = key;
    const header = document.createElement("button");
    header.type = "button";
    header.className = "term-fork-header";
    const body = document.createElement("pre");
    body.className = "term-fork-body";
    root.append(header, body);
    const node: ForkNode = { root, header, body, expanded: false, capturedAt: 0, capturing: false };
    header.addEventListener("mousedown", (event) => event.stopPropagation());
    header.addEventListener("click", () => {
      node.expanded = !node.expanded;
      this.queue.gutterPaint.schedule();
    });
    this.layer.appendChild(root);
    this.nodes.set(key, node);
    return node;
  }

  paint({ geometry }: GutterPaint) {
    const shape = forkShape(this.deps.livePane.$());
    const forks = this.deps.placedForks();
    const placements = shape === "pane"
      ? placeForkPanes(geometry, forks)
      : placeForkOverlays(geometry, forks);
    const byKey = new Map(forks.map((fork) => [forkKey(fork.fork), fork.fork]));
    const now = this.now();
    const live = new Set<string>();
    for (const placement of placements) {
      const fork = byKey.get(placement.key);
      if (!fork) continue;
      live.add(placement.key);
      const node = this.nodeFor(placement.key);
      const expanded = shape === "pane" || node.expanded;
      node.root.dataset.shape = shape;
      node.root.dataset.state = fork.state;
      node.root.hidden = !placement.onScreen;
      node.root.style.left = `${placement.left}px`;
      node.root.style.right = `${placement.right}px`;
      node.root.style.top = `${placement.top}px`;
      node.root.style.height = "height" in placement ? `${placement.height}px` : "";
      node.header.textContent = shape === "pane"
        ? `tmux ${fork.tmux} · ${FORK_PRESET} · ${fork.state}`
        : forkHeaderText(fork, node.expanded, now);
      node.body.hidden = !expanded;
      if (shape === "pane") this.refresh(node, fork, now);
      else node.body.textContent = expanded ? forkBodyLines(fork, this.queue.term.cols).join("\n") : "";
    }
    for (const [key, node] of this.nodes) {
      if (live.has(key)) continue;
      node.root.remove();
      this.nodes.delete(key);
    }
  }

  /// A child pane mirrors `tmux capture-pane -p` on its lane; a capture in
  /// flight is never re-issued, and a dead lane keeps its last screen.
  private refresh(node: ForkNode, fork: BoopTurnCommentFork, now: number) {
    const capture = this.deps.capture;
    if (!capture || node.capturing || node.root.hidden) return;
    if (now - node.capturedAt < fork_capture_ms) return;
    node.capturing = true;
    node.capturedAt = now;
    capture(fork.tmux)
      .then((text) => { node.body.textContent = tailLines(text, fork_pane_rows - 1).join("\n"); })
      .catch(() => {})
      .finally(() => { node.capturing = false; });
  }

  dispose() {
    this.queue.gutterPaint.followers.delete(this.follow);
    this.lifetime.unsubscribe();
    for (const node of this.nodes.values()) node.root.remove();
    this.nodes.clear();
    this.layer.remove();
  }
}
