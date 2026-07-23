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

  // One current transcript node opens to visible rows only. The fixture has two
  // visible/tool pairs; visible rows are newest-first. Each visible turn owns
  // collapsed Files and Tools aggregate rows, keeping raw tool events out of
  // the default scan while retaining them for recovery.
  await expect(page.locator('[data-testid="sidebar-turns"] .dtable')).toContainText("current · codex");
  await expect(page.locator('[data-testid="sidebar-turns"] .dtable')).toContainText("fix the off-by-one");
  await expect(page.locator('[data-testid="sidebar-turns"] .dtable')).toContainText("moving chrome");
  await expect(page.locator('[data-testid="sidebar-turns"] .dtable')).toContainText("latest visible answer");
  await expect(page.locator('[data-testid="sidebar-turns"] .dtable')).toContainText("compaction");
  await expect(page.locator('[data-testid="sidebar-turns"] .dtable')).not.toContainText("[Bash] inspect latest state");

  const turns = page.locator('[data-testid="sidebar-turns"]');
  await turns.getByLabel("turn content filter").selectOption("visible");
  await expect(turns).not.toContainText("[Read] README.md and reactdock.tsx");
  const latest = turns.locator(".dtable-row").filter({ hasText: "latest visible answer" });
  await latest.locator(".tt-twisty").click();
  await expect(turns).toContainText("Files");
  await expect(turns).toContainText("Tools");
  await expect(turns).not.toContainText("inspect latest state");
  const tools = turns.locator(".dtable-row").filter({ hasText: "Tools" });
  await tools.locator(".tt-twisty").click();
  await expect(turns).toContainText("inspect latest state");
  await expect(turns).toContainText("assistant · exec");

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
  await turn.locator(".turn-copy").hover();
  const preview = page.getByTestId("turn-preview-popover");
  await expect(preview).toBeVisible();
  const box = await preview.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: "test-results/term-turns-hover.png" });

  await turn.hover();
  const openAction = turn.locator(".turn-action", { hasText: "↗" });
  const starAction = turn.locator(".turn-action", { hasText: "☆" });
  await expect(openAction).toBeVisible();
  await expect(starAction).toBeVisible();
  const rowBox = await turn.boundingBox();
  const openBox = await openAction.boundingBox();
  const starBox = await starAction.boundingBox();
  expect(rowBox).toBeTruthy();
  expect(openBox).toBeTruthy();
  expect(starBox).toBeTruthy();
  expect(Math.abs(openBox!.width - openBox!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(starBox!.width - starBox!.height)).toBeLessThanOrEqual(1);
  expect(openBox!.height).toBeLessThanOrEqual(rowBox!.height);
  expect(starBox!.height).toBeLessThanOrEqual(rowBox!.height);
  await page.screenshot({ path: "test-results/term-turn-actions-hover.png" });
  await openAction.click();
  await expect(page.locator(".fs-preview .code-plain")).toContainText("e2e-codex-1");

  await page.locator(".term-sidebar").screenshot({ path: "test-results/term-turns.png" });
});

test("session sidebar Turns view: Kimi support interval rolls into its response", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1&harness=kimi");
  await page.getByTestId("open-term").click();
  const turns = page.locator('[data-testid="sidebar-turns"]');
  await expect(turns).toContainText("current · kimi");
  const latest = turns.locator(".dtable-row").filter({ hasText: "latest visible answer" });
  await latest.locator(".tt-twisty").click();
  await expect(turns).toContainText("Tools");
  const tools = turns.locator(".dtable-row").filter({ hasText: "Tools" });
  await tools.locator(".tt-twisty").click();
  await expect(turns).toContainText("assistant · Bash");
  await page.locator(".term-sidebar").screenshot({ path: "test-results/term-kimi-rollup.png" });
});
