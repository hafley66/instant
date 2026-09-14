import { describe, expect, it } from "vitest";
import { browserFileUrl, expandHome, htmlFileUrl } from "./0_htmlFileUrl";

describe("expandHome", () => {
  it("expands only a leading ~/ and leaves absolute paths alone", () => {
    expect(expandHome("~/target/doc/crate/index.html", "/Users/test")).toBe(
      "/Users/test/target/doc/crate/index.html",
    );
    expect(expandHome("~/papers/x.html", "/Users/test/")).toBe("/Users/test/papers/x.html");
    expect(expandHome("/abs/index.html", "/Users/test")).toBe("/abs/index.html");
    expect(expandHome("~/x.html", "")).toBe("~/x.html");
  });
});

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
