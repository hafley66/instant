// The builtin plugin: registers the core rail panels (tmux, Worktrees, Activity,
// Favorites, Config, Status) and the config-panel option toggles. The panel
// bodies are React components (tablepanels.tsx / status.tsx); onShow wires each
// to its lazy data refresh.
import { registerPlugin } from "./plugin";
import { TmuxPanelV2, WorktreesPanelV2, ActivityPanelV2 } from "./tablepanels";
import { StatusPanelV2, registerBuiltinStatus } from "./status";
import { store } from "./state";
import { cdpPerf } from "./cdp";
import { setBrowserPerf } from "./browser";
import { refreshSessions, scanWorktreesIfNeeded } from "./worktrees";
import { ConfigPanelV2 } from "./activity";
import { registerFavoritesPlugin } from "./favorites";

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
    ],
  });
  registerFavoritesPlugin(); // between activity/config: keeps rail order
  registerPlugin({
    id: "builtin",
    panels: [
      {
        id: "config",
        title: "Config",
        icon: "⚙",
        iconUrl: "/icons/Controls3000_32x32_4.png",
        iconLabel: "Config",
        html: "",
        component: ConfigPanelV2,
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
