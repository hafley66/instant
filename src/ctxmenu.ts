// Windows-XP-style right-click menu. The webview's native context menu is
// suppressed; the rows are rendered by 0_navMenu.ts (submenus, keyboard,
// hold-to-reorder) under the same .ctx-menu class names the skins style.
import {
  closeNavMenu,
  openNavMenu,
  type NavChildren,
  type NavEntry,
  type NavMenuOptions,
  type NavMenuOrder,
} from "./0_navMenu";
import type { Signal as SignalOf } from "@hafley66/signals";

export type CtxItem =
  | {
      label: string;
      action: () => void;
      disabled?: boolean;
      subtext?: string;
      children?: NavChildren;
      order?: SignalOf<NavMenuOrder>;
    }
  | { sep: true };

let seq = 0;

/// `CtxItem` carries no ids and the menu keys rows by one, so a stable-per-open
/// id is minted here.
export function toNavEntries(items: CtxItem[], open: number): NavEntry[] {
  return items.map((item, index) => "sep" in item ? item : {
    id: `ctx:${open}:${index}`,
    label: item.label,
    subtext: item.subtext,
    disabled: item.disabled,
    children: item.children,
    order: item.order,
    run: item.disabled ? undefined : item.action,
  });
}

/// Render the menu at (x,y), flipping near the right/bottom edge so it stays
/// on-screen. Dismisses on outside click, Esc, scroll, blur, or resize.
export function showContextMenu(x: number, y: number, items: CtxItem[], options: NavMenuOptions = {}): void {
  openNavMenu(x, y, toNavEntries(items, ++seq), options);
}

// Suppress the native menu and render ours; `itemsFor` maps the event target to
// the contextual item list. Esc dismisses inside 0_navMenu's key handler.
export function wireContextMenu(itemsFor: (target: HTMLElement) => CtxItem[]): void {
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, itemsFor(e.target as HTMLElement));
  });
}

export { closeNavMenu as dismissContextMenu };
