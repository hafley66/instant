import { createGrid, GridTable } from "@hafley66/grid/react";
import { Endpoint, Signal, SignalReact } from "@hafley66/signals/react";
import type { GridConfig, GridState } from "@hafley66/grid";
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

function timestamp(value: number): string {
  return new Date(value).toISOString().slice(11, 19);
}

function duration(row: BoopNetworkEvent): string {
  if (row.started_ts === null || row.finished_ts === null) return "";
  return `${Math.max(0, row.finished_ts - row.started_ts)} ms`;
}

const columns = [
  { accessorKey: "created_ts", header: "Time", size: 110, cell: ({ row }: { row: { original: BoopNetworkEvent } }) => timestamp(row.original.created_ts) },
  { accessorKey: "kind", header: "Event", size: 110 },
  { accessorKey: "lane", header: "Lane", size: 150 },
  { accessorKey: "from_lane", header: "From", size: 130 },
  { accessorKey: "to_lane", header: "To", size: 130 },
  { accessorKey: "session", header: "Session", size: 130 },
  { accessorKey: "classification", header: "State", size: 110 },
  { id: "duration", header: "Duration", size: 100, cell: ({ row }: { row: { original: BoopNetworkEvent } }) => duration(row.original) },
  { accessorKey: "detail", header: "Detail", size: 220 },
] as unknown as GridConfig<BoopNetworkEvent>["columnDefs"];

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
  const filter = Signal("");
  const rows = Signal<BoopNetworkEvent[]>(() => {
    const target = pendingSelection;
    const events = query.data.$() ?? [];
    if (!target) return events;
    return events.filter((row) => row.session === target.sessionId || row.lane.includes(target.sessionId));
  });
  return {
    input,
    query,
    filter,
    grid: createGrid({
      schema: boopNetworkEventSchema,
      rows,
      columnDefs: columns,
      mode: "client",
      getRowId: (row) => row.event_key,
      state: Signal<GridState>({
        sorting: [], columnFilters: [], globalFilter: undefined, columnOrder: [],
        columnPinning: { start: [], end: [] }, columnVisibility: {}, columnSizing: {},
        rowPinning: { top: [], bottom: [] }, rowSelection: {}, expanded: {}, grouping: [],
        pagination: { pageIndex: 0, pageSize: EVENT_LIMIT },
      }),
    }),
  };
}

function BoopAgentExplorerPanelView() {
  const model = useRef<ReturnType<typeof createNetworkModel> | null>(null);
  model.current ??= createNetworkModel();
  const query = model.current.query.$();
  const events = model.current.query.data.$() ?? [];
  const filter = model.current.filter.$();
  const refresh = () => {
    pendingSelection = null;
    model.current?.query.refetch();
  };
  const updateFilter = (value: string) => {
    model.current?.filter.$(value);
    const grid = model.current?.grid;
    if (grid) grid.state.$({ ...grid.state.$(), globalFilter: value || undefined });
  };

  return (
    <div className="v2-panel boop-network-panel" data-testid="boop-agent-explorer">
      <div className="act-bar">
        <span className="spy-title">network · boop</span>
        <span className="wt-count">{query.isLoading ? "loading" : `${events.length} events · past 7 days · cap ${EVENT_LIMIT}`}</span>
        <span className="spy-spacer" />
        <button type="button" onClick={refresh}>refresh</button>
      </div>
      <div className="wt-scan">
        <input
          value={filter}
          placeholder="filter events…"
          onChange={(event) => updateFilter(event.currentTarget.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
      </div>
      {query.isError ? <div className="session-empty">{String(query.error)}</div> : null}
      {events.length > 0 ? <BoopNetworkGraph events={events} /> : null}
      <div className="panel-scroll boop-agent-explorer-body" data-testid="boop-network-scroll-owner">
        {!query.isLoading && events.length === 0 && !query.isError ? <div className="session-empty">no Boop activity in the past 7 days</div> : null}
        {events.length > 0 ? <GridTable grid={model.current.grid} density="compact" scrollMode="external" /> : null}
      </div>
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
