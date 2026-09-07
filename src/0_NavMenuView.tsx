import { memo, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { SignalReact } from "@hafley66/signals/react";
import {
  injectNavMenuCss,
  navMenuModel,
  placeMenu,
  type NavEntry,
  type NavLevelView,
  type NavMenuModel,
  type NavMenuOptions,
  type NavRowView,
} from "./0_navMenu";

export type NavRowRender = (id: string) => void;

type RowProps = {
  model: NavMenuModel;
  depth: number;
  /// True when the pointer, given the mouse event, is inside a level deeper
  /// than `depth`. A leaf row must then leave that level alone.
  insideDeeper: (depth: number, event: ReactMouseEvent) => boolean;
  onRowRender?: NavRowRender;
} & Extract<NavRowView, { kind: "item" }>;

/// One row, memoised on its own props: a favourite toggle rewrites one row's
/// props and React leaves every other row's DOM alone.
const NavRow = memo(SignalReact(function NavRow(props: RowProps) {
  const { model, depth, insideDeeper, onRowRender, id, label, subtext, hasChildren, disabled, favorite } = props;
  onRowRender?.(id);
  return (
    <div
      className={"ctx-item"
        + (disabled ? " ctx-disabled" : "")
        + (props.focused ? " ctx-active" : "")
        + (props.dragging ? " ctx-dragging" : "")}
      data-nav-id={id}
      role="menuitem"
      onMouseEnter={(event) => {
        model.focus(id);
        if (insideDeeper(depth, event)) return;
        if (hasChildren) model.openSubmenu(depth, id);
        else model.closeTo(depth);
      }}
      onClick={() => {
        if (model.consumeDragClick(id) || disabled) return;
        model.run(depth, id);
      }}
    >
      <span className="ctx-label">{label}</span>
      {subtext ? <span className="ctx-subtext">{subtext}</span> : null}
      {hasChildren ? <span className="ctx-arrow">▸</span> : null}
      {favorite === null ? null : (
        <button
          type="button"
          className="ctx-star"
          data-favorite={String(favorite)}
          onPointerDown={(event) => {
            event.stopPropagation();
            event.preventDefault();
            model.toggleFavorite(depth, id);
          }}
          onClick={(event) => event.stopPropagation()}
        >
          {favorite ? "★" : "☆"}
        </button>
      )}
    </div>
  );
}));

const NavSearch = memo(SignalReact(function NavSearch(
  { model, depth, query }: { model: NavMenuModel; depth: number; query: string },
) {
  return (
    <div className="ctx-search">
      <input
        type="text"
        className="ctx-search-input"
        placeholder="search"
        value={query}
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => model.setQuery(depth, event.target.value)}
      />
    </div>
  );
}));

type LevelProps = {
  model: NavMenuModel;
  level: NavLevelView;
  x: number;
  y: number;
  bind: (depth: number, element: HTMLElement | null) => void;
  ownerRect: (depth: number, ownerId: string | null) => DOMRect | null;
  insideDeeper: (depth: number, event: ReactMouseEvent) => boolean;
  onRowRender?: NavRowRender;
};

/// One popover per level: the top layer keeps a submenu clear of xterm and of
/// dockview, and the position is measured after the rows land.
const NavLevel = SignalReact(function NavLevel(props: LevelProps) {
  const { model, level, x, y, bind, ownerRect, insideDeeper, onRowRender } = props;
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = root.current as (HTMLElement & { showPopover?: () => void }) | null;
    try {
      element?.showPopover?.();
    } catch {
      /* no popover support: the fixed position still holds */
    }
  }, []);

  /// What the level measures at. A hover only restyles a row, so it must not
  /// re-run the hide-measure-place dance: the placed level would jump under it.
  const measuredAt = `${level.ownerId ?? ""}|${level.rows.length}|`
    + level.rows.map((row) => row.kind === "search" ? row.query : "").join("");

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    element.style.visibility = "hidden";
    element.style.left = "0px";
    element.style.top = "0px";
    element.style.maxHeight = "";
    element.style.overflowY = "";
    const rect = level.depth === 0 ? null : ownerRect(level.depth, level.ownerId);
    const size = element.getBoundingClientRect();
    const { left, top, maxHeight } = placeMenu(
      size,
      { x: rect?.right ?? x, y: rect?.top ?? y },
      { width: window.innerWidth, height: window.innerHeight },
      rect?.right,
    );
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    /// Inline, so no skin rule on `.ctx-menu[popover]` outranks it and leaves
    /// the capped level clipped with no way to scroll.
    element.style.maxHeight = maxHeight === null ? "" : `${maxHeight}px`;
    element.style.overflowY = maxHeight === null ? "" : "auto";
    element.style.visibility = "visible";
  }, [measuredAt, level.depth, x, y]);

  return (
    <div
      className="ctx-menu"
      role="menu"
      popover="manual"
      ref={(element) => {
        root.current = element;
        bind(level.depth, element);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const target = (event.target as HTMLElement).closest<HTMLElement>("[data-nav-id],[data-group-id]");
        if (!target) return;
        const groupId = target.dataset.groupId;
        model.pressed(level.depth, groupId ?? target.dataset.navId!, groupId ? "group" : "item");
      }}
      onPointerMove={(event) => {
        const under = (document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target) as HTMLElement | null;
        const target = under?.closest<HTMLElement>("[data-nav-id],[data-group-id]");
        const id = target?.dataset.groupId ?? target?.dataset.navId;
        if (id) model.dragOver(id);
      }}
      onPointerUp={() => model.release()}
      onPointerCancel={() => model.release()}
    >
      {level.rows.map((row, index) => {
        if (row.kind === "sep") return <div className="ctx-sep" key={`sep:${index}`} />;
        if (row.kind === "search") {
          return <NavSearch key="search" model={model} depth={level.depth} query={row.query} />;
        }
        if (row.kind === "group") {
          return (
            <div
              className={"ctx-group" + (row.dragging ? " ctx-dragging" : "")}
              data-group-id={row.id}
              key={`group:${row.id}`}
            >
              {row.label}
            </div>
          );
        }
        return (
          <NavRow key={row.id} model={model} depth={level.depth} insideDeeper={insideDeeper} onRowRender={onRowRender} {...row} />
        );
      })}
    </div>
  );
});

export type NavMenuProps = {
  model: NavMenuModel;
  /// Filled with each level's element, in depth order, for callers that ask
  /// the menu what is open.
  registry?: HTMLElement[];
  onRowRender?: NavRowRender;
};

/// The whole menu: one component reading one derived signal. No hook, no
/// store adapter, no props threading the state down.
export const NavMenu = SignalReact(function NavMenu({ model, registry, onRowRender }: NavMenuProps) {
  const view = model.view.$();
  const elements = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => injectNavMenuCss(), []);

  useEffect(() => {
    const isTyping = (event: KeyboardEvent) =>
      (event.target as HTMLElement | null)?.classList?.contains("ctx-search-input") === true;
    const focusedRow = (depth: number) =>
      model.view.$().levels[depth]?.rows.find((row) => row.kind === "item" && row.focused);
    const onKey = (event: KeyboardEvent) => {
      const open = model.view.$();
      if (!open.open) return;
      const depth = open.levels.length - 1;
      const stop = () => { event.preventDefault(); event.stopPropagation(); };
      if (event.key === "Escape") { stop(); if (!model.clearQuery(depth)) model.close(); return; }
      if (event.key === "ArrowDown") { stop(); model.moveFocus(1); return; }
      if (event.key === "ArrowUp") { stop(); model.moveFocus(-1); return; }
      if (event.key === "ArrowRight") {
        const row = focusedRow(depth);
        if (row?.kind === "item" && row.hasChildren) { stop(); model.openSubmenu(depth, row.id); }
        return;
      }
      if (event.key === "ArrowLeft") { if (depth > 0) { stop(); model.closeTo(depth - 1); } return; }
      if (event.key === "Enter") { stop(); model.activate(); return; }
      if (event.key === "f" && !isTyping(event)) {
        const row = focusedRow(depth);
        if (row?.kind === "item" && row.favorite !== null) { stop(); model.toggleFavorite(depth, row.id); }
      }
    };
    const onOutside = (event: PointerEvent) => {
      if (elements.current.some((element) => element?.contains(event.target as Node))) return;
      queueMicrotask(() => model.close());
    };
    /// A capped level scrolls its own rows, and a scroll fires on the capture
    /// path: dismissing on that would close the menu on the first wheel tick.
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && elements.current.some((element) => element?.contains(target))) return;
      model.close();
    };
    const dismiss = () => model.close();
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [model]);

  const bind = (depth: number, element: HTMLElement | null) => {
    elements.current[depth] = element;
    if (!registry) return;
    if (element) registry[depth] = element;
    else registry.length = Math.min(registry.length, depth);
  };

  const ownerRect = (depth: number, ownerId: string | null) => {
    if (!ownerId) return null;
    const owner = elements.current[depth - 1]
      ?.querySelector<HTMLElement>(`[data-nav-id="${CSS.escape(ownerId)}"]`);
    return owner?.getBoundingClientRect() ?? null;
  };

  const insideDeeper = useCallback((depth: number, event: ReactMouseEvent) => {
    const under = document.elementFromPoint?.(event.clientX, event.clientY) as Element | null;
    if (!under) return false;
    return elements.current.slice(depth + 1).some((element) => element?.contains(under));
  }, []);

  if (!view.open) {
    elements.current = [];
    if (registry) registry.length = 0;
    return null;
  }

  return (
    <>
      {view.levels.map((level) => (
        <NavLevel
          key={level.depth}
          model={model}
          level={level}
          x={view.x}
          y={view.y}
          bind={bind}
          ownerRect={ownerRect}
          insideDeeper={insideDeeper}
          onRowRender={onRowRender}
        />
      ))}
    </>
  );
});

export type NavMenuMount = { roots: HTMLElement[]; dispose: () => void };

/// Mount the menu into `host`. The signature and the return shape are what the
/// hand-rolled painter had, so every caller is unchanged.
export function renderNavMenu(model: NavMenuModel, host: HTMLElement = document.body): NavMenuMount {
  const roots: HTMLElement[] = [];
  const container = document.createElement("div");
  container.className = "nav-menu-root";
  host.appendChild(container);
  const root = createRoot(container);
  root.render(<NavMenu model={model} registry={roots} />);
  return {
    roots,
    dispose() {
      root.unmount();
      container.remove();
      roots.length = 0;
    },
  };
}

export type NavMenuHandle = {
  model: NavMenuModel;
  open: NavMenuModel["open"];
  close: NavMenuModel["close"];
  levels: () => HTMLElement[];
  dispose: () => void;
};

/// One menu: the model, the React tree bound to it, and the two calls a caller
/// needs. A host that renders its own tree uses `navMenuModel` plus `NavMenu`.
export function createNavMenu(options: NavMenuOptions = {}, host?: HTMLElement): NavMenuHandle {
  const model = navMenuModel(options);
  const mounted = renderNavMenu(model, host);
  return {
    model,
    open: model.open,
    close: model.close,
    levels: () => mounted.roots.filter(Boolean),
    dispose: mounted.dispose,
  };
}

let shared: NavMenuHandle | null = null;

export function openNavMenu(x: number, y: number, entries: NavEntry[], options: NavMenuOptions = {}) {
  shared ??= createNavMenu();
  shared.open(x, y, entries, options);
}

export function closeNavMenu() {
  shared?.close();
}

/// The open levels, for tests and for a caller that needs to know a menu is up.
export function navMenuLevels(): HTMLElement[] {
  return shared?.levels() ?? [];
}
