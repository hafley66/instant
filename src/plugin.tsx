import {
  Component,
  createElement,
  Fragment,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { IDockviewPanelProps } from "dockview";

// One row under a panel's rail button (rail.ts renders these when the panel is
// expanded there). Providers fetch their own data; an empty list means no
// expansion affordance at all.
export interface RailChild {
  id: string; // unique within the panel's children (dedup key)
  label: string;
  hint?: string; // title tooltip on the child button
  run: () => void;
}

export interface PanelDef {
  id: string;
  title: string;
  icon: string; // fallback glyph when iconUrl is absent
  iconUrl?: string; // XP-style raster icon (public/icons/*.png); wins over `icon`
  iconLabel: string;
  // Vestigial: two untouchable panel registrations (meme, rules) still pass
  // `html: ""` from before their React conversion. Kept optional (rather than
  // deleted) so those literals keep compiling; unused otherwise -- every panel
  // renders through `component` now.
  html?: string;
  component: ComponentType<IDockviewPanelProps>;
  onShow?: () => void;
  railChildren?: () => Promise<RailChild[]>; // child rows under the rail button (rail.ts refreshChildren)
}

// A declarative config toggle a plugin contributes to the Config panel's
// Options section. get/set bind it to wherever the value lives (the store, a
// settings bag, …) so the panel needs no per-option wiring — it just renders a
// checkbox and calls set() on change. Effects (re-font, show/hide chrome) belong
// in a store.subscribe so they run however the value is changed.
export interface ConfigOption {
  id: string; // unique; used as the checkbox id + render key
  label: string;
  hint?: string;
  get: () => boolean;
  set: (on: boolean) => void;
}

// Health of a background service a plugin owns (a daemon, socket, engine, …).
// `idle` is a healthy not-running (e.g. a lazily-spawned engine); `unknown` is
// pre-first-check. The Status panel ranks these worst-first for the rail dot.
export type StatusState = "up" | "down" | "degraded" | "idle" | "unknown";

// A file/dir a plugin wants reachable from the Status panel (log, db, config).
// Clicking opens it; `reveal: true` shows it in Finder instead of opening it.
export interface StatusLink {
  label: string;
  path: string;
  reveal?: boolean;
}

export interface StatusReport {
  state: StatusState;
  detail?: string; // one short line, e.g. ":7748 · 142 worktrees"
  links?: StatusLink[];
}

// A plugin's contribution to the Status panel. `check` is polled on an interval;
// it brings its own logic (fetch a port, invoke a command, stat a file) so the
// panel needs no per-service wiring. Throwing from check() reads as `down`.
export interface StatusProbe {
  id: string;
  label: string;
  check: () => Promise<StatusReport>;
}

export interface Plugin {
  id: string;
  panels: PanelDef[];
  options?: ConfigOption[]; // config toggles surfaced in the Config panel
  status?: StatusProbe[]; // service health surfaced in the Status panel
}

const panelMap = new Map<string, PanelDef>();
const optionList: ConfigOption[] = [];
const statusList: StatusProbe[] = [];

export function registerPlugin(p: Plugin) {
  for (const panel of p.panels) {
    panelMap.set(panel.id, panel);
  }
  if (p.options) optionList.push(...p.options);
  if (p.status) statusList.push(...p.status);
}

// Register a status probe on its own (for plugins with no panel/option to add).
export function registerStatus(p: StatusProbe) {
  statusList.push(p);
}

/// Every status probe declared across all registered plugins, in registration
/// order. The Status panel polls each and lists them.
export function statusProbes(): StatusProbe[] {
  return statusList;
}

/// Every config option declared across all registered plugins, in registration
/// order. The Config panel renders these as checkboxes.
export function configOptions(): ConfigOption[] {
  return optionList;
}

export function getPanel(id: string): PanelDef | undefined {
  return panelMap.get(id);
}

export function panelIds(): string[] {
  return [...panelMap.keys()];
}

export function allPanels(): PanelDef[] {
  return [...panelMap.values()];
}

interface PanelErrorBoundaryProps {
  title: string;
  children: ReactNode;
}
interface PanelErrorBoundaryState {
  error: Error | null;
  attempt: number; // bumped on retry so the remounted subtree gets a fresh key
}

// Per-panel crash containment: a panel that throws during render used to
// white-screen the whole app (a treetable sort crash did exactly that). This
// wraps every panel at dockComponents() -- the single place PanelDef entries
// become dockview's component registry -- so every panel, html-backed or
// React `component`-backed, gets a boundary for free. Must be a class:
// getDerivedStateFromError/componentDidCatch have no hook equivalent.
class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<PanelErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[panel:${this.props.title}]`, error, info.componentStack);
  }

  retry = () => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render() {
    const { error } = this.state;
    if (!error) {
      // Key on attempt: retry must remount the subtree (fresh component state),
      // not just re-render the same crashed instance.
      return createElement(Fragment, { key: this.state.attempt }, this.props.children);
    }
    // Inline styles, not new stylesheet rules: styles.css is already past the
    // 500-line cap other files are held to, so it must not grow.
    return createElement(
      "div",
      { className: "panel-error", style: { padding: 12, overflow: "auto", height: "100%", boxSizing: "border-box" } },
      createElement("div", { className: "panel-error-title", style: { fontWeight: "bold", marginBottom: 4 } }, `${this.props.title}: crashed`),
      createElement("div", { className: "panel-error-message", style: { marginBottom: 8 } }, error.message),
      createElement(
        "pre",
        {
          className: "panel-error-stack",
          style: {
            maxHeight: 240,
            overflow: "auto",
            fontFamily: "Menlo, Consolas, monospace",
            fontSize: 11,
            whiteSpace: "pre-wrap",
            padding: 8,
            border: "1px solid currentColor",
          },
        },
        error.stack ?? "",
      ),
      createElement(
        "button",
        { type: "button", className: "panel-error-retry", style: { marginTop: 8 }, onClick: this.retry },
        "Retry",
      ),
    );
  }
}

export function dockComponents(): Record<string, ComponentType<IDockviewPanelProps>> {
  const out: Record<string, ComponentType<IDockviewPanelProps>> = {};
  for (const [id, p] of panelMap) {
    const Inner = p.component;
    out[id] = function BoundedPanel(props: IDockviewPanelProps) {
      return createElement(PanelErrorBoundary, { title: p.title, children: createElement(Inner, props) });
    };
  }
  return out;
}

// `order` lets a caller (src/rail.ts) render a user-chosen subset/ordering of
// panels instead of raw registration order; omit it for the full registry in
// registration order (unchanged default behavior).
export function buildActivityRail(order?: PanelDef[]) {
  const actbar = document.getElementById("actbar");
  if (!actbar) return;
  const existing = actbar.querySelector("#actbar-panels");
  if (existing) existing.remove();
  const container = document.createElement("span");
  container.id = "actbar-panels";
  // The anchor-positioning polyfill builds its anchor registry from STYLESHEETS,
  // not inline styles, so anchor-name/position-anchor must live in a real <style>
  // (one rule per item) for the polyfill to wire each tip to its rail button.
  const anchorRules: string[] = [];
  for (const p of order ?? panelMap.values()) {
    const btn = document.createElement("button");
    btn.className = "actbar-item";
    btn.id = `${p.id}-toggle`;
    btn.dataset.panel = p.id;
    btn.setAttribute("aria-label", p.title); // a11y; visual tooltip is .rail-tip
    const icon = p.iconUrl
      ? `<img class="ai-img" src="${p.iconUrl}" alt="" />`
      : p.icon;
    btn.innerHTML = `<span class="ai">${icon}</span><span class="al">${p.iconLabel}</span>`;
    container.appendChild(btn);

    // Popover tooltip (top layer, so it escapes the rail/dock clip). Shown on
    // hover only while the rail is collapsed — big mode already shows labels.
    const tip = document.createElement("div");
    tip.className = "rail-tip";
    tip.id = `rail-tip-${p.id}`;
    tip.setAttribute("popover", "manual");
    tip.textContent = p.title;
    container.appendChild(tip);

    anchorRules.push(
      `#${p.id}-toggle{anchor-name:--rail-${p.id}}`,
      `#rail-tip-${p.id}{left:anchor(--rail-${p.id} right);top:anchor(--rail-${p.id} center)}`,
    );

    const hide = () => {
      try {
        tip.hidePopover();
      } catch {
        /* not open */
      }
    };
    btn.addEventListener("pointerenter", () => {
      if (actbar.dataset.mode !== "compact") return;
      try {
        tip.showPopover();
      } catch {
        /* already open */
      }
    });
    btn.addEventListener("pointerleave", hide);
    btn.addEventListener("click", hide);
  }
  let style = document.getElementById("rail-anchors");
  if (!style) {
    style = document.createElement("style");
    style.id = "rail-anchors";
    document.head.appendChild(style);
  }
  style.textContent = anchorRules.join("\n");
  const spacer = actbar.querySelector(".actbar-spacer");
  if (spacer) actbar.insertBefore(container, spacer);
  else actbar.appendChild(container);
}