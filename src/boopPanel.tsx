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
export function laneFrames(lane: BoopLane, events: BoopLaneEvent[]): MarbleEvent["frames"] {
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

const BOOP_COLUMNS: TreeColumn<BoopLane>[] = [
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
];

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
  useEffect(() => {
    marbler.current.source.$(rows);
  }, [rows]);

  return (
    <div className="v2-panel boop-panel">
      <div className="fs-list boop-master">
        <TreeTable<BoopLane>
          columns={BOOP_COLUMNS}
          data={lanes}
          getRowId={(r) => r.route}
          defaultSorting={BOOP_SORT}
          rowClass={(r) => (r.route === selected ? "fs-selected" : undefined)}
          onRowClick={(r) => setSelected(r.route)}
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
        <MarblerPanel model={marbler.current} />
      </div>
    </div>
  );
}
