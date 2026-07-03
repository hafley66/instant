// React panels (v2) built on <TreeTable>, registered alongside the vanilla
// innerHTML panels so they can be proven out side by side. Data derivation and
// click/pin/gesture handlers live in main.ts (where the session/worktree logic
// already is); main.ts injects them through these bridges, keeping this file
// purely presentational. useApp() subscribes the panels to the store so they
// re-render when sessions/worktrees/sort change.
import { useEffect, useRef, useState } from "react";
import { useApp } from "./useStore";
import { TreeTable, type TreeColumn } from "./treetable";
import type { SortingState, ExpandedState } from "@tanstack/react-table";
import type { SessionSort, SessionSortKey, Fav } from "./state";

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

// A claude/opencode process found outside any tmux session — display-ready
// (cwd tildified). Rendered as a banner above the session table so it can't
// be missed even though it's not a tmux row itself.
export interface RogueRow {
  pid: number;
  tty: string;
  command: string;
  cwd: string; // tildified, or the raw args when no cwd was resolvable
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
  // rogue (off-tmux) agent sessions
  rogue: () => RogueRow[];
  onAdopt: (r: RogueRow) => void;
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
  {
    id: "name",
    header: "session",
    cell: (r) => <span className="s-name">{r.name}</span>,
    sortValue: (r) => r.name,
  },
  {
    id: "proc",
    header: "proc",
    cell: (r) =>
      r.proc ? (
        <span className="s-proc" title="foreground process">
          {r.proc}
        </span>
      ) : null,
    sortValue: (r) => r.proc,
  },
  {
    id: "meta",
    header: "win",
    cell: (r) => (
      <span className="s-meta">
        {r.windows}w{r.open ? " · open" : ""}
      </span>
    ),
    sortValue: (r) => r.windows,
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
    sortValue: (r) => r.pwd,
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
    sortValue: (r) => r.chips.length,
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

// Bridge the store's SessionSort <-> react-table SortingState so the toolbar
// <select> and the clickable headers share one source of truth. "activity" has
// no column (it's the implicit order from sortSessions), so it maps to an empty
// SortingState; name/windows map to their column ids.
const SORT_COL: Record<Exclude<SessionSortKey, "activity">, string> = {
  name: "name",
  windows: "meta",
  proc: "proc",
  pwd: "pwd",
  chips: "chips",
};
function sortFromStore(s: SessionSort): SortingState {
  if (s.key === "activity") return [];
  return [{ id: SORT_COL[s.key], desc: s.dir === "desc" }];
}
function sortToStore(ss: SortingState): SessionSort {
  if (!ss.length) return { key: "activity", dir: "desc" };
  const { id, desc } = ss[0];
  const key = (Object.keys(SORT_COL) as (keyof typeof SORT_COL)[]).find(
    (k) => SORT_COL[k] === id,
  );
  return key ? { key, dir: desc ? "desc" : "asc" } : { key: "activity", dir: "desc" };
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
  const rogue = tmuxBridge?.rogue() ?? [];
  return (
    <div className="v2-panel">
      <TmuxToolbar />
      {rogue.length > 0 ? (
        <div className="rogue-banner">
          <div className="rogue-head">
            ⚠ {rogue.length} agent{rogue.length > 1 ? "s" : ""} running outside tmux
          </div>
          {rogue.map((r) => (
            <div className="rogue-row" key={r.pid}>
              <span className="s-proc" title="foreground process">
                {r.command}
              </span>
              <span className="s-meta">pid {r.pid}</span>
              <span className="s-pwd" title={r.cwd}>
                {r.cwd}
              </span>
              <button type="button" className="ql-btn" onClick={() => tmuxBridge?.onAdopt(r)}>
                adopt
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="panel-scroll">
        {rows.length === 0 ? (
          <div className="session-empty">no live sessions — launch one above</div>
        ) : (
          <TreeTable<TmuxRow>
            columns={TMUX_COLUMNS}
            data={rows}
            getRowId={(r) => r.name}
            serverSort
            sorting={sortFromStore(tmuxBridge?.sort() ?? { key: "activity", dir: "desc" })}
            onSortingChange={(s) => tmuxBridge?.setSort(sortToStore(s))}
            controls
            filter={(r, q) => {
              const s = q.toLowerCase();
              return (
                r.name.toLowerCase().includes(s) ||
                r.proc.toLowerCase().includes(s) ||
                r.pwd.toLowerCase().includes(s) ||
                r.chips.some((c) => c.label.toLowerCase().includes(s))
              );
            }}
            searchPlaceholder="filter sessions…"
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
  // org/clone/leaf(worktree)/session are the git+tmux layer; dir/file are the
  // filesystem layer folded in — a leaf (or space, or dir) expands into its
  // directory contents (lazy), so one tree spans worktrees + files + sessions.
  kind: "org" | "clone" | "leaf" | "session" | "dir" | "file";
  label: string;
  glyph?: string; // file/dir emoji prefix (📁/📄/🖼)
  meta?: string; // org: "N clones" · clone: "@branch"
  // leaf
  clonePath?: string; // source clone (gestures + add key)
  worktree?: string; // disk path (gesture key + drag entity)
  branch?: string;
  head?: string;
  pathDisplay?: string;
  dirty?: boolean;
  fav?: boolean;
  favPath?: string; // any path-bearing row is favoritable (leaf/clone/space)
  // session (leaf child): a live tmux session in this worktree
  sessionName?: string;
  attached?: boolean;
  proc?: string;
  windows?: number;
  open?: boolean;
  // clone
  adding?: boolean; // its inline "+ worktree" branch input is open
  // space: a user-added non-git folder (anonymous AI-session workspace). Rendered
  // as a leaf, but its context menu offers "remove space" instead of git actions.
  space?: boolean;
  isDir?: boolean; // fs row: directory vs file (file/dir kinds)
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
  // persisted expand state (store.wtExpanded)
  expanded: () => ExpandedState;
  setExpanded: (e: ExpandedState) => void;
  // leaf gestures + actions
  onLeafSingle: (r: WtTreeRow, x: number, y: number) => void;
  onLeafDouble: (r: WtTreeRow) => void;
  onLeafContext: (r: WtTreeRow, x: number, y: number) => void;
  onLeafMenu: (r: WtTreeRow, x: number, y: number) => void; // open ▾ anchored chooser
  onCloneContext: (r: WtTreeRow, x: number, y: number) => void; // clone/org repo-name ctx menu
  onResume: (name: string) => void; // resume/focus a session row
  onKill: (name: string) => void; // kill a session row
  toggleFav: (worktree: string) => void;
  // filesystem layer (folded in): a leaf/space/dir can lazily expand into its
  // directory contents; files open a preview / paste their path.
  canExpand: (r: WtTreeRow) => boolean;
  onToggle: (r: WtTreeRow, willExpand: boolean) => void;
  onFile: (r: WtTreeRow) => void; // single-click a file row → preview
  onFileActivate: (r: WtTreeRow) => void; // double-click a file row → paste path
  onPathContext: (r: WtTreeRow, x: number, y: number) => void; // file/dir ctx menu
  // clone "+ worktree" inline add
  revealAdd: (clonePath: string) => void;
  submitAdd: (clonePath: string, branch: string) => void;
  cancelAdd: () => void;
  // non-git "spaces" (anonymous AI-session folders)
  addSpace: (path: string) => void;
  removeSpace: (path: string) => void;
}

let wtBridge: WtBridge | null = null;
export function setWorktreesPanel(b: WtBridge) {
  wtBridge = b;
}

// Favorite toggle. Rendered on any path-bearing row (leaf/clone/space). Filled +
// accented when on; dim otherwise. Click stops row-click so it never opens a menu.
function FavStar({ row }: { row: WtTreeRow }) {
  if (!row.favPath) return null;
  return (
    <span
      className={"wt-star" + (row.fav ? " on" : "")}
      title={row.fav ? "unfavorite" : "favorite"}
      onClick={(e) => {
        e.stopPropagation();
        wtBridge?.toggleFav(row.favPath!);
      }}
    >
      {row.fav ? "★" : "☆"}
    </span>
  );
}

// Tree (name) column: star + label on path rows (leaf/clone/space + org meta),
// a live-session line (dot + name + proc + windows) on session children.
function WtNameCell({ row }: { row: WtTreeRow }) {
  if (row.kind === "session") {
    return (
      <>
        <span className={"dot" + (row.attached ? " on" : "")} />
        <span className="s-name">{row.label}</span>
        {row.proc ? (
          <span className="s-proc" title="foreground process">
            {row.proc}
          </span>
        ) : null}
        <span className="s-meta">
          {row.windows}w{row.open ? " · open" : ""}
        </span>
      </>
    );
  }
  return (
    <>
      <FavStar row={row} />
      {row.glyph ? <span className="wt-glyph">{row.glyph}</span> : null}
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

// Trailing actions: open ▾ on leaves, kill × on session rows, + worktree (or its
// input) on clones. Sessions are now visible as child rows, so the leaf-level
// "resume" button is gone — click a session row to resume/focus it.
function WtActionsCell({ row }: { row: WtTreeRow }) {
  if (row.kind === "leaf") {
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
      </span>
    );
  }
  if (row.kind === "session") {
    return (
      <span className="wt-actions">
        <button
          className="wt-act"
          title="kill this tmux session"
          onClick={(e) => {
            e.stopPropagation();
            if (row.sessionName) wtBridge?.onKill(row.sessionName);
          }}
        >
          ×
        </button>
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
  {
    id: "name",
    header: "worktree",
    tree: true,
    cell: (r) => <WtNameCell row={r} />,
    sortValue: (r) => r.label,
  },
  {
    id: "branch",
    header: "branch",
    cell: (r) => (r.kind === "leaf" ? r.branch : ""),
    sortValue: (r) => r.branch ?? "",
  },
  {
    id: "head",
    header: "head",
    cell: (r) => (r.kind === "leaf" ? r.head : ""),
    sortValue: (r) => r.head ?? "",
  },
  {
    id: "path",
    header: "path",
    cell: (r) =>
      (r.kind === "leaf" || r.kind === "file" || r.kind === "dir") && r.pathDisplay ? (
        <span className="wt-path" title={r.worktree}>
          {r.pathDisplay}
        </span>
      ) : (
        ""
      ),
    sortValue: (r) => r.pathDisplay ?? "",
  },
  {
    id: "dirty",
    header: "",
    cellClass: (r) => (r.kind === "leaf" && r.dirty ? "wt-dirty" : undefined),
    cell: (r) => (r.kind === "leaf" && r.dirty ? "●" : ""),
    sortValue: (r) => (r.kind === "leaf" && r.dirty ? 1 : 0),
  },
  { id: "actions", header: "", noRowClick: true, cell: (r) => <WtActionsCell row={r} /> },
];

// Scan-root + Scan + Focus toggle, ported from the retired v1 html. Header sort
// replaces the old Tree/Table button (the v2 panel is flat-only).
function WtToolbar() {
  const [root, setRoot] = useState(wtBridge?.scanRoot() ?? "");
  const [space, setSpace] = useState(""); // inline non-git folder add (empty = closed)
  const [adding, setAdding] = useState(false);
  const focus = wtBridge?.focus() ?? false;
  const { shown, total } = wtBridge?.counts() ?? { shown: 0, total: 0 };
  const scan = (e: React.FormEvent) => {
    e.preventDefault();
    wtBridge?.scan(root.trim());
  };
  const commitSpace = () => {
    const p = space.trim();
    if (p) wtBridge?.addSpace(p);
    setSpace("");
    setAdding(false);
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
      {adding ? (
        <input
          className="wt-space-input"
          autoFocus
          placeholder="folder path (non-git workspace)…"
          value={space}
          onChange={(e) => setSpace(e.target.value)}
          onBlur={commitSpace}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitSpace();
            } else if (e.key === "Escape") {
              setSpace("");
              setAdding(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="wt-space-btn"
          title="add a non-git folder as an AI-session workspace"
          onClick={() => setAdding(true)}
        >
          + Space
        </button>
      )}
      <span className="wt-count">
        {total ? (focus ? `${shown}/${total} ★` : `${total} worktrees`) : ""}
      </span>
    </form>
  );
}

// ---- activity v2 (virtualized flat table + preview) ----
// Display-ready timeline row: main.ts formats every column. `paste` is the
// dbl-click payload (text/url/title, never the shot path); `title` is what the
// <tr title> / ctx-menu paste uses (shot path wins there, mirroring v1).
export interface ActRow {
  id: number;
  ts: number;
  time: string;
  source: string; // raw event source: os | browser | files | session
  src: string; // display label
  action: string;
  target: string;
  title: string;
  paste: string;
  kind: string;
  filePath?: string; // previewable file (screenshot PNG or logged file path)
  shot?: string;
  url?: string;
  text?: string;
}

export interface ActCapturePerms {
  screen_recording: boolean;
  accessibility: boolean;
  tap_active: boolean;
}
export interface ActCaptureStatus {
  kind: string;
  ok: boolean;
  reason: string;
  ts: number;
}

export interface ActivityBridge {
  rows: () => ActRow[];
  count: () => { shown: number; total: number };
  source: () => string;
  setSource: (s: string) => void;
  query: () => string;
  setQuery: (q: string) => void;
  recording: () => boolean;
  toggleRecord: () => void;
  clear: () => void;
  hasEvents: () => boolean;
  onActivate: (r: ActRow) => void; // dbl-click → paste into active terminal
  openPreview: (path: string) => void; // file-backed row → split-right preview tab
  // capture diagnostics
  perms: () => ActCapturePerms | null;
  status: () => ActCaptureStatus | null;
  refreshPerms: () => void;
  requestScreen: () => void;
  onShow?: () => void;
}

let activityBridge: ActivityBridge | null = null;
export function setActivityPanel(b: ActivityBridge) {
  activityBridge = b;
}

const ACT_COLUMNS: TreeColumn<ActRow>[] = [
  { id: "time", header: "time", sortValue: (r) => r.ts, cell: (r) => r.time },
  {
    id: "src",
    header: "src",
    cellClass: () => "act-src",
    sortValue: (r) => r.src,
    cell: (r) => r.src,
  },
  { id: "action", header: "action", sortValue: (r) => r.action, cell: (r) => r.action },
  { id: "target", header: "target", sortValue: (r) => r.target, cell: (r) => r.target },
];

const ACT_DEFAULT_SORT: SortingState = [{ id: "time", desc: true }];

// (value, label): value is the store's ActivitySource; label is the chip text.
const ACT_CHIPS: [string, string][] = [
  ["all", "all"],
  ["os", "screen"],
  ["browser", "browser"],
  ["files", "files"],
  ["session", "sessions"],
];

function ActToolbar() {
  const b = activityBridge!;
  const { shown, total } = b.count();
  return (
    <div className="act-bar">
      <input
        className="act-search"
        placeholder="search…"
        autoComplete="off"
        spellCheck={false}
        value={b.query()}
        onChange={(e) => b.setQuery(e.target.value)}
      />
      <span className="wt-count">{total ? `${shown}/${total}` : ""}</span>
      <span className="spy-spacer" />
      <button
        type="button"
        className={"act-record" + (b.recording() ? " recording" : "")}
        onClick={() => b.toggleRecord()}
      >
        {b.recording() ? "● Recording" : "○ Record"}
      </button>
      <button type="button" onClick={() => b.clear()}>
        Clear
      </button>
    </div>
  );
}

// Capture diagnostics row: permission banners (Screen Recording / input access)
// + the live outcome of the last gesture. This is the "why isn't it shooting?"
// readout — it turns the silent backend no-ops into something you can see.
function ActStatusBar() {
  const b = activityBridge!;
  const perms = b.perms();
  const st = b.status();
  if (!b.recording() && !perms) return null;
  const banners: React.ReactNode[] = [];
  if (perms && !perms.screen_recording) {
    banners.push(
      <span key="sr" className="act-warn">
        ⚠ Screen Recording denied
        <button type="button" className="act-grant" onClick={() => b.requestScreen()}>
          Grant
        </button>
      </span>,
    );
  }
  if (perms && !perms.tap_active) {
    banners.push(
      <span key="tap" className="act-warn" title="Grant Accessibility / Input Monitoring to instant in System Settings → Privacy & Security, then relaunch.">
        ⚠ Input access off — no gestures captured
      </span>,
    );
  }
  // Last gesture outcome. ok=shot saved; else the precise skip reason.
  let last: React.ReactNode = null;
  if (st) {
    last = (
      <span className={"act-last" + (st.ok ? " ok" : "")}>
        {st.ok ? "✓ shot" : "skipped"}: {st.kind}
        {st.ok ? "" : ` — ${st.reason}`}
      </span>
    );
  }
  if (!banners.length && !last) return null;
  return (
    <div className="act-status">
      {banners}
      {last}
    </div>
  );
}

function ActChips() {
  const b = activityBridge!;
  const cur = b.source();
  return (
    <div className="act-chips">
      {ACT_CHIPS.map(([val, label]) => (
        <button
          key={val}
          type="button"
          className={"act-chip" + (cur === val ? " on" : "")}
          onClick={() => b.setSource(val)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// Shown before the first event arrives (capture off, no extension yet).
function ActivitySetup() {
  return (
    <div className="empty-help">
      <h3>activity — setup</h3>
      <p>
        A searchable history of what you touch: screen captures on mouse/key
        gestures, plus browser navigation/clicks and the files you open.
      </p>
      <p>
        <b>Screen capture (OS):</b> flip <b>Recording</b> on (top-right of this
        panel). The first shot prompts for <b>Screen Recording</b> permission —
        grant it, then double-clicks, drags, and ⌘C/⌘V each save a screenshot
        tagged with the frontmost app. Default off; only ⌘C/⌘V keys are read.
      </p>
      <p>
        <b>Browser:</b> the ingest server runs at <code>127.0.0.1:8787</code>{" "}
        while instant is open. Install the extension:
      </p>
      <ol>
        <li>
          Open <code>chrome://extensions</code>
        </li>
        <li>
          Enable <b>Developer mode</b> (top-right)
        </li>
        <li>
          <b>Load unpacked</b> → pick the <code>extension/</code> folder in the
          instant repo
        </li>
      </ol>
      <p>
        Click any row to preview it; double-click to paste its text/url into the
        active terminal. Search filters fzf-style.
      </p>
      <p className="muted">Test the browser ingest without Chrome:</p>
      <pre>{`curl -XPOST 127.0.0.1:8787/ingest \\
  -H 'content-type: application/json' \\
  -d '{"kind":"nav","url":"https://example.com","title":"Example"}'`}</pre>
    </div>
  );
}

export function ActivityPanelV2() {
  useApp();
  const b = activityBridge;
  useEffect(() => {
    b?.onShow?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [sel, setSel] = useState<number | null>(null);
  const rows = b?.rows() ?? [];
  const hasEvents = b?.hasEvents() ?? false;
  return (
    <div className="v2-panel">
      <ActToolbar />
      <ActChips />
      <ActStatusBar />
      {/* id keeps the legacy #activity-table context-menu hook working. */}
      <div id="activity-table" className="fs-list">
        {hasEvents ? (
          <TreeTable<ActRow>
            columns={ACT_COLUMNS}
            data={rows}
            getRowId={(r) => String(r.id)}
            virtual
            defaultSorting={ACT_DEFAULT_SORT}
            rowTitle={(r) => r.title}
            rowClass={(r) => (r.id === sel ? "fs-selected" : undefined)}
            onRowClick={(r) => {
              setSel(r.id);
              // Any file-backed row (screenshot or logged file) opens the shared
              // file preview in a split-right tab.
              if (r.filePath) b?.openPreview(r.filePath);
            }}
            onRowDoubleClick={(r) => b?.onActivate(r)}
          />
        ) : (
          <ActivitySetup />
        )}
      </div>
    </div>
  );
}

// ---- favorites (saved AI turns), grouped by session ----
// Tree-data table (MUI-X style, same as the worktrees panel): each parent row is
// an on-disk AI session (editor + cwd), folding its favorited turns. The session
// row is "starred at" the latest of its turns, shows how many are saved, whether
// a live tmux session sits in its cwd, and a "resume" action that reattaches /
// relaunches the conversation. Turn children carry copy / locate / remove.
export interface FavTreeRow {
  id: string;
  kind: "session" | "turn";
  editor: "claude" | "opencode";
  label: string; // session: cwd basename / short id · turn: role
  starredAt: number; // session: max(created) · turn: this fav's `created`
  // session
  sessionId?: string; // on-disk conversation id (resume key)
  cwd?: string;
  count?: number; // # favorited turns folded under it
  live?: boolean; // a live tmux session exists in this cwd
  // turn
  role?: string;
  preview?: string;
  fav?: Fav; // the underlying fav (copy/locate/remove payload)
  children?: FavTreeRow[];
}

export interface FavBridge {
  rows: () => FavTreeRow[];
  onShow?: () => void;
  expanded: () => ExpandedState;
  setExpanded: (e: ExpandedState) => void;
  resume: (r: FavTreeRow) => void; // resume an on-disk session in its cwd
  copy: (f: Fav) => void; // full text → clipboard
  locate: (f: Fav) => void; // reveal the source (jsonl line / db id)
  remove: (f: Fav) => void;
}
let favBridge: FavBridge | null = null;
export function setFavoritesPanel(b: FavBridge) {
  favBridge = b;
}

function favWhen(ts: number): string {
  if (!ts) return "";
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Name column: session → live dot + editor badge + label + count; turn → role
// badge + preview text.
function FavNameCell({ row }: { row: FavTreeRow }) {
  if (row.kind === "session") {
    return (
      <>
        <span
          className={"dot" + (row.live ? " on" : "")}
          title={row.live ? "live session in this cwd" : "on disk"}
        />
        <span className={"fav-badge fav-" + row.editor}>{row.editor}</span>
        <span className="wt-label">{row.label}</span>
        <span className="wt-meta">{row.count} starred</span>
      </>
    );
  }
  return (
    <>
      <span className={"fav-role fav-role-" + row.role}>{row.role}</span>
      <span className="fav-preview-inline" title={row.fav?.locator}>
        {row.preview}
      </span>
    </>
  );
}

// Trailing actions: session → resume; turn → copy / locate / remove.
function FavActionsCell({ row }: { row: FavTreeRow }) {
  if (row.kind === "session") {
    return (
      <span className="wt-actions">
        <button
          className="wt-act wt-open"
          title="resume this conversation in its cwd"
          onClick={(e) => {
            e.stopPropagation();
            favBridge?.resume(row);
          }}
        >
          resume
        </button>
      </span>
    );
  }
  const f = row.fav!;
  return (
    <span className="wt-actions">
      <button
        className="wt-act"
        title="copy full text"
        onClick={(e) => {
          e.stopPropagation();
          favBridge?.copy(f);
        }}
      >
        copy
      </button>
      <button
        className="wt-act"
        title="reveal source"
        onClick={(e) => {
          e.stopPropagation();
          favBridge?.locate(f);
        }}
      >
        locate
      </button>
      <button
        className="wt-act"
        title="remove favorite"
        onClick={(e) => {
          e.stopPropagation();
          favBridge?.remove(f);
        }}
      >
        ×
      </button>
    </span>
  );
}

const FAV_COLUMNS: TreeColumn<FavTreeRow>[] = [
  { id: "name", header: "favorite", tree: true, cell: (r) => <FavNameCell row={r} /> },
  {
    id: "starred",
    header: "starred at",
    sortValue: (r) => r.starredAt,
    cell: (r) => <span className="fav-when">{favWhen(r.starredAt)}</span>,
  },
  { id: "actions", header: "", noRowClick: true, cell: (r) => <FavActionsCell row={r} /> },
];

// Search predicate: match editor/label/role/preview/cwd substring. A session row
// is kept when it or any child turn matches (filterFromLeafRows keeps ancestors).
function favFilter(r: FavTreeRow, q: string): boolean {
  const s = q.toLowerCase();
  return (
    r.label.toLowerCase().includes(s) ||
    r.editor.toLowerCase().includes(s) ||
    (r.role?.toLowerCase().includes(s) ?? false) ||
    (r.preview?.toLowerCase().includes(s) ?? false) ||
    (r.cwd?.toLowerCase().includes(s) ?? false)
  );
}

export function FavoritesPanelV2() {
  useApp();
  const b = favBridge;
  useEffect(() => {
    b?.onShow?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rows = b?.rows() ?? [];
  const total = rows.reduce((n, r) => n + (r.count ?? 0), 0);
  return (
    <div className="v2-panel">
      <div className="act-bar">
        <span className="spy-title">favorites</span>
        <span className="wt-count">
          {total ? `${total} in ${rows.length} session${rows.length > 1 ? "s" : ""}` : ""}
        </span>
      </div>
      <div className="panel-scroll fav-list">
        {rows.length === 0 ? (
          <div className="session-empty">
            no saved turns — favorite the current turn from a terminal
          </div>
        ) : (
          <TreeTable<FavTreeRow>
            columns={FAV_COLUMNS}
            data={rows}
            getRowId={(r) => r.id}
            getSubRows={(r) => r.children}
            controls
            filter={favFilter}
            searchPlaceholder="filter favorites…"
            expanded={b?.expanded() ?? {}}
            onExpandedChange={(e) => b?.setExpanded(e)}
            rowClass={(r) => `fav-${r.kind}`}
            rowTitle={(r) => (r.kind === "session" ? (r.cwd ?? r.label) : (r.fav?.locator ?? ""))}
            // Session rows are group nodes: double-click folds. A turn
            // double-click copies its text.
            toggleOnDoubleClick={(r) => r.kind === "session"}
            onRowDoubleClick={(r) => {
              if (r.kind === "turn" && r.fav) b?.copy(r.fav);
            }}
          />
        )}
      </div>
    </div>
  );
}

// Search predicate: match label/branch/path/session/meta substring (case-
// insensitive). A match on any field keeps the row; filterFromLeafRows keeps its
// ancestors too. Matches the full absolute path (not just the tildified display)
// so a query like an org or parent-dir segment filters the whole subtree.
function wtFilter(r: WtTreeRow, q: string): boolean {
  const s = q.toLowerCase();
  return (
    r.label.toLowerCase().includes(s) ||
    (r.branch?.toLowerCase().includes(s) ?? false) ||
    (r.pathDisplay?.toLowerCase().includes(s) ?? false) ||
    (r.worktree?.toLowerCase().includes(s) ?? false) ||
    (r.meta?.toLowerCase().includes(s) ?? false) ||
    (r.sessionName?.toLowerCase().includes(s) ?? false)
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
            controls
            virtual
            filter={wtFilter}
            searchPlaceholder="filter worktrees + files…"
            expanded={wtBridge?.expanded() ?? {}}
            onExpandedChange={(e) => wtBridge?.setExpanded(e)}
            // Leaf/space/dir show a twisty before their fs children load; the
            // toggle handler lazily lists the directory on first expand.
            getRowCanExpand={(r) => wtBridge?.canExpand(r) ?? false}
            onToggleExpand={(r, willExpand) => wtBridge?.onToggle(r, willExpand)}
            toggleOnDoubleClick={(r) => r.kind === "org" || r.kind === "clone" || r.kind === "dir"}
            rowClass={(r) => `wt-${r.kind}`}
            rowTitle={(r) => r.worktree ?? r.label}
            rowEntity={(r) =>
              (r.kind === "leaf" || r.kind === "file" || r.kind === "dir") && r.worktree
                ? { kind: r.kind === "file" ? "file" : "repo", value: r.worktree }
                : undefined
            }
            onRowClick={(r, e) => {
              if (r.kind === "leaf") wtBridge?.onLeafSingle(r, e.clientX, e.clientY);
              else if (r.kind === "file") wtBridge?.onFile(r);
              else if (r.kind === "session" && r.sessionName) wtBridge?.onResume(r.sessionName);
            }}
            onRowDoubleClick={(r) => {
              if (r.kind === "leaf") wtBridge?.onLeafDouble(r);
              else if (r.kind === "file") wtBridge?.onFileActivate(r);
              else if (r.kind === "session" && r.sessionName) wtBridge?.onResume(r.sessionName);
            }}
            onRowContextMenu={(r, e) => {
              if (r.kind === "leaf") wtBridge?.onLeafContext(r, e.clientX, e.clientY);
              else if (r.kind === "file" || r.kind === "dir")
                wtBridge?.onPathContext(r, e.clientX, e.clientY);
              else if (r.kind === "clone" || r.kind === "org")
                wtBridge?.onCloneContext(r, e.clientX, e.clientY);
            }}
          />
        )}
      </div>
    </div>
  );
}
