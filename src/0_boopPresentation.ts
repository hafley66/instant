// Pure projections from the boop session graph and mail tail into the shapes
// the roster table and the marbler model consume. No React, no DOM, so the
// active/label/timeline decisions are testable without a renderer.
import type { MarbleEvent, MarbleFrame } from "@hafley66/marbler";
import type { GraphNode } from "./0_boopGraph";

export interface BoopLane {
  route: string;
  kind: string;
  harness: string | null;
  model: string | null;
  goal: string | null;
  parent: string | null;
  cwd: string | null;
  branch: string | null;
  registeredMs: number;
  state: string;
}

export interface BoopLaneEvent {
  ts: number;
  kind: string;
  fromRoute: string;
  toRoute: string;
  preview: string;
}

const FRAME_KINDS: ReadonlySet<MarbleFrame["kind"]> = new Set([
  "spawn", "turn-start", "turn-finish", "mail-in", "mail-out",
  "result", "error", "exit",
]);

function frameKind(mail: BoopLaneEvent, direction: "in" | "out" | "self"): MarbleFrame["kind"] {
  if (mail.kind === "result") return "result";
  if (mail.kind === "error" || mail.kind === "exited_without_completion") return "error";
  const direct = mail.kind as MarbleFrame["kind"];
  if (FRAME_KINDS.has(direct)) return direct;
  return direction === "in" ? "mail-in" : "mail-out";
}

// Mail rows carry both endpoints; a row lands as a dot on each lane it
// touches, with the other endpoint as its peer so marbler can draw the link.
export function laneFrames(lane: BoopLane, events: BoopLaneEvent[]): MarbleFrame[] {
  const touching = events.filter(
    (event) => event.fromRoute === lane.route || event.toRoute === lane.route,
  );
  return touching.map((event, index) => {
    const direction =
      event.fromRoute === lane.route && event.toRoute === lane.route
        ? ("self" as const)
        : event.toRoute === lane.route
          ? ("in" as const)
          : ("out" as const);
    const peer =
      direction === "in" ? event.fromRoute : direction === "out" ? event.toRoute : null;
    return {
      id: `${lane.route}:${event.ts}:${index}`,
      t: event.ts,
      kind: frameKind(event, direction),
      direction,
      peer,
      preview: event.preview,
      repeat: 1,
    };
  });
}

export function toMarbleEvents(lanes: BoopLane[], events: BoopLaneEvent[]): MarbleEvent[] {
  return lanes.map((lane) => ({
    id: lane.route,
    // The graph's human label, not the raw route/session id. The full identity
    // stays on the roster row (title) and in the drawer's boop:// url.
    name: lane.goal || lane.route,
    method: lane.harness ?? "shell",
    status: lane.state === "open" ? 200 : 0,
    type: "note",
    initiator: lane.parent ?? "root",
    size: "",
    start: lane.registeredMs > 0 ? lane.registeredMs : null,
    duration: null,
    from: lane.parent ?? "bus",
    to: lane.route,
    preview: lane.cwd ?? "",
    phases: [],
    frames: laneFrames(lane, events),
  }));
}

export interface LaneStat {
  lastTs: number;
  endedTs: number;
  count: number;
  dots: { id: string; t: number; cls: string }[];
}

// Per-lane rollup for the mail / time / spark columns. Dots cap at 240 so a
// chatty lane cannot blow up the DOM; the cap keeps the newest dots.
export function laneStats(rows: MarbleEvent[]): Map<string, LaneStat> {
  const map = new Map<string, LaneStat>();
  for (const row of rows) {
    for (const frame of row.frames ?? []) {
      const stat = map.get(row.id) ?? { lastTs: 0, endedTs: 0, count: 0, dots: [] };
      stat.count += 1;
      stat.lastTs = Math.max(stat.lastTs, frame.t);
      if (frame.kind === "result" || frame.kind === "error" || frame.kind === "exit") {
        stat.endedTs = Math.max(stat.endedTs, frame.t);
      }
      if (stat.dots.length < 240) {
        stat.dots.push({
          id: frame.id,
          t: frame.t,
          cls: frame.kind === "error" ? "err" : frame.direction,
        });
      }
      map.set(row.id, stat);
    }
  }
  return map;
}

// The viewport domain is message activity and nothing else. A lane's spawn
// stamp is not a mail: folding registeredMs in stretched the domain back to
// session start, crushing every recent frame into a sliver at the right edge.
// No mail means no domain at all (`[]`), which the panel renders as empty.
export function stampsOf(rows: MarbleEvent[]): number[] {
  const stamps: number[] = [];
  for (const row of rows) {
    for (const frame of row.frames ?? []) stamps.push(frame.t);
  }
  return stamps;
}

// Lane narrowing: the selected root's subtree (parent-edge walk) plus mail
// peers, so links keep both endpoints. Filtered lanes are disabled.
export function subtreeLanes(lanes: BoopLane[], rows: MarbleEvent[], root: string | null): MarbleEvent[] {
  if (!root) return rows;
  const keep = new Set<string>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const lane of lanes) {
      if (lane.parent && keep.has(lane.parent) && !keep.has(lane.route)) {
        keep.add(lane.route);
        grew = true;
      }
    }
  }
  for (const row of rows) {
    if (!keep.has(row.id)) continue;
    for (const frame of row.frames ?? []) if (frame.peer) keep.add(frame.peer);
  }
  return rows.filter((row) => keep.has(row.id));
}

// Root sessions for the master table: TUI panes and top-level lanes; a named
// parent that is itself a route means the row is an intermediate lane.
export function rootLanes(lanes: BoopLane[]): BoopLane[] {
  return lanes.filter((lane) => !lane.parent || lane.parent === "root");
}

// The marbler and the mail rollups still speak BoopLane; every graph node is
// one lane-shaped row, its parent the node it nests under.
export function lanesOfNodes(nodes: GraphNode[]): BoopLane[] {
  return nodes.map((node) => ({
    route: node.id,
    kind: node.kind,
    harness: node.harness,
    model: null,
    goal: node.label,
    parent: node.parentId,
    cwd: node.cwd,
    branch: null,
    registeredMs: node.startedTs,
    state: node.state === "live" ? "open" : "closed",
  }));
}

// A root stays under "active only" when anything in its subtree is live.
export function subtreeLive(node: GraphNode): boolean {
  return node.state === "live" || node.children.some(subtreeLive);
}
