> Integration review, 2026-09-13: this is an archived worker proposal, not a compiled migration. Source aliases into the sibling hafley-rxjs checkout were authorized, so publication is not a prerequisite for a local attempt. That attempt was not implemented before the user requested draining the worktrees. Use `route` alone as row identity (the Boop selection primary key), keep `lastFocusedAt` numeric/null, and reconcile DB selection on every refresh with feedback suppression. The NUL-composite example below is superseded. No signal-grid runtime code is included in this change.

# Boop recipient grid: signal-grid migration attempt (blocked, reviewable)

Status: **not wired**. The live implementation stays on `TreeTable` (`src/1_boopSelection.tsx`)
because `@hafley66/signal-grid` cannot be installed from any registry and its `dist/` ships no
type declarations. This note holds the exact adapter and wiring so the swap is a mechanical edit
once the library is published.

Full API reference (read-only, by `chore-boop-grid-api`): [API research](0_boop-signal-grid-api.md).

## Blocker (measured 2026-09-13)

| package | npmjs.org | local verdaccio `127.0.0.1:4873` | note |
| --- | --- | --- | --- |
| `@hafley66/signals` | 200 | 200 | installable |
| `@hafley66/xdom` | 200 | 200 | installable |
| `@hafley66/path` | 200 | 200 | installable |
| `@hafley66/trace` | 404 | 404 | `workspace:*` in signal-grid; never published |
| `@hafley66/signal-grid` | 404 | 404 | dist imports `@hafley66/trace` |

Second blocker: `signal-grid`'s Vite build has no declaration step (`vite-plugin-dts` is absent from
its `vite.config.ts`), so `package.json#types` (`./dist/index.d.ts`) resolves to a missing file.
TypeScript consumers fail even after a publish.

Unblocking needs two actions outside this lane's authorization:

```sh
# library edit: add vite-plugin-dts to packages/signal-grid/vite.config.ts, build, then publish
pnpm --filter @hafley66/trace build        && pnpm --filter @hafley66/trace publish --registry http://127.0.0.1:4873 --no-git-checks
pnpm --filter @hafley66/signal-grid build  && pnpm --filter @hafley66/signal-grid publish --registry http://127.0.0.1:4873 --no-git-checks
```

## Adapter to drop in (`src/1_boopSelectionGrid.tsx`, not compiled yet)

```tsx
import { useEffect, useMemo } from "react";
import { Signal } from "@hafley66/signals";
import { checkboxColumn, grid, type ColumnDef, type Grid } from "@hafley66/signal-grid";
import { GridView } from "@hafley66/signal-grid/react";
import "@hafley66/signal-grid/theme.css";
import type { BoopSelectionRow } from "./0_boopSelection";

const NUL = String.fromCharCode(0);
const rowId = (r: BoopSelectionRow): string => `${r.route}${NUL}${r.session}${NUL}${r.pane}`;

const COLUMNS: readonly ColumnDef<BoopSelectionRow>[] = [
  checkboxColumn<BoopSelectionRow>(),
  { id: "session", header: "session", field: "session", width: 170, resizable: true },
  { id: "route", header: "route", field: "route", width: 190, resizable: true },
  { id: "title", header: "title", field: "title", flex: 1, minWidth: 200 },
  { id: "focus", header: "focus", field: "lastFocusedAt", width: 70, sortable: true },
];

// rows$ is a Signal so a poll pushes data without recreating the grid (recreating
// loses selection, scroll and identity). rowSelection is the one selection source;
// BoopSelectionRow.selected is ignored by the grid and must be mirrored in/out.
export function BoopSelectionGrid(props: {
  rows: readonly BoopSelectionRow[];
  selected: ReadonlySet<string>;
  onToggle: (route: string, on: boolean) => void;
}) {
  const rows$ = useMemo(() => Signal<readonly BoopSelectionRow[]>(props.rows), []);
  useEffect(() => { rows$(props.rows); }, [props.rows, rows$]);

  const g: Grid<BoopSelectionRow> = useMemo(() => grid<BoopSelectionRow>({
    id: "boop-selection",
    rows: rows$,
    columns: COLUMNS,
    rowId,
    state: {
      rowSelection: Object.fromEntries(
        props.rows.filter((r) => r.selected).map((r) => [rowId(r), true]),
      ),
    },
  }), []);
  useEffect(() => () => g.close(), [g]);

  return <GridView grid={g} style={{ blockSize: "100%" }} />;
}
```

Behaviour to preserve when swapping: the grid owns the checkbox cell (`checkboxColumn()`), so the
per-row toggle must be read from `g.state.rowSelection` and written through `setSelection`, and the
flash on a failed write stays app-side (revert the signal). `state` is the controlled seam; do not
also render `selected` in a cell slot.

## Layout contract

`GridView`'s host must have a resolved height or the viewport measures 0 and virtualized rows never
render. The current panel already provides that: `.bs-panel` is the fixed/resizable box and the grid
area is `flex: 1 1 auto; min-height: 0`. `src/1_boopSelection.css` would drop the `.dtable*`
overrides and keep the panel geometry, composer bounds and resize hint. `resizable: true` on the
session/route columns is the library's own column resize; the outer `resize: both` panel stays as is.
