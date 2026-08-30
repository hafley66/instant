import { expect, test } from "@playwright/test";

// App-level receipt: invokes the exported openRectangleWorkspace seam in the
// harness and proves the rectangle workspace lands as a Dockview tab beside the
// ordinary Sessions tab, that same-id reopen focuses (no duplicate tab), and
// that close/reopen keeps a single cytoscape canvas (no layered duplicate).

const openRect = (page: import("@playwright/test").Page) =>
  page.getByTestId("open-rect");

test("openRectangleWorkspace opens a Dockview tab beside an existing Sessions tab", async ({ page }) => {
  await page.goto("/e2e-rectangle.html?e2e=1");

  const sessionsTab = page.locator(".dv-default-tab").filter({ hasText: "Sessions" });
  await expect(sessionsTab).toBeVisible();
  await expect(page.locator(".dv-default-tab")).toHaveCount(1);

  await openRect(page).click();

  const rectTab = page.locator(".dv-default-tab").filter({ hasText: "Rect Workspace" });
  await expect(rectTab).toBeVisible();
  await expect(page.locator(".dv-default-tab")).toHaveCount(2);

  // Session + graph identifying text is visible in the rectangle workspace tab.
  await expect(page.getByText("session one")).toBeVisible();
  await expect(page.getByText("session two")).toBeVisible();
  await expect(page.getByText("build graph")).toBeVisible();
  await expect(page.getByTestId("cytoscape-rectangle")).toBeVisible();

  await page.screenshot({ path: "test-results/rectangle-app-tab.png", fullPage: true });

  // Reopening the same id focuses the existing tab; no duplicate.
  await openRect(page).click();
  await expect(page.locator(".dv-default-tab")).toHaveCount(2);
  await expect(rectTab).toHaveCount(1);

  // Close the rectangle tab, reopen it; a single cytoscape canvas remains.
  await rectTab.locator(".dv-default-tab-action").click();
  await expect(page.locator(".dv-default-tab").filter({ hasText: "Rect Workspace" })).toHaveCount(0);
  await openRect(page).click();
  await expect(page.locator(".dv-default-tab")).toHaveCount(2);
  await expect(page.getByTestId("cytoscape-rectangle")).toHaveCount(1);
  await expect(page.getByText("build graph")).toBeVisible();

  const rectWorkspace2 = page.getByTestId("rectangle-workspace");
  await expect(rectWorkspace2).toBeVisible();
  await page.screenshot({ path: "test-results/rectangle-app-reopened.png", fullPage: true });
});
