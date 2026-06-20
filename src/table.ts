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
  rowTitle?: (row: T) => string;
}

export function renderTable<T>(opts: TableOpts<T>): HTMLTableElement {
  const { columns, rows, onRow, rowTitle } = opts;
  const table = document.createElement("table");
  table.className = "dtable";

  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const col of columns) {
    const th = document.createElement("th");
    th.textContent = col.header;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.className = "dtable-row";
    for (const col of columns) {
      const td = document.createElement("td");
      td.textContent = col.cell(row);
      const cls = col.cellClass?.(row);
      if (cls) td.className = cls;
      tr.appendChild(td);
    }
    if (rowTitle) tr.title = rowTitle(row);
    if (onRow) tr.onclick = () => onRow(row);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}
