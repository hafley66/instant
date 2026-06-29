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
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, useState, type ReactNode, type MouseEvent } from "react";

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
  defaultExpandedAll?: boolean;
  // Controlled expansion (persist in the store). Omit to let the table own it.
  expanded?: ExpandedState;
  onExpandedChange?: (e: ExpandedState) => void;
  onRowClick?: (row: T, e: MouseEvent) => void;
  onRowDoubleClick?: (row: T, e: MouseEvent) => void;
  onRowContextMenu?: (row: T, e: MouseEvent) => void;
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
  // Search query for the controls bar. A non-empty query forces every branch
  // open so matches buried under collapsed ancestors are visible.
  const [query, setQuery] = useState("");

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
    state: { sorting, expanded: q ? true : expanded, globalFilter: q },
    onSortingChange: (updater) =>
      setSorting(typeof updater === "function" ? updater(sorting) : updater),
    onExpandedChange: setExpanded,
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
      case "Enter":
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

  const tableEl = (
    <table className="dtable">
      <thead>
        <tr>
          {table.getHeaderGroups()[0].headers.map((h) => {
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
        {q ? <span className="tt-match">{matches}</span> : null}
      </div>
      {host}
    </div>
  );
}

function TableRow<T>(props: {
  row: Row<T>;
  index: number;
  active: boolean;
  onFocusRow: (index: number) => void;
  columns: TreeColumn<T>[];
  onRowClick?: (row: T, e: MouseEvent) => void;
  onRowDoubleClick?: (row: T, e: MouseEvent) => void;
  onRowContextMenu?: (row: T, e: MouseEvent) => void;
  onToggleExpand?: (row: T, willExpand: boolean) => void;
  toggleOnDoubleClick?: (row: T) => boolean;
  rowClass?: (row: T) => string | undefined;
  rowTitle?: (row: T) => string;
  rowEntity?: (row: T) => { kind: string; value: string } | undefined;
}) {
  const { row, columns } = props;
  const data = row.original;
  const ent = props.rowEntity?.(data);
  const cls = ["dtable-row", props.active ? "kbd-active" : "", props.rowClass?.(data)]
    .filter(Boolean)
    .join(" ");
  return (
    <tr
      className={cls}
      data-row-index={props.index}
      title={props.rowTitle?.(data)}
      draggable={ent ? true : undefined}
      data-entity-kind={ent?.kind}
      data-entity-value={ent?.value}
      onMouseDown={() => props.onFocusRow(props.index)}
      onClick={
        props.onRowClick
          ? (e) => {
              // Bail if the click landed in an action cell (pin/star). A belt to
              // stopPropagation's braces: survives any synthetic-event quirk.
              if ((e.target as HTMLElement).closest("[data-no-row-click]")) return;
              props.onRowClick!(data, e);
            }
          : undefined
      }
      onDoubleClick={
        props.toggleOnDoubleClick?.(data) && row.getCanExpand()
          ? (e) => {
              if ((e.target as HTMLElement).closest("[data-no-row-click]")) return;
              props.onToggleExpand?.(data, !row.getIsExpanded());
              row.toggleExpanded();
            }
          : props.onRowDoubleClick
            ? (e) => props.onRowDoubleClick!(data, e)
            : undefined
      }
      onContextMenu={
        props.onRowContextMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              props.onRowContextMenu!(data, e);
            }
          : undefined
      }
    >
      {columns.map((c) => (
        <td
          key={c.id}
          className={c.cellClass?.(data)}
          data-no-row-click={c.noRowClick ? "" : undefined}
        >
          {c.tree ? (
            <span
              className="tt-tree"
              style={{ paddingLeft: `${row.depth * 12}px` }}
            >
              {row.getCanExpand() ? (
                <span
                  className="tt-twisty"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onToggleExpand?.(data, !row.getIsExpanded());
                    row.toggleExpanded();
                  }}
                >
                  {row.getIsExpanded() ? "▾" : "▸"}
                </span>
              ) : (
                <span className="tt-twisty tt-leaf" />
              )}
              {c.cell(data)}
            </span>
          ) : (
            c.cell(data)
          )}
        </td>
      ))}
    </tr>
  );
}
