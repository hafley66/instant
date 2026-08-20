import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

test("projects Boop table and list regions onto xterm and expands them", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1&structured=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible();
  await page.evaluate(() => window.__term!.write(`\x1b[2J\x1b[H${[
    "STRUCTURED TURN START",
    "| Item | Visibility |",
    "| --- | --- |",
    "| alpha | visible |",
    "| beta | hidden |",
    "- first visible item",
    "- second visible item",
    "STRUCTURED TURN END",
  ].join("\r\n")}`));
  await expect(page.locator(".term-structured-overlay")).toHaveCount(2);
  await page.screenshot({ path: resolve("artifacts/v2-structured-inline.png"), fullPage: true });

  await page.locator(".term-structured-overlay").filter({ hasText: "TABLE" }).click();
  const modal = page.locator('.term-structured-modal[data-kind="table"]');
  await expect(modal.locator("table")).toContainText("alpha");
  await expect(modal.locator("table")).toContainText("hidden");
  await page.screenshot({ path: resolve("artifacts/v2-table-expanded.png"), fullPage: true });
  await modal.getByRole("button", { name: "Close" }).click();

  await page.locator(".term-structured-overlay").filter({ hasText: "LIST" }).click();
  await expect(page.locator('.term-structured-modal[data-kind="list"] li')).toHaveCount(2);
  await page.screenshot({ path: resolve("artifacts/v2-list-expanded.png"), fullPage: true });
});
