// Headless tree/flat table built on TanStack react-table, painting the same
// `.dtable` markup the vanilla table.ts emits so every skin (xp/p5/ac3) styles
// it via the design tokens — no new CSS. One component drives flat lists (tmux,
// worktrees) and row-expand trees (files): pass `getSubRows` + mark one column
// `tree` and it renders the indent + twisty; omit them for a flat table.
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  useReactTable,
  type Row,
  type SortingState,
  type ExpandedState,
  type ColumnDef,
  type ColumnSizingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, useState, type ReactNode, type MouseEvent } from "react";
import type { CellEdit } from "./treetableEdit";
import { TableRow } from "./treetableRow";
import { hasWidthSignal, anyWidthSignal } from "./treetableSize";

export type { CellEdit } from "./treetableEdit";

export interface TreeColumn<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  // <td> class for this column on a given row (e.g. wt-dirty).
  cellClass?: (row: T) => string | undefined;
  // Provide to make the header clickable/sortable. Numbers sort numerically.
  sortValue?: (row: T) => string | number | null | undefined;
  // The one column that carries the tree twisty + depth indent (tree tables).
  tree?: boolean;
  // Action cells (pin, star): clicks here must NOT trigger the row's onClick.
  noRowClick?: boolean;
  // Inline editing: opt a column in with an editor kind + a string projection of
  // the field. Requires the table's onCellEdit prop. Columns without both stay
  // display-only (unchanged for every existing consumer).
  edit?: CellEdit;
  getEditValue?: (row: T) => string;
  // Column resizing (all columns resizable by default). `size` authors a start
  // width in px; the user can drag any column's right edge to override it.
  // min/maxSize clamp the drag. A column with no `size` and never dragged stays
  // auto-sized — the table only switches to fixed layout once some column has a
  // width signal, so untouched tables render identically to before.
  size?: number;
  minSize?: number;
  maxSize?: number;
}

export interface TreeTableProps<T> {
  columns: TreeColumn<T>[];
  data: T[];
  getSubRows?: (row: T) => T[] | undefined;
  getRowId?: (row: T, index: number) => string;
  // Controlled sort (persist in the store). Omit to let the table own it.
  sorting?: SortingState;
  onSortingChange?: (s: SortingState) => void;
  defaultSorting?: SortingState;
  // Controlled column widths (persist in the store). Omit to let the table own
  // local sizing state. Keys are column ids; values are px. Mirrors the
  // controlled-sorting pattern above.
  columnSizing?: ColumnSizingState;
  onColumnSizingChange?: (s: ColumnSizingState) => void;
  // Rows arrive pre-sorted by the host (e.g. tmux floats pinned sessions first
  // via sortSessions). react-table then only mirrors the sort state for header
  // marks + clicks — it never reorders (sortingFn is a no-op), so the host's
  // order — including pinning — is final.
  serverSort?: boolean;
  defaultExpandedAll?: boolean;
  // Controlled expansion (persist in the store). Omit to let the table own it.
  expanded?: ExpandedState;
  onExpandedChange?: (e: ExpandedState) => void;
  onRowClick?: (row: T, e: MouseEvent) => void;
  onRowDoubleClick?: (row: T, e: MouseEvent) => void;
  onRowContextMenu?: (row: T, e: MouseEvent) => void;
  // Inline cell edit committed (Enter/blur/select). Fired with the row, the
  // column id, and the editor's string value; the host maps it back to a field.
  onCellEdit?: (row: T, columnId: string, value: string) => void;
  rowClass?: (row: T) => string | undefined;
  rowTitle?: (row: T) => string;
  // draggable entity payload (mirrors table.ts rowEntity; main.ts dragstart reads
  // data-entity-kind/value).
  rowEntity?: (row: T) => { kind: string; value: string } | undefined;
  // Force a row to show the twisty even before its children are loaded (lazy
  // trees): return true for expandable rows whose getSubRows is still empty.
  getRowCanExpand?: (row: T) => boolean;
  // Fired when a twisty toggles, before the table state flips. Lazy trees load
  // children here (willExpand=true) so the next render has subRows to show.
  onToggleExpand?: (row: T, willExpand: boolean) => void;
  // Virtualize the body (spacer <tr>s above/below the visible window). For long
  // flat lists (activity); the table scrolls inside its own container.
  virtual?: boolean;
  // Render a controls bar above the table: a search box (when `filter` is given)
  // plus collapse-all / expand-all buttons. Self-contained + reusable.
  controls?: boolean;
  // Controlled search state follows the same persistence pattern as sorting and
  // sizing. Sidebar views use this to restore their independent filters.
  query?: string;
  onQueryChange?: (query: string) => void;
  // Optional host reset for persisted table state.
  onResetView?: () => void;
  toolbar?: ReactNode;
  // Predicate for the search box: return true to keep a row. A row is shown when
  // it matches OR any descendant matches (filterFromLeafRows keeps ancestors).
  filter?: (row: T, q: string) => boolean;
  searchPlaceholder?: string;
  // When set and a row can expand, a double-click on the row toggles it instead
  // of firing onRowDoubleClick — for rows with no primary action (org/dir nodes).
  toggleOnDoubleClick?: (row: T) => boolean;
}

export function TreeTable<T>(props: TreeTableProps<T>) {
  const {
    columns,
    data,
    getSubRows,
    getRowId,
    defaultExpandedAll,
    onRowClick,
    onRowDoubleClick,
    onRowContextMenu,
    onToggleExpand,
    rowClass,
    rowTitle,
    rowEntity,
    virtual,
  } = props;

  const [ownSorting, setOwnSorting] = useState<SortingState>(props.defaultSorting ?? []);
  const sorting = props.sorting ?? ownSorting;
  const setSorting = (s: SortingState) => {
    props.onSortingChange?.(s);
    if (!props.sorting) setOwnSorting(s);
  };
  const [ownExpanded, setOwnExpanded] = useState<ExpandedState>(defaultExpandedAll ? true : {});
  const expanded = props.expanded ?? ownExpanded;
  const [ownSizing, setOwnSizing] = useState<ColumnSizingState>({});
  const columnSizing = props.columnSizing ?? ownSizing;
  const setColumnSizing = (s: ColumnSizingState) => {
    props.onColumnSizingChange?.(s);
    if (props.columnSizing === undefined) setOwnSizing(s);
  };
  // Search query for the controls bar. A non-empty query forces every branch
  // open so matches buried under collapsed ancestors are visible.
  const [ownQuery, setOwnQuery] = useState("");
  const query = props.query ?? ownQuery;
  const setQuery = (next: string) => {
    props.onQueryChange?.(next);
    if (props.query === undefined) setOwnQuery(next);
  };

  const colDefs: ColumnDef<T>[] = columns.map((c) => ({
    id: c.id,
    header: c.header,
    // Every column needs an accessorFn or react-table's getCanGlobalFilter() is
    // false for it; a table with zero filterable columns skips global filtering
    // entirely (the symptom: a panel whose columns are all display-only, like
    // worktrees, never filters). The "" fallback makes the column filterable
    // without affecting sort (gated on enableSorting) or render (cells use
    // c.cell). The globalFilterFn ignores the column and tests the whole row.
    accessorFn: c.sortValue ? (row) => c.sortValue!(row) : () => "",
    enableSorting: !!c.sortValue,
    // null/undefined sink last regardless of direction.
    sortUndefined: "last",
    // serverSort: the host already ordered these rows; don't reorder on click.
    // "auto" must be spelled out: an explicit `sortingFn: undefined` clobbers
    // react-table's 'auto' default in the spread-merge, getSortingFn() then
    // returns undefined and the first active sort crashes sortData.
    sortingFn: props.serverSort ? () => 0 : "auto",
    // Column resizing: pass authored sizes through so getSize() returns them.
    // Leaving size undefined keeps react-table's 150 default, but that default
    // is never painted — width styles are gated on hasWidthSignal below.
    size: c.size,
    minSize: c.minSize,
    maxSize: c.maxSize,
    meta: c,
  }));

  const q = query.trim();
  // Route expansion through the controlled prop when present, else local state.
  // An active search displays everything expanded but never persists that.
  const setExpanded = (updater: ExpandedState | ((p: ExpandedState) => ExpandedState)) => {
    const base = q ? true : expanded;
    const next = typeof updater === "function" ? updater(base) : updater;
    props.onExpandedChange?.(next);
    if (props.expanded === undefined) setOwnExpanded(next);
  };
  const table = useReactTable<T>({
    data,
    columns: colDefs,
    // Active search forces all branches open so deep matches surface.
    state: { sorting, expanded: q ? true : expanded, globalFilter: q, columnSizing },
    onSortingChange: (updater) =>
      setSorting(typeof updater === "function" ? updater(sorting) : updater),
    onExpandedChange: setExpanded,
    // All columns resizable by default; live-update widths while dragging.
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    onColumnSizingChange: (updater) =>
      setColumnSizing(typeof updater === "function" ? updater(columnSizing) : updater),
    onGlobalFilterChange: (v) => setQuery(typeof v === "function" ? v(query) : (v ?? "")),
    globalFilterFn: (row, _col, value) =>
      props.filter ? props.filter(row.original, String(value)) : true,
    // A parent stays visible when any leaf descendant matches.
    filterFromLeafRows: true,
    getSubRows,
    getRowId,
    getRowCanExpand: props.getRowCanExpand
      ? (row) => props.getRowCanExpand!(row.original)
      : undefined,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    // We pre-sort children too; keep manual paging off, everything client-side.
    enableSortingRemoval: true,
  });

  const modelRows = table.getRowModel().rows;
  const wrapRef = useRef<HTMLDivElement>(null);
  // Virtualizer is created unconditionally (hooks rule); only consulted when
  // `virtual` is set. Spacer <tr>s pad the height so column widths still align.
  const virtualizer = useVirtualizer({
    count: modelRows.length,
    getScrollElement: () => wrapRef.current,
    estimateSize: () => 22,
    overscan: 12,
  });

  // Single-cell-at-a-time inline edit, keyed by row id + column id. Local to the
  // table; the editor commits through props.onCellEdit.
  const [editing, setEditing] = useState<{ row: string; col: string } | null>(null);
  const firstEditableCol = (): string | undefined =>
    props.onCellEdit ? columns.find((c) => c.edit && c.getEditValue)?.id : undefined;

  // Keyboard cursor: the focused row index in the flattened (visible) model.
  // Arrows move it, ←/→ collapse/expand (or step out/in), Enter activates the
  // row (reuses onRowClick at the row's rect so menus anchor sensibly).
  const [active, setActive] = useState(-1);
  const cur = active >= modelRows.length ? modelRows.length - 1 : active;
  const rowAt = (i: number) =>
    wrapRef.current?.querySelector<HTMLElement>(`[data-row-index="${i}"]`) ?? null;
  const moveTo = (i: number) => {
    if (!modelRows.length) return;
    const idx = Math.max(0, Math.min(modelRows.length - 1, i));
    setActive(idx);
    // Virtual lists need the virtualizer to bring the row into range first.
    if (virtual) virtualizer.scrollToIndex(idx, { align: "auto" });
    requestAnimationFrame(() => rowAt(idx)?.scrollIntoView({ block: "nearest" }));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Don't hijack typing in form fields rendered inside cells (meme layer text,
    // color/range/number inputs): let Space/Enter/arrows reach the field.
    if ((e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]"))
      return;
    if (!modelRows.length) return;
    const i = cur < 0 ? 0 : cur;
    const row = modelRows[i];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveTo(cur < 0 ? 0 : i + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveTo(cur < 0 ? 0 : i - 1);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (row.getCanExpand() && !row.getIsExpanded()) {
          onToggleExpand?.(row.original, true);
          row.toggleExpanded();
        } else if (i + 1 < modelRows.length) moveTo(i + 1);
        break;
      case "ArrowLeft": {
        e.preventDefault();
        if (row.getCanExpand() && row.getIsExpanded()) row.toggleExpanded();
        else {
          const p = row.getParentRow();
          if (p) {
            const pi = modelRows.findIndex((r) => r.id === p.id);
            if (pi >= 0) moveTo(pi);
          }
        }
        break;
      }
      case "Enter": {
        e.preventDefault();
        // Editable tables: Enter edits the row's first editable cell (nav is
        // row-level, so there's no focused-column concept to honor). Otherwise
        // fall back to activating the row.
        const col = firstEditableCol();
        if (col) {
          setEditing({ row: row.id, col });
          break;
        }
        if (onRowClick) {
          const r = rowAt(i)?.getBoundingClientRect();
          onRowClick(row.original, { clientX: (r?.left ?? 0) + 8, clientY: r?.bottom ?? 0 } as MouseEvent);
        }
        break;
      }
      case " ":
        e.preventDefault();
        if (onRowClick) {
          const r = rowAt(i)?.getBoundingClientRect();
          onRowClick(row.original, { clientX: (r?.left ?? 0) + 8, clientY: r?.bottom ?? 0 } as MouseEvent);
        }
        break;
      case "Home":
        e.preventDefault();
        moveTo(0);
        break;
      case "End":
        e.preventDefault();
        moveTo(modelRows.length - 1);
        break;
    }
  };

  const renderRow = (row: Row<T>, index: number) => (
    <TableRow
      key={row.id}
      row={row}
      index={index}
      active={index === cur}
      onFocusRow={setActive}
      columns={columns}
      onRowClick={onRowClick}
      onRowDoubleClick={onRowDoubleClick}
      onRowContextMenu={onRowContextMenu}
      onToggleExpand={onToggleExpand}
      toggleOnDoubleClick={props.toggleOnDoubleClick}
      rowClass={rowClass}
      rowTitle={rowTitle}
      rowEntity={rowEntity}
      editingCol={editing && editing.row === row.id ? editing.col : null}
      onStartEdit={props.onCellEdit ? (col) => setEditing({ row: row.id, col }) : undefined}
      onCommitEdit={
        props.onCellEdit
          ? (col, value) => {
              props.onCellEdit!(row.original, col, value);
              setEditing(null);
            }
          : undefined
      }
      onCancelEdit={() => setEditing(null)}
    />
  );

  let body: ReactNode;
  if (virtual) {
    const items = virtualizer.getVirtualItems();
    const total = virtualizer.getTotalSize();
    const before = items.length ? items[0].start : 0;
    const after = items.length ? total - items[items.length - 1].end : 0;
    body = (
      <>
        {before > 0 && (
          <tr className="dtable-spacer">
            <td colSpan={columns.length} style={{ height: before, padding: 0, border: 0 }} />
          </tr>
        )}
        {items.map((it) => renderRow(modelRows[it.index], it.index))}
        {after > 0 && (
          <tr className="dtable-spacer">
            <td colSpan={columns.length} style={{ height: after, padding: 0, border: 0 }} />
          </tr>
        )}
      </>
    );
  } else {
    body = modelRows.map(renderRow);
  }

  // Width plumbing: a <colgroup> carries each column's width so header and body
  // (and the virtual spacer colSpan rows) stay aligned with one style per column
  // instead of per-cell props. A col gets a width ONLY when its column has a
  // signal (dragged or authored); the rest stay auto. When any column is sized
  // the table flips to fixed layout so those px widths are authoritative —
  // otherwise it stays auto and renders identically to before.
  const sizeById: Record<string, number | undefined> = {};
  for (const c of columns) sizeById[c.id] = c.size;
  const sized = anyWidthSignal(
    columns.map((c) => c.id),
    columnSizing,
    sizeById,
  );
  const cols = table.getHeaderGroups()[0].headers;
  const tableEl = (
    <table className={"dtable" + (sized ? " dtable-sized" : "")}>
      <colgroup>
        {cols.map((h) => {
          const w = hasWidthSignal(h.column.id, columnSizing, sizeById[h.column.id])
            ? h.column.getSize()
            : undefined;
          return <col key={h.id} style={w !== undefined ? { width: w } : undefined} />;
        })}
      </colgroup>
      <thead>
        <tr>
          {cols.map((h) => {
            const sortable = h.column.getCanSort();
            const dir = h.column.getIsSorted(); // false | "asc" | "desc"
            return (
              <th
                key={h.id}
                className={
                  (sortable ? "dtable-th-sort" : "") + (dir ? " sorted" : "")
                }
                onClick={sortable ? h.column.getToggleSortingHandler() : undefined}
              >
                {flexRender(h.column.columnDef.header, h.getContext())}
                {dir ? (
                  <span className="dtable-sort-mark">{dir === "asc" ? " ▲" : " ▼"}</span>
                ) : null}
                {h.column.getCanResize() ? (
                  <div
                    className={
                      "dtable-resizer" + (h.column.getIsResizing() ? " is-resizing" : "")
                    }
                    // getResizeHandler drives the drag; stop click/dblclick from
                    // reaching the <th> so a grab never toggles the sort. Double-
                    // click resets the column to its authored/default width.
                    onMouseDown={h.getResizeHandler()}
                    onTouchStart={h.getResizeHandler()}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      h.column.resetSize();
                    }}
                  />
                ) : null}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>{body}</tbody>
    </table>
  );

  // Focusable wrapper owns keyboard nav. `virtual` adds the scroll container
  // (.tt-scroll); flat tables scroll in their panel parent but still focus here.
  const host = (
    <div
      className={"tt-wrap" + (virtual ? " tt-scroll" : "")}
      tabIndex={0}
      ref={wrapRef}
      onKeyDown={onKeyDown}
    >
      {tableEl}
    </div>
  );

  if (!props.controls) return host;

  // Controls bar: search (optional) + collapse-all / expand-all. expandAll on a
  // lazy tree only opens already-loaded children; collapseAll also clears search.
  const matches = q ? table.getRowModel().rows.length : 0;
  return (
    <div className="tt-host">
      <div className="tt-controls">
        {props.toolbar}
        {props.filter ? (
          <input
            className="tt-search"
            placeholder={props.searchPlaceholder ?? "filter…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        ) : null}
        <button
          type="button"
          className="tt-ctl"
          title="collapse all"
          onClick={() => {
            setQuery("");
            setExpanded({});
          }}
        >
          ⊟
        </button>
        <button
          type="button"
          className="tt-ctl"
          title="expand all"
          onClick={() => {
            // Expand every currently-known expandable row by id (persist-friendly
            // vs the `true` sentinel; lazy trees only open already-loaded nodes).
            const all: Record<string, boolean> = {};
            for (const r of table.getCoreRowModel().flatRows) {
              if (r.getCanExpand()) all[r.id] = true;
            }
            setExpanded(all);
          }}
        >
          ⊞
        </button>
        {props.onResetView ? (
          <button type="button" className="tt-ctl" title="reset view" onClick={props.onResetView}>↺</button>
        ) : null}
        {q ? <span className="tt-match">{matches}</span> : null}
      </div>
      {host}
    </div>
  );
}
