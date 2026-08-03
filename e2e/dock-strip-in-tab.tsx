import "xp.css";
import "../src/styles.css";
import { createElement } from "react";
import type { IDockviewPanelProps } from "dockview";
import { registerPlugin } from "../src/plugin";
import { setDockStrip } from "../src/plugins/harnessTrace/DockStripPanel";
import { registerHarnessTracePlugin } from "../src/plugins/harnessTrace";
import { initRail } from "../src/rail";
import { activePanelId, addTermPanel, mountReactDock, setDockHooks } from "../src/reactdock";
import { store } from "../src/state";
import { setHomeDir } from "../src/core";
import { wireContextMenu } from "../src/ctxmenu";
import { installKeymap } from "../src/keymap";
import { toggleTermStripFor } from "../src/plugins/harnessTrace/InTabStrip";

setHomeDir("/Users/e2e");
// ?term=<sid> mounts the terminal for another session id: "s3" has no tmux row
// and no related agent session, which is the fresh-terminal summon case.
const TERM_SID = new URLSearchParams(location.search).get("term") ?? "s1";
function SessionsPanel(_props: IDockviewPanelProps) {
  return createElement("div", { "data-testid": "sessions-panel" }, "Sessions");
}
registerPlugin({
  id: "dock-strip-in-tab-e2e-sessions",
  panels: [{ id: "sessions", title: "Sessions", icon: "S", iconLabel: "Sessions", component: SessionsPanel }],
});
registerHarnessTracePlugin();

// Spy on the strip's click = go there path (the panel calls this bridge).
const w = window as Window & { __dockStripOpened?: string; __termRefits?: number };
setDockStrip({ onOpen: (name) => { w.__dockStripOpened = name; } });
// Count the refits the host is asked for (main.ts wires this to fitTerm, which
// resizes the pty): the strip owes one whenever its height moves the xterm's
// bottom edge, and silence the rest of the time.
setDockHooks({ onTermLayout: () => { w.__termRefits = (w.__termRefits ?? 0) + 1; } });

// Two tmux sessions: s1 rooted at this tab's claude cwd, s2 rooted at the other
// tree's cwd. The terminal's sid is "s1", so the strip keeps the externals of
// tree 1 (the opencode lane and its subagent), hides tree 1's claude rows (the
// tab's own TUI lists those), and drops tree 2 until the scope widens.
store.set({
  sessions: [
    { name: "s1", windows: 1, attached: true, activity: 1, created: 1, paths: ["/Users/e2e/projects/demo"], commands: ["claude"] },
    { name: "s2", windows: 1, attached: true, activity: 1, created: 1, paths: ["/Users/e2e/projects/other"], commands: ["claude"] },
  ],
  sessionWorktrees: { "s1": ["/Users/e2e/projects/demo"], "s2": ["/Users/e2e/projects/other"] },
});

mountReactDock(document.getElementById("dock")!);
initRail();
wireContextMenu(() => []);
// The production binding of the Toggle Relations Strip command, running the
// production body against this page's terminal (the focused-terminal lookup is
// main.ts's job and has no dock chrome here).
installKeymap([
  { id: "term.strip", keys: ["$mod+Shift+Period"], run: () => toggleTermStripFor(TERM_SID) },
]);

// Wait for the dock to initialize, then add a terminal panel for session "s1"
// with a stub element standing in for the xterm node, so TerminalPanel mounts
// with the in-tab relation strip beneath it.
const attempt = () => {
  if (activePanelId() == null) {
    setTimeout(attempt, 20);
    return;
  }
  const stub = document.createElement("div");
  stub.setAttribute("data-testid", "term-stub");
  stub.textContent = `${TERM_SID} xterm`;
  addTermPanel(TERM_SID, TERM_SID, stub);
};
setTimeout(attempt, 20);
