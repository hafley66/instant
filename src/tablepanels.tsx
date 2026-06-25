// React panels (v2) built on <TreeTable>, registered alongside the vanilla
// innerHTML panels so they can be proven out side by side. Data derivation and
// click/pin/gesture handlers live in main.ts (where the session/worktree logic
// already is); main.ts injects them through these bridges, keeping this file
// purely presentational. useApp() subscribes the panels to the store so they
// re-render when sessions/worktrees/sort change.
import { useEffect } from "react";
import { useApp } from "./useStore";
import { TreeTable, type TreeColumn } from "./treetable";
import type { SortingState } from "@tanstack/react-table";

// ---- tmux v2 ----
export interface TmuxRow {
  name: string;
  attached: boolean;
  proc: string;
  windows: number;
  open: boolean;
  pwd: string; // tildified, display-ready
  chips: { label: string; current: boolean; path: string }[];
  pinned: boolean;
}

export interface TmuxBridge {
  rows: () => TmuxRow[];
  onOpen: (name: string) => void;
  onPin: (name: string) => void;
  onShow?: () => void; // mount refresh (component panels don't get PanelDef.onShow)
}

let tmuxBridge: TmuxBridge | null = null;
export function setTmuxPanel(b: TmuxBridge) {
  tmuxBridge = b;
}

const TMUX_COLUMNS: TreeColumn<TmuxRow>[] = [
  {
    id: "dot",
    header: "",
    cell: (r) => <span className={"dot" + (r.attached ? " on" : "")} />,
  },
  { id: "name", header: "session", cell: (r) => <span className="s-name">{r.name}</span> },
  {
    id: "proc",
    header: "proc",
    cell: (r) =>
      r.proc ? (
        <span className="s-proc" title="foreground process">
          {r.proc}
        </span>
      ) : null,
  },
  {
    id: "meta",
    header: "win",
    cell: (r) => (
      <span className="s-meta">
        {r.windows}w{r.open ? " · open" : ""}
      </span>
    ),
  },
  {
    id: "pwd",
    header: "cwd",
    cell: (r) =>
      r.pwd ? (
        <span className="s-pwd" title={r.pwd}>
          {r.pwd}
        </span>
      ) : null,
  },
  {
    id: "chips",
    header: "worktrees",
    cell: (r) =>
      r.chips.length ? (
        <span className="s-worktrees">
          {r.chips.map((c) => (
            <span
              key={c.path}
              className={"wt-chip" + (c.current ? " current" : "")}
              title={c.path}
            >
              {c.label}
            </span>
          ))}
        </span>
      ) : null,
  },
  {
    id: "pin",
    header: "",
    noRowClick: true,
    cell: (r) => <PinCell row={r} />,
  },
];

function PinCell({ row }: { row: TmuxRow }) {
  return (
    <span
      className={"s-pin" + (row.pinned ? " on" : "")}
      title={row.pinned ? "unpin" : "pin to top"}
      onClick={(e) => {
        e.stopPropagation();
        tmuxBridge?.onPin(row.name);
      }}
    >
      {row.pinned ? "📌" : "📍"}
    </span>
  );
}

export function TmuxPanelV2() {
  useApp(); // re-render on store change
  // Block body: onShow returns a Promise (refreshSessions); returning it from the
  // effect would make React treat the Promise as the cleanup fn and call it on
  // unmount -> "destroy is not a function". Return nothing.
  useEffect(() => {
    tmuxBridge?.onShow?.();
  }, []);
  const rows = tmuxBridge?.rows() ?? [];
  return (
    <div className="panel-scroll">
      {rows.length === 0 ? (
        <div className="session-empty">no live sessions — launch one in the tmux panel</div>
      ) : (
        <TreeTable<TmuxRow>
          columns={TMUX_COLUMNS}
          data={rows}
          getRowId={(r) => r.name}
          onRowClick={(r) => tmuxBridge?.onOpen(r.name)}
          rowClass={(r) => (r.pinned ? "pinned" : undefined)}
        />
      )}
    </div>
  );
}

// ---- worktrees v2 (flat) ----
// Display-ready row: main.ts derives every label so this file stays presentational.
export interface WtRow {
  worktree: string; // disk path (stable id + gesture key)
  origin: string; // prettyOrigin(org/repo)
  clone: string; // baseName(clone)
  worktreeLabel: string; // "(main)" or baseName
  branch: string;
  head: string;
  pathDisplay: string; // tildified path
  dirty: boolean;
  fav: boolean;
}

export interface WtBridge {
  rows: () => WtRow[];
  onSingle: (r: WtRow, x: number, y: number) => void;
  onDouble: (r: WtRow) => void;
  onContext: (r: WtRow, x: number, y: number) => void;
  onToggleFav: (r: WtRow) => void;
  onShow?: () => void;
}

let wtBridge: WtBridge | null = null;
export function setWorktreesPanel(b: WtBridge) {
  wtBridge = b;
}

const WT_COLUMNS: TreeColumn<WtRow>[] = [
  {
    id: "star",
    header: "",
    noRowClick: true,
    cellClass: (r) => (r.fav ? "wt-star on" : "wt-star"),
    sortValue: (r) => (r.fav ? 0 : 1),
    cell: (r) => <StarCell row={r} />,
  },
  { id: "origin", header: "org/repo", sortValue: (r) => r.origin, cell: (r) => r.origin },
  { id: "clone", header: "clone", sortValue: (r) => r.clone, cell: (r) => r.clone },
  {
    id: "worktree",
    header: "worktree",
    sortValue: (r) => r.worktreeLabel,
    cell: (r) => r.worktreeLabel,
  },
  { id: "branch", header: "branch", sortValue: (r) => r.branch, cell: (r) => r.branch },
  { id: "head", header: "head", sortValue: (r) => r.head, cell: (r) => r.head },
  {
    id: "path",
    header: "path",
    sortValue: (r) => r.worktree,
    cell: (r) => (
      <span className="wt-path" title={r.worktree}>
        {r.pathDisplay}
      </span>
    ),
  },
  {
    id: "dirty",
    header: "",
    sortValue: (r) => (r.dirty ? 0 : 1),
    cellClass: (r) => (r.dirty ? "wt-dirty" : undefined),
    cell: (r) => (r.dirty ? "●" : ""),
  },
];

const WT_DEFAULT_SORT: SortingState = [{ id: "star", desc: false }];

function StarCell({ row }: { row: WtRow }) {
  return (
    <span
      title={row.fav ? "unfavorite" : "favorite"}
      onClick={(e) => {
        e.stopPropagation();
        wtBridge?.onToggleFav(row);
      }}
    >
      {row.fav ? "★" : "☆"}
    </span>
  );
}

export function WorktreesPanelV2() {
  useApp();
  useEffect(() => {
    wtBridge?.onShow?.();
  }, []);
  const rows = wtBridge?.rows() ?? [];
  return (
    <div className="panel-scroll">
      {rows.length === 0 ? (
        <div className="session-empty">no worktrees scanned</div>
      ) : (
        <TreeTable<WtRow>
          columns={WT_COLUMNS}
          data={rows}
          getRowId={(r) => r.worktree}
          defaultSorting={WT_DEFAULT_SORT}
          rowTitle={(r) => r.worktree}
          rowEntity={(r) => ({ kind: "repo", value: r.worktree })}
          onRowClick={(r, e) => wtBridge?.onSingle(r, e.clientX, e.clientY)}
          onRowDoubleClick={(r) => wtBridge?.onDouble(r)}
          onRowContextMenu={(r, e) => wtBridge?.onContext(r, e.clientX, e.clientY)}
        />
      )}
    </div>
  );
}
