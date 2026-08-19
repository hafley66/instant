import { test, expect } from "@playwright/test";

test("terminal filesystem sidebar renders the cwd tree", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1");
  await page.getByTestId("open-term").click();

  const sidebar = page.locator(".term-sidebar");
  await expect(sidebar).toBeVisible({ timeout: 10_000 });
  await expect(sidebar.locator(".file-tree-grid")).toBeVisible();
  await expect(sidebar).toContainText("src");
  await expect(sidebar).toContainText("README.md");
  await expect(sidebar).not.toContainText("Turns");
  await expect(sidebar).not.toContainText("Touched");
});
