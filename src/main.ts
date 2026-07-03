// Composition root: boot order, the command table, and the global Tauri event
// listeners. Every concern lives in its own module (terminal, tabs, browser,
// worktrees, favorites, activity, capture, overlay, chrome, dnd, sprefa,
// history, preview, clickrules, panels); this file only wires them together.
import "xp.css";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { homeDir } from "@tauri-apps/api/path";
// CSS Anchor Positioning isn't in WebKit yet (Tauri = WKWebView); this shims
// `anchor-name`/`position-anchor`/`anchor()`/`position-area` so tooltips and
// menus can be authored in native CSS. No-ops where the browser supports it.
import anchorPolyfill from "@oddbird/css-anchor-positioning/fn";
import { store, type CaptureStatus, type Event, type Fav } from "./state";
import { allPanels } from "./plugin";
import { initRail } from "./rail";
import { recordVisit } from "./nav";
import { registerRulesPlugin } from "./rules";
import { registerMeme } from "./meme";
import { isFilePickerOpen } from "./overlayGuard";
import { installKeymap, type Command } from "./keymap";
import { openPalette, isPaletteOpen } from "./palette";
import { type GraphicsFrame } from "./graphics";
import { cdpPerf } from "./cdp";
import {
  mountReactDock,
  togglePanel,
  setDockHooks,
  onDockChange,
} from "./reactdock";
import { setHomeDir, sessionId, activeId, flashStatus, nextSkin, showError, logLine } from "./core";
import { initPreviewThemeSync } from "./preview";
import { wireDomCmdClick } from "./clickrules";
import {
  tabs,
  openTab,
  activate,
  onTermShown,
  onTermClosed,
  fitTerm,
  zoomGesture,
  zoomResetGesture,
  sendTextToTab,
  setReplaying,
} from "./terminal";
import { browserTabs, spawnBrowserTab, openBrowserTab, cycleBrowserQuality, setBrowserPerf } from "./browser";
import {
  focusTabByOffset,
  focusTabN,
  closeActiveTab,
  openTabAtPwd,
  reopenLastTab,
  applyTabTitle,
  isPinnedTab,
  togglePinTab,
} from "./tabs";
import {
  refreshSessions,
  refreshRogue,
  scanWorktrees,
  renderWorktreesPanel,
  registerV2Bridges,
} from "./worktrees";
import {
  favoriteCurrentTurn,
  refreshFavorites,
  updateFavBadge,
} from "./favorites";
import { ACTIVITY_CAP, registerActivityBridge } from "./activity";
import { isCapturing, cancelHide, scheduleHide, captureToPrompt, toggleRecording } from "./capture";
import {
  ZOOM_STEP,
  applyZoom,
  applyOverlay,
  toggleMiniMode,
  toggleOverlayFade,
  cycleOverlayMode,
  toggleClickThrough,
} from "./overlay";
import {
  syncSkin,
  syncXpPixel,
  syncMode,
  applyToolbar,
  syncSidebar,
  syncToggles,
  wireChrome,
  wireWindowResize,
  wireRailResize,
  ctxItemsFor,
  setLastCtxY,
} from "./chrome";
import { wireContextMenu } from "./ctxmenu";
import { isDraggingIn, wireOsDrop } from "./dnd";
import { registerSprefa } from "./sprefa";
import { registerNav } from "./history";
import { registerBuiltin } from "./panels";

const TAB_COMMANDS: Command[] = [
  // The palette lists every command below that carries a `title`. ⌘⇧P, the
  // VSCode-standard binding.
  { id: "palette.open", keys: ["$mod+Shift+p"], title: "Show All Commands", group: "Palette", run: () => openPalette() },
  { id: "tab.next", keys: ["$mod+Shift+BracketRight", "Control+Tab"], title: "Next Tab", group: "Tabs", run: () => focusTabByOffset(1) },
  { id: "tab.prev", keys: ["$mod+Shift+BracketLeft", "Control+Shift+Tab"], title: "Previous Tab", group: "Tabs", run: () => focusTabByOffset(-1) },
  { id: "tab.close", keys: ["$mod+w"], title: "Close Tab", group: "Tabs", run: closeActiveTab },
  { id: "tab.open", keys: ["$mod+t"], title: "New Tab at Current Directory", group: "Tabs", run: openTabAtPwd },
  { id: "tab.reopen", keys: ["$mod+Shift+t"], title: "Reopen Closed Tab", group: "Tabs", run: reopenLastTab },
  { id: "tab.browser", keys: [], title: "Open Browser", group: "Tabs", run: () => openBrowserTab() },
  { id: "browser.quality", keys: [], title: "Cycle Render Quality", group: "Browser", run: () => cycleBrowserQuality() },
  { id: "browser.perf", keys: [], title: "Toggle Performance Mode (1x)", group: "Browser", run: () => setBrowserPerf(!cdpPerf()) },
  // "Super XP": grainy pixel font everywhere (chrome + terminal). Persisted.
  { id: "skin.xpPixel", keys: [], title: "Toggle Super XP (pixel font)", group: "Skin", run: () => store.set({ xpPixel: !store.get().xpPixel }) },
  { id: "skin.cycle", keys: [], title: "Cycle Skin", group: "Skin", run: () => store.set({ skin: nextSkin(store.get().skin) }) },
  // The top toolbar is opt-in; these keep its actions reachable when it's hidden.
  { id: "view.toolbar", keys: [], title: "Toggle Top Toolbar", group: "View", run: () => store.set({ showToolbar: !store.get().showToolbar }) },
  { id: "view.mode", keys: [], title: "Toggle Dark Mode", group: "View", run: () => store.set({ mode: store.get().mode === "dark" ? "light" : "dark" }) },
  { id: "view.shot", keys: [], title: "Screenshot to Active Terminal", group: "View", run: () => captureToPrompt() },
  // Favorite the active tab's latest AI turn (claude/opencode) into favorites.db.
  { id: "ai.favTurn", keys: ["$mod+Shift+s"], title: "Favorite Latest AI Turn", group: "AI", run: () => void favoriteCurrentTurn() },
  // Reload the webview — recover from a crashed React render without restarting
  // the app (tmux sessions outlive the reload, so nothing is lost).
  { id: "app.reload", keys: ["$mod+r"], title: "Reload Window", group: "App", run: () => location.reload() },
  // Safe reload: reload but skip reading persisted state (dock layout, tabs, …)
  // so a corrupt value can't re-jam startup. One-shot; the next layout change
  // rewrites the bad copy. See SAFE_BOOT in state.ts.
  {
    id: "app.safeReload",
    keys: ["$mod+Shift+r"],
    title: "Reload Window (Safe Boot)",
    group: "App",
    run: () => {
      try {
        sessionStorage.setItem("SAFE_BOOT", "1");
      } catch {
        /* ignore */
      }
      location.reload();
    },
  },
  // Zoom: cmd +/-/0. A focused terminal zooms its own font (persisted per tab);
  // otherwise the webview chrome (rail + toolbars) zooms (persisted, 0.5–2.0).
  { id: "app.zoomIn", keys: ["$mod+Equal", "$mod+Shift+Equal"], title: "Zoom In", group: "App", run: () => zoomGesture(ZOOM_STEP) },
  { id: "app.zoomOut", keys: ["$mod+Minus"], title: "Zoom Out", group: "App", run: () => zoomGesture(-ZOOM_STEP) },
  { id: "app.zoomReset", keys: ["$mod+Digit0"], title: "Reset Zoom", group: "App", run: zoomResetGesture },
  // Overlay controls: mini layout, faded panel, follow-focus mode, click-through.
  { id: "overlay.mini", keys: ["$mod+Shift+m"], title: "Toggle Mini Mode", group: "Overlay", run: toggleMiniMode },
  { id: "overlay.fade", keys: ["$mod+Shift+d"], title: "Toggle Fade", group: "Overlay", run: toggleOverlayFade },
  { id: "overlay.mode", keys: ["$mod+Shift+o"], title: "Cycle Overlay Mode", group: "Overlay", run: cycleOverlayMode },
  { id: "overlay.clickThrough", keys: ["$mod+Shift+i"], title: "Toggle Click-Through", group: "Overlay", run: () => void toggleClickThrough() },
  // cmd/ctrl+1..9 jump to a tab (9 = last). Palette-hidden (no title): too many,
  // and the palette is for discovery, not numbered jumps.
  ...Array.from({ length: 9 }, (_, i) => ({
    id: `tab.goto${i + 1}`,
    keys: [`$mod+${i + 1}`],
    run: () => focusTabN(i + 1),
  })),
];

async function main() {
  // Resolve the home dir once so tildify() can stay synchronous during render.
  setHomeDir(await homeDir().catch(() => ""));
  // On theme flip, re-render open file/diff previews so syntax colors track.
  initPreviewThemeSync();
  // Skin/mode are store-driven: subscribe for changes, then apply once for the
  // persisted initial state.
  store.subscribe(syncSkin, ["skin"]);
  store.subscribe(syncXpPixel, ["xpPixel"]);
  store.subscribe(syncMode, ["mode"]);
  store.subscribe(applyToolbar, ["showToolbar"]);
  store.subscribe(syncSidebar, ["sidebar"]);
  // dockview owns the layout; we only react: refit the active terminal
  // whenever dockview re-lays-out a group. Panel lazy-load is handled per-panel
  // via PanelDef.onShow in the plugin registry.
  setDockHooks({
    onTermActivate: onTermShown,
    onTermClose: onTermClosed,
    onTermLayout: fitTerm,
    onTermRetitle: (sid) => applyTabTitle(sid.slice(sessionId("").length)),
    isTermPinned: (sid) => isPinnedTab(sid.slice(sessionId("").length)),
    toggleTermPin: (sid) => togglePinTab(sid.slice(sessionId("").length)),
  });
  store.subscribe(renderWorktreesPanel, [
    "worktrees",
    "wtView",
    "wtExpanded",
    "wtFocus",
    "wtFavorites",
    "wtAgents",
  ]);
  syncSkin(store.get());
  syncXpPixel(store.get());
  syncMode(store.get());
  applyToolbar(store.get());
  syncSidebar(store.get());
  renderWorktreesPanel();
  // Re-apply the persisted recording flag to the backend (default off there).
  invoke("capture_set_enabled", { on: store.get().captureEnabled }).catch(
    console.error,
  );

  applyZoom(); // restore persisted webview zoom
  registerBuiltin();
  registerRulesPlugin();
  registerSprefa();
  registerNav();
  registerMeme();
  registerV2Bridges();
  registerActivityBridge();
  refreshFavorites();
  initRail(); // builds the rail, then wires drag-reorder + right-click visibility (src/rail.ts)
  store.subscribe(updateFavBadge, ["aiFavs"]);
  updateFavBadge();
  // Activate anchor-positioning where it's not native (WebKit) AFTER the rail
  // exists, so the polyfill discovers the .rail-tip anchors. useAnimationFrame
  // keeps anchored elements positioned as layout/scroll changes. Gate on the
  // anchor() FUNCTION, not just the anchor-name property: WebKit may parse the
  // property while lacking positioning, which would skip the polyfill and leave
  // the tooltip stuck at the top.
  if (!CSS.supports("left: anchor(--x right)")) {
    anchorPolyfill({ useAnimationFrame: true }).catch(console.error);
  }
  wireChrome();
  wireDomCmdClick(); // ⌘-click search inside preview / rg panels (not just terminals)
  // A dock failure must not abort the rest of boot (sessions, pty listeners).
  try {
    onDockChange(syncToggles); // keep rail highlights in sync as panels open/close
    mountReactDock(document.getElementById("dock")!); // dockview-react renders + adopts the pooled panels
    syncToggles();
  } catch (e) {
    showError("wireDock", e);
  }
  wireWindowResize();
  wireRailResize();
  wireOsDrop().catch((e) => showError("wireOsDrop", e));
  // Capture the right-click Y (capture phase, before wireContextMenu's bubble
  // handler) so ctxItemsFor can map it to a terminal buffer row for turn-identify.
  document.addEventListener("contextmenu", (e) => setLastCtxY(e.clientY), true);
  wireContextMenu(ctxItemsFor);
  await refreshSessions();
  // Scan worktrees in the background so session rows can show which worktrees
  // they've touched; re-relate sessions once the scan lands.
  scanWorktrees().then(refreshSessions).catch(() => {});
  // Background poll for AI harnesses running outside tmux entirely (ps + lsof,
  // cheap). Runs regardless of which panel is open so a rogue session gets
  // flagged even if the user never opens the tmux panel to look for it.
  refreshRogue();
  setInterval(refreshRogue, 8000);

  await listen<{ id: string; chunk: string }>("pty-data", (e) => {
    tabs.get(e.payload.id)?.term.write(e.payload.chunk);
  });

  // Kitty graphics frames resolved by the Rust proxy (graphics sessions only).
  await listen<GraphicsFrame>("pty-graphics", (e) => {
    tabs.get(e.payload.id)?.overlay?.push(e.payload);
  });

  // CDP engine failed to launch/attach a browser tab.
  await listen<{ id: string; error: string }>("cdp-error", (e) => {
    console.error("[cdp]", e.payload.error);
    flashStatus(`browser error: ${e.payload.error}`);
  });

  // Global navigation history: every browser tab's URL change (link, redirect,
  // SPA pushState) lands here regardless of which tab it came from. The per-tab
  // CdpView listens to the same event for its own address bar / back-forward.
  await listen<{ id: string; url: string }>("cdp-url", (e) => {
    recordVisit(e.payload.url);
  });

  // Reattach tabs that were open before the reload. The tmux sessions (and the
  // agents inside) are still alive in the Rust backend; `tmux new-session -A`
  // reattaches. Capture the wanted active id first — openTab() flips active as
  // it replays — then restore it once all tabs exist.
  const wantActive = store.get().active;
  setReplaying(true); // don't log restored tabs as fresh visits
  for (const t of store.get().openTabs) {
    if (t.browser && t.url) spawnBrowserTab(t.name, t.url);
    else openTab(t.name, { command: t.command, cwd: t.cwd, graphics: t.graphics });
  }
  setReplaying(false);
  if (wantActive && (tabs.has(wantActive) || browserTabs.has(wantActive))) activate(wantActive);

  // Each new activity row (browser ingest, os capture, file open) arrives here;
  // prepend, newest-first, capped.
  await listen<Event>("activity-added", (e) => {
    store.set({
      activity: [e.payload, ...store.get().activity].slice(0, ACTIVITY_CAP),
    });
  });

  // Per-gesture capture outcome (shot saved, or the reason it was skipped) —
  // drives the Activity panel's live status line + permission banner.
  await listen<CaptureStatus>("capture-status", (e) => {
    store.set({ captureStatus: e.payload });
  });

  // favorites.db mutated (add/remove) — refresh the mirror so any open panel
  // re-renders. The emitting command also returns the list, but this keeps
  // multiple windows / out-of-band edits in sync.
  await listen<Fav[]>("favorites-changed", (e) => {
    store.set({ aiFavs: e.payload });
  });

  // Frontmost-app stream (Rust polls every 400ms). Foundation for the overlay
  // state machine: stash who's in front so panels can react to focus (e.g. raise
  // / fade when VSCode comes forward). "instant" while we're focused; ignore self.
  await listen<string>("frontmost-app", (e) => {
    const app = e.payload;
    if (app && app !== "instant") store.set({ frontmostApp: app });
  });

  // Summon: replay entrance animation + refocus active terminal.
  await listen("summoned", () => {
    const app = document.getElementById("app")!;
    app.classList.remove("summon-in");
    void app.offsetWidth; // restart the CSS animation
    app.classList.add("summon-in");
    refreshSessions();
    // Window may reappear at a new size/position; refit so the grid (and the
    // tmux pane behind it) matches, otherwise the TUI draws clipped.
    const id = activeId();
    if (id) {
      const t = tabs.get(id);
      requestAnimationFrame(() => {
        t?.fit.fit();
        t?.term.focus();
      });
    }
  });

  // Each terminal panel refits itself via dockview's onDidDimensionsChange
  // (wired through onTermLayout -> fitTerm), so no global ResizeObserver here.

  // Esc hides the popover — unless the command palette is open, where Esc just
  // closes the palette (handled on its own input, which stops propagation).
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !isPaletteOpen()) getCurrentWindow().hide();
  });

  // Central keymap: binds the command table on the window. The focused-terminal
  // path is intercepted inside attachCustomKeyEventHandler (runMatchingCommand)
  // so combos aren't typed into the pty. The rail panels (tmux, Worktrees,
  // Activity, Favorites, Config, Sprefa, …) are added as palette commands so
  // they're reachable from ⌘⇧P, not just the rail buttons. Built here because
  // plugins are registered by now.
  const panelCommands: Command[] = allPanels().map((p) => ({
    id: `panel.${p.id}`,
    keys: [],
    title: `Toggle ${p.title}`,
    group: "Panel",
    run: () => togglePanel(p.id),
  }));
  installKeymap([...TAB_COMMANDS, ...panelCommands]);

  // Overlay: re-apply on any change to its config or the frontmost app, then once
  // now so a persisted mini/fade/follow is restored on boot.
  store.subscribe(applyOverlay, [
    "overlayMode",
    "overlayTarget",
    "overlayFade",
    "miniMode",
    "frontmostApp",
  ]);
  applyOverlay();

  // Right-⌘ + Right-⇧ + V: the native tap (lib.rs) swallows the combo, copies
  // the focused app's selection, and emits the text here. Write it straight into
  // the active terminal (no picker).
  await listen<string>("send-highlight-text", (e) => {
    const id = activeId();
    const text = e.payload;
    if (!text || !text.trim()) return showError("highlight", "nothing selected to send");
    if (id) sendTextToTab(id, text + " ");
  });

  // Tray menu "Recording" item toggles capture (same path as the panel button).
  await listen("toggle-record", () => toggleRecording());

  // Tray menu "AI Integrations" master switch: off hides agents from the launch
  // pickers (shell only). Persisted via the store.
  await listen("toggle-ai", () => {
    const on = !store.get().aiEnabled;
    store.set({ aiEnabled: on });
    flashStatus(`AI integrations ${on ? "on" : "off"}`);
  });

  // Click-outside dismiss: hide when the window loses focus. Gated on a prior
  // focus so it doesn't self-hide at launch, and suppressed during screenshot.
  const win = getCurrentWindow();
  let everFocused = false;
  await win.onFocusChanged(({ payload: focused }) => {
    if (focused) {
      everFocused = true;
      cancelHide();
      return;
    }
    if (everFocused && !isCapturing() && !isDraggingIn() && !isFilePickerOpen()) {
      // Defer so a drag-in (which blurs us) can land; a drag-enter cancels it.
      // Kept short so tab-away/click-out dismiss feels instant.
      cancelHide();
      scheduleHide(() => win.hide(), 120);
    }
  });
}

// Mirror console.error to the on-disk log. Most invoke failures use
// `.catch(console.error)` (open_session, list_sessions, addPanel, …) and never
// reach showError, so without this they're invisible in a bundled build — which
// is exactly how a recoverable tmux/dock error reads as "jammed, no diagnostics".
{
  const orig = console.error.bind(console);
  const fmt = (a: unknown): string => {
    if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  console.error = (...args: unknown[]) => {
    orig(...args);
    try {
      logLine("[console.error] " + args.map(fmt).join(" "));
    } catch {
      /* ignore */
    }
  };
}

window.addEventListener("error", (e) => showError("error", e.error ?? e.message));
window.addEventListener("unhandledrejection", (e) => showError("promise", e.reason));

main().catch((e) => showError("main", e));
