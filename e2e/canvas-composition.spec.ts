import { expect, test } from "@playwright/test";

test("canvas tab composes terminal and nested graph surfaces beside an agent tab", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/e2e-canvas-composition.html?e2e=1");

  const agentTab = page.locator(".dv-tab").filter({ hasText: "sprefa-3" });
  const canvasTab = page.locator(".dv-tab").filter({ hasText: "Canvas" }).first();
  await expect(agentTab).toBeVisible();
  await expect(canvasTab).toBeVisible();
  await canvasTab.click();
  await expect(page.getByTestId("canvas-terminal-surface")).toContainText("bus ls");
  await expect(page.getByTestId("nested-canvas-surface")).toContainText("artifact graph");
  await expect(page.locator(".mini-canvas-node")).toHaveCount(2);

  await expect(page).toHaveScreenshot("canvas-composition.png", { animations: "disabled" });

  await agentTab.click();
  await expect(page.getByTestId("agent-panel")).toContainText("normal sibling tab");
  expect(pageErrors).toEqual([]);
});
