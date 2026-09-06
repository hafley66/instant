# navmenu

A context menu with submenus, search, favourites and hold-to-reorder, in two
files: `src/0_navMenu.ts` is the model and the pure half (`@hafley66/signals`
and `./fuzzy`, nothing else); `src/0_NavMenuView.tsx` is the React renderer
(`react`, `react-dom/client`, `@hafley66/signals/react`). Both lift out of
instant as one package.

## Shape

| export | what it is |
|---|---|
| `navMenuModel(options)` | every visible fact as signals, combined into one derived `view: SignalOf<NavMenuView>`. No DOM. |
| `NavMenu` (`0_NavMenuView.tsx`) | `SignalReact(({ model }) => ...)`: reads `model.view.$()` with no hook and no store adapter. `NavLevel` is `SignalReact`, `NavRow` and `NavSearch` are `memo(SignalReact(...))` on primitive props, so one starred row repaints one row. |
| `renderNavMenu(model, host?)` | mounts `NavMenu` with `createRoot`. Same signature and `{ roots, dispose }` return as the painter it replaced. |
| `createNavMenu(options, host?)` | the two above wired together: `{ model, open, close, levels, dispose }`. |
| `openNavMenu` / `closeNavMenu` / `navMenuLevels` | a shared instance, what `src/ctxmenu.ts` calls. |
| `placeMenu(size, point, viewport, flipTo?)` | pure placement: at the point, flipped off the right or bottom edge, submenus flipped to the left of their owner row. |
| `levelRows`, `orderedGroups`, `withFavorites`, `filterGroups`, `moveNavItem`, `moveNavGroup`, `moveWithin`, `mergeIds`, `toggleFavorite` | the pure half, all unit-tested without a DOM. |
| `NAV_MENU_CSS`, `injectNavMenuCss()` | the structural rules, injected once on first paint. Colours stay with the host's skin. |

## Types

```ts
type NavItem = { id, label, subtext?, group?, run?, disabled?, children?, persist? };
type NavGroup = { id, label, items: NavItem[] };
type NavChildren = NavGroup[] | (() => NavGroup[] | Promise<NavGroup[]>);
type NavMenuOrder = { groups: string[]; items: Record<string, string[]> };
type NavMenuFavorites = string[];
type NavMenuPersistence = { order: SignalOf<NavMenuOrder>; favorites: SignalOf<NavMenuFavorites> };
type NavMenuOptions = { persistence?, holdMs?, searchAfter? };
```

## Behaviour

| rule | value |
|---|---|
| submenu opens | hover, ArrowRight, or clicking an item with `children` and no `run` |
| search row | drawn when a level offers more than `searchAfter` (default 6) items; `fuzzyFilter` over `"<group>: <item>"`; Escape clears the query before it closes |
| favourites | the star glyph or `f` on the focused row; pinned as a `Favorites` group titled `"<group>: <item>"`, ids prefixed `fav:`, still listed in the home group |
| reorder | press and hold `holdMs` (default 350), then move. An item never leaves its group; a pinned row reorders the favourites list itself. The model owns the hold timer (`pressed` / `release`), so the renderer keeps no state |
| the star | acts on pointerdown, not click: any emission redraws the row, and a browser fires no click when the pressed node is gone |
| keyboard | ArrowUp/Down walk, ArrowRight/Left open and close a submenu, Enter runs, Escape clears then closes, `f` stars |

## Rendering

`renderNavMenu` is the only place React is mounted; every event handler calls a
model action and nothing else. A host that renders its own tree imports
`navMenuModel` and `NavMenu` directly, or reads `model.view` and draws it any
way it likes: `NavMenuView` is a plain data shape.

## Persistence

Injected: the module never names a storage key. instant's adapter is
`src/0_navMenuStore.ts` (`navMenuStore(key)` -> two `storageSignal`s), and
`memoryPersistence()` is the no-storage default.

| key | written by |
|---|---|
| `fork.presets.order` | the preset submenu's group and item order |
| `fork.presets.favorites` | the starred presets, in pin order |
| `fork.lastPreset` | the preset the Fork row last ran |
| `forkRender.livePane` | the fork render shape (overlay or child pane) |
