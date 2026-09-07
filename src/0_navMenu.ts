import { Signal } from "@hafley66/signals";
import type { Signal as SignalOf } from "@hafley66/signals";
import { fuzzyFilter } from "./fuzzy";

/// One row. `children` opens a submenu of groups; a group's items never leave
/// their group when reordered.
export type NavItem = {
  id: string;
  label: string;
  subtext?: string;
  group?: string;
  run?: () => void;
  disabled?: boolean;
  children?: NavChildren;
  /// Where this item's submenu keeps its order and favourites.
  persist?: NavMenuPersistence;
};

/// Groups resolved when the submenu opens, so a caller may fetch them.
export type NavChildren = NavGroup[] | (() => NavGroup[] | Promise<NavGroup[]>);

export type NavGroup = { id: string; label: string; items: NavItem[] };

export type NavSeparator = { sep: true };
export type NavEntry = NavItem | NavSeparator;

/// The user's order: group ids, then item ids per group. Ids the caller no
/// longer offers are dropped on read; ids it added append.
export type NavMenuOrder = { groups: string[]; items: Record<string, string[]> };
export type NavMenuFavorites = string[];

export const empty_nav_order: NavMenuOrder = { groups: [], items: {} };

/// Both persisted facts, injected: a host with its own storage passes its own
/// signals and this module never names a storage key.
export type NavMenuPersistence = {
  order: SignalOf<NavMenuOrder>;
  favorites: SignalOf<NavMenuFavorites>;
};

export function memoryPersistence(): NavMenuPersistence {
  return { order: Signal<NavMenuOrder>(empty_nav_order), favorites: Signal<NavMenuFavorites>([]) };
}

/// A pinned row's id, so it never collides with its home row's id.
export const fav_prefix = "fav:";
export const favorites_group_id = "__favorites";
export const favorites_group_label = "Favorites";

/// A submenu longer than this opens with a search row.
export const nav_search_after = 6;
/// Press-and-hold before a move arms, so a plain click still picks the row.
export const nav_hold_ms = 350;

/// Ids the user ordered, then ids they have never seen, in offer order.
export function mergeIds(order: string[] | undefined, offered: string[]): string[] {
  const known = new Set(offered);
  const kept = (order ?? []).filter((id) => known.has(id));
  const seen = new Set(kept);
  return [...kept, ...offered.filter((id) => !seen.has(id))];
}

/// `dragId` takes the slot `overId` holds. Inserting *before* the drop target
/// after removing the drag would make a one-row downward drag a no-op.
export function moveWithin(list: string[], dragId: string, overId: string): string[] {
  const from = list.indexOf(dragId);
  const to = list.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return list;
  const next = list.slice();
  next.splice(from, 1);
  next.splice(to, 0, dragId);
  return next;
}

export function isSeparator(entry: NavEntry): entry is NavSeparator {
  return "sep" in entry;
}

export function navGroupOf(groups: NavGroup[], itemId: string): string | null {
  for (const group of groups) if (group.items.some((item) => item.id === itemId)) return group.id;
  return null;
}

/// Groups and their items in the user's order, appending anything new.
export function orderedGroups(groups: NavGroup[], order: NavMenuOrder): NavGroup[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  return mergeIds(order.groups, groups.map((group) => group.id)).flatMap((id) => {
    const group = byId.get(id);
    if (!group) return [];
    const items = new Map(group.items.map((item) => [item.id, item]));
    const ids = mergeIds(order.items[id], group.items.map((item) => item.id));
    return [{ ...group, items: ids.flatMap((itemId) => {
      const item = items.get(itemId);
      return item ? [item] : [];
    }) }];
  });
}

/// An item moves only among its own group's items; a drop on a row of another
/// group leaves the order untouched.
export function moveNavItem(
  groups: NavGroup[],
  order: NavMenuOrder,
  dragId: string,
  overId: string,
): NavMenuOrder {
  const groupId = navGroupOf(groups, dragId);
  if (!groupId || groupId !== navGroupOf(groups, overId)) return order;
  const group = groups.find((candidate) => candidate.id === groupId);
  if (!group) return order;
  const current = mergeIds(order.items[groupId], group.items.map((item) => item.id));
  return { ...order, items: { ...order.items, [groupId]: moveWithin(current, dragId, overId) } };
}

export function moveNavGroup(
  groups: NavGroup[],
  order: NavMenuOrder,
  dragId: string,
  overId: string,
): NavMenuOrder {
  const current = mergeIds(order.groups, groups.map((group) => group.id));
  return { ...order, groups: moveWithin(current, dragId, overId) };
}

export function favoriteHomeId(id: string): string {
  return id.startsWith(fav_prefix) ? id.slice(fav_prefix.length) : id;
}

export function toggleFavorite(favorites: NavMenuFavorites, id: string): NavMenuFavorites {
  const home = favoriteHomeId(id);
  return favorites.includes(home) ? favorites.filter((entry) => entry !== home) : [...favorites, home];
}

/// The starred items pinned as one group at the top, titled by their home
/// group, still listed in their home group. Ids that no longer exist drop out.
export function withFavorites(groups: NavGroup[], favorites: NavMenuFavorites): NavGroup[] {
  const byId = new Map<string, { group: NavGroup; item: NavItem }>();
  for (const group of groups) for (const item of group.items) byId.set(item.id, { group, item });
  const items = favorites.flatMap((id) => {
    const hit = byId.get(id);
    return hit ? [{ ...hit.item, id: `${fav_prefix}${id}`, label: `${hit.group.label}: ${hit.item.label}` }] : [];
  });
  if (!items.length) return groups;
  return [{ id: favorites_group_id, label: favorites_group_label, items }, ...groups];
}

/// Rows matching the query across every group, keyed "<group>: <item>"; a
/// group with no match is not drawn.
export function filterGroups(groups: NavGroup[], query: string): NavGroup[] {
  if (!query.trim()) return groups;
  const rows = groups.flatMap((group) => group.items.map((item) => ({ group, item })));
  const hits = new Set(
    fuzzyFilter(query, rows, (row) => `${row.group.label}: ${row.item.label}`)
      .map((row) => `${row.group.id}/${row.item.id}`),
  );
  return groups.flatMap((group) => {
    const items = group.items.filter((item) => hits.has(`${group.id}/${item.id}`));
    return items.length ? [{ ...group, items }] : [];
  });
}

export function navItemCount(groups: NavGroup[]): number {
  return groups.reduce((total, group) => total + group.items.length, 0);
}

/// One open level: what it was opened from and what it offers. `groups` is
/// null until a submenu's children resolve.
export type NavLevelState = {
  ownerId: string | null;
  entries: NavEntry[];
  groups: NavGroup[] | null;
  persistence: NavMenuPersistence | null;
};

export type NavRowView =
  | { kind: "sep" }
  | { kind: "search"; query: string }
  | { kind: "group"; id: string; label: string; dragging: boolean }
  | {
      kind: "item";
      id: string;
      label: string;
      subtext: string | null;
      hasChildren: boolean;
      disabled: boolean;
      favorite: boolean | null;
      focused: boolean;
      dragging: boolean;
    };

export type NavLevelView = { depth: number; ownerId: string | null; rows: NavRowView[] };
export type NavMenuView = { open: boolean; x: number; y: number; levels: NavLevelView[] };

export const closed_nav_view: NavMenuView = { open: false, x: 0, y: 0, levels: [] };

export type NavDrag = { depth: number; id: string; kind: "item" | "group"; moved: boolean };

/// Every visible fact of one level, as rows. Pure: the same inputs draw the
/// same menu, whatever the DOM is doing.
export function levelRows(
  level: NavLevelState,
  order: NavMenuOrder,
  /// `null` where the caller injected no persistence: no star is offered.
  favorites: NavMenuFavorites | null,
  query: string,
  focusedId: string | null,
  dragId: string | null,
  searchAfter = nav_search_after,
): NavRowView[] {
  const itemRow = (item: NavItem, favorite: boolean | null): NavRowView => ({
    kind: "item",
    id: item.id,
    label: item.label,
    subtext: item.subtext ?? null,
    hasChildren: !!item.children,
    disabled: !!item.disabled,
    favorite,
    focused: item.id === focusedId,
    dragging: item.id === dragId,
  });
  if (!level.groups) {
    return level.entries.map((entry) =>
      isSeparator(entry) ? { kind: "sep" } as NavRowView : itemRow(entry, null));
  }
  const pinned = withFavorites(orderedGroups(level.groups, order), favorites ?? []);
  const rows: NavRowView[] = navItemCount(pinned) > searchAfter ? [{ kind: "search", query }] : [];
  for (const group of filterGroups(pinned, query)) {
    rows.push({ kind: "group", id: group.id, label: group.label, dragging: group.id === dragId });
    for (const item of group.items) {
      rows.push(itemRow(item, favorites ? favorites.includes(favoriteHomeId(item.id)) : null));
    }
  }
  return rows;
}

export type NavMenuOptions = {
  persistence?: NavMenuPersistence;
  holdMs?: number;
  searchAfter?: number;
};

/// The menu as state: signals in, one derived view out, no DOM anywhere.
export type NavMenuModel = {
  view: SignalOf<NavMenuView>;
  /// Read per open: a caller may pass its own hold on the call that opens.
  holdMs: () => number;
  open: (x: number, y: number, entries: NavEntry[], options?: NavMenuOptions) => void;
  close: () => void;
  closeTo: (depth: number) => void;
  openSubmenu: (depth: number, itemId: string) => void;
  setQuery: (depth: number, query: string) => void;
  clearQuery: (depth: number) => boolean;
  focus: (id: string | null) => void;
  moveFocus: (delta: number) => void;
  activate: () => void;
  run: (depth: number, itemId: string) => void;
  toggleFavorite: (depth: number, itemId: string) => void;
  /// The press starts the hold; the model owns the timer so the renderer
  /// keeps no state of its own.
  pressed: (depth: number, id: string, kind: "item" | "group") => void;
  release: () => void;
  armDrag: (depth: number, id: string, kind: "item" | "group") => void;
  dragOver: (overId: string) => void;
  endDrag: () => void;
  consumeDragClick: (id: string) => boolean;
  itemAt: (depth: number, itemId: string) => NavItem | undefined;
};

export function navMenuModel(defaults: NavMenuOptions = {}): NavMenuModel {
  const at = Signal<{ x: number; y: number } | null>(null);
  const stack = Signal<NavLevelState[]>([]);
  const queries = Signal<Record<number, string>>({});
  const focused = Signal<string | null>(null);
  const drag = Signal<NavDrag | null>(null);
  const dragClick = Signal<string | null>(null);
  let options: NavMenuOptions = defaults;
  let hold: ReturnType<typeof setTimeout> | null = null;

  const persistenceAt = (depth: number): NavMenuPersistence | null =>
    stack.$()[depth]?.persistence ?? options.persistence ?? null;

  const view = Signal<NavMenuView>(() => {
    const point = at.$();
    const open = stack.$();
    const query = queries.$();
    const focus = focused.$();
    const dragging = drag.$();
    if (!point || !open.length) return closed_nav_view;
    return {
      open: true,
      x: point.x,
      y: point.y,
      levels: open.map((level, depth) => ({
        depth,
        ownerId: level.ownerId,
        rows: levelRows(
          level,
          level.persistence?.order.$() ?? empty_nav_order,
          level.persistence?.favorites.$() ?? null,
          query[depth] ?? "",
          focus,
          dragging?.id ?? null,
          options.searchAfter ?? nav_search_after,
        ),
      })),
    };
  });

  const itemAt = (depth: number, itemId: string): NavItem | undefined => {
    const level = stack.$()[depth];
    if (!level) return undefined;
    if (level.groups) {
      for (const group of withFavorites(level.groups, level.persistence?.favorites.$() ?? [])) {
        const hit = group.items.find((item) => item.id === itemId);
        if (hit) return hit;
      }
      return undefined;
    }
    return level.entries.find((entry): entry is NavItem => !isSeparator(entry) && entry.id === itemId);
  };

  const close = () => {
    at.$(null);
    stack.$([]);
    queries.$({});
    focused.$(null);
    drag.$(null);
  };

  const closeTo = (depth: number) => {
    if (stack.$().length <= depth + 1) return;
    stack.$(stack.$().slice(0, depth + 1));
  };

  const openSubmenu = (depth: number, itemId: string) => {
    const item = itemAt(depth, itemId);
    if (!item?.children) return;
    if (stack.$()[depth + 1]?.ownerId === itemId) return;
    closeTo(depth);
    stack.$([...stack.$(), {
      ownerId: itemId,
      entries: [{ id: "__loading", label: "…", disabled: true }],
      groups: null,
      persistence: item.persist ?? options.persistence ?? null,
    }]);
    const opened = stack.$().length - 1;
    const children = item.children;
    const resolved = typeof children === "function"
      ? Promise.resolve().then(children)
      : Promise.resolve(children);
    void resolved.catch(() => [] as NavGroup[]).then((groups) => {
      const current = stack.$();
      if (current[opened]?.ownerId !== itemId) return;
      stack.$(current.map((level, at) => at === opened ? { ...level, groups } : level));
    });
  };

  const run = (depth: number, itemId: string) => {
    const item = itemAt(depth, itemId);
    if (!item || item.disabled) return;
    if (item.run) {
      close();
      item.run();
      return;
    }
    if (item.children) openSubmenu(depth, itemId);
  };

  const focusableRows = (): Extract<NavRowView, { kind: "item" }>[] => {
    const levels = view.$().levels;
    const rows = levels[levels.length - 1]?.rows ?? [];
    return rows.filter((row): row is Extract<NavRowView, { kind: "item" }> =>
      row.kind === "item" && !row.disabled);
  };

  return {
    view,
    holdMs: () => options.holdMs ?? nav_hold_ms,
    open(x, y, entries, opts = {}) {
      close();
      if (!entries.length) return;
      options = { ...defaults, ...opts };
      at.$({ x, y });
      stack.$([{ ownerId: null, entries, groups: null, persistence: options.persistence ?? null }]);
    },
    close,
    closeTo,
    openSubmenu,
    setQuery(depth, query) {
      if ((queries.$()[depth] ?? "") === query) return;
      queries.$({ ...queries.$(), [depth]: query });
      focused.$(null);
    },
    clearQuery(depth) {
      if (!queries.$()[depth]) return false;
      queries.$({ ...queries.$(), [depth]: "" });
      return true;
    },
    focus(id) {
      if (focused.$() === id) return;
      focused.$(id);
    },
    moveFocus(delta) {
      const items = focusableRows();
      if (!items.length) return;
      const current = items.findIndex((row) => row.focused);
      const next = current < 0
        ? (delta > 0 ? 0 : items.length - 1)
        : (current + delta + items.length) % items.length;
      focused.$(items[next].id);
    },
    activate() {
      const depth = stack.$().length - 1;
      const id = focused.$();
      if (depth >= 0 && id) run(depth, id);
    },
    run,
    toggleFavorite(depth, itemId) {
      const favorites = persistenceAt(depth)?.favorites;
      if (!favorites) return;
      favorites.$(toggleFavorite(favorites.$(), itemId));
    },
    pressed(depth, id, kind) {
      if (hold) clearTimeout(hold);
      hold = setTimeout(() => drag.$({ depth, id, kind, moved: false }), options.holdMs ?? nav_hold_ms);
    },
    release() {
      if (hold) clearTimeout(hold);
      hold = null;
      this.endDrag();
    },
    armDrag(depth, id, kind) {
      drag.$({ depth, id, kind, moved: false });
    },
    dragOver(overId) {
      const current = drag.$();
      if (!current || overId === current.id) return;
      const level = stack.$()[current.depth];
      const persistence = persistenceAt(current.depth);
      if (!level?.groups || !persistence) return;
      if (current.id.startsWith(fav_prefix)) {
        if (!overId.startsWith(fav_prefix)) return;
        const moved = moveWithin(
          persistence.favorites.$(),
          favoriteHomeId(current.id),
          favoriteHomeId(overId),
        );
        if (moved === persistence.favorites.$()) return;
        persistence.favorites.$(moved);
        drag.$({ ...current, moved: true });
        return;
      }
      const pinned = withFavorites(level.groups, persistence.favorites.$());
      const next = current.kind === "group"
        ? moveNavGroup(level.groups, persistence.order.$(), current.id, overId)
        : moveNavItem(pinned, persistence.order.$(), current.id, overId);
      if (next === persistence.order.$()) return;
      persistence.order.$(next);
      drag.$({ ...current, moved: true });
    },
    endDrag() {
      const current = drag.$();
      dragClick.$(current?.moved ? current.id : null);
      if (current) drag.$(null);
    },
    consumeDragClick(id) {
      if (dragClick.$() !== id) return false;
      dragClick.$(null);
      return true;
    },
    itemAt,
  };
}

/// Breathing room kept between a level and every viewport edge.
export const nav_viewport_margin = 8;

/// `maxHeight` is null while the level fits; a taller one is capped and scrolls
/// its own rows.
export type Placement = { left: number; top: number; maxHeight: number | null };

/// Slides up only as far as it must, so a submenu stays beside its owner row;
/// overflowing right it lands its right edge on `flipTo`, the owner's right edge.
export function placeMenu(
  size: { width: number; height: number },
  point: { x: number; y: number },
  viewport: { width: number; height: number },
  flipTo?: number,
  margin = nav_viewport_margin,
): Placement {
  const room = viewport.height - 2 * margin;
  const maxHeight = size.height > room ? room : null;
  const height = maxHeight ?? size.height;
  return {
    left: point.x + size.width > viewport.width
      ? Math.max(0, (flipTo ?? point.x) - size.width)
      : point.x,
    top: Math.max(margin, Math.min(point.y, viewport.height - margin - height)),
    maxHeight,
  };
}

/// The module's own structural rules, injected once. Colours and the frame
/// stay with the host's skin; nothing here names a palette.
export const NAV_MENU_CSS = `
.ctx-menu { position: fixed; overflow: auto; }
.ctx-menu[popover] { margin: 0; inset: auto; overflow: auto; }
.ctx-item { display: flex; align-items: baseline; gap: 8px; }
.ctx-label { flex: 1; }
.ctx-subtext { opacity: .6; font-size: 12px; }
.ctx-arrow { opacity: .7; }
.ctx-group {
  padding: 4px 8px 2px;
  opacity: .55;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .08em;
  text-transform: uppercase;
  cursor: default;
}
.ctx-dragging { opacity: .6; }
/* Sticky: a capped level scrolls its rows and the query stays typeable. */
.ctx-search { position: sticky; top: 0; z-index: 1; background: var(--panel-bg); padding: 3px 4px 5px; }
.ctx-search-input { width: 100%; padding: 8px 10px; color: inherit; font: inherit; box-sizing: border-box; }
.ctx-star {
  padding: 0 10px;
  min-width: 36px;
  min-height: 34px;
  font-size: 18px;
  margin: -8px -14px -8px auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  opacity: 0;
}
.ctx-item:hover .ctx-star,
.ctx-active .ctx-star,
.ctx-star[data-favorite="true"] { opacity: .85; }
`;

let cssInjected = false;

export function injectNavMenuCss(doc: Document = document) {
  if (cssInjected || doc.querySelector("style[data-nav-menu]")) return;
  const style = doc.createElement("style");
  style.dataset.navMenu = "";
  style.textContent = NAV_MENU_CSS;
  doc.head.appendChild(style);
  cssInjected = true;
}
