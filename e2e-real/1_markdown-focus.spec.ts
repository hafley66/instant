import { expect, test } from "@playwright/test";
import { rmSync } from "node:fs";
import { boot, cmdClickToken, killAllSessions, mkRepo, openSessionTab, typeLine } from "./0_real";

test("Markdown headings, grid controls and keyboard focus work beside a terminal", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const dir = mkRepo({ "focus.md": `# Focus regression

A rendered paragraph with an [ordinary link](https://example.com).

| Name | Value |
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
    await content.getByRole("link", { name: "ordinary link" }).focus();
    await expect(content.getByRole("link", { name: "ordinary link" })).toBeFocused();
    await page.keyboard.press("Meta+Equal");
    await expect(content).toHaveCSS("zoom", "1.1");
    expect(errors).toEqual([]);
    await testInfo.attach("markdown-focus", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await testInfo.attach("page-errors", { body: JSON.stringify(errors, null, 2), contentType: "application/json" });
    killAllSessions();
    rmSync(dir, { recursive: true, force: true });
  }
});
