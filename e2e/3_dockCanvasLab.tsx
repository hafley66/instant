import { memo, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { SignalReact } from "@hafley66/signals/react";
import { Background, Controls, MiniMap, ReactFlow, type NodeChange, type NodeProps } from "@xyflow/react";
import { DockviewReact, themeDark, type DockviewReadyEvent, type IDockviewPanelProps } from "dockview";
import "dockview/dist/styles/dockview.css";
import "@xyflow/react/dist/style.css";
import "./0_dockCanvasLab.css";
import type { PanelNode } from "./0_dockCanvasTypes";
import { labState, nodeCountButton, panelInput, runtimeEvents } from "./2_dockCanvasEpic";

const LivePanelNode = memo(SignalReact(function LivePanelNode({ id, data }: NodeProps<PanelNode>) {
  const value = labState.values[id].$() ?? `state-${data.seed}`;
  return (
    <article className="lab-node" data-testid="live-panel" data-panel-id={id}>
      <header className="lab-node-header">{data.title}</header>
      <div className="lab-node-body">
        <small>signal-backed live React DOM</small>
        <input id={panelInput.id({ id })} aria-label={`${data.title} input`} defaultValue={value} />
      </div>
    </article>
  );
}));

const nodeTypes = { panelNode: LivePanelNode };

const CanvasPanel = SignalReact(function CanvasPanel(_props: IDockviewPanelProps) {
  const nodes = labState.nodes.$();
  const onNodesChange = useCallback((changes: NodeChange<PanelNode>[]) => {
    runtimeEvents.$({ type: "nodes-changed", changes });
  }, []);
  return (
    <div className="lab-canvas" data-testid="canvas-panel">
      <nav className="lab-toolbar" aria-label="node count">
        {[20, 100, 500].map((count) => <button key={count} id={nodeCountButton.id({ count })}>{count} nodes</button>)}
      </nav>
      <ReactFlow nodes={nodes} edges={[]} nodeTypes={nodeTypes} onNodesChange={onNodesChange}
        onlyRenderVisibleElements minZoom={0.05} maxZoom={2} defaultViewport={{ x: 24, y: 24, zoom: 1 }}>
        <Background color="#283448" gap={24} /><MiniMap pannable zoomable /><Controls />
      </ReactFlow>
    </div>
  );
});

const MetricsPanel = SignalReact(function MetricsPanel(_props: IDockviewPanelProps) {
  const metrics = labState.metrics.$();
  return <section className="lab-metrics" data-testid="metrics-panel"><h2>Scanned state</h2><dl>
    {Object.entries(metrics).map(([key, value]) => <div key={key} style={{ display: "contents" }}><dt>{key}</dt><dd data-metric={key}>{String(value)}</dd></div>)}
  </dl></section>;
});

function TerminalPanel(_props: IDockviewPanelProps) { return <pre className="lab-terminal" data-testid="terminal-panel">$ pnpm test\n✓ xterm panel fixture</pre>; }
function FilesPanel(_props: IDockviewPanelProps) { return <section className="lab-static">Files projection<br />src/main.tsx<br />src/terminal.ts</section>; }
function TurnsPanel(_props: IDockviewPanelProps) { return <section className="lab-static">Turns projection<br />current assistant turn</section>; }
function SubagentsPanel(_props: IDockviewPanelProps) { return <section className="lab-static">Subagents projection<br />luna: idle</section>; }

const workspaceComponents = { terminal: TerminalPanel, files: FilesPanel, turns: TurnsPanel, subagents: SubagentsPanel };
function WorkspacePanel(_props: IDockviewPanelProps) {
  const initialized = useRef(false);
  const ready = useCallback((event: DockviewReadyEvent) => {
    runtimeEvents.$({ type: "workspace-ready", value: event });
    if (initialized.current) return;
    initialized.current = true;
    const terminal = event.api.addPanel({ id: "terminal", component: "terminal", title: "xterm" });
    event.api.addPanel({ id: "files", component: "files", title: "Files", position: { referencePanel: terminal, direction: "right" } });
    event.api.addPanel({ id: "turns", component: "turns", title: "Turns", position: { referencePanel: terminal } });
    event.api.addPanel({ id: "subagents", component: "subagents", title: "Subagents", position: { referencePanel: terminal } });
  }, []);
  return <DockviewReact className="lab-workspace" theme={themeDark} components={workspaceComponents} onReady={ready} />;
}

const components = { canvas: CanvasPanel, metrics: MetricsPanel, workspace: WorkspacePanel };
function Lab() {
  const initialized = useRef(false);
  const ready = useCallback((event: DockviewReadyEvent) => {
    runtimeEvents.$({ type: "outer-ready", value: event });
    if (initialized.current) return;
    initialized.current = true;
    const canvas = event.api.addPanel({ id: "canvas", component: "canvas", title: "Spatial panels" });
    event.api.addPanel({ id: "workspace", component: "workspace", title: "Terminal workspace", position: { referencePanel: canvas, direction: "right" } });
    event.api.addPanel({ id: "metrics", component: "metrics", title: "Metrics", position: { referencePanel: canvas, direction: "below" } });
    runtimeEvents.$({ type: "dock-layout-created", count: event.api.panels.length });
  }, []);
  return <DockviewReact className="dock-canvas-lab" theme={themeDark} components={components} onReady={ready} />;
}

createRoot(document.getElementById("root")!).render(<Lab />);
