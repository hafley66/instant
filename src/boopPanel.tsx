// Boop rail panel: lane roster (master table) with the mail stream drawn by
// @hafley66/marbler; a lane is a line, a mail is a dot, filtered = disabled.
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "./generated/native";
import { TreeTable, type TreeColumn } from "./treetable";
import type { SortingState } from "@tanstack/react-table";
import { createMarbler, MarblerPanel, type MarbleEvent, type MarbleFrame } from "@hafley66/marbler";

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

// Rows carry the per-poll rollups so the column array stays module-stable:
// rebuilt columns reset tanstack's sort state, killing header clicks.
export interface BoopRow extends BoopLane {
  mailCount: number;
  lastTs: number;
  dots: LaneStat["dots"];
  windowRange: [number, number] | null;
}

const BOOP_COLUMNS: TreeColumn<BoopRow>[] = [
  {
    id: "route",
    header: "lane",
    tree: true,
    sortValue: (r) => r.route,
    cell: (r) => r.route,
    cellClass: (r) => (r.state === "open" ? "boop-open" : "boop-closed"),
  },
  { id: "state", header: "state", sortValue: (r) => r.state, cell: (r) => r.state },
  { id: "harness", header: "harness", sortValue: (r) => r.harness ?? "", cell: (r) => r.harness ?? "" },
  { id: "model", header: "model", sortValue: (r) => r.model ?? "", cell: (r) => (r.model ?? "").split("/").pop() ?? "" },
  { id: "parent", header: "parent", sortValue: (r) => r.parent ?? "", cell: (r) => r.parent ?? "" },
  { id: "goal", header: "goal", sortValue: (r) => r.goal ?? "", cell: (r) => r.goal ?? "" },
  {
    id: "mails",
    header: "mail",
    sortValue: (r) => r.mailCount,
    cell: (r) => String(r.mailCount),
    size: 52,
  },
  {
    id: "lastEvent",
    header: "last event",
    sortValue: (r) => r.lastTs,
    cell: (r) => (r.lastTs ? fmtAgo(r.lastTs, Date.now()) : "—"),
    size: 84,
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
  count: number;
  dots: { id: string; t: number; cls: string }[];
}

// Per-lane rollup for the mail / last-event / spark columns. Dots cap at 240
// so a chatty lane cannot blow up the DOM; the cap keeps the newest dots.
export function laneStats(rows: MarbleEvent[]): Map<string, LaneStat> {
  const map = new Map<string, LaneStat>();
  for (const row of rows) {
    for (const frame of row.frames ?? []) {
      const stat = map.get(row.id) ?? { lastTs: 0, count: 0, dots: [] };
      stat.count += 1;
      stat.lastTs = Math.max(stat.lastTs, frame.t);
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

// Lane narrowing: the selected lane plus its mail peers, so inter-lane
// links keep both endpoints. Filtered lanes are disabled, never deleted.
export function narrowRows(rows: MarbleEvent[], lane: string | null): MarbleEvent[] {
  if (!lane) return rows;
  const keep = new Set<string>([lane]);
  const focus = rows.find((row) => row.id === lane);
  for (const frame of focus?.frames ?? []) if (frame.peer) keep.add(frame.peer);
  return rows.filter((row) => keep.has(row.id));
}

const BOOP_SORT: SortingState = [{ id: "route", desc: false }];

const POLL_MS = 1000;
// Full history on first paint; after that only the tail, merged in memory.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function BoopPanelV2() {
  const [lanes, setLanes] = useState<BoopLane[]>([]);
  const [events, setEvents] = useState<BoopLaneEvent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const lastTs = useRef(0);
  const marbler = useRef(createMarbler([]));

  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const since = lastTs.current === 0 ? Date.now() - LOOKBACK_MS : lastTs.current;
        const [nextLanes, tail] = await Promise.all([
          invoke<BoopLane[]>("boop_lanes"),
          invoke<BoopLaneEvent[]>("boop_lane_events", { sinceMs: since }),
        ]);
        if (stopped) return;
        setLanes(nextLanes);
        if (tail.length) {
          lastTs.current = tail[tail.length - 1].ts + 1;
          setEvents((prior) => prior.concat(tail));
        }
      } catch {
        // Store not reachable (no boop yet); the empty panel says so.
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
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

  // A selected lane narrows the network view to that line plus its peers
  // (peers stay so inter-lane links still draw). Click the row again to clear.
  const shown = useMemo(() => narrowRows(rows, selected), [rows, selected]);

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

  const data: BoopRow[] = useMemo(
    () =>
      lanes.map((lane) => ({
        ...lane,
        mailCount: stats.get(lane.route)?.count ?? 0,
        lastTs: stats.get(lane.route)?.lastTs ?? 0,
        dots: stats.get(lane.route)?.dots ?? [],
        windowRange,
      })),
    [lanes, stats, windowRange],
  );

  const summaryAll = useMemo(() => {
    const open = lanes.filter((lane) => lane.state === "open").length;
    return [
      `${open} open · ${lanes.length - open} closed`,
      `${events.length} mail in window`,
    ];
  }, [lanes, events.length]);
  const summary = selected
    ? [`showing ${selected} + peers`, `${shown.length} of ${rows.length} lanes`]
    : summaryAll;

  return (
    <div className="v2-panel boop-panel">
      <div className="fs-list boop-master">
        <TreeTable<BoopRow>
          columns={BOOP_COLUMNS}
          data={data}
          getRowId={(r) => r.route}
          defaultSorting={BOOP_SORT}
          virtual
          rowClass={(r) => (r.route === selected ? "fs-selected" : undefined)}
          onRowClick={(r) => setSelected((prior) => (prior === r.route ? null : r.route))}
        />
        {lanes.length === 0 && (
          <div className="empty-help">
            <h3>boop — no lanes</h3>
            <p>
              Lanes appear when <code>boop beep lane create</code> registers
              them. The panel reads the store read-only and refreshes every
              second.
            </p>
          </div>
        )}
      </div>
      <div className="boop-marbler">
        {selected && (
          <button type="button" className="boop-narrow" onClick={() => setSelected(null)}>
            showing {selected} + peers ×
          </button>
        )}
        <MarblerPanel model={marbler.current} embedded summary={summary} />
      </div>
    </div>
  );
}
