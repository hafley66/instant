import { describe, expect, it } from "vitest";
import { normalizeSvgEntities, panSvgBox, svgBoxAtZoom, svgNativeBox, svgSourceBox } from "./0_svgViewport";

describe("isolated SVG viewport", () => {
  it("parses, zooms around a focus point, and pans in SVG coordinates", () => {
    const original = svgSourceBox(`<svg viewBox="0 0 2547 11185"></svg>`)!;
    const zoomed = svgBoxAtZoom(original, original, 2, 0.25, 0.75);
    expect({
      original,
      native: svgNativeBox(original, 1600, 900),
      zoomed,
      panned: panSvgBox(zoomed, 100, -50, 1000, 500),
    }).toMatchInlineSnapshot(`
      {
        "native": {
          "height": 900,
          "width": 1600,
          "x": 473.5,
          "y": 0,
        },
        "original": {
          "height": 11185,
          "width": 2547,
          "x": 0,
          "y": 0,
        },
        "panned": {
          "height": 5592.5,
          "width": 1273.5,
          "x": 445.725,
          "y": 3635.125,
        },
        "zoomed": {
          "height": 5592.5,
          "width": 1273.5,
          "x": 318.375,
          "y": 4194.375,
        },
      }
    `);
  });

  it("converts HTML-only entities before XML parsing", () => {
    expect(normalizeSvgEntities(
      `<svg><text>A&nbsp;B &amp; C&mdash;D &unknown;</text></svg>`,
    )).toMatchInlineSnapshot(`"<svg><text>A B &amp; C—D &amp;unknown;</text></svg>"`);
  });
});
