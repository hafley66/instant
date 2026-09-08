// The per-terminal filesystem sidebar against a real pane: cd the tab into a
// directory built for the run, toggle the sidebar with its keymap, read the
// tree. The tab's cwd is the tree's root, so the pane and the sidebar have to
// agree.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { boot, closeTabs, killAllSessions, openTab, settleCwd, shot, typeLine } from "./0_real";

// Thirty entries: the grid once painted a single page of 20 rows with no pager
// and cut a repo root off at its twentieth entry, so the last file here is the
// receipt that the whole listing shows.
function makeTree(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "term-sidebar-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "main.ts"), "export const main = 1;\n");
  writeFileSync(path.join(dir, "README.md"), "# tree under test\n");
  for (let i = 1; i <= 28; i++) writeFileSync(path.join(dir, `entry-${String(i).padStart(2, "0")}.txt`), `${i}\n`);
  writeFileSync(path.join(dir, "zz-last.txt"), "last\n");
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
  await expect(sidebar).toContainText("zz-last.txt");
  // The tree lists the filesystem, so no turn column reaches it.
  await expect(sidebar).not.toContainText("Turns");
  await expect(sidebar).not.toContainText("Touched");
  await shot(page, "term-sidebar-01-tree");
});
