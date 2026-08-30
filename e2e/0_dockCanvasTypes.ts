import type { Node, NodeChange } from "@xyflow/react";
import type { DockviewReadyEvent } from "dockview";

export type PanelKind = "canvas" | "terminal" | "files" | "turns" | "subagents" | "metrics";
export type PanelRecord = { id: string; kind: PanelKind; title: string };
export type PanelNode = Node<{ title: string; seed: number }, "panelNode">;

export type LabEvent =
  | { type: "outer-ready"; value: DockviewReadyEvent }
  | { type: "workspace-ready"; value: DockviewReadyEvent }
  | { type: "node-count-selected"; count: number }
  | { type: "nodes-changed"; changes: NodeChange<PanelNode>[] }
  | { type: "panel-input-changed"; id: string; value: string }
  | { type: "dock-layout-created"; count: number };

export type LabState = {
  panels: Record<string, PanelRecord>;
  nodes: PanelNode[];
  values: Record<string, string>;
  metrics: {
    requestedNodes: number;
    layoutMs: number;
    dockPanels: number;
    eventCount: number;
    lastEvent: LabEvent["type"] | "initial";
  };
};
