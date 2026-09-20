// Windows-XP-style right-click menu. The webview's native context menu is
// suppressed; the rows are rendered by 0_navMenu.ts (submenus, keyboard,
// hold-to-reorder) under the same .ctx-menu class names the skins style.
import { closeNavMenu, openNavMenu } from "./0_NavMenuView";
import type {
  NavChildren,
  NavEntry,
  NavMenuOptions,
  NavMenuPersistence,
} from "./0_navMenu";

export type CtxItem =
  | {
      label: string;
      action: () => void;
      disabled?: boolean;
      doubleRightClick?: boolean;
      subtext?: string;
      children?: NavChildren;
      persist?: NavMenuPersistence;
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
    persist: item.persist,
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
export function wireContextMenu(itemsFor: (target: HTMLElement) => CtxItem[]): () => void {
  type Press = { x: number; y: number; at: number };
  let nativePending: Press | null = null;
  let shortcut: (Press & { owner: Element; action: () => void }) | null = null;
  const nearby = (press: Press, event: MouseEvent) =>
    performance.now() - press.at <= 500
    && Math.hypot(press.x - event.clientX, press.y - event.clientY) <= 8;
  const pressAt = (event: MouseEvent): Press => ({ x: event.clientX, y: event.clientY, at: performance.now() });
  const onDown = (event: MouseEvent) => {
    const previous = shortcut;
    shortcut = null;
    nativePending = null;
    if (event.button !== 2 || !previous || !nearby(previous, event)) return;
    const target = event.target as Element;
    if (!previous.owner.contains(target) && !target.closest(".ctx-menu")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    nativePending = pressAt(event);
    closeNavMenu();
    previous.action();
  };
  const onContext = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    // Terminal mousedown dispatches a synthetic menu before tmux handles the
    // press. The browser's subsequent native event belongs to that same press.
    if (event.button === 2 && nativePending && nearby(nativePending, event)) {
      nativePending = null;
      return;
    }
    const target = event.target as HTMLElement;
    const owner = target.closest(".term-host");
    if (owner && event.button === 0) nativePending = pressAt(event);
    const items = itemsFor(target);
    const item = items.find((item) => "action" in item && item.doubleRightClick && !item.disabled);
    shortcut = owner && item && "action" in item
      ? { ...pressAt(event), owner, action: item.action }
      : null;
    showContextMenu(event.clientX, event.clientY, items);
  };
  const reset = () => { shortcut = null; nativePending = null; };
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("contextmenu", onContext);
  document.addEventListener("keydown", reset, true);
  window.addEventListener("blur", reset);
  window.addEventListener("resize", reset);
  document.addEventListener("scroll", reset, true);
  return () => {
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("contextmenu", onContext);
    document.removeEventListener("keydown", reset, true);
    window.removeEventListener("blur", reset);
    window.removeEventListener("resize", reset);
    document.removeEventListener("scroll", reset, true);
  };
}

export { closeNavMenu as dismissContextMenu };
