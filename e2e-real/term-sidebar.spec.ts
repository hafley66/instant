// The per-terminal filesystem sidebar against a real pane: cd the tab into a
// directory built for the run, toggle the sidebar with its keymap, read the
// tree. The tab's cwd is the tree's root, so the pane and the sidebar have to
// agree.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { boot, closeTabs, killAllSessions, openTab, settleCwd, shot, typeLine } from "./0_real";

// The grid paints one page of 20 rows and offers no pager (defect noted in the
// commit body), so the tree under test is a directory that fits on one page.
function makeTree(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "term-sidebar-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "main.ts"), "export const main = 1;\n");
  writeFileSync(path.join(dir, "README.md"), "# tree under test\n");
  return dir;
}

test.afterEach(async ({ page }) => {
  await closeTabs(page);
});

test.afterAll(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
});

test("terminal filesystem sidebar renders the cwd tree", async ({ page }) => {
  const dir = makeTree();
  await boot(page);
  const session = await openTab(page);
  typeLine(session, `cd ${dir}`);
  await page.waitForTimeout(800);
  await settleCwd(page, session, path.basename(dir));

  // ⌘⇧\ toggles the focused terminal's sidebar; the keymap owns the chord.
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", code: "Backslash", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  });

  const sidebar = page.locator(".term-sidebar");
  await expect(sidebar).toBeVisible({ timeout: 10_000 });
  await expect(sidebar.locator(".file-tree-grid")).toBeVisible({ timeout: 10_000 });
  await expect(sidebar).toContainText("src");
  await expect(sidebar).toContainText("README.md");
  // The tree lists the filesystem, so no turn column reaches it.
  await expect(sidebar).not.toContainText("Turns");
  await expect(sidebar).not.toContainText("Touched");
  await shot(page, "term-sidebar-01-tree");
});
