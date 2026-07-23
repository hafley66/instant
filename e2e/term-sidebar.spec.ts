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

test("session sidebar Files view: explorer over session-derived Touched (resizable)", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1");
  await page.getByTestId("open-term").click();

  await expect(page.locator(".term-host")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".term-sidebar")).toBeVisible({ timeout: 10_000 });

  // Select Files: top = filesystem explorer, bottom = Touched (derived
  // from the session transcript, so the assistant turn's file_path shows here).
  await page.getByRole("button", { name: "Files" }).click();
  await expect(page.locator(".term-sidebar .dtable")).toHaveCount(2);
  await expect(page.locator('[data-testid="sidebar-files"] .dtable')).toContainText("src");
  await expect(page.locator('[data-testid="sidebar-files"] .dtable')).toContainText("package.json");
  await expect(page.locator('[data-testid="sidebar-touched"] .dtable')).toContainText("reactdock.tsx");

  // The sash between them resizes (Touched grows when dragged up).
  const sash = page.locator(".term-sidebar-sash");
  await expect(sash).toBeVisible();
  const before = await page.locator('[data-testid="sidebar-touched"]').boundingBox();
  const sashBox = await sash.boundingBox();
  if (sashBox && before) {
    const cx = sashBox.x + sashBox.width / 2;
    const cy = sashBox.y + sashBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 60, { steps: 6 });
    await page.mouse.up();
    await expect(async () => {
      const after = await page.locator('[data-testid="sidebar-touched"]').boundingBox();
      expect(after).toBeTruthy();
      expect(after!.height).toBeGreaterThan(before.height + 20);
    }).toPass({ timeout: 5_000 });
  }

  await page.locator(".term-sidebar").screenshot({ path: "test-results/term-sidebar.png" });
});

test("session sidebar Turns view: transcript tree and Touched metadata", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-sidebar")).toBeVisible({ timeout: 10_000 });

  // Turns is the default source and remains the left tab.
  await expect(page.locator('[data-testid="sidebar-turns"]')).toBeVisible();

  // One transcript node (labeled by cwd) over its turns (default-expanded) +
  // the assistant turn's referenced file as a child. Turns default newest-first.
  await expect(page.locator('[data-testid="sidebar-turns"] .dtable')).toContainText("term-e2e");
  await expect(page.locator('[data-testid="sidebar-turns"] .dtable')).toContainText("fix the off-by-one");
  await expect(page.locator('[data-testid="sidebar-turns"] .dtable')).toContainText("moving chrome");
  await expect(page.locator('[data-testid="sidebar-turns"] .dtable')).toContainText("reactdock.tsx");
  await expect(page.locator('[data-testid="sidebar-turns"] .dtable')).toContainText("compaction");

  const touched = page.locator('[data-testid="sidebar-touched"]');
  await expect(touched).toContainText("README.md");
  await expect(touched).toContainText("Uses");
  await touched.locator(".dtable-row", { hasText: "README.md" }).locator(".tt-twisty").click();
  await expect(touched).toContainText("Sidebar UX");

  // Double-click expands a turn; the hover action opens its record in a
  // split-right preview tab.
  const turn = page
    .locator('[data-testid="sidebar-turns"] .dtable-row')
    .filter({ hasText: "moving chrome" });
  await turn.hover();
  await turn.locator(".turn-action", { hasText: "↗" }).click();
  await expect(page.locator(".fs-preview .code-plain")).toContainText("e2e-claude-1");

  await page.locator(".term-sidebar").screenshot({ path: "test-results/term-turns.png" });
});
