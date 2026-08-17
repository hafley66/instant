import { describe, expect, it } from "vitest";
import { externalViewerTarget, persistedViewerTarget, viewerFailureAction } from "./0_externalShells";

describe("external shell viewer targets", () => {
  it("keeps the lane identity and pane target separate", () => {
    expect(persistedViewerTarget(externalViewerTarget("luna", "%509"))).toMatchInlineSnapshot(`
      {
        "name": "luna",
        "tmuxTarget": "%509",
        "viewer": true,
      }
    `);
  });

  it("removes a viewer tab after an attach failure", () => {
    expect(viewerFailureAction(true)).toBe("remove");
    expect(viewerFailureAction(false)).toBe("retain");
  });
});
