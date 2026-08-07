import "xp.css";
import "../src/styles.css";
import { createElement } from "react";
import type { IDockviewPanelProps } from "dockview";
import { registerPlugin } from "../src/plugin";
import { mountReactDock, setDockHooks } from "../src/reactdock";
import { openPreviewPanel } from "../src/preview";
import { setHomeDir } from "../src/core";

const path = "/tmp/instant-monaco/live-tab.ts";
const text = `type PanelLifecycle = "open" | "ready" | "changed" | "saved" | "closed";

export function renderInInstantTab(event: PanelLifecycle): string {
  return \`Monaco lifecycle: \${event}\`;
}

console.log(renderInInstantTab("ready"));
`;

(window as Window & { __instantE2eNativeResults?: Record<string, unknown> }).__instantE2eNativeResults = {
  read_text: text,
  save_text: null,
};

function SessionsPanel(_props: IDockviewPanelProps) {
  return createElement("div", { className: "session-empty" }, "Open the source receipt as a tab");
}
registerPlugin({
  id: "monaco-e2e",
  panels: [{ id: "sessions", title: "Sessions", icon: "S", iconLabel: "Sessions", component: SessionsPanel }],
});
setHomeDir("/tmp");
setDockHooks({
  onTermActivate: () => {}, onTermClose: () => {}, onTermLayout: () => {}, onTermRetitle: () => {},
  isTermPinned: () => false, toggleTermPin: () => {}, onTermCwd: () => null,
});
mountReactDock(document.getElementById("dock")!);
document.querySelector<HTMLButtonElement>("[data-testid=open-source]")!.onclick = () => openPreviewPanel(path);
