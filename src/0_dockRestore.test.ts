import { describe, expect, it } from "vitest";
import { restoredTerminalSessionIds } from "./0_dockRestore";

describe("restoredTerminalSessionIds", () => {
  it("maps persisted terminal and browser tabs to their Dockview session ids", () => {
    expect(
      [...restoredTerminalSessionIds([
        { name: "sprefa-3", command: "claude", cwd: "/projects/sprefa" },
        { name: "docs", command: null, cwd: null, browser: true, url: "https://example.test" },
        { name: "sprefa-3", command: "claude", cwd: "/projects/sprefa" },
      ])],
    ).toMatchInlineSnapshot(`
      [
        "s:sprefa-3",
        "s:docs",
      ]
    `);
  });
});
