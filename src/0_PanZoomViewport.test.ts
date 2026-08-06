import { describe, expect, it } from "vitest";
import { clampPanZoom, wheelPanOffset } from "./0_PanZoomViewport";

describe("pan/zoom viewport input", () => {
  it("uses bounded scale and directional wheel pan for diagrams and file images", () => {
    expect({
      minimum: clampPanZoom(0),
      maximum: clampPanZoom(100),
      trackpad: wheelPanOffset({ x: 10, y: 20 }, 5, -8, false),
      shiftWheel: wheelPanOffset({ x: 10, y: 20 }, 0, 12, true),
    }).toMatchInlineSnapshot(`
      {
        "maximum": 64,
        "minimum": 0.1,
        "shiftWheel": {
          "x": -2,
          "y": 20,
        },
        "trackpad": {
          "x": 5,
          "y": 28,
        },
      }
    `);
  });
});
