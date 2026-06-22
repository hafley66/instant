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
}

export interface TableOpts<T> {
  columns: Column<T>[];
  rows: T[];
  onRow?: (row: T) => void;
  onRowDblClick?: (row: T) => void;
  rowTitle?: (row: T) => string;
  // Class applied to a row's <tr> (e.g. to mark the selected row).
  rowClass?: (row: T) => string | undefined;
}

type RowOpts<T> = Omit<TableOpts<T>, "rows">;

// Build one <tr> from a row. Shared by the static and virtual tables so their
// cell/handler/selection behavior is identical.
function buildRow<T>(row: T, opts: RowOpts<T>): HTMLTableRowElement {
  const { columns, onRow, onRowDblClick, rowTitle, rowClass } = opts;
  const tr = document.createElement("tr");
  tr.className = "dtable-row";
  const extra = rowClass?.(row);
  if (extra) tr.className += ` ${extra}`;
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

function buildHead<T>(columns: Column<T>[]): HTMLTableSectionElement {
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col.header;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  return thead;
}

export function renderTable<T>(opts: TableOpts<T>): HTMLTableElement {
  const table = document.createElement("table");
  table.className = "dtable";
  table.appendChild(buildHead(opts.columns));
  const tbody = document.createElement("tbody");
  for (const row of opts.rows) tbody.appendChild(buildRow(row, opts));
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

export function virtualTable<T>(host: HTMLElement, opts: RowOpts<T>): VirtualTable<T> {
  const { columns } = opts;

  const table = document.createElement("table");
  table.className = "dtable";
  table.appendChild(buildHead(columns));
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  host.replaceChildren(table);

  let rows: T[] = [];
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
      rows = next;
      ensureRowH();
      virtualizer.setOptions({ ...virtualizer.options, count: next.length });
      virtualizer._willUpdate();
      paint();
    },
    destroy() {
      cleanup();
    },
  };
}
