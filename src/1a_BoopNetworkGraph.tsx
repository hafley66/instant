import type { Geometry } from "@hafley66/grapht";
import { PixiProjection } from "@hafley66/grapht-render-pixijs";
import { useEffect, useRef } from "react";
import type { BoopNetworkEvent } from "./1_boopNetwork";

type BoopNetworkGraphProps = { events: BoopNetworkEvent[] };

function band(value: string, count: number): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % count;
}

function eventGeometry(events: BoopNetworkEvent[]): Geometry {
  const chronological = events.slice().reverse();
  const laneIndex = new Map<string, number>();
  const previousByLane = new Map<string, number>();
  const edges: [number, number][] = [];
  const positions = new Float32Array(chronological.length * 2);
  const first = chronological[0]?.created_ts ?? 0;
  const last = chronological[chronological.length - 1]?.created_ts ?? first + 1;
  const span = Math.max(1, last - first);

  chronological.forEach((event, index) => {
    const lane = laneIndex.get(event.lane) ?? laneIndex.size;
    laneIndex.set(event.lane, lane);
    positions[index * 2] = ((event.created_ts - first) / span) * 1_000;
    positions[index * 2 + 1] = lane * 96 + band(`${event.kind}:${event.session}`, 12) * 7;
    const previous = previousByLane.get(event.lane);
    if (previous !== undefined) edges.push([previous, index]);
    previousByLane.set(event.lane, index);
  });

  return {
    nodeIds: chronological.map((event) => event.event_key),
    positions,
    edges,
  };
}

export function BoopNetworkGraph({ events }: BoopNetworkGraphProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element || events.length === 0) return;
    let disposed = false;
    let projection: PixiProjection | null = null;
    const resize = new ResizeObserver((entries) => {
      const width = Math.max(1, Math.floor(entries[0]?.contentRect.width ?? 1));
      projection?.resize(width, 180);
      projection?.render();
    });
    const initialize = async () => {
      const width = Math.max(1, Math.floor(element.getBoundingClientRect().width));
      const next = new PixiProjection(element, eventGeometry(events), {
        renderer: "webgl",
        representation: "particles",
        width,
        height: 180,
        devicePixelRatio: window.devicePixelRatio || 1,
        backgroundColor: 0x10141c,
      });
      await next.init();
      if (disposed) {
        next.dispose();
        return;
      }
      projection = next;
      next.app.canvas.dataset.testid = "boop-network-grapht";
      element.dataset.nodeCount = String(events.length);
      element.dataset.edgeCount = String(next.currentEdgeCount());
      resize.observe(element);
      await next.firstRender();
    };
    void initialize();
    return () => {
      disposed = true;
      resize.disconnect();
      projection?.dispose();
    };
  }, [events]);

  return <div ref={host} data-testid="boop-network-graph" style={{ width: "100%", height: 180, overflow: "hidden", flex: "0 0 180px" }} />;
}
