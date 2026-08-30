import { Signal, SignalCreator } from "@hafley66/signals";
import { filter, map, merge, scan } from "rxjs";
import { applyNodeChanges } from "@xyflow/react";
import { Dom } from "./1_dockCanvasDom";
import type { LabEvent, LabState, PanelNode } from "./0_dockCanvasTypes";

export const nodeCountButton = Dom("/dock-canvas/node-count/:count");
export const panelInput = Dom("/dock-canvas/panel/:id/input");
export const runtimeEvents = SignalCreator<LabEvent>({ event: true });

const domEvents$ = merge(
  nodeCountButton.$.click.pipe(map(({ params }) => ({ type: "node-count-selected", count: Number(params.count) }) as LabEvent)),
  panelInput.$.input.pipe(
    filter(({ delegateElement }) => delegateElement instanceof HTMLInputElement),
    map(({ params, delegateElement }) => ({
      type: "panel-input-changed",
      id: params.id,
      value: (delegateElement as HTMLInputElement).value,
    }) as LabEvent),
  ),
);

export const labEvents$ = merge(runtimeEvents.$, domEvents$);

const makeNodes = (count: number): { nodes: PanelNode[]; layoutMs: number } => {
  const started = performance.now();
  const columns = Math.ceil(Math.sqrt(count));
  const nodes = Array.from({ length: count }, (_, index): PanelNode => ({
    id: `panel-${index}`,
    type: "panelNode",
    position: { x: (index % columns) * 280, y: Math.floor(index / columns) * 168 },
    data: { title: `Live panel ${index + 1}`, seed: index },
  }));
  return { nodes, layoutMs: performance.now() - started };
};

const initialNodes = makeNodes(100);
export const initialState: LabState = {
  panels: Object.fromEntries([
    { id: "terminal", kind: "terminal", title: "xterm" },
    { id: "files", kind: "files", title: "Files" },
    { id: "turns", kind: "turns", title: "Turns" },
    { id: "subagents", kind: "subagents", title: "Subagents" },
  ].map((panel) => [panel.id, panel])),
  nodes: initialNodes.nodes,
  values: {},
  metrics: {
    requestedNodes: 100,
    layoutMs: initialNodes.layoutMs,
    dockPanels: 0,
    eventCount: 0,
    lastEvent: "initial",
  },
};

export function reduceLab(state: LabState, event: LabEvent): LabState {
  const metrics = { ...state.metrics, eventCount: state.metrics.eventCount + 1, lastEvent: event.type };
  if (event.type === "node-count-selected") {
    const next = makeNodes(event.count);
    return { ...state, nodes: next.nodes, metrics: { ...metrics, requestedNodes: event.count, layoutMs: next.layoutMs } };
  }
  if (event.type === "nodes-changed") return { ...state, nodes: applyNodeChanges(event.changes, state.nodes), metrics };
  if (event.type === "panel-input-changed") return { ...state, values: { ...state.values, [event.id]: event.value }, metrics };
  if (event.type === "dock-layout-created") return { ...state, metrics: { ...metrics, dockPanels: event.count } };
  return { ...state, metrics };
}

export const labState = Signal(labEvents$.pipe(scan(reduceLab, initialState)), initialState);
const labRuntime = labState.$.subscribe();
window.addEventListener("pagehide", () => labRuntime.unsubscribe(), { once: true });

declare global { interface Window { __dockCanvasLab: typeof labState } }
window.__dockCanvasLab = labState;
