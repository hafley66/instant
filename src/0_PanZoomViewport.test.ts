import { describe, expect, it } from "vitest";
import { clampPanZoom, wheelPanZoom } from "./0_PanZoomViewport";

describe("pan/zoom viewport scale", () => {
  it("uses one bounded scale policy for diagrams and file images", () => {
    expect({
      minimum: clampPanZoom(0),
      maximum: clampPanZoom(100),
      wheelIn: wheelPanZoom(1, -1),
      wheelOut: wheelPanZoom(1, 1),
    }).toMatchInlineSnapshot(`
      {
        "maximum": 64,
        "minimum": 0.1,
        "wheelIn": 1.12,
        "wheelOut": 0.8928571428571428,
      }
    `);
  });
});
