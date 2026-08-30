import { DockviewReact, type DockviewReadyEvent, type IDockviewPanelProps, themeDark } from "dockview";
import "dockview/dist/styles/dockview.css";
import { createRoot } from "react-dom/client";
import { CanvasWorkspacePanel } from "../src/plugins/canvas";

function AgentPanel(_props: IDockviewPanelProps) {
  return (
    <div data-testid="agent-panel" style={{ height: "100%", boxSizing: "border-box", padding: 18, background: "#090d14", color: "#d6dce8", font: "13px Menlo, monospace" }}>
      <strong>agent · claude · sprefa-3</strong>
      <pre>{"terminal transcript remains a normal sibling tab\n$ _"}</pre>
    </div>
  );
}

function Fixture() {
  const ready = (event: DockviewReadyEvent) => {
    event.api.addPanel({ id: "agent", component: "agent", title: "sprefa-3" });
    event.api.addPanel({ id: "canvas", component: "canvas", title: "Canvas" });
  };
  return <DockviewReact className="dockview-theme-dark" theme={themeDark} components={{ agent: AgentPanel, canvas: CanvasWorkspacePanel }} onReady={ready} />;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
