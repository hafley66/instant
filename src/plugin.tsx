import { createElement, useEffect, useRef, type ComponentType } from "react";
import type { IDockviewPanelProps } from "dockview";

export interface PanelDef {
  id: string;
  title: string;
  icon: string; // fallback glyph when iconUrl is absent
  iconUrl?: string; // XP-style raster icon (public/icons/*.png); wins over `icon`
  iconLabel: string;
  html: string;
  component?: ComponentType<IDockviewPanelProps>;
  onShow?: () => void;
}

export interface Plugin {
  id: string;
  panels: PanelDef[];
}

const panelMap = new Map<string, PanelDef>();

export function registerPlugin(p: Plugin) {
  for (const panel of p.panels) {
    panelMap.set(panel.id, panel);
  }
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

function panelComponent(id: string): ComponentType<IDockviewPanelProps> {
  const def = panelMap.get(id);
  return function Panel() {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const node = document.getElementById(`panel-${id}`);
      if (node && ref.current) {
        ref.current.appendChild(node);
        def?.onShow?.();
      }
      return () => {
        const pool = document.getElementById("panel-pool");
        if (pool && node) pool.appendChild(node);
      };
    }, []);

    return createElement("div", { className: "dv-host", ref });
  };
}

export function dockComponents(): Record<string, ComponentType<IDockviewPanelProps>> {
  const out: Record<string, ComponentType<IDockviewPanelProps>> = {};
  for (const [id, p] of panelMap) {
    out[id] = p.component ?? panelComponent(id);
  }
  return out;
}

export function injectPanelHtml() {
  const pool = document.getElementById("panel-pool");
  if (!pool) return;
  for (const p of panelMap.values()) {
    if (document.getElementById(`panel-${p.id}`)) continue;
    const s = document.createElement("section");
    s.className = "panel";
    s.id = `panel-${p.id}`;
    s.dataset.panel = p.id;
    s.dataset.label = p.title;
    s.innerHTML = p.html;
    pool.appendChild(s);
  }
}

export function buildActivityRail() {
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
  for (const p of panelMap.values()) {
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