import { createElement, useEffect, useRef, type ComponentType } from "react";
import type { IDockviewPanelProps } from "dockview";

export interface PanelDef {
  id: string;
  title: string;
  icon: string;
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
  for (const p of panelMap.values()) {
    const btn = document.createElement("button");
    btn.className = "actbar-item";
    btn.id = `${p.id}-toggle`;
    btn.dataset.panel = p.id;
    btn.title = p.title;
    btn.innerHTML = `<span class="ai">${p.icon}</span><span class="al">${p.iconLabel}</span>`;
    container.appendChild(btn);
  }
  const spacer = actbar.querySelector(".actbar-spacer");
  if (spacer) actbar.insertBefore(container, spacer);
  else actbar.appendChild(container);
}