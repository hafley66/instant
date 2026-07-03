// In-cell editor for the TreeTable grid (extracted so treetable.tsx stays under
// the file-size cap). A column opts in via TreeColumn.edit + getEditValue and the
// table's onCellEdit prop; the table owns "which cell is editing" state and mounts
// one CellEditor in place of the cell's render. Text commits on Enter/blur; select
// commits on change/blur; Escape cancels. Keystrokes are stopPropagation'd so they
// never reach the table's keyboard nav or the window-level keymap (tinykeys binds
// with ignore:()=>false, and Esc hides the window).
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export type CellEdit = { kind: "text" } | { kind: "select"; options: readonly string[] };

export interface CellEditorProps {
  edit: CellEdit;
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}

export function CellEditor({ edit, initial, onCommit, onCancel }: CellEditorProps) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
  // Once we commit or cancel the parent unmounts us; guard so a trailing blur
  // (which also fires during that unmount) can't double-fire onCommit.
  const done = useRef(false);
  const commit = (v: string) => {
    if (done.current) return;
    done.current = true;
    onCommit(v);
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    // Keep keystrokes inside the editor: no table nav, no window keymap, no
    // Esc-hides-window.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit(value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  if (edit.kind === "select") {
    return (
      <select
        ref={ref}
        className="tt-edit tt-edit-select"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          commit(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => commit(value)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {edit.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      ref={ref}
      className="tt-edit tt-edit-text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => commit(value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      autoComplete="off"
      spellCheck={false}
    />
  );
}
