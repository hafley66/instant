import { describe, expect, it } from "vitest";
import { nextClosedOrder, reopenKind } from "./0_reopenOrder";

describe("closed tab chronology", () => {
  it("selects the newest close across terminal and panel histories", () => {
    const fileFirst = nextClosedOrder();
    const shellSecond = nextClosedOrder();
    const shellFirst = nextClosedOrder();
    const fileSecond = nextClosedOrder();
    expect([
      ["file then shell in one millisecond", reopenKind(fileFirst, shellSecond)],
      ["shell then file in one millisecond", reopenKind(fileSecond, shellFirst)],
      ["shell only", reopenKind(null, shellSecond)],
      ["file only", reopenKind(fileSecond, null)],
      ["empty", reopenKind(null, null)],
    ]).toMatchInlineSnapshot(`
      [
        [
          "file then shell in one millisecond",
          "terminal",
        ],
        [
          "shell then file in one millisecond",
          "panel",
        ],
        [
          "shell only",
          "terminal",
        ],
        [
          "file only",
          "panel",
        ],
        [
          "empty",
          "none",
        ],
      ]
    `);
  });
});
