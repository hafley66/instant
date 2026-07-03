// The single app store. UI/persisted state lives here; runtime resources (live
// xterm Terminals) stay in their own registry in main.ts. New durable fields
// (sessions, panels, layout) get added to AppState and listed in PERSIST.
import { createStore } from "./store";
import type { SortState } from "./table";

export type { SortState };

// How the sessions launcher orders its rows. "activity" = tmux last-activity.
export type SessionSortKey = "name" | "activity" | "windows" | "proc" | "pwd" | "chips";
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
// Mirror of capture::CapturePerms — TCC grants + whether the input tap is live.
export interface CapturePerms {
  screen_recording: boolean;
  accessibility: boolean;
  tap_active: boolean;
}
// Mirror of capture::CaptureStatus — the outcome of the last capture gesture.
export interface CaptureStatus {
  kind: string;
  ok: boolean;
  reason: string;
  ts: number;
}

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

// One AI-harness turn read off disk (Rust ledger::AiMessage). Identity is
// (editor, session_id, id); `text` is the full extracted plain text.
export interface AiMessage {
  editor: "claude" | "opencode";
  session_id: string;
  id: string;
  seq: number;
  role: string;
  ts: number;
  preview: string;
  text: string;
  locator: string;
}

// A favorited turn (Rust favorites::Fav) — a snapshot persisted to favorites.db,
// surfaced here as runtime state (the db, not localStorage, is authoritative).
export interface Fav extends AiMessage {
  message_id: string; // = AiMessage.id (the db column name)
  cwd: string;
  created: number;
}

// A reattachable tab: enough to re-`open_session` after a frontend reload. The
// tmux session (and the agent inside) survives in the Rust backend; only the
// xterm wiring is lost on reload, so we replay these on boot.
export interface OpenTab {
  name: string;
  command: string | null;
  cwd: string | null;
  graphics?: boolean; // kitty-graphics (awrit) tab — restore the overlay on reload
  browser?: boolean; // CDP browser tab — re-open the canvas on reload
  url?: string; // browser tab's URL (normalized) to reopen at
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

// A claude/opencode process on a real terminal outside any tmux session (Rust
// pty::RogueSession) — typed straight into Terminal.app/iTerm rather than
// opened through instant. Surfaced so it can be "adopted" into a tracked tmux
// worktree session instead of running off the grid.
export interface RogueSession {
  pid: number;
  tty: string;
  command: string; // "claude" | "opencode"
  args: string;
  cwd: string | null;
}

// A label + the shell command it launches, offered when opening a worktree
// session. User-editable (persisted as wtAgents) so the picker isn't hardcoded.
export interface WtAgent {
  label: string;
  command: string;
  // Flag this harness uses to resume a session by id (claude `--resume`,
  // opencode `--session`). When set and autoResume is on, the launcher appends
  // `<resume> <latest-session-id>` so the agent continues the last conversation
  // in that cwd instead of starting blank. Undefined = no resume support.
  resume?: string;
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
  showToolbar: boolean; // top toolbar (Shot/dark/skin); hidden by default, opt in via Config
  sidebar: Sidebar; // activity rail compact/big (persisted)
  active: string | null; // active tab id (persisted; replayed against reattached tabs)
  openTabs: OpenTab[]; // tabs to reattach after reload (tmux sessions outlive the webview)
  tabTitles: Record<string, string>; // durable per-panel title overrides, keyed by full panel id (persisted)
  dockJSON: unknown; // serialized dockview layout (persisted); null until first save
  sessions: Session[]; // live tmux sessions (runtime)
  rogueSessions: RogueSession[]; // claude/opencode running outside any tmux session (runtime, polled)
  sessionWorktrees: Record<string, string[]>; // session name -> worktree paths it has touched (persisted, accumulated)
  terminalTabs: TabMeta[]; // open terminal tabs (runtime; xterm lives in engine)
  worktrees: WorktreeRow[]; // last scan result (runtime)
  // Worktrees resolved on demand for a live session's cwd that the scan walk
  // never reached (outside scanRoot, or created after the last scan) — see
  // autoTrackSessionPaths. Persisted so a manually-started agent session stays
  // tracked across reloads; pruned once a real scan covers the same path.
  autoWorktrees: WorktreeRow[];
  activity: Event[]; // unified activity timeline (runtime)
  aiFavs: Fav[]; // favorited AI turns, mirrored from favorites.db (runtime)
  frontmostApp: string; // owner name of the current frontmost app (runtime; drives overlay focus behavior)
  // ---- overlay (coexist with another app, e.g. VSCode) ----
  overlayMode: "off" | "follow"; // off = normal summon window; follow = auto show/hide tracking overlayTarget's focus (persisted)
  overlayTarget: string; // app whose focus drives `follow` (CGWindow owner name, e.g. "Code") (persisted)
  overlayFade: boolean; // dim the window so it reads as a faded panel (persisted)
  miniMode: boolean; // compact single-column layout + smaller window (persisted)
  xpPixel: boolean; // "Super XP": force the grainy pixel font everywhere incl. terminal (persisted)
  activitySource: ActivitySource; // source filter chip (persisted)
  activityType: ActivityType; // event-type sub-filter chip (persisted)
  activityQuery: string; // fuzzy search box (runtime)
  captureEnabled: boolean; // screen-capture recording on/off (persisted, mirrors backend)
  capturePerms: CapturePerms | null; // TCC + tap state for the activity capture diagnostics (runtime)
  captureStatus: CaptureStatus | null; // last per-gesture capture outcome, from the capture-status event (runtime)
  config: ConfigView | null; // resolved observation config (runtime)
  fsChildren: Record<string, FsEntry[]>; // per-folder listings for the unified tree, loaded on expand (runtime)
  sessionSort: SessionSort; // sessions launcher ordering (persisted)
  tableSort: Record<string, SortState>; // per-dtable sort, keyed by table id (persisted)
  wtView: WtView; // tree vs flat table
  scanRoot: string; // worktrees scan path
  sidebarWidth: number; // px
  zoom: number; // webview zoom factor for chrome/rail/toolbars (persisted; applied via getCurrentWebview().setZoom)
  tabZoom: Record<string, number>; // per-terminal font size (px), keyed by tab/session id (persisted)
  // Agent sessions killed on tab close (to free RAM); reopen relaunches with
  // --resume <id>. Keyed by CWD — the stable identity for "the agent in this
  // worktree" (a reopen mints a fresh tmux name, so name keys don't recur).
  resumeTabs: Record<string, { editor: "claude" | "opencode"; sessionId: string }>;
  wtExpanded: string[]; // expanded tree node keys
  favExpanded: string[]; // expanded favorite-session node keys (persisted)
  wtFavorites: string[]; // starred worktree paths (persisted)
  spaces: string[]; // user-designated non-git folders to run AI sessions in (persisted); shown atop the Worktrees panel
  wtFocus: boolean; // when on, the worktree view shows only starred rows
  wtAddingClone: string | null; // clone path whose inline "+ worktree" branch input is open (runtime)
  wtAgents: WtAgent[]; // configurable agent picker for "open session here" (persisted)
  aiEnabled: boolean; // master switch for AI integrations; off hides wtAgents from the launch pickers (persisted, default true)
  clickRules: ClickRule[]; // ⌘-click token -> shell command table (persisted)
  autoResume: boolean; // when on, launching an agent resumes its latest session in that cwd (persisted, default true)
  pinnedSessions: string[]; // tmux session names pinned to the top of the list (persisted)
  pinnedTabs: string[]; // terminal tab session names pinned (persisted)
  sprefaScope: SprefaScopeItem[]; // selected files/repos/revs (persisted)
  sprefaScopeActive: boolean; // when on, scope contributes sel_* facts to queries
}

// Seeded into wtAgents on first run; thereafter the user's edited list wins.
export const DEFAULT_WT_AGENTS: WtAgent[] = [
  { label: "claude", command: "claude", resume: "--resume" },
  { label: "opencode", command: "opencode", resume: "--session" },
];

// What a ⌘-click on a terminal token does: the first rule whose `pattern` (a JS
// regex) matches the clicked token wins, and its `command` runs in the pane cwd
// with `$1` substituted by the shell-quoted token. Commands that print to stdout
// (rg) open a results panel on the right; launchers (open/code) print nothing.
export interface ClickRule {
  pattern: string;
  command: string;
}
export const DEFAULT_CLICK_RULES: ClickRule[] = [
  { pattern: "^(https?://|www\\.)", command: "open $1" }, // url -> browser
  // Catch-all: open in the editor only if the token (sans :line) is a real path,
  // else ripgrep it from cwd. The existence test is why this can't be pure regex
  // — `obj.method` looks file-ish but isn't a file, so it greps. `-n` makes rg
  // emit path:line:text so the panel can link each hit.
  // -F: match the token literally so punctuation (foo(), arr[0], a.b) isn't read
  // as a regex (which errors on unbalanced parens etc.). -e: so a token starting
  // with `-` (e.g. --flag) isn't taken as an rg flag.
  { pattern: ".", command: 'f=$1; if [ -e "${f%%:*}" ]; then code -g $1; else rg -nF -e $1; fi' },
];

// Durable slice, mirrored to localStorage. Runtime fields (active, sessions,
// worktrees) are excluded.
const PERSIST: (keyof AppState)[] = [
  "skin",
  "mode",
  "showToolbar",
  "sidebar",
  "active",
  "openTabs",
  "tabTitles",
  "dockJSON",
  "sessionWorktrees",
  "autoWorktrees",
  "activitySource",
  "activityType",
  "captureEnabled",
  "sessionSort",
  "tableSort",
  "wtView",
  "scanRoot",
  "sidebarWidth",
  "zoom",
  "tabZoom",
  "resumeTabs",
  "wtExpanded",
  "favExpanded",
  "overlayMode",
  "overlayTarget",
  "overlayFade",
  "miniMode",
  "xpPixel",
  "wtFavorites",
  "spaces",
  "wtFocus",
  "wtAgents",
  "aiEnabled",
  "clickRules",
  "autoResume",
  "pinnedSessions",
  "pinnedTabs",
  "sprefaScope",
  "sprefaScopeActive",
];

// JSON so arrays/numbers round-trip. Falls back to the raw string for values
// written by the old plain-string persistence (migrates skin/mode in place).
// Safe boot: skip reading persisted state so a corrupt value (e.g. a dock layout
// that throws "resource already disposed") can't jam startup. One-shot via a
// sessionStorage flag (survives reload, cleared on app restart) set by ⌘⇧R or the
// tray "Safe Reopen"; also honors a ?safe / ?reset URL param. The next normal
// layout change overwrites the bad persisted copy, so it self-heals.
export const SAFE_BOOT: boolean = (() => {
  try {
    if (sessionStorage.getItem("SAFE_BOOT") === "1") {
      sessionStorage.removeItem("SAFE_BOOT");
      return true;
    }
  } catch {
    /* sessionStorage can throw in locked-down contexts */
  }
  return /[?#&](safe|reset)\b/.test(location.search + location.hash);
})();

function loadKey<T>(k: string, fallback: T): T {
  if (SAFE_BOOT) return fallback;
  const raw = localStorage.getItem(k);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return typeof fallback === "string" ? (raw as unknown as T) : fallback;
  }
}

function load(): AppState {
  // One-time reset: resumeTabs changed from cwd-probe keys (which collided across
  // sessions sharing a cwd, resuming a random sibling) to session-name keys whose
  // ids we own via `claude --session-id`. Drop the old poisoned entries once.
  if (localStorage.getItem("resumeTabsV2") !== "1") {
    localStorage.removeItem("resumeTabs");
    localStorage.setItem("resumeTabsV2", "1");
  }
  // clickRules defaults changed twice during bring-up (existence-checked file
  // rule, then -F literal grep so punctuation doesn't break the regex). Drop the
  // old persisted copy once per bump so the new default takes over. Bump the
  // suffix when the default changes; a user's edits between bumps survive.
  if (localStorage.getItem("clickRulesV3") !== "1") {
    localStorage.removeItem("clickRules");
    localStorage.setItem("clickRulesV3", "1");
  }
  return {
    skin: loadKey<Skin>("skin", "xp"),
    mode: loadKey<Mode>("mode", "light"),
    showToolbar: loadKey<boolean>("showToolbar", false),
    sidebar: loadKey<Sidebar>("sidebar", "big"),
    active: loadKey<string | null>("active", null),
    openTabs: loadKey<OpenTab[]>("openTabs", []),
    tabTitles: loadKey<Record<string, string>>("tabTitles", {}),
    dockJSON: loadKey<unknown>("dockJSON", null),
    sessions: [],
    rogueSessions: [],
    sessionWorktrees: loadKey<Record<string, string[]>>("sessionWorktrees", {}),
    terminalTabs: [],
    worktrees: [],
    autoWorktrees: loadKey<WorktreeRow[]>("autoWorktrees", []),
    activity: [],
    aiFavs: [],
    frontmostApp: "",
    overlayMode: loadKey<"off" | "follow">("overlayMode", "off"),
    overlayTarget: loadKey<string>("overlayTarget", "Code"),
    overlayFade: loadKey<boolean>("overlayFade", false),
    miniMode: loadKey<boolean>("miniMode", false),
    xpPixel: loadKey<boolean>("xpPixel", false),
    activitySource: loadKey<ActivitySource>("activitySource", "all"),
    activityType: loadKey<ActivityType>("activityType", "all"),
    activityQuery: "",
    captureEnabled: loadKey<boolean>("captureEnabled", false),
    capturePerms: null,
    captureStatus: null,
    sessionSort: loadKey<SessionSort>("sessionSort", { key: "activity", dir: "desc" }),
    tableSort: loadKey<Record<string, SortState>>("tableSort", {}),
    config: null,
    fsChildren: {},
    wtView: loadKey<WtView>("wtView", "tree"),
    scanRoot: loadKey<string>("scanRoot", "~/projects"),
    sidebarWidth: loadKey<number>("sidebarWidth", 150),
    zoom: loadKey<number>("zoom", 1),
    tabZoom: loadKey<Record<string, number>>("tabZoom", {}),
    resumeTabs: loadKey<AppState["resumeTabs"]>("resumeTabs", {}),
    wtExpanded: loadKey<string[]>("wtExpanded", []),
    favExpanded: loadKey<string[]>("favExpanded", []),
    wtFavorites: loadKey<string[]>("wtFavorites", []),
    spaces: loadKey<string[]>("spaces", []),
    wtFocus: loadKey<boolean>("wtFocus", false),
    wtAddingClone: null,
    wtAgents: loadKey<WtAgent[]>("wtAgents", DEFAULT_WT_AGENTS),
    aiEnabled: loadKey<boolean>("aiEnabled", true),
    clickRules: loadKey<ClickRule[]>("clickRules", DEFAULT_CLICK_RULES),
    autoResume: loadKey<boolean>("autoResume", true),
    pinnedSessions: loadKey<string[]>("pinnedSessions", []),
    pinnedTabs: loadKey<string[]>("pinnedTabs", []),
    sprefaScope: loadKey<SprefaScopeItem[]>("sprefaScope", []),
    sprefaScopeActive: loadKey<boolean>("sprefaScopeActive", false),
  };
}

export const store = createStore<AppState>(load());

store.subscribe((s) => {
  for (const k of PERSIST) localStorage.setItem(k, JSON.stringify(s[k]));
}, PERSIST);
