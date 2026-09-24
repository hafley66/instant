// A pointer position to a terminal cell. `bufferRow` indexes xterm's buffer;
// `clientRow` is the row in the tmux client grid, null when xterm is scrolled above it.
export type TermGeometry = {
  left: number;
  top: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
  viewportY: number;
  baseY: number;
};

export type TermCell = { col: number; row: number; bufferRow: number; clientRow: number | null };

export function termCellAt(g: TermGeometry, clientX: number, clientY: number): TermCell {
  const cellH = g.height / g.rows || 1;
  const cellW = g.width / g.cols || 1;
  const row = Math.max(0, Math.min(g.rows - 1, Math.floor((clientY - g.top) / cellH)));
  const col = Math.max(0, Math.min(g.cols - 1, Math.floor((clientX - g.left) / cellW)));
  const bufferRow = g.viewportY + row;
  const client = bufferRow - g.baseY;
  return { col, row, bufferRow, clientRow: client >= 0 ? client : null };
}
