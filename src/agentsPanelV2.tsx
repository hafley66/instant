// Agents (boop) v2 panel, on the shared <TreeTable> grid stack. Rows are boop
// lanes (liveness, pid, rss, cpu) expandable to the lane's route detail. Data
// derivation + shellouts live in main.ts; this file reads the boop snapshot
// signal directly. The signals JSX Vite plugin tracks the .$() read.
import { useEffect, useState } from "react";
import { TreeTable, type TreeColumn } from "./treetable";
import { boopAgents, type AgentsRow } from "./boopAgents";

export interface AgentsSummary {
  total: number;
  live: number;
  sessions: number;
  costUsd: number | null;
}

export interface AgentsBridge {
  onShow?: () => void;
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
  return <span className="s-name">{row.lane}</span>;
}

function AgentsDotCell({ row }: { row: AgentsRow }) {
  if (row.kind !== "lane") return null;
  return <span className={"dot" + (row.state === "live" ? " on" : "")} />;
}

function AgentsStateCell({ row }: { row: AgentsRow }) {
  if (row.kind !== "lane") return null;
  return <span className={"agents-state " + row.state}>{row.state}</span>;
}

// Row action: hail. Clicking opens an inline body input; Enter sends it through
// the bridge (a `boop beep hail <lane> --body …` shellout).
function HailCell({ row }: { row: AgentsRow }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  if (row.kind !== "lane") return null;
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

const AGENTS_COLUMNS: TreeColumn<AgentsRow>[] = [
  { id: "dot", header: "", cell: (r) => <AgentsDotCell row={r} /> },
  {
    id: "lane",
    header: "lane",
    tree: true,
    cell: (r) => <AgentsNameCell row={r} />,
    sortValue: (r) => ("lane" in r ? r.lane : ""),
  },
  {
    id: "harness",
    header: "harness",
    cell: (r) => ("harness" in r ? <span className="s-meta">{r.harness}</span> : ""),
    sortValue: (r) => ("harness" in r ? r.harness : ""),
  },
  {
    id: "state",
    header: "state",
    cell: (r) => <AgentsStateCell row={r} />,
    sortValue: (r) => ("state" in r ? r.state : ""),
  },
  {
    id: "pid",
    header: "pid",
    cell: (r) => ("pid" in r && r.pid !== null ? String(r.pid) : ""),
    sortValue: (r) => ("pid" in r ? (r.pid ?? -1) : -1),
  },
  {
    id: "rss",
    header: "rss",
    cell: (r) => ("rssKb" in r ? fmtKb(r.rssKb) : ""),
    sortValue: (r) => ("rssKb" in r ? (r.rssKb ?? -1) : -1),
  },
  {
    id: "cpu",
    header: "cpu",
    cell: (r) => ("cpuPct" in r ? fmtCpu(r.cpuPct) : ""),
    sortValue: (r) => ("cpuPct" in r ? (r.cpuPct ?? -1) : -1),
  },
  { id: "hail", header: "", noRowClick: true, cell: (r) => <HailCell row={r} /> },
];

function agentsFilter(r: AgentsRow, q: string): boolean {
  const s = q.toLowerCase();
  if (r.kind === "route") {
    return (r.sessionId ?? "").toLowerCase().includes(s) || (r.model ?? "").toLowerCase().includes(s);
  }
  return (
    r.lane.toLowerCase().includes(s) ||
    r.harness.toLowerCase().includes(s) ||
    r.state.toLowerCase().includes(s) ||
    r.model.toLowerCase().includes(s) ||
    r.cwd.toLowerCase().includes(s)
  );
}

export function AgentsPanelV2() {
  useEffect(() => {
    agentsBridge?.onShow?.();
  }, []);
  const b = agentsBridge;
  const snap = boopAgents.$();
  const rows = snap.lanes;
  const sum: AgentsSummary = {
    total: rows.length,
    live: rows.filter((row) => row.state === "live").length,
    sessions: snap.sessions.length,
    costUsd: snap.costUsd,
  };
  return (
    <div className="v2-panel">
      <div className="act-bar">
        <span className="spy-title">agents · boop</span>
        <span className="wt-count">
          {sum.live} live / {sum.total} lanes
          {sum.costUsd != null ? ` · $${sum.costUsd.toFixed(2)}` : ""}
        </span>
      </div>
      <div className="panel-scroll">
        {rows.length === 0 ? (
          <div className="session-empty">no boop lanes — is the registry reachable?</div>
        ) : (
          <TreeTable<AgentsRow>
            columns={AGENTS_COLUMNS}
            data={rows}
            getRowId={(r) => r.id}
            getSubRows={(r) => b?.getSubRows(r)}
            getRowCanExpand={(r) => b?.canExpand(r) ?? false}
            onToggleExpand={(r, willExpand) => b?.onToggle(r.lane, willExpand)}
            controls
            filter={agentsFilter}
            searchPlaceholder="filter lanes…"
            rowClass={(r) => "agents-" + r.kind}
            rowTitle={(r) => ("cwd" in r && r.cwd ? r.cwd : ("lane" in r ? r.lane : ""))}
          />
        )}
      </div>
    </div>
  );
}
