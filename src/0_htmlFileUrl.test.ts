import { describe, expect, it } from "vitest";
import { browserFileUrl, htmlFileUrl } from "./0_htmlFileUrl";

describe("htmlFileUrl", () => {
  it("encodes an absolute Playwright report path as a Chromium file URL", () => {
    expect(htmlFileUrl("/Users/test/projects/instant/.worktrees/diagrams/playwright report/index.html"))
      .toMatchInlineSnapshot(`"file:///Users/test/projects/instant/.worktrees/diagrams/playwright%20report/index.html"`);
  });

  it("routes only HTML files to Chromium", () => {
    expect([
      htmlFileUrl("/tmp/report.HTM"),
      htmlFileUrl("/tmp/report.svg"),
      htmlFileUrl("/tmp/report.html:12"),
      browserFileUrl("/tmp/paper.pdf"),
      browserFileUrl("~/papers/closure.html", "/Users/test"),
    ]).toMatchInlineSnapshot(`
      [
        "file:///tmp/report.HTM",
        null,
        null,
        null,
        "file:///Users/test/papers/closure.html",
      ]
    `);
  });
});
