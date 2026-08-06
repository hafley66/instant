import { describe, expect, it } from "vitest";
import { documentHref } from "./0_documentHref";

describe("documentHref", () => {
  it("maps document links into Instant paths and lines", () => {
    expect([
      documentHref("vscode://file/Users/test/repo/src/main.ts:144", "/tmp/chart.svg"),
      documentHref("file:///Users/test/repo/src/main.ts#L39", "/tmp/chart.svg"),
      documentHref("../notes/design.md", "/Users/test/repo/plans/chart.svg"),
      documentHref("https://example.com/docs", "/tmp/chart.svg"),
    ]).toMatchInlineSnapshot(`
      [
        {
          "line": 144,
          "path": "/Users/test/repo/src/main.ts",
        },
        {
          "line": 39,
          "path": "/Users/test/repo/src/main.ts",
        },
        {
          "path": "/Users/test/repo/notes/design.md",
        },
        null,
      ]
    `);
  });
});
