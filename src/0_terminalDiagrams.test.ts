import { describe, expect, it } from "vitest";
import { svgAspectRatio } from "./0_terminalDiagrams";

describe("svgAspectRatio", () => {
  it("reads SVG dimensions and rejects missing renderer output", () => {
    expect([
      svgAspectRatio('<svg viewBox="0 0 640 320"></svg>'),
      svgAspectRatio('<svg width="300" height="600"></svg>'),
      svgAspectRatio(undefined),
      svgAspectRatio(Promise.resolve("<svg></svg>")),
      svgAspectRatio("<svg></svg>"),
    ]).toMatchInlineSnapshot(`
      [
        2,
        0.5,
        null,
        null,
        null,
      ]
    `);
  });
});
