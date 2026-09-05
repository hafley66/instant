// Boop rail panel: lane roster (master table) with the mail stream drawn by
// @hafley66/marbler; a lane is a line, a mail is a dot, filtered = disabled.
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "./generated/native";
import { TreeTable, type TreeColumn } from "./treetable";
import { settings } from "./0_settings";
import type { SortingState } from "@tanstack/react-table";
import { createMarbler, MarblerPanel, type MarbleEvent, type MarbleFrame } from "@hafley66/marbler";
import { buildGraphTree, flattenTree, type GraphNode, type SessionGraph } from "./0_boopGraph";

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
    name: lane.route,
    method: lane.harness ?? "shell",
    status: lane.state === "open" ? 200 : 0,
    type: "note",
    initiator: lane.parent ?? "root",
    size: "",
    start: lane.registeredMs > 0 ? lane.registeredMs : null,
    duration: null,
    from: lane.parent ?? "bus",
    to: lane.route,
    preview: lane.goal ?? lane.cwd ?? "",
    phases: [],
    frames: laneFrames(lane, events),
  }));
}

// Rows are graph nodes (lanes and sessions, nested) carrying the per-poll
// rollups; the column array stays module-stable because rebuilt columns reset
// tanstack's sort state, killing header clicks.
export interface BoopRow extends GraphNode {
  mailCount: number;
  endedTs: number;
  dots: LaneStat["dots"];
  windowRange: [number, number] | null;
  subRows: BoopRow[];
}

const BOOP_COLUMNS: TreeColumn<BoopRow>[] = [
  {
    id: "route",
    header: "agent",
    tree: true,
    sortValue: (r) => r.label,
    cell: (r) => r.label,
    cellClass: (r) => (r.state === "live" ? "boop-open" : "boop-closed"),
  },
  { id: "kind", header: "kind", sortValue: (r) => r.kind, cell: (r) => r.kind, size: 64 },
  { id: "state", header: "state", sortValue: (r) => r.state, cell: (r) => r.state, size: 56 },
  { id: "harness", header: "harness", sortValue: (r) => r.harness ?? "", cell: (r) => r.harness ?? "" },
  { id: "cwd", header: "cwd", sortValue: (r) => r.cwd ?? "", cell: (r) => (r.cwd ?? "").split("/").filter(Boolean).slice(-2).join("/") },
  {
    id: "mails",
    header: "mail",
    sortValue: (r) => r.mailCount,
    cell: (r) => String(r.mailCount),
    size: 52,
  },
  {
    id: "started",
    header: "started",
    sortValue: (r) => r.startedTs,
    cell: (r) => (r.startedTs ? fmtAgo(r.startedTs, Date.now()) : "—"),
    size: 84,
  },
  {
    id: "updated",
    header: "updated",
    sortValue: (r) => r.lastTs,
    cell: (r) => (r.lastTs ? fmtAgo(r.lastTs, Date.now()) : "—"),
    size: 84,
  },
  {
    id: "ended",
    header: "ended",
    sortValue: (r) => r.finishedTs || r.endedTs,
    cell: (r) => {
      const at = r.finishedTs || r.endedTs;
      return r.state === "live" || !at ? "—" : fmtAgo(at, Date.now());
    },
    size: 92,
  },
  {
    id: "waterfall",
    header: "waterfall",
    cell: (r) => {
      if (!r.dots.length || !r.windowRange) return <span className="muted">—</span>;
      const span = r.windowRange[1] - r.windowRange[0] || 1;
      return (
        <span className="boop-spark" title={`${r.mailCount} mail`}>
          {r.dots.map((dot) => (
            <i
              key={dot.id}
              className={dot.cls}
              style={{ left: `${((dot.t - r.windowRange![0]) / span) * 100}%` }}
            />
          ))}
        </span>
      );
    },
    size: 160,
    maxSize: 420,
  },
];

function fmtAgo(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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

export function stampsOf(rows: MarbleEvent[]): number[] {
  const stamps: number[] = [];
  for (const row of rows) {
    if (row.start !== null) stamps.push(row.start);
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

const BOOP_SORT: SortingState = [{ id: "updated", desc: true }];
const GRAPH_POLL_MS = 3000;

const POLL_MS = 1000;
// Full history on first paint; after that only the tail, merged in memory.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function BoopPanelV2() {
  const [graph, setGraph] = useState<SessionGraph | null>(null);
  const [events, setEvents] = useState<BoopLaneEvent[]>([]);
  const sinceTs = useRef(Date.now() - LOOKBACK_MS);
  const roots = useMemo(() => (graph ? buildGraphTree(graph, sinceTs.current) : []), [graph]);
  const nodes = useMemo(() => flattenTree(roots), [roots]);
  const lanes = useMemo(() => lanesOfNodes(nodes), [nodes]);
  const [selected, setSelected] = useState<string | null>(null);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const lastTs = useRef(0);
  const marbler = useRef(createMarbler([]));

  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const since = lastTs.current === 0 ? Date.now() - LOOKBACK_MS : lastTs.current;
        const tail = await invoke<BoopLaneEvent[]>("boop_lane_events", { sinceMs: since });
        if (stopped) return;
        setInvokeError(null);
        if (tail.length) {
          lastTs.current = tail[tail.length - 1].ts + 1;
          setEvents((prior) => prior.concat(tail));
        }
      } catch (reason) {
        // Shown in the empty state; a silent catch here once read as
        // "no lanes" while the store was fine.
        if (!stopped) setInvokeError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    // The graph read walks the process table and tmux, so it polls slower
    // than the mail tail.
    const refreshGraph = async () => {
      try {
        const next = await invoke<SessionGraph>("boop_session_graph", { historySinceMs: sinceTs.current });
        if (stopped) return;
        setInvokeError(null);
        setGraph(next);
      } catch (reason) {
        if (!stopped) setInvokeError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void refresh();
    void refreshGraph();
    const timer = window.setInterval(refresh, POLL_MS);
    const graphTimer = window.setInterval(refreshGraph, GRAPH_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearInterval(graphTimer);
    };
  }, []);

  const rows = useMemo(() => toMarbleEvents(lanes, events), [lanes, events]);
  const stats = useMemo(() => laneStats(rows), [rows]);
  const stamps = useMemo(() => stampsOf(rows), [rows]);
  const newest = Math.max(0, ...stamps);
  // Memoized: an unstable identity here fired the viewport effect on every
  // render and stomped in-flight navigator gestures.
  const windowRange = useMemo<[number, number] | null>(() => (stamps.length
    ? [Math.min(...stamps), Math.max(newest + POLL_MS, newest + 1)]
    : null), [stamps, newest]);

  // A selected root narrows the network view to its descendant subtree plus
  // mail peers. Click the row again to clear.
  const shown = useMemo(
    () => subtreeLanes(lanes, rows, selected),
    [lanes, rows, selected],
  );

  useEffect(() => {
    marbler.current.source.$(shown);
    marbler.current.selectedId.$(selected);
  }, [shown, selected]);

  useEffect(() => {
    // Seeded-empty model starts with a degenerate range; while following,
    // chase the newest stamp. Value-equal writes are skipped.
    const vp = marbler.current.viewport.$();
    if (!windowRange) return;
    const fullSame = vp.full[0] === windowRange[0] && vp.full[1] === windowRange[1];
    if (vp.followLive) {
      const span = vp.visible[1] - vp.visible[0] || windowRange[1] - windowRange[0];
      const visible: [number, number] = [
        Math.max(windowRange[0], windowRange[1] - span),
        windowRange[1],
      ];
      if (fullSame && vp.visible[0] === visible[0] && vp.visible[1] === visible[1]) return;
      marbler.current.viewport.$({ ...vp, full: windowRange, visible });
    } else if (!fullSame) {
      marbler.current.viewport.$({ ...vp, full: windowRange });
    }
  }, [shown, windowRange]);

  const onlyActive = settings.boopOnlyActive.$();
  const toRow = (node: GraphNode): BoopRow => ({
    ...node,
    mailCount: stats.get(node.id)?.count ?? 0,
    endedTs: stats.get(node.id)?.endedTs ?? 0,
    dots: stats.get(node.id)?.dots ?? [],
    windowRange,
    subRows: node.children.map(toRow),
  });
  const data: BoopRow[] = useMemo(() => {
    const source = onlyActive ? roots.filter(subtreeLive) : roots;
    return source.map(toRow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots, onlyActive, stats, windowRange]);
  const hiddenByActive = onlyActive ? roots.filter((node) => !subtreeLive(node)).length : 0;
  const summaryAll = useMemo(() => {
    const open = lanes.filter((lane) => lane.state === "open").length;
    return [
      `${open} open · ${lanes.length - open} closed`,
      `${events.length} mail in window`,
    ];
  }, [lanes, events.length]);
  const summary = selected
    ? [`showing ${selected} + descendants`, `${shown.length} of ${rows.length} lanes`]
    : summaryAll;

  return (
    <div className="v2-panel boop-panel">
      <div className="fs-list boop-master">
        <div className="boop-toolbar">
          <label className="boop-only-active">
            <input
              type="checkbox"
              checked={onlyActive}
              onChange={(e) => settings.boopOnlyActive.$(e.target.checked)}
            />
            active only
          </label>
          {hiddenByActive > 0 && (
            <span className="muted">{hiddenByActive} hidden by active-only</span>
          )}
        </div>
        <TreeTable<BoopRow>
          columns={BOOP_COLUMNS}
          data={data}
          getRowId={(r) => r.id}
          getSubRows={(r) => r.subRows}
          defaultExpandedAll
          defaultSorting={BOOP_SORT}
          virtual
          rowClass={(r) => (r.id === selected ? "fs-selected" : undefined)}
          onRowClick={(r) => setSelected((prior) => (prior === r.id ? null : r.id))}
        />
        {lanes.length === 0 && (
          <div className="empty-help">
            <h3>boop: no agents in the window</h3>
            {invokeError ? (
              <p className="act-warn">store read failed: {invokeError}</p>
            ) : (
              <p>
                Rows come from boop's session graph: every lane and harness
                session active in the last 24 hours, nested by who spawned whom.
                Mail refreshes every second, the graph every three.
              </p>
            )}
          </div>
        )}
      </div>
      <div className="boop-marbler">
        {selected && (
          <button type="button" className="boop-narrow" onClick={() => setSelected(null)}>
            showing {selected} + descendants ×
          </button>
        )}
        <MarblerPanel model={marbler.current} embedded summary={summary} />
      </div>
    </div>
  );
}
