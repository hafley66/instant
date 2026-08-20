import { describe, expect, it } from "vitest";
import { terminalLineId } from "./00b_terminalLineAnchors";

describe("terminal line identity", () => {
  it("is stable for the same logical line and distinct for visible duplicates", () => {
    expect([
      terminalLineId("same wrapped logical line"),
      terminalLineId("same wrapped logical line"),
      terminalLineId("same wrapped logical line", 1),
      terminalLineId("changed line"),
    ]).toMatchInlineSnapshot(`
      [
        "line-jtngeh-0",
        "line-jtngeh-0",
        "line-jtngeh-1",
        "line-1m9i4nv-0",
      ]
    `);
  });
});
