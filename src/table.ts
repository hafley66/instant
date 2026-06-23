import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  observeElementRect,
} from "@tanstack/virtual-core";

// Reusable skin-agnostic DataTable. Paints `.dtable` markup that the design
// tokens (var(--head-bg), --row-hover, …) style per skin, so the same call site
// reads correctly under XP, P5, and AC3. Columns are declarative: a header plus
// a per-row cell accessor and optional per-cell class.
export interface Column<T> {
  header: string;
  cell: (row: T) => string;
  // Class applied to this column's <td> for a given row (e.g. a dirty flag).
  cellClass?: (row: T) => string | undefined;
  // When present the column header is clickable to sort by this value. Numbers
  // sort numerically; strings use a numeric-aware localeCompare; null/undefined
  // sink to the bottom.
  sortKey?: (row: T) => string | number | null | undefined;
}

// Which column index is the sort key and which way. `col` indexes into columns.
export interface SortState {
  col: number;
  dir: "asc" | "desc";
}

export interface TableOpts<T> {
  columns: Column<T>[];
  rows: T[];
  onRow?: (row: T) => void;
  onRowDblClick?: (row: T) => void;
  rowTitle?: (row: T) => string;
  // Class applied to a row's <tr> (e.g. to mark the selected row).
  rowClass?: (row: T) => string | undefined;
  // Marks the row as a draggable entity (file/repo/rev) carrying a typed value.
  // Sets draggable + data-entity-kind/value; the global dragstart/ctx handlers
  // in main.ts key off those attrs (shared with sprefa result cells).
  rowEntity?: (row: T) => { kind: string; value: string } | undefined;
  // Active sort + a callback to request a new one (caller persists, re-renders).
  sort?: SortState;
  onSort?: (s: SortState) => void;
}

type RowOpts<T> = Omit<TableOpts<T>, "rows">;

// Compare two sortKey values: numeric when both numbers, else numeric-aware
// string compare; null/undefined always sink last (before dir is applied).
function cmpKey(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): number {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

// Stable sort of a copy of `rows` by the active column's sortKey.
export function sortRows<T>(rows: T[], columns: Column<T>[], sort?: SortState): T[] {
  if (!sort) return rows;
  const key = columns[sort.col]?.sortKey;
  if (!key) return rows;
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const c = cmpKey(key(a.row), key(b.row));
      return c !== 0 ? c * sign : a.i - b.i; // index tiebreak keeps it stable
    })
    .map((x) => x.row);
}

// Build one <tr> from a row. Shared by the static and virtual tables so their
// cell/handler/selection behavior is identical.
function buildRow<T>(row: T, opts: RowOpts<T>): HTMLTableRowElement {
  const { columns, onRow, onRowDblClick, rowTitle, rowClass, rowEntity } = opts;
  const tr = document.createElement("tr");
  tr.className = "dtable-row";
  const extra = rowClass?.(row);
  if (extra) tr.className += ` ${extra}`;
  const ent = rowEntity?.(row);
  if (ent) {
    tr.draggable = true;
    tr.dataset.entityKind = ent.kind;
    tr.dataset.entityValue = ent.value;
  }
  for (const col of columns) {
    const td = document.createElement("td");
    td.textContent = col.cell(row);
    const cls = col.cellClass?.(row);
    if (cls) td.className = cls;
    tr.appendChild(td);
  }
  if (rowTitle) tr.title = rowTitle(row);
  if (onRow) tr.onclick = () => onRow(row);
  if (onRowDblClick) tr.ondblclick = () => onRowDblClick(row);
  return tr;
}

// Header row. Columns with a sortKey render a clickable th: click the active
// column to flip direction, a new column to sort it ascending. The ▲/▼ marker
// shows the current sort.
function buildHead<T>(
  columns: Column<T>[],
  sort?: SortState,
  onSort?: (s: SortState) => void,
): HTMLTableSectionElement {
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  columns.forEach((col, i) => {
    const th = document.createElement("th");
    th.textContent = col.header;
    if (col.sortKey && onSort) {
      th.className = "dtable-th-sort";
      if (sort?.col === i) {
        th.classList.add("sorted");
        const mark = document.createElement("span");
        mark.className = "dtable-sort-mark";
        mark.textContent = sort.dir === "asc" ? " ▲" : " ▼";
        th.appendChild(mark);
      }
      th.onclick = () => {
        const dir = sort?.col === i && sort.dir === "asc" ? "desc" : "asc";
        onSort({ col: i, dir });
      };
    }
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  return thead;
}

export function renderTable<T>(opts: TableOpts<T>): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "dtable";
  table.appendChild(buildHead(opts.columns, opts.sort, opts.onSort));
  const tbody = document.createElement("tbody");
  for (const row of sortRows(opts.rows, opts.columns, opts.sort))
    tbody.appendChild(buildRow(row, opts));
  table.appendChild(tbody);
  return table;
}

// A virtualized table for large, frequently-updated lists (the activity spy
// hits 2000 rows). `host` is the scroll container (overflow:auto); TanStack's
// Virtualizer owns the scroll/resize observers and the visible-range math, and
// we paint only the rows it reports, with spacer <tr>s padding the height
// above/below. Rows are fixed-height, measured once from a probe.
export interface VirtualTable<T> {
  setRows(rows: T[]): void;
  destroy(): void;
}

// virtualTable owns its own sort state (it is long-lived, recreated rarely), so
// header clicks re-sort in place and survive setRows. `defaultSort` seeds it;
// `onSort` lets the caller persist the choice.
export interface VirtualOpts<T> extends RowOpts<T> {
  defaultSort?: SortState;
}

export function virtualTable<T>(host: HTMLElement, opts: VirtualOpts<T>): VirtualTable<T> {
  const { columns } = opts;
  let sort = opts.defaultSort;

  const table = document.createElement("table");
  table.className = "dtable";
  const tbody = document.createElement("tbody");
  table.appendChild(tbody); // thead is inserted before it by renderHead

  const renderHead = () => {
    const head = buildHead(columns, sort, (s) => {
      sort = s;
      opts.onSort?.(s);
      renderHead();
      reflow();
    });
    const old = table.querySelector("thead");
    if (old) table.replaceChild(head, old);
    else table.insertBefore(head, tbody);
  };
  renderHead();
  host.replaceChildren(table);

  let raw: T[] = []; // insertion order, as handed to setRows
  let rows: T[] = []; // sorted view
  let rowH = 0; // measured lazily from a real row; 0 until a visible measure

  const spacer = (h: number): HTMLTableRowElement => {
    const tr = document.createElement("tr");
    tr.className = "dtable-spacer";
    const td = document.createElement("td");
    td.colSpan = columns.length;
    td.style.cssText = `height:${h}px;padding:0;border:0`;
    tr.appendChild(td);
    return tr;
  };

  // Measure one real row's height into the (visible) tbody, once.
  const ensureRowH = () => {
    if (rowH || rows.length === 0) return;
    const probe = buildRow(rows[0], opts);
    tbody.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    tbody.removeChild(probe);
    if (h > 0) rowH = h;
  };

  function paint() {
    if (rows.length === 0) {
      tbody.replaceChildren();
      return;
    }
    const items = virtualizer.getVirtualItems();
    const total = virtualizer.getTotalSize();
    const before = items.length ? items[0].start : 0;
    const after = items.length ? total - items[items.length - 1].end : 0;
    const frag = document.createDocumentFragment();
    if (before > 0) frag.appendChild(spacer(before));
    for (const it of items) frag.appendChild(buildRow(rows[it.index], opts));
    if (after > 0) frag.appendChild(spacer(after));
    tbody.replaceChildren(frag);
  }

  // Re-derive the sorted view from raw + current sort, then repaint.
  function reflow() {
    rows = sortRows(raw, columns, sort);
    ensureRowH();
    virtualizer.setOptions({ ...virtualizer.options, count: rows.length });
    virtualizer._willUpdate();
    paint();
  }

  const virtualizer = new Virtualizer<HTMLElement, HTMLTableRowElement>({
    count: 0,
    getScrollElement: () => host,
    estimateSize: () => rowH || 22,
    scrollToFn: elementScroll,
    observeElementRect, // resize observer -> recompute
    observeElementOffset, // scroll listener -> recompute
    overscan: 10,
    onChange: () => paint(),
  });

  const cleanup = virtualizer._didMount();

  return {
    setRows(next) {
      raw = next;
      reflow();
    },
    destroy() {
      cleanup();
    },
  };
}
