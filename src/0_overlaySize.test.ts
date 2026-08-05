import { describe, expect, it } from "vitest";
import { overlaySizeTransition } from "./0_overlaySize";

describe("overlaySizeTransition", () => {
  it("preserves a normal window on initialization and resizes only for mini state", () => {
    expect([
      overlaySizeTransition(null, false),
      overlaySizeTransition(null, true),
      overlaySizeTransition(false, true),
      overlaySizeTransition(true, false),
      overlaySizeTransition(false, false),
    ]).toMatchInlineSnapshot(`
      [
        null,
        "mini",
        "mini",
        "normal",
        null,
      ]
    `);
  });
});
