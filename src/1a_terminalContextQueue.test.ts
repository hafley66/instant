import { describe, expect, it } from "vitest";
import { formatQueuedContext } from "./1a_terminalContextQueue";

describe("terminal next-message context", () => {
  it("formats enabled editable selections and canonical tables", () => {
    expect(formatQueuedContext([
      { id: "s", kind: "selection", text: " selected text ", turnIds: ["boop:4"], enabled: true },
      { id: "off", kind: "selection", text: "skip", turnIds: [], enabled: false },
      { id: "t", kind: "table", text: "| A | B |\n|---|---|\n| 1 | 2 |", turnIds: ["boop:5"], enabled: true },
    ])).toMatchInlineSnapshot(`
      "Selected context:

      [turn boop:4]
      selected text

      [turn boop:5]
      | A | B |
      |---|---|
      | 1 | 2 |

      "
    `);
  });
});
