import { describe, expect, it } from "vitest";
import { clampPanZoom, pinchPanZoom, wheelPanOffset, wheelZooms } from "./0_PanZoomViewport";

describe("pan/zoom viewport input", () => {
  it("uses bounded scale and directional wheel pan for diagrams and file images", () => {
    expect({
      minimum: clampPanZoom(0),
      maximum: clampPanZoom(100),
      trackpad: wheelPanOffset({ x: 10, y: 20 }, 5, -8, false),
      shiftWheel: wheelPanOffset({ x: 10, y: 20 }, 0, 12, true),
      pinchOut: pinchPanZoom(1, 20),
      pinchIn: pinchPanZoom(1, -20),
      wheelZoom: {
        plain: wheelZooms(false, false),
        pinch: wheelZooms(true, false),
        command: wheelZooms(false, true),
      },
    }).toMatchInlineSnapshot(`
      {
        "maximum": 64,
        "minimum": 0.1,
        "pinchIn": 1.2214027581601699,
        "pinchOut": 0.8187307530779818,
        "shiftWheel": {
          "x": -2,
          "y": 20,
        },
        "trackpad": {
          "x": 5,
          "y": 28,
        },
        "wheelZoom": {
          "command": true,
          "pinch": true,
          "plain": false,
        },
      }
    `);
  });
});
