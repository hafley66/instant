# navmenu

`src/0_navMenu.ts` is a context menu with submenus, search, favourites and
hold-to-reorder. It imports `@hafley66/signals` and `./fuzzy`, nothing else, so
it lifts out of instant as a package.

## Shape

| export | what it is |
|---|---|
| `navMenuModel(options)` | every visible fact as signals, combined into one derived `view: SignalOf<NavMenuView>`. No DOM. |
| `renderNavMenu(model, host?)` | the DOM as a function of `model.view`; rebuilds rows on every emission and reads only ids back off elements. Returns `{ roots, dispose }`. |
| `createNavMenu(options, host?)` | the two above wired together: `{ model, open, close, levels, dispose }`. |
| `openNavMenu` / `closeNavMenu` / `navMenuLevels` | a shared instance, what `src/ctxmenu.ts` calls. |
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
| reorder | press and hold `holdMs` (default 350), then move. An item never leaves its group; a pinned row reorders the favourites list itself |
| keyboard | ArrowUp/Down walk, ArrowRight/Left open and close a submenu, Enter runs, Escape clears then closes, `f` stars |

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
