// A markdown tab keeps its DOM and scroll offset when another tab in its group
// takes the front and it comes back, both for a tab opened this session and for
// one restored from a layout saved before md panels declared keepAlive.
import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import { boot, cmdClickToken, killAllSessions, mkRepo, openSessionTab, typeLine } from "./0_real";

const LONG = ["# Long", "", ...Array.from({ length: 160 }, (_, index) => `Paragraph ${index} of a document long enough to scroll.\n`)].join("\n");
const dirs: string[] = [];
test.afterEach(() => { if (!process.env.INSTANT_E2E_KEEP) killAllSessions(); });
test.afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

const tab = (page: Page, title: string) => page.locator(".dv-tab", { hasText: title });
const longContent = (page: Page) => page.locator(".mdview-content", { hasText: "Paragraph 159" });

/// Scroll the long doc, mark its scroller node, bring the other md tab to the
/// front and the long one back. Returns what the scroller looks like after.
async function roundTrip(page: Page): Promise<{ marked: boolean; scrollTop: number }> {
  await tab(page, "long.md").click();
  // A fresh load opens folded; unfolding is per document.
  await page.locator(".mdview-root .act-bar:visible").getByRole("button", { name: "unfold all" }).click();
  await expect(longContent(page)).toBeVisible({ timeout: 20_000 });
  await longContent(page).evaluate((node) => {
    node.scrollTop = 1500;
    node.setAttribute("data-probe", "long");
  });
  await tab(page, "short.md").click();
  await expect(longContent(page)).toBeHidden();
  await tab(page, "long.md").click();
  await expect(longContent(page)).toBeVisible();
  await page.waitForTimeout(300);
  return longContent(page).evaluate((node) => ({ marked: node.getAttribute("data-probe") === "long", scrollTop: node.scrollTop }));
}

test("a markdown tab keeps its DOM and scroll across a tab switch, also after restoring an old layout", async ({ page }) => {
  await boot(page);
  const dir = mkRepo({ "long.md": LONG, "short.md": "# Short\n\nOne line.\n" });
  dirs.push(dir);
  const session = await openSessionTab(page, dir);
  typeLine(session, 'clear; echo "  long.md short.md"');
  await page.waitForTimeout(1_200);
  await cmdClickToken(page, session, "long.md");
  await expect(page.locator(".mdview-content")).toBeVisible({ timeout: 20_000 });
  typeLine(session, 'clear; echo "  short.md"');
  await page.waitForTimeout(1_200);
  await cmdClickToken(page, session, "short.md");
  await expect(tab(page, "short.md")).toBeVisible({ timeout: 20_000 });
  const opened = await roundTrip(page);

  // The layout a build before keepAlive saved: the same panels with no renderer.
  await page.evaluate(() => {
    const saved = localStorage.getItem("dockJSON")!;
    localStorage.setItem("dockJSON", saved.replaceAll(/,"renderer":"always"/g, ""));
  });
  await page.reload();
  await expect(page.locator("#sessions-toggle")).toBeVisible({ timeout: 30_000 });
  await expect(tab(page, "long.md")).toBeVisible({ timeout: 20_000 });
  const restored = await roundTrip(page);

  expect({ opened, restored }).toEqual({
    opened: { marked: true, scrollTop: 1500 },
    restored: { marked: true, scrollTop: 1500 },
  });
});
