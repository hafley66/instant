// Agents (boop) v2 panel, on the shared <TreeTable> grid stack. Rows are boop
// lanes (liveness, pid, rss, cpu) expandable to the lane's route detail. Data
// derivation + shellouts live in main.ts; this file reads the boop snapshot
// signal directly. The signals JSX Vite plugin tracks the .$() read.
import { useEffect, useState, type ReactNode } from "react";
import { createGrid } from "@hafley66/grid";
import { GridTable } from "@hafley66/grid/react";
import { Signal } from "@hafley66/signals";
import { z } from "zod";
import { boopAgents, sessionTree, type AgentsRow } from "./boopAgents";

export interface AgentsSummary {
  total: number;
  live: number;
  sessions: number;
  costUsd: number | null;
}

export interface AgentsBridge {
  onShow?: () => void;
  open: (row: AgentsRow) => void;
  canExpand: (row: AgentsRow) => boolean;
  getSubRows: (row: AgentsRow) => AgentsRow[] | undefined;
  onToggle: (lane: string, willExpand: boolean) => void;
  hail: (lane: string, body: string) => Promise<void>;
}

let agentsBridge: AgentsBridge | null = null;
export function setAgentsPanel(b: AgentsBridge) {
  agentsBridge = b;
}

function fmtKb(kb: number | null): string {
  if (kb === null) return "";
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)}M` : `${kb}K`;
}

function fmtCpu(cpu: number | null): string {
  return cpu === null ? "" : `${cpu.toFixed(1)}%`;
}

function AgentsNameCell({ row }: { row: AgentsRow }) {
  if (row.kind === "route") {
    return (
      <span className="s-pwd" title={row.cwd ?? row.tmux ?? ""}>
        → {row.sessionId ?? "unresolved"}
        <span className="wt-meta">{row.model ?? ""}</span>
      </span>
    );
  }
  if (row.kind === "session") {
    return <span className="s-name" title={`${row.cwd}\n${row.sessionId}`}>{row.lane}</span>;
  }
  return <span className="s-name">{row.lane}</span>;
}

function AgentsDotCell({ row }: { row: AgentsRow }) {
  if (row.kind !== "lane") return null;
  return <span className={"dot" + (row.state === "live" ? " on" : "")} />;
}

function OpenCell({ row, children }: { row: AgentsRow; children: ReactNode }) {
  const canOpen = row.kind === "session" || (row.kind === "lane" && row.state === "live" && !!row.tmux);
  return (
    <span onClick={() => agentsBridge?.open(row)} style={{ display: "block", cursor: canOpen ? "pointer" : "default" }}>
      {children}
    </span>
  );
}

function AgentsStateCell({ row }: { row: AgentsRow }) {
  if (row.kind === "session") return <span className="s-meta">{row.turns} turns</span>;
  if (row.kind !== "lane") return null;
  return <span className={"agents-state " + row.state}>{row.state}</span>;
}

// Row action: hail. Clicking opens an inline body input; Enter sends it through
// the bridge (a `boop beep hail <lane> --body …` shellout).
function HailCell({ row }: { row: AgentsRow }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  if (row.kind !== "lane" || !row.addressable) return null;
  if (open) {
    return (
      <input
        className="agents-hail-input"
        autoFocus
        placeholder="body…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const b = body.trim();
            if (b) void agentsBridge?.hail(row.lane, b);
            setBody("");
            setOpen(false);
          } else if (e.key === "Escape") {
            setBody("");
            setOpen(false);
          }
        }}
        onBlur={() => {
          setBody("");
          setOpen(false);
        }}
      />
    );
  }
  const on = row.state === "live";
  return (
    <span className="wt-actions">
      <button
        className={"wt-act" + (on ? "" : " agents-hail-off")}
        title={on ? "hail this lane" : "lane not live — hail queues for next spawn"}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        hail
      </button>
    </span>
  );
}

const agentsRows = Signal<AgentsRow[]>(() => [
  ...boopAgents.$().tree,
  ...sessionTree(boopAgents.$().sessions),
]);
const agentsGrid = createGrid<AgentsRow>({
  schema: z.custom<AgentsRow>(),
  rows: agentsRows,
  mode: "client",
  getRowId: (row) => row.id,
  getSubRows: (row) => agentsBridge?.getSubRows(row),
  columnDefs: [
    { id: "__expand", header: "" },
    { id: "dot", header: "", cell: ({ row }) => <AgentsDotCell row={row.original} /> },
    {
      id: "name",
      header: "lane",
      accessorFn: (row) => row.lane,
      cell: ({ row }) => <OpenCell row={row.original}><AgentsNameCell row={row.original} /></OpenCell>,
    },
    {
      id: "harness",
      header: "harness",
      accessorFn: (row) => "harness" in row ? row.harness : "",
      cell: ({ row }) => <OpenCell row={row.original}>{"harness" in row.original ? <span className="s-meta">{row.original.harness}</span> : ""}</OpenCell>,
    },
    {
      id: "state",
      header: "state",
      accessorFn: (row) => row.kind === "session" ? `${row.turns} turns` : "state" in row ? row.state : "",
      cell: ({ row }) => <OpenCell row={row.original}><AgentsStateCell row={row.original} /></OpenCell>,
    },
    {
      id: "pid",
      header: "pid",
      accessorFn: (row) => "pid" in row ? (row.pid ?? -1) : -1,
      cell: ({ row }) => <OpenCell row={row.original}>{"pid" in row.original && row.original.pid !== null ? String(row.original.pid) : ""}</OpenCell>,
    },
    {
      id: "rss",
      header: "rss",
      accessorFn: (row) => "rssKb" in row ? (row.rssKb ?? -1) : -1,
      cell: ({ row }) => <OpenCell row={row.original}>{"rssKb" in row.original ? fmtKb(row.original.rssKb) : ""}</OpenCell>,
    },
    {
      id: "cpu",
      header: "cpu",
      accessorFn: (row) => "cpuPct" in row ? (row.cpuPct ?? -1) : -1,
      cell: ({ row }) => <OpenCell row={row.original}>{"cpuPct" in row.original ? fmtCpu(row.original.cpuPct) : ""}</OpenCell>,
    },
    { id: "hail", header: "", cell: ({ row }) => <HailCell row={row.original} /> },
  ],
});

export function AgentsPanelV2() {
  const [filter, setFilter] = useState("");
  useEffect(() => {
    agentsBridge?.onShow?.();
  }, []);
  const snap = boopAgents.$();
  const rows = agentsRows.$();
  const sum: AgentsSummary = {
    total: snap.lanes.length,
    live: snap.lanes.filter((row) => row.state === "live").length,
    sessions: snap.sessions.length,
    costUsd: snap.costUsd,
  };
  return (
    <div className="v2-panel">
      <div className="act-bar">
        <span className="spy-title">agents · boop</span>
        <span className="wt-count">
          {sum.live} live / {sum.total} lanes · {sum.sessions} chats
          {sum.costUsd != null ? ` · $${sum.costUsd.toFixed(2)}` : ""}
        </span>
      </div>
      <div className="panel-scroll">
        <input
          value={filter}
          placeholder="filter lanes…"
          onChange={(event) => {
            const value = event.currentTarget.value;
            setFilter(value);
            agentsGrid.onGlobalFilterChange(value);
          }}
        />
        {rows.length === 0 ? (
          <div className="session-empty">no boop lanes — is the registry reachable?</div>
        ) : (
          <GridTable grid={agentsGrid} density="compact" maxHeight={720} />
        )}
      </div>
    </div>
  );
}
