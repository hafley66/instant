import { expect, test } from "@playwright/test";
import { rmSync } from "node:fs";
import { boot, cmdClickToken, killAllSessions, mkRepo, openSessionTab, typeLine } from "./0_real";

test("Markdown headings, grid controls and keyboard focus work beside a terminal", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dir = mkRepo({ "focus.md": `# Focus regression with a deliberately long section heading that exceeds the available Markdown pane width

A rendered paragraph with an [ordinary link](https://example.com) and \`inline_code()\`.

| Name | Value with a deliberately long column header that exceeds its available width |
| --- | --- |
| beta | 2 |
| alpha | 1 |

\`\`\`ts
const answer = 42;
\`\`\`
` }, "Markdown focus fixture");
  try {
    await boot(page);
    const session = await openSessionTab(page, dir);
    typeLine(session, 'clear; echo "focus.md"');
    await expect(page.locator(".term-host .xterm-rows")).toContainText("focus.md");
    await cmdClickToken(page, session, "focus.md");
    const content = page.locator(".mdview-content");
    await expect(content).toBeVisible();

    // A real mouse click traverses Instant's Dockview activation and focus
    // restoration. Rendering the table alone never reaches this boundary.
    await content.getByRole("button", { name: /Focus regression/ }).click();
    expect(errors, "opening the Markdown heading must not recurse through focus").toEqual([]);
    await expect(content).toContainText("A rendered paragraph");
    await expect(content.locator('[data-streamdown="code-block-body"]')).toContainText("const answer = 42;");
    await expect(content.locator(".sg-cell")).toHaveText(["beta", "2", "alpha", "1"]);

    await expect(content.locator(".mdview-title")).toHaveAttribute("title", /Focus regression with a deliberately long section heading/);
    const longHeader = content.locator(".mdview-table-header-label").nth(1);
    await expect(longHeader).toHaveAttribute("title", "Value with a deliberately long column header that exceeds its available width");
    expect(await longHeader.evaluate((el) => ({
      clipped: el.scrollWidth > el.clientWidth,
      overflow: getComputedStyle(el).textOverflow,
      wrap: getComputedStyle(el).whiteSpace,
    }))).toEqual({ clipped: true, overflow: "ellipsis", wrap: "nowrap" });
    await expect(content.locator(".sg-cell").first()).toHaveCSS("padding-top", "1px");
    await expect(content.locator(".sg-cell").first()).toHaveCSS("padding-left", "4px");

    await expect(content.locator(".sg-cell").first()).toHaveCSS("align-items", "center");
    await expect(content.locator(".mdview-table-grid")).toHaveCSS("--sg-row-h", "28px");

    const name = content.locator('.sg-head-cell[data-col-id="column-0"]');
    await name.hover();
    await name.getByRole("button", { name: "Sort column ascending", exact: true }).first().click();
    await expect(content.locator(".sg-cell")).toHaveText(["alpha", "1", "beta", "2"]);

    await page.locator(".mdview-root summary", { hasText: "reading width" }).click();
    const width = page.getByRole("spinbutton", { name: "Prose width in pixels", exact: true });
    await width.fill("620");
    await expect(width).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("spinbutton", { name: "Minimum prose width in pixels", exact: true })).toBeFocused();
    await expect(content).toHaveCSS("--md-prose-width", "620px");
    await page.locator(".mdview-root summary", { hasText: "reading width" }).click();

    await page.keyboard.press("Meta+Equal");
    await expect(content).toHaveCSS("zoom", "1.1");
    await page.keyboard.press("Meta+Digit0");
    await expect(content).toHaveCSS("zoom", "1");

    await page.locator(".term-host .xterm-screen").click();
    // terminal.ts schedules a second focus at 60ms after activation. Let that
    // user action finish before programmatically moving focus back to Markdown.
    await page.waitForTimeout(100);
    await content.getByRole("link", { name: "ordinary link" }).focus();
    await expect(content.getByRole("link", { name: "ordinary link" })).toBeFocused();
    await page.keyboard.press("Meta+Equal");
    await expect(content).toHaveCSS("zoom", "1.1");
    expect(errors).toEqual([]);
    if (!(await page.locator("body").evaluate((body) => body.classList.contains("xp-pixel")))) {
      await page.keyboard.press("Meta+Shift+p");
      await page.locator(".cmdp-input").fill("Super XP");
      await page.locator(".cmdp-input").press("Enter");
    }
    await expect(page.locator("body")).toHaveClass(/xp-pixel/);
    const inlineCode = content.locator("code").filter({ hasText: "inline_code()" });
    await expect(inlineCode).toHaveCSS("font-family", '"SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Monaco, Consolas, monospace');
    await expect(inlineCode).toHaveCSS("-webkit-font-smoothing", "antialiased");

    expect(errors).toEqual([]);
    await testInfo.attach("markdown-focus", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await testInfo.attach("page-errors", { body: JSON.stringify(errors, null, 2), contentType: "application/json" });
    killAllSessions();
    rmSync(dir, { recursive: true, force: true });
  }
});
