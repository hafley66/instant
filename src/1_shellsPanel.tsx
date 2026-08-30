// Shells (boop) v2 panel: the external-agent shell tree on the shared grid
// stack. Reads the same boop snapshot signal as the Agents panel; rows are the
// lane tree only (no session groups). Open / expand / hail flow through the
// shared boop bridge (boopBridge.ts); display values come from the pure model
// (0_shellsModel.ts). The signals JSX Vite plugin tracks the .$() read.
import { useEffect, useState, type ReactNode } from "react";
import { createGrid } from "@hafley66/grid";
import { GridTable } from "@hafley66/grid/react";
import { Signal } from "@hafley66/signals";
import { z } from "zod";
import { boopAgents, type AgentsRow } from "./boopAgents";
import type { AgentsBridge } from "./agentsPanelV2";
import { shellCell } from "./0_shellsModel";

export type ShellsBridge = AgentsBridge;

let shellsBridge: ShellsBridge | null = null;
export function setShellsPanel(b: ShellsBridge) {
  shellsBridge = b;
}

function ShellsNameCell({ row }: { row: AgentsRow }) {
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

function ShellsDotCell({ row }: { row: AgentsRow }) {
  if (row.kind !== "lane") return null;
  return <span className={"dot" + (row.state === "live" ? " on" : "")} />;
}

function ShellsOpenCell({ row, children }: { row: AgentsRow; children: ReactNode }) {
  const canOpen = row.kind === "lane" && row.state === "live" && !!row.tmux;
  return (
    <span onClick={() => shellsBridge?.open(row)} style={{ display: "block", cursor: canOpen ? "pointer" : "default" }}>
      {children}
    </span>
  );
}

function ShellsStateCell({ row }: { row: AgentsRow }) {
  if (row.kind !== "lane") return null;
  return <span className={"agents-state " + row.state}>{row.state}</span>;
}

// Row action: hail. Clicking opens an inline body input; Enter sends it through
// the bridge (a `boop beep hail <lane> --body …` shellout).
function ShellsHailCell({ row }: { row: AgentsRow }) {
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
            if (b) void shellsBridge?.hail(row.lane, b);
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

const shellsRows = Signal<AgentsRow[]>(() => boopAgents.$().tree);
const shellsGrid = createGrid<AgentsRow>({
  schema: z.custom<AgentsRow>(),
  rows: shellsRows,
  mode: "client",
  getRowId: (row) => row.id,
  getSubRows: (row) => shellsBridge?.getSubRows(row),
  columnDefs: [
    { id: "__expand", header: "" },
    { id: "dot", header: "", cell: ({ row }) => <ShellsDotCell row={row.original} /> },
    {
      id: "lane",
      header: "lane",
      accessorFn: (row) => row.lane,
      cell: ({ row }) => <ShellsOpenCell row={row.original}><ShellsNameCell row={row.original} /></ShellsOpenCell>,
    },
    {
      id: "state",
      header: "state",
      accessorFn: (row) => ("state" in row ? row.state : ""),
      cell: ({ row }) => <ShellsOpenCell row={row.original}><ShellsStateCell row={row.original} /></ShellsOpenCell>,
    },
    {
      id: "harness",
      header: "harness",
      accessorFn: (row) => ("harness" in row ? row.harness : ""),
      cell: ({ row }) => <ShellsOpenCell row={row.original}><span className="s-meta">{shellCell(row.original, "harness")}</span></ShellsOpenCell>,
    },
    {
      id: "model",
      header: "model",
      accessorFn: (row) => ("model" in row ? (row.model ?? "") : ""),
      cell: ({ row }) => <ShellsOpenCell row={row.original}><span className="s-meta">{shellCell(row.original, "model")}</span></ShellsOpenCell>,
    },
    {
      id: "tmux",
      header: "tmux",
      accessorFn: (row) => ("tmux" in row ? (row.tmux ?? "") : ""),
      cell: ({ row }) => <ShellsOpenCell row={row.original}><span className="s-pwd">{shellCell(row.original, "tmux")}</span></ShellsOpenCell>,
    },
    {
      id: "cwd",
      header: "cwd",
      accessorFn: (row) => ("cwd" in row ? (row.cwd ?? "") : ""),
      cell: ({ row }) => <ShellsOpenCell row={row.original}><span className="s-pwd">{shellCell(row.original, "cwd")}</span></ShellsOpenCell>,
    },
    {
      id: "pid",
      header: "pid",
      accessorFn: (row) => ("pid" in row ? (row.pid ?? -1) : -1),
      cell: ({ row }) => <ShellsOpenCell row={row.original}>{shellCell(row.original, "pid")}</ShellsOpenCell>,
    },
    {
      id: "rss",
      header: "rss",
      accessorFn: (row) => ("rssKb" in row ? (row.rssKb ?? -1) : -1),
      cell: ({ row }) => <ShellsOpenCell row={row.original}>{shellCell(row.original, "rss")}</ShellsOpenCell>,
    },
    {
      id: "cpu",
      header: "cpu",
      accessorFn: (row) => ("cpuPct" in row ? (row.cpuPct ?? -1) : -1),
      cell: ({ row }) => <ShellsOpenCell row={row.original}>{shellCell(row.original, "cpu")}</ShellsOpenCell>,
    },
    {
      id: "uptime",
      header: "uptime",
      accessorFn: (row) => ("uptimeSec" in row ? (row.uptimeSec ?? -1) : -1),
      cell: ({ row }) => <ShellsOpenCell row={row.original}>{shellCell(row.original, "uptime")}</ShellsOpenCell>,
    },
    { id: "hail", header: "", cell: ({ row }) => <ShellsHailCell row={row.original} /> },
  ],
});

export function ShellsPanelV2() {
  const [filter, setFilter] = useState("");
  useEffect(() => {
    shellsBridge?.onShow?.();
  }, []);
  const snap = boopAgents.$();
  const rows = shellsRows.$();
  const live = snap.lanes.filter((row) => row.state === "live").length;
  return (
    <div className="v2-panel">
      <div className="act-bar">
        <span className="spy-title">shells · boop</span>
        <span className="wt-count">
          {live} live / {snap.lanes.length} lanes
          {snap.costUsd != null ? ` · $${snap.costUsd.toFixed(2)}` : ""}
        </span>
      </div>
      <div className="panel-scroll">
        <input
          value={filter}
          placeholder="filter shells…"
          onChange={(event) => {
            const value = event.currentTarget.value;
            setFilter(value);
            shellsGrid.onGlobalFilterChange(value);
          }}
        />
        {rows.length === 0 ? (
          <div className="session-empty">no boop lanes — is the registry reachable?</div>
        ) : (
          <GridTable grid={shellsGrid} density="compact" maxHeight={720} />
        )}
      </div>
    </div>
  );
}
