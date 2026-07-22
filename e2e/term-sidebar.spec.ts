import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";

// An innocent tmux session, created fresh and guaranteed cleaned up — the
// disposable terminal the sidebar is bespoke to. (The headless run mocks the
// native edge, so the session isn't attached here; it stands in for the real
// per-session terminal and proves the create/teardown fixture is tidy.)
const TMUX = "instant-e2e-term-sidebar";

test.beforeAll(() => {
  try {
    execFileSync("tmux", ["kill-session", "-t", TMUX], { stdio: "ignore" });
  } catch {
    /* not running yet */
  }
  execFileSync("tmux", ["new-session", "-d", "-s", TMUX, "-c", "/tmp"], { stdio: "ignore" });
});

test.afterAll(() => {
  try {
    execFileSync("tmux", ["kill-session", "-t", TMUX], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
});

test("session sidebar stacks a Files pane over a Touched pane (resizable)", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1");
  await page.getByTestId("open-term").click();

  // The terminal panel adopted its xterm host...
  await expect(page.locator(".term-host")).toBeVisible({ timeout: 10_000 });
  // ...and the per-terminal right sidebar opened beside it.
  await expect(page.locator(".term-sidebar")).toBeVisible({ timeout: 10_000 });

  // Two stacked panes: the Files explorer (top) and the Touched MRU list
  // (bottom), each a reused <TreeTable> (.dtable).
  await expect(page.locator(".term-sidebar .dtable")).toHaveCount(2);
  await expect(page.locator('[data-testid="sidebar-files"] .dtable')).toContainText("src");
  await expect(page.locator('[data-testid="sidebar-files"] .dtable')).toContainText("package.json");
  await expect(page.locator('[data-testid="sidebar-touched"] .dtable')).toContainText("README.md");

  // The sash between them is present (resizable stack, not a static split).
  const sash = page.locator(".term-sidebar-sash");
  await expect(sash).toBeVisible();
  const touchedBefore = await page.locator('[data-testid="sidebar-touched"]').boundingBox();

  // Drag the sash up so the Touched pane grows — proves the resize is live.
  const sashBox = await sash.boundingBox();
  if (sashBox && touchedBefore) {
    const cx = sashBox.x + sashBox.width / 2;
    const cy = sashBox.y + sashBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 60, { steps: 6 });
    await page.mouse.up();
    await expect(async () => {
      const after = await page.locator('[data-testid="sidebar-touched"]').boundingBox();
      expect(after).toBeTruthy();
      expect(after!.height).toBeGreaterThan(touchedBefore.height + 20);
    }).toPass({ timeout: 5_000 });
  }

  // Proof: the stacked sidebar (after resize) and the whole window.
  await page.locator(".term-sidebar").screenshot({ path: "test-results/term-sidebar.png" });
  await page.screenshot({ path: "test-results/term-sidebar-window.png", fullPage: true });
});
