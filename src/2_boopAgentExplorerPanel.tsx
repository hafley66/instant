import { Endpoint, Signal, SignalReact } from "@hafley66/signals/react";
import { invoke } from "./generated/native";
import { from, map } from "rxjs";
import { useRef } from "react";
import { registerPlugin } from "./plugin";
import { BOOP_AGENT_EXPLORER_PLUGIN_ID, type AgentGraphQuery } from "./0_boopAgentExplorerTypes";
import {
  boopNetworkEventSchema,
  parseBoopNetworkEvents,
  type BoopNetworkEvent,
} from "./1_boopNetwork";
import { BoopNetworkGraph } from "./1a_BoopNetworkGraph";

const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_LIMIT = 2_000;

type RunBoopNetworkCommand = (query: AgentGraphQuery & { sinceMs: number; limit: number }) => Promise<string>;

let runEvents: RunBoopNetworkCommand | null = null;
let pendingSelection: { harness: string; sessionId: string } | null = null;

export function setBoopAgentExplorerRunner(run: RunBoopNetworkCommand): void {
  runEvents = run;
}

export function setBoopAgentExplorerSelection(harness: string, sessionId: string): void {
  pendingSelection = { harness, sessionId };
}

type NetworkInput = { sinceMs: number; limit: number };

const endpoint = new Endpoint<NetworkInput, BoopNetworkEvent[]>({
  request: (input) => ({ url: "native://boop_trace_events", method: "POST", body: input }),
  decode: (response) => boopNetworkEventSchema.array().parse(response.body),
}, (request) => from(
  runEvents
    ? runEvents(request.body as NetworkInput)
    : invoke<string>("boop_trace_events", request.body as Record<string, unknown>),
).pipe(map((text) => ({ status: 200, body: parseBoopNetworkEvents(text) }))));

function createNetworkModel() {
  const input = Signal<NetworkInput | undefined>({ sinceMs: Date.now() - HISTORY_WINDOW_MS, limit: EVENT_LIMIT });
  const query = endpoint.createQuery(input, { staleTime: 5_000 });
  return { input, query };
}

function BoopAgentExplorerPanelView() {
  const model = useRef<ReturnType<typeof createNetworkModel> | null>(null);
  model.current ??= createNetworkModel();
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
