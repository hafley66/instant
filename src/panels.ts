// The builtin plugin: registers the core rail panels (tmux, Worktrees, Activity,
// Favorites, Config, Status) and the config-panel option toggles. The panel
// bodies are React components (tablepanels.tsx / status.tsx); onShow wires each
// to its lazy data refresh.
import { registerPlugin } from "./plugin";
import {
  TmuxPanelV2,
  WorktreesPanelV2,
  ActivityPanelV2,
  FavoritesPanelV2,
} from "./tablepanels";
import { StatusPanelV2, registerBuiltinStatus } from "./status";
import { store } from "./state";
import { cdpPerf } from "./cdp";
import { setBrowserPerf } from "./browser";
import { refreshSessions, scanWorktreesIfNeeded } from "./worktrees";
import { refreshConfig } from "./activity";
import { refreshFavorites } from "./favorites";

export function registerBuiltin() {
  registerPlugin({
    id: "builtin",
    // Config-panel toggles. Effects live in store.subscribe(applyToolbar /
    // syncXpPixel), so set() only flips state and any source (here, palette,
    // keymap) triggers the same effect.
    options: [
      {
        id: "showToolbar",
        label: "Show top toolbar",
        hint: "Shot / dark-mode / skin buttons (hidden by default)",
        get: () => store.get().showToolbar,
        set: (on) => store.set({ showToolbar: on }),
      },
      {
        id: "xpPixel",
        label: "Super XP (pixel font)",
        hint: "grainy bitmap font everywhere, incl. the terminal",
        get: () => store.get().xpPixel,
        set: (on) => store.set({ xpPixel: on }),
      },
      {
        id: "cdpPerf",
        label: "Browser performance mode",
        hint: "render at 1x — lower latency / better A/V sync, softer text",
        get: () => cdpPerf(),
        set: (on) => setBrowserPerf(on),
      },
    ],
    panels: [
      {
        id: "sessions",
        title: "tmux",
        icon: "▦",
        iconUrl: "/icons/BatExec_32x32_4.png",
        iconLabel: "tmux",
        html: "",
        component: TmuxPanelV2,
        onShow: () => { refreshSessions(); },
      },
      {
        id: "worktrees",
        title: "Worktrees",
        icon: "⊞",
        iconUrl: "/icons/Explorer100_32x32_4.png",
        iconLabel: "Worktrees",
        html: "",
        component: WorktreesPanelV2,
        onShow: () => scanWorktreesIfNeeded(),
      },
      {
        id: "activity",
        title: "Activity",
        icon: "◉",
        iconUrl: "/icons/Sysmon1000_32x32_4.png",
        iconLabel: "Activity",
        html: "",
        component: ActivityPanelV2,
      },
      {
        id: "favorites",
        title: "Favorites",
        icon: "★",
        iconLabel: "Favorites",
        html: "",
        component: FavoritesPanelV2,
        onShow: () => refreshFavorites(),
      },
      {
        id: "config",
        title: "Config",
        icon: "⚙",
        iconUrl: "/icons/Controls3000_32x32_4.png",
        iconLabel: "Config",
        html: `<div class="act-bar">
          <span class="spy-title">config</span>
          <span id="config-meta" class="wt-count"></span>
          <span class="spy-spacer"></span>
          <button id="config-reload" type="button">Reload</button>
          <button id="config-open" type="button">Open file</button>
        </div>
        <div id="config-body" class="cfg-body"></div>`,
        onShow: () => { if (!store.get().config) refreshConfig(); },
      },
      {
        id: "status",
        title: "Status",
        icon: "●", // glyph (not raster) so CSS can tint it by aggregate health
        iconLabel: "Status",
        html: "",
        component: StatusPanelV2,
      },
    ],
  });
  registerBuiltinStatus();
}
