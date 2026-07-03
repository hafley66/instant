// One TreeTable body row: the <tr> + its <td> cells, the twisty for tree
// columns, the action-cell / row-click guards, and the inline cell editor mount.
// Split out of treetable.tsx to keep that file under the size cap; the table owns
// row/edit state and passes it down here. Type-only import of TreeColumn from
// treetable is a cycle TS resolves fine (no runtime cycle: treetable imports this
// module's value, this module imports only types from treetable).
import type { Row } from "@tanstack/react-table";
import type { MouseEvent } from "react";
import type { TreeColumn } from "./treetable";
import { CellEditor } from "./treetableEdit";

export function TableRow<T>(props: {
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
  // Inline edit: the column id currently editing in THIS row (or null), plus the
  // start/commit/cancel handlers (absent when the table has no onCellEdit).
  editingCol?: string | null;
  onStartEdit?: (col: string) => void;
  onCommitEdit?: (col: string, value: string) => void;
  onCancelEdit?: () => void;
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
      {columns.map((c) => {
        const editable = !!(c.edit && c.getEditValue && props.onCommitEdit);
        const isEditing = editable && props.editingCol === c.id;
        // The editor replaces the cell's own render; double-click enters it, and
        // an editable cell doesn't trigger the row's onClick (like action cells).
        const content = isEditing ? (
          <CellEditor
            edit={c.edit!}
            initial={c.getEditValue!(data)}
            onCommit={(v) => props.onCommitEdit!(c.id, v)}
            onCancel={() => props.onCancelEdit?.()}
          />
        ) : (
          c.cell(data)
        );
        return (
          <td
            key={c.id}
            className={c.cellClass?.(data)}
            data-no-row-click={c.noRowClick || editable ? "" : undefined}
            onDoubleClick={
              editable
                ? (e) => {
                    e.stopPropagation();
                    props.onStartEdit?.(c.id);
                  }
                : undefined
            }
          >
            {c.tree ? (
              <span className="tt-tree" style={{ paddingLeft: `${row.depth * 12}px` }}>
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
                {content}
              </span>
            ) : (
              content
            )}
          </td>
        );
      })}
    </tr>
  );
}
