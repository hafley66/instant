// The single app store. UI/persisted state lives here; runtime resources (live
// xterm Terminals) stay in their own registry in main.ts. New durable fields
// (sessions, panels, layout) get added to AppState and listed in PERSIST.
import { createStore } from "./store";

export type Skin = "xp" | "p5" | "ac3";
export type Mode = "light" | "dark";
export type Sidebar = "compact" | "big"; // activity rail: icons-only vs labelled
// Dockable surfaces. Each is a DOM subtree that lives in one zone at a time.
// Dockable tool/sessions panels. Terminals are separate dynamic panels
// (id `term:<sessionId>`), not part of this union.
export type PanelId =
  | "sessions"
  | "worktrees"
  | "activity"
  | "files"
  | "preview"
  | "config";
// Direction a panel docks toward when toggled on from the toolbar (relative to
// the terminal). Consumed by dock.ts -> dockview addPanel position.
export type DockDir = "left" | "right" | "below";
export const DEFAULT_DIR: Record<PanelId, DockDir> = {
  sessions: "left",
  worktrees: "right",
  activity: "right",
  files: "right",
  preview: "right",
  config: "right",
};

export type WtView = "tree" | "table";
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

// Mirror of the Rust workspace::Workspace registry (backend-owned).
export interface Workspace {
  id: string;
  repo: string;
  branch: string;
  path: string;
  agent: string;
  created: number;
}

export interface AppState {
  skin: Skin;
  mode: Mode;
  sidebar: Sidebar; // activity rail compact/big (persisted)
  active: string | null; // active tab id (persisted; replayed against reattached tabs)
  openTabs: OpenTab[]; // tabs to reattach after reload (tmux sessions outlive the webview)
  workspaces: Workspace[]; // backend-owned, not persisted client-side
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
  wtView: WtView; // tree vs flat table
  scanRoot: string; // worktrees scan path
  fsCwd: string; // Files explorer current directory (persisted)
  sidebarWidth: number; // px
  wtExpanded: string[]; // expanded tree node keys
}

// Durable slice, mirrored to localStorage. Runtime fields (active, workspaces,
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
  "wtView",
  "scanRoot",
  "fsCwd",
  "sidebarWidth",
  "wtExpanded",
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
    workspaces: [],
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
    config: null,
    files: null,
    fsSelected: null,
    wtView: loadKey<WtView>("wtView", "tree"),
    scanRoot: loadKey<string>("scanRoot", "~/projects"),
    fsCwd: loadKey<string>("fsCwd", "~"),
    sidebarWidth: loadKey<number>("sidebarWidth", 150),
    wtExpanded: loadKey<string[]>("wtExpanded", []),
  };
}

export const store = createStore<AppState>(load());

store.subscribe((s) => {
  for (const k of PERSIST) localStorage.setItem(k, JSON.stringify(s[k]));
}, PERSIST);
