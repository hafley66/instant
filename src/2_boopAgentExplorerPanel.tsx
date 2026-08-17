import { createMarbler, MarblerPanel } from "@hafley66/marbler";
import type { ExpandedState } from "@tanstack/react-table";
import { useEffect, useRef, useState } from "react";
import { boopAgentRoute } from "@hafley66/boop-adapters";
import { TreeTable, type TreeColumn } from "./treetable";
import { readPluginState, savePluginState } from "./pluginState";
import { registerPlugin } from "./plugin";
import {
  BOOP_AGENT_EXPLORER_PLUGIN_ID,
  EMPTY_EXPLORER_UI,
  type AgentGraphQuery,
  type AgentExplorerSnapshot,
  type BoopAgentGraph,
  type BoopExplorerUiState,
  type AgentTreeRow,
} from "./0_boopAgentExplorerTypes";
import {
  BoopAgentExplorerClient,
  projectBoopAgentGraph,
  type RunBoopCommand,
} from "./1_boopAgentExplorer";

const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

let loadGraph: ((query: AgentGraphQuery) => Promise<BoopAgentGraph>) | null = null;
let pendingSelection: { harness: string; sessionId: string } | null = null;

export function setBoopAgentExplorerRunner(run: RunBoopCommand): void {
  const client = new BoopAgentExplorerClient(run);
  loadGraph = (query) => client.load(query);
}

export function setBoopAgentExplorerSelection(harness: string, sessionId: string): void {
  pendingSelection = { harness, sessionId };
}

function treeFilter(row: AgentTreeRow, query: string): boolean {
  const q = query.toLowerCase();
  return [row.id, row.name, row.harness, row.sessionId, row.status, row.cwd]
    .some((value) => value.toLowerCase().includes(q)) ||
    row.communications.some((communication) =>
      [communication.id, communication.kind, communication.message].some((value) => value.toLowerCase().includes(q)),
    );
}

function communicationText(row: AgentTreeRow): string {
  if (!row.communications.length) return "";
  const kinds = new Map<string, number>();
  for (const communication of row.communications) kinds.set(communication.kind, (kinds.get(communication.kind) ?? 0) + 1);
  return [...kinds.entries()].map(([kind, count]) => `${kind} ×${count}`).join(" · ");
}

const TREE_COLUMNS: TreeColumn<AgentTreeRow>[] = [
  {
    id: "name",
    header: "agent",
    tree: true,
    cell: (row) => <span className="s-name" title={row.cwd}>{row.name}</span>,
    sortValue: (row) => row.name,
  },
  { id: "harness", header: "harness", cell: (row) => <span className="s-meta">{row.harness}</span>, sortValue: (row) => row.harness },
  { id: "status", header: "state", cell: (row) => <span className={`agents-state ${row.status}`}>{row.status}</span>, sortValue: (row) => row.status },
  { id: "session", header: "session", cell: (row) => <span className="s-meta" title={row.sessionId}>{row.sessionId}</span>, sortValue: (row) => row.sessionId },
  { id: "activity", header: "activity", cell: communicationText, sortValue: (row) => row.communications.length },
];

function initialUi(): BoopExplorerUiState {
  const saved = readPluginState<Partial<BoopExplorerUiState>>(BOOP_AGENT_EXPLORER_PLUGIN_ID, {});
  return {
    ...EMPTY_EXPLORER_UI,
    ...saved,
    expanded: saved.expanded ?? {},
  };
}

function routeSelection(rows: AgentTreeRow[], target: { harness: string; sessionId: string }): string | null {
  for (const row of rows) {
    if (row.harness === target.harness && row.sessionId === target.sessionId) return row.id;
    const child = row.children ? routeSelection(row.children, target) : null;
    if (child) return child;
  }
  return null;
}

function Timeline({ snapshot }: { snapshot: AgentExplorerSnapshot | null }) {
  const model = useRef(createMarbler([])).current;
  useEffect(() => {
    model.source.$(snapshot?.timeline ?? []);
  }, [model, snapshot?.timeline]);
  if (!snapshot?.timeline.length) return <div className="session-empty">no timed agent activity</div>;
  return <div className="boop-agent-marble"><MarblerPanel model={model} /></div>;
}

export function BoopAgentExplorerPanel() {
  const [ui, setUi] = useState(initialUi);
  const [snapshot, setSnapshot] = useState<AgentExplorerSnapshot | null>(null);
  const [error, setError] = useState("");
  const request = useRef(0);
  const updateUi = <K extends keyof BoopExplorerUiState>(key: K, value: BoopExplorerUiState[K]) => {
    setUi((previous) => {
      const next = { ...previous, [key]: value };
      savePluginState<BoopExplorerUiState>(BOOP_AGENT_EXPLORER_PLUGIN_ID, { [key]: value });
      return next;
    });
  };
  const refresh = () => {
    const loader = loadGraph;
    if (!loader) {
      setError("Boop agent graph runner is unavailable");
      return;
    }
    const sequence = ++request.current;
    const query: AgentGraphQuery = {
      ...(ui.cwd?.trim() ? { cwd: ui.cwd.trim() } : {}),
      includeHistory: ui.includeHistory,
    };
    setError("");
    void loader(query).then((graph) => {
      if (sequence !== request.current) return;
      const next = projectBoopAgentGraph(
        graph,
        ui.includeHistory ? Date.now() - HISTORY_WINDOW_MS : undefined,
      );
      setSnapshot(next);
      const routeId = pendingSelection ? routeSelection(next.tree, pendingSelection) : null;
      if (routeId) updateUi("selectedId", routeId);
      pendingSelection = null;
    }).catch((reason: unknown) => {
      if (sequence === request.current) setError(String(reason));
    });
  };
  useEffect(() => {
    refresh();
    return () => { request.current += 1; };
  }, [ui.cwd, ui.includeHistory]);
  const expanded = ui.expanded as ExpandedState;
  const rows = snapshot?.tree ?? [];
  const selected = snapshot?.timeline.find((event) => event.id === ui.selectedId);
  const summary = snapshot ? `${snapshot.tree.length} roots · ${snapshot.graph.nodes.length} agents · ${snapshot.timeline.length} events` : "";
  const onExpandedChange = (next: ExpandedState) => {
    const value = typeof next === "object" ? next : {};
    updateUi("expanded", value as Record<string, boolean>);
  };
  return (
    <div className="v2-panel" data-testid="boop-agent-explorer">
      <div className="act-bar">
        <span className="spy-title">agent explorer · boop</span>
        <span className="wt-count">{summary}</span>
        <span className="spy-spacer" />
        <button type="button" onClick={refresh}>refresh</button>
      </div>
      <div className="wt-scan">
        <input
          value={ui.filter}
          placeholder="filter agents…"
          onChange={(event) => updateUi("filter", event.currentTarget.value)}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <input
          value={ui.cwd ?? ""}
          placeholder="cwd (optional)…"
          onChange={(event) => updateUi("cwd", event.currentTarget.value || undefined)}
          onKeyDown={(event) => event.stopPropagation()}
        />
        <label><input type="checkbox" checked={ui.includeHistory} onChange={(event) => updateUi("includeHistory", event.currentTarget.checked)} /> past 7 days</label>
      </div>
      {error ? <div className="session-empty">{error}</div> : null}
      <div className="panel-scroll boop-agent-explorer-body">
        {rows.length === 0 && !error ? <div className="session-empty">no Boop agents</div> : null}
        {rows.length > 0 ? (
          <TreeTable
            columns={TREE_COLUMNS}
            data={rows}
            getRowId={(row) => row.id}
            getSubRows={(row) => row.children}
            expanded={expanded}
            onExpandedChange={onExpandedChange}
            query={ui.filter}
            onQueryChange={(query) => updateUi("filter", query)}
            filter={treeFilter}
            controls
            searchPlaceholder="filter agents…"
            rowClass={(row) => row.id === ui.selectedId ? "selected" : undefined}
            onRowClick={(row) => updateUi("selectedId", row.id)}
          />
        ) : null}
        <Timeline snapshot={snapshot} />
        {selected ? <div className="act-status">selected event: {selected.id} · {selected.type}</div> : null}
      </div>
    </div>
  );
}

export function registerBoopAgentExplorer(): void {
  registerPlugin({
    id: BOOP_AGENT_EXPLORER_PLUGIN_ID,
    panels: [{
      id: BOOP_AGENT_EXPLORER_PLUGIN_ID,
      title: "Agent Explorer",
      icon: "⌁",
      iconLabel: "Agent Explorer",
      html: "",
      component: BoopAgentExplorerPanel,
    }],
    routes: [{
      id: `${BOOP_AGENT_EXPLORER_PLUGIN_ID}.route`,
      open: (path) => {
        const match = boopAgentRoute.match(path);
        if (!match.matched) return false;
        setBoopAgentExplorerSelection(match.values.harness, match.values.sessionId);
        return true;
      },
    }],
  });
}
