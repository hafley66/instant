// The single app store. UI/persisted state lives here; runtime resources (live
// xterm Terminals) stay in their own registry in main.ts. New durable fields
// (sessions, panels, layout) get added to AppState and listed in PERSIST.
import { createStore } from "./store";
import type { SortState } from "./table";

export type { SortState };

// How the sessions launcher orders its rows. "activity" = tmux last-activity.
export type SessionSortKey = "name" | "activity" | "windows";
export interface SessionSort {
  key: SessionSortKey;
  dir: "asc" | "desc";
}

export type Skin = "xp" | "p5" | "ac3";
export type Mode = "light" | "dark";
export type Sidebar = "compact" | "big"; // activity rail: icons-only vs labelled
// Dockable surfaces. Each is a DOM subtree that lives in one zone at a time.
// Dockable tool/sessions panels. Terminals are separate dynamic panels
// (id `term:<sessionId>`), not part of this union. Panel ids are now
// registered through the plugin registry (plugin.tsx) — not a hardcoded union.
export type PanelId = string;

export type WtView = "tree" | "table";

// Files, repos, and revs are the common sprefa entities. A selection of them is
// the "scope tray": a collection you build by clicking/dragging entity cells.
// When sprefaScopeActive, runSprefaScratch prepends sel_repo/sel_file/sel_rev
// facts so queries can join against the selection.
export type SprefaScopeKind = "repo" | "file" | "rev";
export interface SprefaScopeItem {
  kind: SprefaScopeKind;
  value: string;
}
export type ActivitySource = "all" | "browser" | "os" | "files" | "session";
export type ActivityType =
  | "all"
  | "highlight"
  | "clip"
  | "image"
  | "file"
  | "url"
  | "click";

// A filesystem entry (Rust fs::Entry) for the Files explorer.
export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number; // unix ms
  ext: string;
}

// One directory listing (Rust fs::DirListing).
export interface DirListing {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

// One row of the unified activity store (Rust activity::Event). Sources: a
// browser DOM/tab event (extension), an os screen capture (gesture), or a file
// open (Files panel).
export interface Event {
  id: number;
  ts: number; // unix ms
  source: "browser" | "os" | "files" | "session";
  kind: string; // nav|click|dblclick|drag|copy|paste|tabopen|open|focus|…
  app: string; // frontmost app (os captures)
  url: string;
  title: string; // browser title / file name
  text: string; // selection/clipboard / file path / dom context
  shot: string; // screenshot path (os captures)
}

// Resolved observation config (Rust config::ConfigView). Edited in the Config
// panel; written back to config.json via config_set.
export interface ConfigView {
  path: string;
  source: "file" | "default";
  error: string | null;
  exclude_sites: string[];
  exclude_files: string[];
  exclude_apps: string[];
  excluded_count: number;
}

// A reattachable tab: enough to re-`open_session` after a frontend reload. The
// tmux session (and the agent inside) survives in the Rust backend; only the
// xterm wiring is lost on reload, so we replay these on boot.
export interface OpenTab {
  name: string;
  command: string | null;
  cwd: string | null;
}

// A live tmux session row (Rust pty::Session).
export interface Session {
  name: string;
  windows: number;
  attached: boolean;
  activity: number; // unix seconds of last activity (tmux #{session_activity})
  created: number; // unix seconds the session was created
  paths: string[]; // distinct pane cwds; mapped to worktrees it has touched
  commands: string[]; // distinct foreground process per pane (#{pane_current_command}): claude, nvim, zsh…
}

// A label + the shell command it launches, offered when opening a worktree
// session. User-editable (persisted as wtAgents) so the picker isn't hardcoded.
export interface WtAgent {
  label: string;
  command: string;
}

// One open terminal tab (its xterm lives in the engine registry, keyed by id).
export interface TabMeta {
  id: string;
  name: string;
}

// A discovered git worktree (Rust worktrees::WorktreeRow).
export interface WorktreeRow {
  origin: string;
  clone: string;
  worktree: string;
  branch: string;
  head: string;
  is_main: boolean;
  dirty: boolean;
}

export interface AppState {
  skin: Skin;
  mode: Mode;
  sidebar: Sidebar; // activity rail compact/big (persisted)
  active: string | null; // active tab id (persisted; replayed against reattached tabs)
  openTabs: OpenTab[]; // tabs to reattach after reload (tmux sessions outlive the webview)
  dockJSON: unknown; // serialized dockview layout (persisted); null until first save
  sessions: Session[]; // live tmux sessions (runtime)
  sessionWorktrees: Record<string, string[]>; // session name -> worktree paths it has touched (persisted, accumulated)
  terminalTabs: TabMeta[]; // open terminal tabs (runtime; xterm lives in engine)
  worktrees: WorktreeRow[]; // last scan result (runtime)
  activity: Event[]; // unified activity timeline (runtime)
  activitySource: ActivitySource; // source filter chip (persisted)
  activityType: ActivityType; // event-type sub-filter chip (persisted)
  activityQuery: string; // fuzzy search box (runtime)
  captureEnabled: boolean; // screen-capture recording on/off (persisted, mirrors backend)
  config: ConfigView | null; // resolved observation config (runtime)
  files: DirListing | null; // current Files explorer listing (runtime)
  fsSelected: string | null; // selected file path in the explorer (runtime)
  sessionSort: SessionSort; // sessions launcher ordering (persisted)
  tableSort: Record<string, SortState>; // per-dtable sort, keyed by table id (persisted)
  wtView: WtView; // tree vs flat table
  scanRoot: string; // worktrees scan path
  fsCwd: string; // Files explorer current directory (persisted)
  sidebarWidth: number; // px
  wtExpanded: string[]; // expanded tree node keys
  wtFavorites: string[]; // starred worktree paths (persisted)
  wtFocus: boolean; // when on, the worktree view shows only starred rows
  wtAgents: WtAgent[]; // configurable agent picker for "open session here" (persisted)
  pinnedSessions: string[]; // tmux session names pinned to the top of the list (persisted)
  sprefaScope: SprefaScopeItem[]; // selected files/repos/revs (persisted)
  sprefaScopeActive: boolean; // when on, scope contributes sel_* facts to queries
}

// Seeded into wtAgents on first run; thereafter the user's edited list wins.
export const DEFAULT_WT_AGENTS: WtAgent[] = [
  { label: "claude", command: "claude" },
  { label: "opencode", command: "opencode" },
];

// Durable slice, mirrored to localStorage. Runtime fields (active, sessions,
// worktrees) are excluded.
const PERSIST: (keyof AppState)[] = [
  "skin",
  "mode",
  "sidebar",
  "active",
  "openTabs",
  "dockJSON",
  "sessionWorktrees",
  "activitySource",
  "activityType",
  "captureEnabled",
  "sessionSort",
  "tableSort",
  "wtView",
  "scanRoot",
  "fsCwd",
  "sidebarWidth",
  "wtExpanded",
  "wtFavorites",
  "wtFocus",
  "wtAgents",
  "pinnedSessions",
  "sprefaScope",
  "sprefaScopeActive",
];

// JSON so arrays/numbers round-trip. Falls back to the raw string for values
// written by the old plain-string persistence (migrates skin/mode in place).
function loadKey<T>(k: string, fallback: T): T {
  const raw = localStorage.getItem(k);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return typeof fallback === "string" ? (raw as unknown as T) : fallback;
  }
}

function load(): AppState {
  return {
    skin: loadKey<Skin>("skin", "xp"),
    mode: loadKey<Mode>("mode", "light"),
    sidebar: loadKey<Sidebar>("sidebar", "big"),
    active: loadKey<string | null>("active", null),
    openTabs: loadKey<OpenTab[]>("openTabs", []),
    dockJSON: loadKey<unknown>("dockJSON", null),
    sessions: [],
    sessionWorktrees: loadKey<Record<string, string[]>>("sessionWorktrees", {}),
    terminalTabs: [],
    worktrees: [],
    activity: [],
    activitySource: loadKey<ActivitySource>("activitySource", "all"),
    activityType: loadKey<ActivityType>("activityType", "all"),
    activityQuery: "",
    captureEnabled: loadKey<boolean>("captureEnabled", false),
    sessionSort: loadKey<SessionSort>("sessionSort", { key: "activity", dir: "desc" }),
    tableSort: loadKey<Record<string, SortState>>("tableSort", {}),
    config: null,
    files: null,
    fsSelected: null,
    wtView: loadKey<WtView>("wtView", "tree"),
    scanRoot: loadKey<string>("scanRoot", "~/projects"),
    fsCwd: loadKey<string>("fsCwd", "~"),
    sidebarWidth: loadKey<number>("sidebarWidth", 150),
    wtExpanded: loadKey<string[]>("wtExpanded", []),
    wtFavorites: loadKey<string[]>("wtFavorites", []),
    wtFocus: loadKey<boolean>("wtFocus", false),
    wtAgents: loadKey<WtAgent[]>("wtAgents", DEFAULT_WT_AGENTS),
    pinnedSessions: loadKey<string[]>("pinnedSessions", []),
    sprefaScope: loadKey<SprefaScopeItem[]>("sprefaScope", []),
    sprefaScopeActive: loadKey<boolean>("sprefaScopeActive", false),
  };
}

export const store = createStore<AppState>(load());

store.subscribe((s) => {
  for (const k of PERSIST) localStorage.setItem(k, JSON.stringify(s[k]));
}, PERSIST);
