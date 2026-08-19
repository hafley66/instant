import { createMarbler, MarblerPanel, type MarbleEvent, type MarbleFrame, type MarblePhase } from "@hafley66/marbler";
import { useMemo } from "react";
import type { BoopNetworkEvent } from "./1_boopNetwork";

type LaneAccumulator = {
  id: string;
  start: number;
  end: number;
  harness: string;
  phases: MarblePhase[];
  frames: MarbleFrame[];
  failed: boolean;
};

const eventStart = (event: BoopNetworkEvent): number => event.started_ts ?? event.created_ts;
const eventEnd = (event: BoopNetworkEvent): number => event.finished_ts ?? event.created_ts + 1;

function phaseKind(event: BoopNetworkEvent): MarblePhase["kind"] {
  if (event.kind.includes("delivery") || event.from_lane) return "send";
  if (event.kind.includes("open") || event.kind.includes("start")) return "queue";
  if (event.kind.includes("finish") || event.kind.includes("exit")) return "receive";
  if (event.classification === "idle") return "wait";
  return "work";
}

function frameKind(event: BoopNetworkEvent): MarbleFrame["kind"] {
  if (event.kind.includes("error") || event.classification === "failed") return "error";
  if (event.kind.includes("delivery")) return event.to_lane === event.lane ? "mail-in" : "mail-out";
  if (event.kind.includes("turn-start")) return "turn-start";
  if (event.kind.includes("turn-finish")) return "turn-finish";
  if (event.kind.includes("exit")) return "exit";
  if (event.kind.includes("finish")) return "result";
  return "spawn";
}

function frameDirection(event: BoopNetworkEvent): MarbleFrame["direction"] {
  if (event.from_lane && event.from_lane === event.lane) return "out";
  if (event.to_lane && event.to_lane === event.lane) return "in";
  return "self";
}

function framePeer(event: BoopNetworkEvent): string | null {
  if (event.from_lane && event.from_lane !== event.lane) return event.from_lane;
  if (event.to_lane && event.to_lane !== event.lane) return event.to_lane;
  return null;
}

function phaseRanges(phases: MarblePhase[]): MarblePhase[] {
  const ranges = new Map<MarblePhase["kind"], { start: number; end: number }>();
  for (const phase of phases) {
    if (phase.start === null || phase.end === null) continue;
    const range = ranges.get(phase.kind);
    if (range) {
      range.start = Math.min(range.start, phase.start);
      range.end = Math.max(range.end, phase.end);
    } else {
      ranges.set(phase.kind, { start: phase.start, end: phase.end });
    }
  }
  return [...ranges].map(([kind, range]) => ({ kind, ...range }));
}

export function projectBoopEventsToMarbler(events: BoopNetworkEvent[]): MarbleEvent[] {
  if (events.length === 0) return [];
  const origin = Math.min(...events.map(eventStart));
  const lanes = new Map<string, LaneAccumulator>();
  for (const event of events.slice().sort((left, right) => eventStart(left) - eventStart(right))) {
    const start = eventStart(event) - origin;
    const end = Math.max(start + 1, eventEnd(event) - origin);
    const lane = lanes.get(event.lane) ?? {
      id: event.lane,
      start,
      end,
      harness: event.session || event.trace || "agent",
      phases: [],
      frames: [],
      failed: false,
    };
    lane.start = Math.min(lane.start, start);
    lane.end = Math.max(lane.end, end);
    lane.failed ||= event.kind.includes("error") || event.classification === "failed";
    lane.phases.push({ kind: phaseKind(event), start, end });
    lane.frames.push({
      id: event.event_key,
      t: start,
      kind: frameKind(event),
      direction: frameDirection(event),
      peer: framePeer(event),
      preview: event.detail || event.kind,
      repeat: 1,
    });
    lanes.set(event.lane, lane);
  }
  return [...lanes.values()]
    .sort((left, right) => left.start - right.start || left.id.localeCompare(right.id))
    .map((lane) => ({
      id: lane.id,
      name: lane.id,
      method: "AGENT",
      status: lane.failed ? 500 : 200,
      type: "tool",
      initiator: lane.harness,
      size: `${lane.frames.length} events`,
      start: lane.start,
      duration: Math.max(1, lane.end - lane.start),
      from: lane.frames.find((frame) => frame.peer)?.peer ?? lane.id,
      to: lane.id,
      preview: `${lane.frames.length} lifecycle and message events`,
      phases: phaseRanges(lane.phases),
      frames: lane.frames,
      parentId: null,
    }));
}

export function BoopNetworkGraph({ events, rows, expandAll = false }: { events: BoopNetworkEvent[]; rows?: MarbleEvent[]; expandAll?: boolean }) {
  const model = useMemo(() => {
    const next = createMarbler(rows ?? projectBoopEventsToMarbler(events));
    if (expandAll) next.grid.state.$({ ...next.grid.state.$(), expanded: true });
    next.selectedId.$(null);
    return next;
  }, [events, rows, expandAll]);
  return <div className="boop-marbler" data-testid="boop-network-marbler"><MarblerPanel model={model} /></div>;
}
