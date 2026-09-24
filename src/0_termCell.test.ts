import { describe, expect, it } from "vitest";
import { termCellAt, type TermGeometry } from "./0_termCell";

const geometry: TermGeometry = { left: 10, top: 20, width: 800, height: 480, cols: 100, rows: 24, viewportY: 0, baseY: 0 };

describe("termCellAt", () => {
  it("maps pointer positions to cells, clamped to the grid", () => {
    const points: Array<[number, number]> = [[10, 20], [17.9, 39.9], [18, 40], [809, 499], [5000, -50]];
    expect(points.map(([x, y]) => termCellAt(geometry, x, y))).toMatchInlineSnapshot(`
      [
        {
          "bufferRow": 0,
          "clientRow": 0,
          "col": 0,
          "row": 0,
        },
        {
          "bufferRow": 0,
          "clientRow": 0,
          "col": 0,
          "row": 0,
        },
        {
          "bufferRow": 1,
          "clientRow": 1,
          "col": 1,
          "row": 1,
        },
        {
          "bufferRow": 23,
          "clientRow": 23,
          "col": 99,
          "row": 23,
        },
        {
          "bufferRow": 0,
          "clientRow": 0,
          "col": 99,
          "row": 0,
        },
      ]
    `);
  });

  it("offsets the tmux client row by xterm's own scrollback", () => {
    expect([
      termCellAt({ ...geometry, viewportY: 40, baseY: 40 }, 10, 60),
      termCellAt({ ...geometry, viewportY: 30, baseY: 40 }, 10, 60),
      termCellAt({ ...geometry, viewportY: 30, baseY: 40 }, 10, 300),
    ]).toMatchInlineSnapshot(`
      [
        {
          "bufferRow": 42,
          "clientRow": 2,
          "col": 0,
          "row": 2,
        },
        {
          "bufferRow": 32,
          "clientRow": null,
          "col": 0,
          "row": 2,
        },
        {
          "bufferRow": 44,
          "clientRow": 4,
          "col": 0,
          "row": 14,
        },
      ]
    `);
  });
});
