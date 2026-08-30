// Every durable setting, one StorageSignal each. This is the whole persisted
// slice: what used to be a field on AppState plus an entry in PERSIST plus a
// loadKey call is now a single line here.
//
// Read `settings.mode.$()`, write `settings.mode.$(next)`, subscribe with
// `settings.mode.$.subscribe(fn)`. Storage is per key, so writing one setting
// writes one key, and JSON under the same key names loadKey used means values
// saved by earlier builds load unchanged.
import { setting } from "./0_persistedSetting";
import type { HarnessId } from "./harnessTypes";
import {
  SAFE_BOOT,
  DEFAULT_CLICK_RULES,
  DEFAULT_WT_AGENTS,
  type ActivitySource,
  type ActivityType,
  type ClickRule,
  type Mode,
  type OpenTab,
  type SessionSort,
  type Sidebar,
  type Skin,
  type SortState,
  type SprefaScopeItem,
  type TermSidebarState,
  type WorktreeRow,
  type WtAgent,
  type WtView,
} from "./state";

// One-time key migrations. These rewrite localStorage and must run before any
// signal below reads it, which module evaluation order guarantees.
function migrate() {
  // resumeTabs changed from cwd-probe keys (which collided across worktrees) to
  // per-tab keys; the old shape resumes the wrong session, so it is dropped.
  if (localStorage.getItem("resumeTabsV2") !== "1") {
    localStorage.removeItem("resumeTabs");
    localStorage.setItem("resumeTabsV2", "1");
  }
  // Bump the suffix when the default rule set changes; a user's edits between
  // bumps survive.
  if (localStorage.getItem("clickRulesV3") !== "1") {
    localStorage.removeItem("clickRules");
    localStorage.setItem("clickRulesV3", "1");
  }
  // Per-terminal tabZoom (px font size keyed by session id) folds into the
  // generic panelZoom factor map (keyed by full panel id; factor = px / the
  // 13px terminal default). See src/panelZoom.ts.
  if (localStorage.getItem("panelZoomV1") !== "1") {
    const raw = localStorage.getItem("tabZoom");
    const old: Record<string, number> = raw ? JSON.parse(raw) : {};
    if (Object.keys(old).length) {
      const curRaw = localStorage.getItem("panelZoom");
      const cur: Record<string, number> = curRaw ? JSON.parse(curRaw) : {};
      for (const [sid, px] of Object.entries(old)) cur[`term:${sid}`] = px / 13;
      localStorage.setItem("panelZoom", JSON.stringify(cur));
    }
    localStorage.removeItem("tabZoom");
    localStorage.setItem("panelZoomV1", "1");
  }
}
try {
  migrate();
} catch {
  // A malformed old value must not stop the app from booting.
}

export type ResumeTabs = Record<string, { editor: HarnessId; sessionId: string }>;

export const settings = {
  // appearance
  skin: setting<Skin>("skin", "xp"),
  mode: setting<Mode>("mode", "light"),
  xpPixel: setting("xpPixel", false),
  zoom: setting("zoom", 1),
  panelZoom: setting<Record<string, number>>("panelZoom", {}),

  // chrome
  showToolbar: setting("showToolbar", false),
  sidebar: setting<Sidebar>("sidebar", "big"),
  sidebarWidth: setting("sidebarWidth", 150),
  termSidebar: setting<Record<string, TermSidebarState>>("termSidebar", {}),

  // terminal overlays
  // An app that owns the mouse (codex) emits OSC 52 on its own selection, which
  // the bridge would push to the system clipboard on every drag.
  clipboardFromTerminal: setting("clipboardFromTerminal", true),
  inlineDiagrams: setting("inlineDiagrams", true),
  inlineStructuredSelectors: setting("inlineStructuredSelectors", true),

  // tabs and layout
  active: setting<string | null>("active", null),
  openTabs: setting<OpenTab[]>("openTabs", []),
  tabTitles: setting<Record<string, string>>("tabTitles", {}),
  dockJSON: setting<unknown>("dockJSON", null),
  resumeTabs: setting<ResumeTabs>("resumeTabs", {}),
  pinnedTabs: setting<string[]>("pinnedTabs", []),

  // sessions and worktrees
  sessionWorktrees: setting<Record<string, string[]>>("sessionWorktrees", {}),
  autoWorktrees: setting<WorktreeRow[]>("autoWorktrees", []),
  sessionSort: setting<SessionSort>("sessionSort", { key: "activity", dir: "desc" }),
  pinnedSessions: setting<string[]>("pinnedSessions", []),
  wtView: setting<WtView>("wtView", "tree"),
  scanRoot: setting("scanRoot", "~/projects"),
  wtExpanded: setting<string[]>("wtExpanded", []),
  favExpanded: setting<string[]>("favExpanded", []),
  wtFavorites: setting<string[]>("wtFavorites", []),
  wtFocus: setting("wtFocus", false),
  wtAgents: setting<WtAgent[]>("wtAgents", DEFAULT_WT_AGENTS),
  spaces: setting<string[]>("spaces", []),

  // activity
  activitySource: setting<ActivitySource>("activitySource", "all"),
  activityType: setting<ActivityType>("activityType", "all"),
  captureEnabled: setting("captureEnabled", false),
  tableSort: setting<Record<string, SortState>>("tableSort", {}),

  // ai
  aiEnabled: setting("aiEnabled", true),
  autoResume: setting("autoResume", true),
  clickRules: setting<ClickRule[]>("clickRules", DEFAULT_CLICK_RULES),

  // sprefa
  sprefaScope: setting<SprefaScopeItem[]>("sprefaScope", []),
  sprefaScopeActive: setting("sprefaScopeActive", false),

  // plugins
  pluginState: setting<Record<string, unknown>>("pluginState", {}),
};

// The meme plugin used to persist its UI state directly under "meme:ui". Seed
// pluginState.meme from it once; the old key is left in place.
if (!SAFE_BOOT && settings.pluginState.$().meme === undefined) {
  const old = localStorage.getItem("meme:ui");
  if (old !== null) {
    try {
      settings.pluginState.$({ ...settings.pluginState.$(), meme: JSON.parse(old) });
    } catch {
      // ignore malformed old value
    }
  }
}
