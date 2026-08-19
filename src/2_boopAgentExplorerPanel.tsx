import { SignalReact } from "@hafley66/signals/react";
import { useRef } from "react";
import { registerPlugin } from "./plugin";
import { BOOP_AGENT_EXPLORER_PLUGIN_ID } from "./0_boopAgentExplorerTypes";
import { BoopNetworkGraph } from "./1a_BoopNetworkGraph";
import {
  createBoopTraceModel,
  setBoopTraceEventsRunner,
  EVENT_LIMIT,
} from "./1c_boopNetworkQuery";

export { setBoopTraceEventsRunner as setBoopAgentExplorerRunner };

let pendingSelection: { harness: string; sessionId: string } | null = null;

export function setBoopAgentExplorerSelection(harness: string, sessionId: string): void {
  pendingSelection = { harness, sessionId };
}

function BoopAgentExplorerPanelView() {
  const model = useRef<ReturnType<typeof createBoopTraceModel> | null>(null);
  model.current ??= createBoopTraceModel();
  const query = model.current.query.$();
  const allEvents = model.current.query.data.$() ?? [];
  const target = pendingSelection;
  const events = target
    ? allEvents.filter((row) => row.session === target.sessionId || row.lane.includes(target.sessionId))
    : allEvents;
  const refresh = () => {
    pendingSelection = null;
    model.current?.query.refetch();
  };
  return (
    <div className="v2-panel boop-network-panel" data-testid="boop-agent-explorer">
      <div className="act-bar">
        <span className="spy-title">network · boop</span>
        <span className="wt-count">{query.isLoading ? "loading" : `${events.length} events · past 7 days · cap ${EVENT_LIMIT}`}</span>
        <span className="spy-spacer" />
        <button type="button" onClick={refresh}>refresh</button>
      </div>
      {query.isError ? <div className="session-empty">{String(query.error)}</div> : null}
      {events.length > 0 ? <BoopNetworkGraph events={events} /> : null}
      {!query.isLoading && events.length === 0 && !query.isError ? <div className="session-empty">no Boop activity in the past 7 days</div> : null}
    </div>
  );
}

export const BoopAgentExplorerPanel = SignalReact(BoopAgentExplorerPanelView);

export function registerBoopAgentExplorer(): void {
  registerPlugin({
    id: BOOP_AGENT_EXPLORER_PLUGIN_ID,
    panels: [{
      id: BOOP_AGENT_EXPLORER_PLUGIN_ID,
      title: "Network",
      icon: "⇄",
      iconLabel: "Boop Network",
      html: "",
      component: BoopAgentExplorerPanel,
    }],
    routes: [{
      id: `${BOOP_AGENT_EXPLORER_PLUGIN_ID}.route`,
      open: (path) => {
        const match = /^agent:\/\/([^/]+)\/(.+)$/.exec(path);
        if (!match) return false;
        setBoopAgentExplorerSelection(match[1] ?? "", decodeURIComponent(match[2] ?? ""));
        return true;
      },
    }],
  });
}
