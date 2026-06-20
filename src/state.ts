// The single app store. UI/persisted state lives here; runtime resources (live
// xterm Terminals) stay in their own registry in main.ts. New durable fields
// (sessions, panels, layout) get added to AppState and listed in PERSIST.
import { createStore } from "./store";

export type Skin = "xp" | "p5" | "ac3";
export type Mode = "light" | "dark";
export type Panel = "terminal" | "worktrees";
export type WtView = "tree" | "table";

// A reattachable tab: enough to re-`open_session` after a frontend reload. The
// tmux session (and the agent inside) survives in the Rust backend; only the
// xterm wiring is lost on reload, so we replay these on boot.
export interface OpenTab {
  name: string;
  command: string | null;
  cwd: string | null;
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
  active: string | null; // active tab id (persisted; replayed against reattached tabs)
  openTabs: OpenTab[]; // tabs to reattach after reload (tmux sessions outlive the webview)
  workspaces: Workspace[]; // backend-owned, not persisted client-side
  panel: Panel; // terminal vs worktrees table
  worktrees: WorktreeRow[]; // last scan result (runtime)
  wtView: WtView; // tree vs flat table
  scanRoot: string; // worktrees scan path
  sidebarWidth: number; // px
  wtExpanded: string[]; // expanded tree node keys
}

// Durable slice, mirrored to localStorage. Runtime fields (active, workspaces,
// worktrees) are excluded.
const PERSIST: (keyof AppState)[] = [
  "skin",
  "mode",
  "active",
  "openTabs",
  "panel",
  "wtView",
  "scanRoot",
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
    active: loadKey<string | null>("active", null),
    openTabs: loadKey<OpenTab[]>("openTabs", []),
    workspaces: [],
    panel: loadKey<Panel>("panel", "terminal"),
    worktrees: [],
    wtView: loadKey<WtView>("wtView", "tree"),
    scanRoot: loadKey<string>("scanRoot", "~/projects"),
    sidebarWidth: loadKey<number>("sidebarWidth", 150),
    wtExpanded: loadKey<string[]>("wtExpanded", []),
  };
}

export const store = createStore<AppState>(load());

store.subscribe((s) => {
  for (const k of PERSIST) localStorage.setItem(k, JSON.stringify(s[k]));
}, PERSIST);
