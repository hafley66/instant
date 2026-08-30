import { createDockAndFlowModel, type DockAndFlowModel, type DockFlowNode } from "@hafley66/react-dock-and-flow";
import { Background, Controls, type NodeChange, ReactFlow, useNodesState } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { IDockviewPanelProps } from "dockview";
import { useEffect, useMemo } from "react";
import "./1_CanvasPanel.css";

function SurfaceNode({ data }: { data: DockFlowNode["data"] }) {
  if (data.panelId === "panel-0") {
    return (
      <article className="canvas-surface canvas-terminal-surface" data-testid="canvas-terminal-surface">
        <header>tmux · sprefa-3</header>
        <pre>{"$ bus ls\nagent  claude  live\n$ _"}</pre>
      </article>
    );
  }

  return (
    <article className="canvas-surface canvas-nested-surface nodrag nowheel nopan" data-testid="nested-canvas-surface">
      <header>artifact graph</header>
      <div className="mini-canvas">
        <span className="mini-canvas-node">agent</span>
        <span className="mini-canvas-edge">→</span>
        <span className="mini-canvas-node">SVG</span>
      </div>
    </article>
  );
}

function ControlledCanvas({ model }: { model: DockAndFlowModel }) {
  const initialNodes = useMemo(
    () => model.state.nodes.$().map((node) => ({ ...node, type: "default" as const, data: { ...node.data, label: <SurfaceNode data={node.data} /> } })),
    [model],
  );
  const [nodes, _setNodes, applyChanges] = useNodesState(initialNodes);
  const changed = (changes: NodeChange<(typeof nodes)[number]>[]) => {
    applyChanges(changes);
    const controlled = changes.filter((change) => change.type !== "dimensions");
    if (controlled.length) {
      model.events.$({ type: "nodes-changed", changes: controlled as NodeChange<DockFlowNode>[] });
    }
  };
  return (
    <div className="canvas-workspace" data-testid="canvas-workspace">
      <ReactFlow nodes={nodes} edges={[]} onNodesChange={changed} fitView>
        <Background gap={18} size={1} />
        <Controls />
      </ReactFlow>
      <aside className="canvas-details" data-testid="canvas-details">
        <strong>Controlled surfaces</strong>
        <span>one library state and event model</span>
      </aside>
    </div>
  );
}

export function CanvasWorkspacePanel(_props: IDockviewPanelProps) {
  const model = useMemo(() => createDockAndFlowModel(2), []);
  useEffect(() => () => model.dispose(), [model]);
  return <ControlledCanvas model={model} />;
}
