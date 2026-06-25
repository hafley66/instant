// React panels (v2) built on <TreeTable>, registered alongside the vanilla
// innerHTML panels so they can be proven out side by side. Data derivation and
// click/pin/gesture handlers live in main.ts (where the session/worktree logic
// already is); main.ts injects them through these bridges, keeping this file
// purely presentational. useApp() subscribes the panels to the store so they
// re-render when sessions/worktrees/sort change.
import { useEffect, useState } from "react";
import { useApp } from "./useStore";
import { TreeTable, type TreeColumn } from "./treetable";
import type { SortingState } from "@tanstack/react-table";
import type { SessionSort, SessionSortKey } from "./state";

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
  // toolbar
  sort: () => SessionSort;
  setSort: (s: SessionSort) => void;
  launch: (command: string) => void; // quick-launch an agent session
  newShell: (name: string) => void; // plain shell, no agent command
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

// Sort + quick-launch + new-shell controls, ported from the retired v1 html.
function TmuxToolbar() {
  const [name, setName] = useState("");
  const sort = tmuxBridge?.sort() ?? { key: "activity", dir: "desc" };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setName("");
    tmuxBridge?.newShell(n);
  };
  return (
    <form className="wt-scan" onSubmit={submit}>
      <select
        className="session-sort"
        title="sort sessions"
        value={`${sort.key}:${sort.dir}`}
        onChange={(e) => {
          const [key, dir] = e.target.value.split(":");
          tmuxBridge?.setSort({ key: key as SessionSortKey, dir: dir as "asc" | "desc" });
        }}
      >
        <option value="activity:desc">recent</option>
        <option value="activity:asc">oldest</option>
        <option value="name:asc">name a–z</option>
        <option value="name:desc">name z–a</option>
        <option value="windows:desc">windows</option>
      </select>
      <button type="button" className="ql-btn" onClick={() => tmuxBridge?.launch("claude")}>
        + claude
      </button>
      <button type="button" className="ql-btn" onClick={() => tmuxBridge?.launch("opencode")}>
        + opencode
      </button>
      <input
        placeholder="new shell…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoComplete="off"
      />
    </form>
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
    <div className="v2-panel">
      <TmuxToolbar />
      <div className="panel-scroll">
        {rows.length === 0 ? (
          <div className="session-empty">no live sessions — launch one above</div>
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
  // toolbar
  scanRoot: () => string;
  scan: (root: string) => void;
  focus: () => boolean;
  toggleFocus: () => void;
  counts: () => { shown: number; total: number };
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

// Scan-root + Scan + Focus toggle, ported from the retired v1 html. Header sort
// replaces the old Tree/Table button (the v2 panel is flat-only).
function WtToolbar() {
  const [root, setRoot] = useState(wtBridge?.scanRoot() ?? "");
  const focus = wtBridge?.focus() ?? false;
  const { shown, total } = wtBridge?.counts() ?? { shown: 0, total: 0 };
  const scan = (e: React.FormEvent) => {
    e.preventDefault();
    wtBridge?.scan(root.trim());
  };
  return (
    <form className="wt-scan" onSubmit={scan}>
      <input value={root} onChange={(e) => setRoot(e.target.value)} autoComplete="off" />
      <button type="submit">Scan</button>
      <button
        type="button"
        className={"wt-focus-btn" + (focus ? " on" : "")}
        title="show only favorited worktrees"
        onClick={() => wtBridge?.toggleFocus()}
      >
        {focus ? "★ Focus" : "☆ Focus"}
      </button>
      <span className="wt-count">
        {total ? (focus ? `${shown}/${total} ★` : `${total} worktrees`) : ""}
      </span>
    </form>
  );
}

// ---- files v2 (lazy tree) ----
// Display-ready node: main.ts formats every column so this file stays
// presentational. `children` is undefined until the folder is expanded.
export interface FsRow {
  path: string;
  name: string;
  isDir: boolean;
  glyph: string;
  date: string;
  type: string;
  size: string;
  sortName: string; // folders-first key
  sortSize: number; // dirs sink to -1
  modified: number;
  children?: FsRow[];
}

export interface FilesBridge {
  rows: () => FsRow[];
  path: () => string;
  hasParent: () => boolean;
  goUp: () => void;
  goTo: (path: string) => void;
  selected: () => string | null;
  onToggle: (r: FsRow, willExpand: boolean) => void;
  onOpen: (r: FsRow) => void;
  onActivate: (r: FsRow) => void;
  onShow?: () => void;
}

let filesBridge: FilesBridge | null = null;
export function setFilesPanel(b: FilesBridge) {
  filesBridge = b;
}

const FS_COLUMNS: TreeColumn<FsRow>[] = [
  {
    id: "name",
    header: "Name",
    tree: true,
    sortValue: (r) => r.sortName,
    cell: (r) => (
      <span className="fs-name">
        {r.glyph} {r.name}
      </span>
    ),
  },
  { id: "date", header: "Date modified", sortValue: (r) => r.modified, cell: (r) => r.date },
  { id: "type", header: "Type", sortValue: (r) => r.type, cell: (r) => r.type },
  {
    id: "size",
    header: "Size",
    sortValue: (r) => r.sortSize,
    cellClass: () => "fs-size",
    cell: (r) => r.size,
  },
];

const FS_DEFAULT_SORT: SortingState = [{ id: "name", desc: false }];

function FsToolbar() {
  const [path, setPath] = useState(filesBridge?.path() ?? "");
  // Track the root path when Up/Go/double-click changes it externally.
  const current = filesBridge?.path() ?? "";
  const [lastCurrent, setLastCurrent] = useState(current);
  if (current !== lastCurrent) {
    setLastCurrent(current);
    setPath(current);
  }
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    filesBridge?.goTo(path.trim());
  };
  return (
    <form className="fs-bar" onSubmit={go}>
      <button type="button" title="Up one folder" onClick={() => filesBridge?.goUp()}>
        ↑
      </button>
      <input value={path} onChange={(e) => setPath(e.target.value)} autoComplete="off" spellCheck={false} />
      <button type="submit">Go</button>
    </form>
  );
}

export function FilesPanelV2() {
  useApp();
  useEffect(() => {
    filesBridge?.onShow?.();
  }, []);
  const rows = filesBridge?.rows() ?? [];
  const selected = filesBridge?.selected() ?? null;
  return (
    <div className="v2-panel">
      <FsToolbar />
      {/* id keeps the legacy #fs-list context-menu hook working. */}
      <div id="fs-list" className="panel-scroll">
        <TreeTable<FsRow>
          columns={FS_COLUMNS}
          data={rows}
          getRowId={(r) => r.path}
          getSubRows={(r) => r.children}
          getRowCanExpand={(r) => r.isDir}
          onToggleExpand={(r, willExpand) => filesBridge?.onToggle(r, willExpand)}
          defaultSorting={FS_DEFAULT_SORT}
          rowTitle={(r) => r.path}
          rowClass={(r) => (r.path === selected ? "fs-selected" : undefined)}
          rowEntity={(r) => (r.isDir ? undefined : { kind: "file", value: r.path })}
          onRowClick={(r) => filesBridge?.onOpen(r)}
          onRowDoubleClick={(r) => filesBridge?.onActivate(r)}
        />
      </div>
    </div>
  );
}

export function WorktreesPanelV2() {
  useApp();
  useEffect(() => {
    wtBridge?.onShow?.();
  }, []);
  const rows = wtBridge?.rows() ?? [];
  return (
    <div className="v2-panel">
      <WtToolbar />
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
    </div>
  );
}
