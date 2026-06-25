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
  useReactTable,
  type Row,
  type SortingState,
  type ExpandedState,
  type ColumnDef,
} from "@tanstack/react-table";
import { useState, type ReactNode, type MouseEvent } from "react";

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
  onRowClick?: (row: T, e: MouseEvent) => void;
  onRowDoubleClick?: (row: T, e: MouseEvent) => void;
  onRowContextMenu?: (row: T, e: MouseEvent) => void;
  rowClass?: (row: T) => string | undefined;
  rowTitle?: (row: T) => string;
  // draggable entity payload (mirrors table.ts rowEntity; main.ts dragstart reads
  // data-entity-kind/value).
  rowEntity?: (row: T) => { kind: string; value: string } | undefined;
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
    rowClass,
    rowTitle,
    rowEntity,
  } = props;

  const [ownSorting, setOwnSorting] = useState<SortingState>(props.defaultSorting ?? []);
  const sorting = props.sorting ?? ownSorting;
  const setSorting = (s: SortingState) => {
    props.onSortingChange?.(s);
    if (!props.sorting) setOwnSorting(s);
  };
  const [expanded, setExpanded] = useState<ExpandedState>(defaultExpandedAll ? true : {});

  const colDefs: ColumnDef<T>[] = columns.map((c) => ({
    id: c.id,
    header: c.header,
    accessorFn: c.sortValue ? (row) => c.sortValue!(row) : undefined,
    enableSorting: !!c.sortValue,
    // null/undefined sink last regardless of direction.
    sortUndefined: "last",
    meta: c,
  }));

  const table = useReactTable<T>({
    data,
    columns: colDefs,
    state: { sorting, expanded },
    onSortingChange: (updater) =>
      setSorting(typeof updater === "function" ? updater(sorting) : updater),
    onExpandedChange: setExpanded,
    getSubRows,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    // We pre-sort children too; keep manual paging off, everything client-side.
    enableSortingRemoval: true,
  });

  return (
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
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <TableRow
            key={row.id}
            row={row}
            columns={columns}
            onRowClick={onRowClick}
            onRowDoubleClick={onRowDoubleClick}
            onRowContextMenu={onRowContextMenu}
            rowClass={rowClass}
            rowTitle={rowTitle}
            rowEntity={rowEntity}
          />
        ))}
      </tbody>
    </table>
  );
}

function TableRow<T>(props: {
  row: Row<T>;
  columns: TreeColumn<T>[];
  onRowClick?: (row: T, e: MouseEvent) => void;
  onRowDoubleClick?: (row: T, e: MouseEvent) => void;
  onRowContextMenu?: (row: T, e: MouseEvent) => void;
  rowClass?: (row: T) => string | undefined;
  rowTitle?: (row: T) => string;
  rowEntity?: (row: T) => { kind: string; value: string } | undefined;
}) {
  const { row, columns } = props;
  const data = row.original;
  const ent = props.rowEntity?.(data);
  const cls = ["dtable-row", props.rowClass?.(data)].filter(Boolean).join(" ");
  return (
    <tr
      className={cls}
      title={props.rowTitle?.(data)}
      draggable={ent ? true : undefined}
      data-entity-kind={ent?.kind}
      data-entity-value={ent?.value}
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
        props.onRowDoubleClick ? (e) => props.onRowDoubleClick!(data, e) : undefined
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
