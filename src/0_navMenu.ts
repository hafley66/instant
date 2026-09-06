import type { Signal as SignalOf } from "@hafley66/signals";
import { setting } from "./0_persistedSetting";
import { mergeOrder } from "./railOrder";
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
  /// The persisted order its submenu reorders into; without one the submenu
  /// still opens, it just does not move.
  order?: SignalOf<NavMenuOrder>;
  /// The persisted favourite item ids its submenu pins to the top.
  favorites?: SignalOf<NavMenuFavorites>;
};

/// Groups resolved when the submenu opens, so a caller may fetch them.
export type NavChildren = NavGroup[] | (() => NavGroup[] | Promise<NavGroup[]>);

export type NavGroup = { id: string; label: string; items: NavItem[] };

export type NavSeparator = { sep: true };
export type NavEntry = NavItem | NavSeparator;

/// The user's order: group ids, then item ids per group. Ids the caller no
/// longer offers are dropped on read; ids it added append.
export type NavMenuOrder = { groups: string[]; items: Record<string, string[]> };

export const empty_nav_order: NavMenuOrder = { groups: [], items: {} };

/// Item ids the user starred, in the order they are pinned.
export type NavMenuFavorites = string[];

/// A pinned row's id, so it never collides with its home row's id.
export const fav_prefix = "fav:";
export const favorites_group_id = "__favorites";
export const favorites_group_label = "Favorites";

/// A submenu longer than this gets a search row.
export const nav_search_after = 6;

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

/// The persisted order under a key the caller names.
export function navOrder(key: string): SignalOf<NavMenuOrder> {
  return setting<NavMenuOrder>(key, empty_nav_order);
}

/// The persisted favourite ids under a key the caller names.
export function navFavorites(key: string): SignalOf<NavMenuFavorites> {
  return setting<NavMenuFavorites>(key, []);
}

/// `dragId` takes the slot `overId` holds. `railOrder.moveBefore` inserts
/// before `overId` after removing the drag, which makes a one-row downward
/// drag a no-op; a menu drag has to move on the first row crossed.
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
  return mergeOrder(order.groups, groups.map((group) => group.id)).flatMap((id) => {
    const group = byId.get(id);
    if (!group) return [];
    const items = new Map(group.items.map((item) => [item.id, item]));
    const ids = mergeOrder(order.items[id], group.items.map((item) => item.id));
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
  const current = mergeOrder(order.items[groupId], group.items.map((item) => item.id));
  return { ...order, items: { ...order.items, [groupId]: moveWithin(current, dragId, overId) } };
}

export function moveNavGroup(
  groups: NavGroup[],
  order: NavMenuOrder,
  dragId: string,
  overId: string,
): NavMenuOrder {
  const current = mergeOrder(order.groups, groups.map((group) => group.id));
  return { ...order, groups: moveWithin(current, dragId, overId) };
}

/// Press-and-hold before a move arms, so a plain click still picks the row.
export const nav_hold_ms = 350;

export type NavMenuOptions = {
  order?: SignalOf<NavMenuOrder>;
  favorites?: SignalOf<NavMenuFavorites>;
  holdMs?: number;
};

type Level = {
  root: HTMLElement;
  entries: NavEntry[];
  groups: NavGroup[] | null;
  owner: HTMLElement | null;
  order: SignalOf<NavMenuOrder> | null;
  favorites: SignalOf<NavMenuFavorites> | null;
  query: string;
  active: number;
};

let levels: Level[] = [];
let options: NavMenuOptions = {};

function place(root: HTMLElement, x: number, y: number, flipTo?: number) {
  root.style.visibility = "hidden";
  root.style.left = "0px";
  root.style.top = "0px";
  const { width, height } = root.getBoundingClientRect();
  const overflowsRight = x + width > window.innerWidth;
  const left = overflowsRight ? Math.max(0, (flipTo ?? x) - width) : x;
  const top = y + height > window.innerHeight ? Math.max(0, y - height) : y;
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  root.style.visibility = "visible";
}

function showLevel(root: HTMLElement) {
  document.body.appendChild(root);
  try {
    (root as HTMLElement & { showPopover?: () => void }).showPopover?.();
  } catch {
    /* already open, or no popover support: the fixed position still holds */
  }
}

function removeLevel(level: Level) {
  try {
    (level.root as HTMLElement & { hidePopover?: () => void }).hidePopover?.();
  } catch {
    /* never shown */
  }
  level.root.remove();
}

/// Close every level deeper than `depth`.
function closeBelow(depth: number) {
  while (levels.length > depth + 1) {
    const level = levels.pop();
    if (level) removeLevel(level);
  }
}

export function closeNavMenu() {
  while (levels.length) {
    const level = levels.pop();
    if (level) removeLevel(level);
  }
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("blur", closeNavMenu);
  window.removeEventListener("resize", closeNavMenu);
  document.removeEventListener("scroll", closeNavMenu, true);
}

function onOutside(event: PointerEvent) {
  const inside = levels.some((level) => level.root.contains(event.target as Node));
  if (inside) return;
  // The target stays connected until pointerdown dispatch finishes: a listener
  // downstream compares its stacking order against a detached node otherwise.
  queueMicrotask(() => closeNavMenu());
}

function rows(level: Level): HTMLElement[] {
  return [...level.root.querySelectorAll<HTMLElement>(".ctx-item:not(.ctx-disabled)")];
}

function setActive(level: Level, index: number) {
  const all = rows(level);
  if (!all.length) return;
  const next = (index + all.length) % all.length;
  level.active = next;
  for (const [at, row] of all.entries()) row.classList.toggle("ctx-active", at === next);
  all[next].scrollIntoView?.({ block: "nearest" });
}

function activeRow(level: Level): HTMLElement | undefined {
  return rows(level)[level.active];
}

function isTyping(event: KeyboardEvent): boolean {
  return (event.target as HTMLElement | null)?.classList?.contains("ctx-search-input") === true;
}

function onKey(event: KeyboardEvent) {
  const level = levels[levels.length - 1];
  if (!level) return;
  const stop = () => { event.preventDefault(); event.stopPropagation(); };
  if (event.key === "Escape") {
    stop();
    if (level.query) {
      level.query = "";
      renderLevel(level);
      return;
    }
    closeNavMenu();
    return;
  }
  if (event.key === "f" && !isTyping(event) && level.favorites && level.groups) {
    const row = activeRow(level);
    const id = row?.dataset.navId;
    if (id) {
      stop();
      level.favorites.$(toggleFavorite(level.favorites.$(), id));
      renderLevel(level);
    }
    return;
  }
  if (event.key === "ArrowDown") { stop(); setActive(level, level.active + 1); return; }
  if (event.key === "ArrowUp") { stop(); setActive(level, level.active < 0 ? -1 : level.active - 1); return; }
  if (event.key === "ArrowRight") {
    const row = activeRow(level);
    if (row?.dataset.hasChildren === "true") { stop(); void openSubmenu(level, row); }
    return;
  }
  if (event.key === "ArrowLeft") {
    if (levels.length > 1) { stop(); closeBelow(levels.length - 2); }
    return;
  }
  if (event.key === "Enter") {
    const row = activeRow(level);
    if (row) { stop(); row.click(); }
  }
}

function starButton(item: NavItem, level: Level): HTMLElement {
  const star = document.createElement("button");
  star.type = "button";
  star.className = "ctx-star";
  const favorites = level.favorites;
  const home = favoriteHomeId(item.id);
  star.dataset.favorite = String(!!favorites?.$().includes(home));
  star.textContent = star.dataset.favorite === "true" ? "★" : "☆";
  star.addEventListener("pointerdown", (event) => event.stopPropagation());
  star.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!favorites) return;
    favorites.$(toggleFavorite(favorites.$(), home));
    renderLevel(level);
  });
  return star;
}

function itemRow(item: NavItem, level: () => Level): HTMLElement {
  const row = document.createElement("div");
  row.className = "ctx-item" + (item.disabled ? " ctx-disabled" : "");
  row.dataset.navId = item.id;
  row.setAttribute("role", "menuitem");
  const label = document.createElement("span");
  label.className = "ctx-label";
  label.textContent = item.label;
  row.appendChild(label);
  if (item.subtext) {
    const subtext = document.createElement("span");
    subtext.className = "ctx-subtext";
    subtext.textContent = item.subtext;
    row.appendChild(subtext);
  }
  if (item.children) {
    row.dataset.hasChildren = "true";
    const arrow = document.createElement("span");
    arrow.className = "ctx-arrow";
    arrow.textContent = "▸";
    row.appendChild(arrow);
    row.addEventListener("mouseenter", () => void openSubmenu(level(), row));
  } else {
    row.addEventListener("mouseenter", () => closeBelow(levels.indexOf(level())));
  }
  if (level().favorites && level().groups) row.appendChild(starButton(item, level()));
  if (!item.disabled) {
    row.addEventListener("click", () => {
      if (row.dataset.dragged === "true") { delete row.dataset.dragged; return; }
      if (item.run) { closeNavMenu(); item.run(); return; }
      if (item.children) void openSubmenu(level(), row);
    });
  }
  return row;
}

function separatorRow(): HTMLElement {
  const separator = document.createElement("div");
  separator.className = "ctx-sep";
  return separator;
}

function groupRow(group: NavGroup): HTMLElement {
  const header = document.createElement("div");
  header.className = "ctx-group";
  header.dataset.groupId = group.id;
  header.textContent = group.label;
  return header;
}

/// A level's rows, rebuilt from the current order every time it renders, so a
/// move lands the same way a reopen does.
function searchRow(level: Level): HTMLElement {
  const row = document.createElement("div");
  row.className = "ctx-search";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "ctx-search-input";
  input.placeholder = "search";
  input.value = level.query;
  input.addEventListener("pointerdown", (event) => event.stopPropagation());
  input.addEventListener("input", () => {
    level.query = input.value;
    level.active = -1;
    renderLevel(level);
    const next = level.root.querySelector<HTMLInputElement>(".ctx-search-input");
    next?.focus();
    next?.setSelectionRange(next.value.length, next.value.length);
  });
  row.appendChild(input);
  return row;
}

/// A level's rows, rebuilt from the current order, favourites and query every
/// time it renders, so a move lands the same way a reopen does.
function renderLevel(level: Level) {
  level.root.textContent = "";
  const index = () => level;
  if (level.groups) {
    const order = level.order?.$() ?? empty_nav_order;
    const pinned = withFavorites(orderedGroups(level.groups, order), level.favorites?.$() ?? []);
    if (navItemCount(pinned) > nav_search_after) level.root.appendChild(searchRow(level));
    for (const group of filterGroups(pinned, level.query)) {
      level.root.appendChild(groupRow(group));
      for (const item of group.items) level.root.appendChild(itemRow(item, index));
    }
    return;
  }
  for (const entry of level.entries) {
    level.root.appendChild(isSeparator(entry) ? separatorRow() : itemRow(entry, index));
  }
}

function newLevel(
  entries: NavEntry[],
  groups: NavGroup[] | null,
  owner: HTMLElement | null,
  order: SignalOf<NavMenuOrder> | null,
  favorites: SignalOf<NavMenuFavorites> | null,
): Level {
  const root = document.createElement("div");
  root.className = "ctx-menu";
  root.setAttribute("role", "menu");
  root.setAttribute("popover", "manual");
  const level: Level = { root, entries, groups, owner, order, favorites, query: "", active: -1 };
  renderLevel(level);
  wireHoldReorder(level);
  return level;
}

async function resolveChildren(children: NavChildren): Promise<NavGroup[]> {
  return typeof children === "function" ? await children() : children;
}

async function openSubmenu(parent: Level, row: HTMLElement) {
  const depth = levels.indexOf(parent);
  if (depth < 0) return;
  closeBelow(depth);
  const item = findItem(parent, row.dataset.navId ?? "");
  if (!item?.children) return;
  const rect = row.getBoundingClientRect();
  const level = newLevel(
    [{ id: "__loading", label: "…", disabled: true }],
    null,
    row,
    item.order ?? options.order ?? null,
    item.favorites ?? options.favorites ?? null,
  );
  levels.push(level);
  showLevel(level.root);
  place(level.root, rect.right, rect.top, rect.left);
  const groups = await resolveChildren(item.children).catch(() => [] as NavGroup[]);
  if (levels[levels.length - 1] !== level) return;
  level.groups = groups;
  renderLevel(level);
  place(level.root, rect.right, rect.top, rect.left);
}

function findItem(level: Level, id: string): NavItem | undefined {
  if (level.groups) {
    for (const group of level.groups) {
      const hit = group.items.find((item) => item.id === id);
      if (hit) return hit;
    }
    return undefined;
  }
  return level.entries.find((entry): entry is NavItem => !isSeparator(entry) && entry.id === id);
}

/// Press and hold a row or a group header, then move: items reorder inside
/// their own group, groups reorder among themselves, and the order persists.
function wireHoldReorder(level: Level) {
  level.root.addEventListener("pointerdown", (event) => {
    const order = level.order;
    if (!order || !level.groups || event.button !== 0) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-nav-id],[data-group-id]");
    if (!row) return;
    const groupDrag = row.dataset.groupId != null;
    const dragId = groupDrag ? row.dataset.groupId! : row.dataset.navId!;
    let armed = false;
    let working = order.$();
    const hold = setTimeout(() => {
      armed = true;
      row.classList.add("ctx-dragging");
      row.dataset.dragged = "true";
      try {
        row.setPointerCapture(event.pointerId);
      } catch {
        /* capture refused: the move still tracks by elementFromPoint */
      }
    }, options.holdMs ?? nav_hold_ms);

    const onMove = (moved: PointerEvent) => {
      if (!armed) return;
      // Pointer capture keeps sending moves to the pressed row, so the row
      // under the pointer is read by point; the target is the fallback.
      const under = (document.elementFromPoint?.(moved.clientX, moved.clientY)
        ?? moved.target) as HTMLElement | null;
      const target = under?.closest<HTMLElement>(groupDrag ? "[data-group-id]" : "[data-nav-id]");
      const overId = groupDrag ? target?.dataset.groupId : target?.dataset.navId;
      if (!overId || overId === dragId || !level.groups) return;
      if (dragId.startsWith(fav_prefix)) {
        const favorites = level.favorites;
        if (!favorites || !overId.startsWith(fav_prefix)) return;
        const moved = moveWithin(favorites.$(), favoriteHomeId(dragId), favoriteHomeId(overId));
        if (moved === favorites.$()) return;
        favorites.$(moved);
        renderLevel(level);
        return;
      }
      const next = groupDrag
        ? moveNavGroup(level.groups, working, dragId, overId)
        : moveNavItem(level.groups, working, dragId, overId);
      if (next === working) return;
      working = next;
      order.$(working);
      renderLevel(level);
    };
    const onUp = () => {
      clearTimeout(hold);
      level.root.removeEventListener("pointermove", onMove);
      level.root.removeEventListener("pointerup", onUp);
      level.root.removeEventListener("pointercancel", onUp);
      if (!armed) return;
      row.classList.remove("ctx-dragging");
      renderLevel(level);
    };
    level.root.addEventListener("pointermove", onMove);
    level.root.addEventListener("pointerup", onUp);
    level.root.addEventListener("pointercancel", onUp);
  });
}

/// One menu at a time, at the pointer, flipped away from the window edges.
export function openNavMenu(x: number, y: number, entries: NavEntry[], opts: NavMenuOptions = {}) {
  closeNavMenu();
  if (!entries.length) return;
  options = opts;
  const level = newLevel(entries, null, null, opts.order ?? null, opts.favorites ?? null);
  levels = [level];
  showLevel(level.root);
  place(level.root, x, y);
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", closeNavMenu);
  window.addEventListener("resize", closeNavMenu);
  document.addEventListener("scroll", closeNavMenu, true);
}

/// The open levels, for tests and for a caller that needs to know a menu is up.
export function navMenuLevels(): HTMLElement[] {
  return levels.map((level) => level.root);
}
