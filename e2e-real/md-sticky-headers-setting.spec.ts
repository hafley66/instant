// settings.mdStickyHeaders (default on) reaches the md panel: its root carries
// data-md-sticky-headers and section headers stick; off, they scroll away.
import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import { boot, cmdClickToken, killAllSessions, mkRepo, openSessionTab, typeLine } from "./0_real";

const DOC = ["# Top", "", "## Section", "", ...Array.from({ length: 120 }, (_, index) => `Paragraph ${index} of a section long enough to scroll.\n`)].join("\n");
const dirs: string[] = [];
test.afterEach(() => { if (!process.env.INSTANT_E2E_KEEP) killAllSessions(); });
test.afterAll(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

/// Unfold the doc, scroll well into its section, and read where the h2 sits.
async function measure(page: Page) {
  await page.locator(".dv-tab", { hasText: "sticky.md" }).click();
  // A fresh load opens folded; unfolding is per document.
  await page.locator(".mdview-root .act-bar:visible").getByRole("button", { name: "unfold all" }).click();
  const content = page.locator(".mdview-content", { hasText: "Paragraph 119" });
  await expect(content).toBeVisible({ timeout: 20_000 });
  return content.evaluate((scroller) => {
    scroller.scrollTop = 1200;
    const head = scroller.querySelector<HTMLElement>(".mdview-h2")!;
    return {
      attribute: scroller.closest(".mdview-root")!.hasAttribute("data-md-sticky-headers"),
      position: getComputedStyle(head).position,
      inView: head.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top,
    };
  });
}

test("the mdStickyHeaders setting turns md sticky section headers on by default and off when cleared", async ({ page }) => {
  await boot(page);
  const dir = mkRepo({ "sticky.md": DOC });
  dirs.push(dir);
  const session = await openSessionTab(page, dir);
  typeLine(session, 'clear; echo "  sticky.md"');
  await page.waitForTimeout(1_200);
  await cmdClickToken(page, session, "sticky.md");
  await expect(page.locator(".mdview-content")).toBeVisible({ timeout: 20_000 });
  const byDefault = await measure(page);

  await page.evaluate(() => localStorage.setItem("mdStickyHeaders", "false"));
  await page.reload();
  await expect(page.locator("#sessions-toggle")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".dv-tab", { hasText: "sticky.md" })).toBeVisible({ timeout: 20_000 });
  const off = await measure(page);

  expect({ byDefault, off }).toEqual({
    byDefault: { attribute: true, position: "sticky", inView: true },
    off: { attribute: false, position: "static", inView: false },
  });
});
