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
  { id: "name", header: "worktree", tree: true, cell: (r) => <WtNameCell row={r} /> },
  { id: "branch", header: "branch", cell: (r) => (r.kind === "leaf" ? r.branch : "") },
  { id: "head", header: "head", cell: (r) => (r.kind === "leaf" ? r.head : "") },
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

// ---- favorites (saved AI turns) ----
// Flat list of favorited harness messages (a snapshot from favorites.db). Each
// row: editor + role + relative time + preview, with copy / locate / remove.
export interface FavBridge {
  favs: () => Fav[];
  onShow?: () => void;
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

export function FavoritesPanelV2() {
  useApp();
  const b = favBridge;
  useEffect(() => {
    b?.onShow?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const favs = b?.favs() ?? [];
  return (
    <div className="v2-panel">
      <div className="act-bar">
        <span className="spy-title">favorites</span>
        <span className="wt-count">{favs.length ? `${favs.length} saved` : ""}</span>
      </div>
      <div className="panel-scroll fav-list">
        {favs.length === 0 ? (
          <div className="session-empty">
            no saved turns — favorite the current turn from a terminal
          </div>
        ) : (
          favs.map((f) => (
            <div className="fav-row" key={`${f.editor}:${f.session_id}:${f.message_id}`}>
              <div className="fav-head">
                <span className={"fav-badge fav-" + f.editor}>{f.editor}</span>
                <span className={"fav-role fav-role-" + f.role}>{f.role}</span>
                <span className="fav-when">{favWhen(f.created)}</span>
                <span className="spy-spacer" />
                <button className="wt-act" title="copy full text" onClick={() => b?.copy(f)}>
                  copy
                </button>
                <button className="wt-act" title="reveal source" onClick={() => b?.locate(f)}>
                  locate
                </button>
                <button className="wt-act" title="remove favorite" onClick={() => b?.remove(f)}>
                  ×
                </button>
              </div>
              <div className="fav-preview" title={f.locator}>
                {f.preview}
              </div>
            </div>
          ))
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
            }}
          />
        )}
      </div>
    </div>
  );
}
