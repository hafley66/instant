// Shared boop bridge: owns the single BoopClient + 1500 ms poll and wires the
// same open / expand / hail actions into BOTH the Agents and Shells panels.
// One client, one poller, one boopAgents signal — the two panels are two views
// over the same snapshot. Shellout goes through the run_click tauri command.
// New code here calls boop only; it never imports scripts/bus.ts or execs tmux.
import { invoke } from "./generated/native";
import {
  boopAgents,
  BoopClient,
  findLane,
  startBoopPolling,
  subRowsFor,
  withLaneRoute,
} from "./boopAgents";
import { setAgentsPanel, type AgentsBridge } from "./agentsPanelV2";
import { setShellsPanel } from "./1_shellsPanel";
import { openTab } from "./terminal";
import { harnessAdapter, harnessIds } from "./harness";

let registered = false;

export function registerBoopPanels() {
  if (registered) return;
  registered = true;
  const client = new BoopClient((line) => invoke<string>("run_click", { command: line, cwd: "" }));
  const stop = startBoopPolling(client, (snap) => boopAgents.$(snap), 1500);
  window.addEventListener("beforeunload", stop, { once: true });
  const expand = (lane: string) => {
    void client.route(lane).then((detail) => {
      const snap = boopAgents.$();
      boopAgents.$({
        ...snap,
        lanes: snap.lanes.map((l) => (l.lane === lane ? { ...l, route: detail } : l)),
        tree: withLaneRoute(snap.tree, lane, detail),
      });
    });
  };
  const bridge: AgentsBridge = {
    open: (row) => {
      if (row.kind === "lane" && row.state === "live" && row.tmux) {
        openTab(row.tmux, { viewer: true });
        return;
      }
      if (row.kind === "session") {
        const harness = harnessIds.find((id) => id === row.harness);
        if (!harness) return;
        openTab(`chat-${harness}-${row.sessionId}`, {
          cwd: row.cwd,
          command: harnessAdapter(harness).resume(row.sessionId),
        });
      }
    },
    canExpand: (row) => row.kind === "lane" && (row.addressable || (row.childLanes?.length ?? 0) > 0),
    getSubRows: (row) => subRowsFor(row),
    onToggle: (lane, willExpand) => {
      const row = findLane(boopAgents.$().tree, lane);
      if (willExpand && row?.addressable) expand(lane);
    },
    hail: (lane, body) =>
      client.hail(lane, body, "instant").then(() => {
        // no per-hail surface yet; the poll reflects the queued message next tick
      }),
  };
  setAgentsPanel(bridge);
  setShellsPanel(bridge);
}
