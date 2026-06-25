// React panels (v2) built on <TreeTable>, registered alongside the vanilla
// innerHTML panels so they can be proven out side by side. Data derivation and
// click/pin/gesture handlers live in main.ts (where the session/worktree logic
// already is); main.ts injects them through these bridges, keeping this file
// purely presentational. useApp() subscribes the panels to the store so they
// re-render when sessions/worktrees/sort change.
import { useEffect, useRef, useState } from "react";
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

// ---- worktrees v2 (tree-data) ----
// One indented table (org → clone → worktree-leaf), MUI-X tree-data style: the
// name column carries the chevron + indent, other columns + actions fill on
// leaves. main.ts (wtTreeRows) derives every label so this file is presentational.
export interface WtTreeRow {
  id: string;
  kind: "org" | "clone" | "leaf";
  label: string;
  meta?: string; // org: "N clones" · clone: "@branch"
  // leaf
  clonePath?: string; // source clone (gestures + add key)
  worktree?: string; // disk path (gesture key + drag entity)
  branch?: string;
  head?: string;
  pathDisplay?: string;
  dirty?: boolean;
  fav?: boolean;
  resumeNames?: string[]; // live sessions sitting in this worktree
  // clone
  adding?: boolean; // its inline "+ worktree" branch input is open
  children?: WtTreeRow[];
}

export interface WtBridge {
  treeRows: () => WtTreeRow[];
  onShow?: () => void;
  // toolbar
  scanRoot: () => string;
  scan: (root: string) => void;
  focus: () => boolean;
  toggleFocus: () => void;
  counts: () => { shown: number; total: number };
  // leaf gestures + actions
  onLeafSingle: (r: WtTreeRow, x: number, y: number) => void;
  onLeafDouble: (r: WtTreeRow) => void;
  onLeafContext: (r: WtTreeRow, x: number, y: number) => void;
  onLeafMenu: (r: WtTreeRow, x: number, y: number) => void; // open ▾ anchored chooser
  onResume: (name: string) => void;
  toggleFav: (worktree: string) => void;
  // clone "+ worktree" inline add
  revealAdd: (clonePath: string) => void;
  submitAdd: (clonePath: string, branch: string) => void;
  cancelAdd: () => void;
}

let wtBridge: WtBridge | null = null;
export function setWorktreesPanel(b: WtBridge) {
  wtBridge = b;
}

// Tree (name) column: star + label on leaves, label + dim meta on org/clone.
function WtNameCell({ row }: { row: WtTreeRow }) {
  if (row.kind === "leaf") {
    return (
      <>
        <span
          className={"wt-star" + (row.fav ? " on" : "")}
          title={row.fav ? "unfavorite" : "favorite"}
          onClick={(e) => {
            e.stopPropagation();
            if (row.worktree) wtBridge?.toggleFav(row.worktree);
          }}
        >
          {row.fav ? "★" : "☆"}
        </span>
        <span className="wt-label">{row.label}</span>
      </>
    );
  }
  return (
    <>
      <span className="wt-label">{row.label}</span>
      {row.meta ? <span className="wt-meta">{row.meta}</span> : null}
    </>
  );
}

// Inline branch input shown on a clone row mid-add. Enter commits, Esc cancels.
function WtAddInput({ clonePath }: { clonePath: string }) {
  const [v, setV] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <input
      ref={ref}
      className="wt-add-input"
      placeholder="branch name…"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") wtBridge?.submitAdd(clonePath, v.trim());
        else if (e.key === "Escape") wtBridge?.cancelAdd();
      }}
    />
  );
}

// Trailing actions: open ▾ / resume on leaves, + worktree (or its input) on clones.
function WtActionsCell({ row }: { row: WtTreeRow }) {
  if (row.kind === "leaf") {
    const n = row.resumeNames?.length ?? 0;
    return (
      <span className="wt-actions">
        <button
          className="wt-act wt-open"
          title="open a NEW session here (pick an agent)"
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            wtBridge?.onLeafMenu(row, r.left, r.bottom);
          }}
        >
          open ▾
        </button>
        {n ? (
          <button
            className="wt-act wt-resume"
            title={`attach existing session: ${row.resumeNames!.join(", ")}`}
            onClick={(e) => {
              e.stopPropagation();
              wtBridge?.onResume(row.resumeNames![0]);
            }}
          >
            {`resume${n > 1 ? ` (${n})` : ""}`}
          </button>
        ) : null}
      </span>
    );
  }
  if (row.kind === "clone") {
    if (row.adding) return <WtAddInput clonePath={row.clonePath!} />;
    return (
      <span className="wt-actions">
        <button
          className="wt-act wt-add"
          title="add a git worktree under this checkout"
          onClick={(e) => {
            e.stopPropagation();
            wtBridge?.revealAdd(row.clonePath!);
          }}
        >
          + worktree
        </button>
      </span>
    );
  }
  return null;
}

const WT_COLUMNS: TreeColumn<WtTreeRow>[] = [
  { id: "name", header: "worktree", tree: true, cell: (r) => <WtNameCell row={r} /> },
  { id: "branch", header: "branch", cell: (r) => (r.kind === "leaf" ? r.branch : "") },
  { id: "head", header: "head", cell: (r) => (r.kind === "leaf" ? r.head : "") },
  {
    id: "path",
    header: "path",
    cell: (r) =>
      r.kind === "leaf" && r.pathDisplay ? (
        <span className="wt-path" title={r.worktree}>
          {r.pathDisplay}
        </span>
      ) : (
        ""
      ),
  },
  {
    id: "dirty",
    header: "",
    cellClass: (r) => (r.kind === "leaf" && r.dirty ? "wt-dirty" : undefined),
    cell: (r) => (r.kind === "leaf" && r.dirty ? "●" : ""),
  },
  { id: "actions", header: "", noRowClick: true, cell: (r) => <WtActionsCell row={r} /> },
];

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
  const rows = wtBridge?.treeRows() ?? [];
  return (
    <div className="v2-panel">
      <WtToolbar />
      <div className="panel-scroll">
        {rows.length === 0 ? (
          <div className="session-empty">no worktrees scanned</div>
        ) : (
          <TreeTable<WtTreeRow>
            columns={WT_COLUMNS}
            data={rows}
            getRowId={(r) => r.id}
            getSubRows={(r) => r.children}
            defaultExpandedAll
            rowClass={(r) => `wt-${r.kind}`}
            rowTitle={(r) => r.worktree ?? r.label}
            rowEntity={(r) =>
              r.kind === "leaf" && r.worktree ? { kind: "repo", value: r.worktree } : undefined
            }
            onRowClick={(r, e) => {
              if (r.kind === "leaf") wtBridge?.onLeafSingle(r, e.clientX, e.clientY);
            }}
            onRowDoubleClick={(r) => {
              if (r.kind === "leaf") wtBridge?.onLeafDouble(r);
            }}
            onRowContextMenu={(r, e) => {
              if (r.kind === "leaf") wtBridge?.onLeafContext(r, e.clientX, e.clientY);
            }}
          />
        )}
      </div>
    </div>
  );
}
