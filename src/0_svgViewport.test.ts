import { describe, expect, it } from "vitest";
import { normalizeSvgEntities, panSvgBox, svgBoxAtZoom, svgMinimumZoom, svgNativeBox, svgSourceBox, svgPaintBox, svgNeedsRepaint, svgCssTransform, svgFitBox } from "./0_svgViewport";

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

it("reads only root SVG dimensions, including exponents and px fallback", () => {
  expect([
    svgSourceBox('<svg width="800px" height="600"><svg viewBox="0 0 1 1"/></svg>'),
    svgSourceBox('<svg viewBox="-1e2 0 8e2 6e2"/>'),
    svgSourceBox('<svg viewBox="0 0 0 20"/>'),
    svgSourceBox('<svg width="100%" height="100%"><svg viewBox="0 0 4 3"/></svg>'),
    svgSourceBox('<svg stroke-width="800" data-height="600"/>'),
  ]).toEqual([{ x: 0, y: 0, width: 800, height: 600 }, { x: -100, y: 0, width: 800, height: 600 }, null, null, null]);
});

it("pans within a bounded painted surface and rebases beyond its edges", () => {
  const box = { x: 100, y: 200, width: 800, height: 600 };
  const painted = svgPaintBox(box);
  const pan = { ...box, y: 700 };
  const outside = { ...box, y: 801 };
  expect({ painted, inside: svgNeedsRepaint(painted, pan), outside: svgNeedsRepaint(painted, outside),
    transform: svgCssTransform(painted, pan, 800, 600), fit: svgFitBox({ x: 0, y: 0, width: 200, height: 800 }, 800, 600) }).toMatchInlineSnapshot(`
    {
      "fit": {
        "height": 800,
        "width": 1066.6666666666667,
        "x": -433.33333333333337,
        "y": 0,
      },
      "inside": false,
      "outside": true,
      "painted": {
        "height": 1800,
        "width": 2400,
        "x": -700,
        "y": -400,
      },
      "transform": "matrix(1, 0, 0, 1, -800, -1100)",
    }
  `);
});

it("keeps small SVGs at the normal zoom floor and lets large fitted SVGs zoom smoothly below it", () => {
  const native = { x: 0, y: 0, width: 800, height: 600 };
  expect([
    svgMinimumZoom(native, svgFitBox({ x: 0, y: 0, width: 10, height: 10 }, 800, 600)),
    svgMinimumZoom(native, svgFitBox({ x: 0, y: 0, width: 80_000, height: 60_000 }, 800, 600)),
  ]).toEqual([0.1, 0.01]);
});
