import { expect, test } from "@playwright/test";

// Any line under the pointer gets a checkbox in the left gutter, structured
// or not; ticking it queues that line for the next prompt.
const TMUX_PANE = "\x1b[?1049h\x1b[?1006h\x1b[?1000h\x1b[?1002h";
const LINE = "const shift = spans.map((s) => s.row);";

async function openPane(page: import("@playwright/test").Page) {
  await page.goto("/e2e-term.html?e2e=1&noHarness=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible();
  await page.evaluate(([prelude, line]) => {
    window.__term!.write(`${prelude}\x1b[2J\x1b[H${line}\r\nsecond line here\r\n`);
  }, [TMUX_PANE, LINE]);
  await expect.poll(() => page.evaluate(() => window.__term!.mouseMode())).toBe("drag");
}

test("hovering a plain line offers a gutter checkbox that queues the line", async ({ page }) => {
  await openPane(page);
  const point = (await page.evaluate(() => window.__term!.point(0, 8)))!;
  await page.mouse.move(point.x, point.y);
  const check = page.locator(".term-context-hover-check");
  await expect(check).toBeVisible();
  await check.click();
  await expect(page.locator(".term-context-queue header")).toContainText("NEXT MESSAGE · 1");
  await expect(page.locator(".term-context-queue-quote")).toHaveText(LINE);

  // The same line again: the box reads checked and unticking drops the row.
  await page.mouse.move(point.x + 30, point.y);
  await expect(check).toBeChecked();
  await check.click();
  await expect(page.locator(".term-context-queue")).toBeHidden();
});

test("a blank row offers no checkbox", async ({ page }) => {
  await openPane(page);
  const point = (await page.evaluate(() => window.__term!.point(3, 2)))!;
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(".term-context-hover-check")).toBeHidden();
});
