import { describe, expect, it } from "vitest";
import { htmlFileUrl } from "./0_htmlFileUrl";

describe("htmlFileUrl", () => {
  it("encodes an absolute Playwright report path as a Chromium file URL", () => {
    expect(htmlFileUrl("/Users/test/projects/instant/.worktrees/diagrams/playwright report/index.html"))
      .toMatchInlineSnapshot(`"file:///Users/test/projects/instant/.worktrees/diagrams/playwright%20report/index.html"`);
  });

  it("accepts htm case-insensitively and rejects other files", () => {
    expect([
      htmlFileUrl("/tmp/report.HTM"),
      htmlFileUrl("/tmp/report.svg"),
      htmlFileUrl("/tmp/report.html:12"),
    ]).toMatchInlineSnapshot(`
      [
        "file:///tmp/report.HTM",
        null,
        null,
      ]
    `);
  });
});
