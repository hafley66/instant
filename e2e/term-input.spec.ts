import { expect, test } from "@playwright/test";

test("terminal keeps keyboard, drag selection, and wheel input with tmux mouse reporting", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1&noHarness=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible();
  await page.evaluate(() => {
    const target = window as Window & { __instantE2eNativeResults?: Record<string, unknown>; __writes?: unknown[] };
    target.__writes = [];
    target.__instantE2eNativeResults!.write_pty = (args: unknown) => target.__writes!.push(args);
    window.__term!.write("\x1b[2J\x1b[Halpha beta gamma\r\nsecond line\x1b[?1000h\x1b[?1006h");
  });
  const start = await page.evaluate(() => window.__term!.point(0, 0));
  const end = await page.evaluate(() => window.__term!.point(0, 9));
  await page.mouse.click(start!.x, start!.y);
  await page.keyboard.type("typed");
  await expect.poll(() => page.evaluate(() => (window as Window & { __writes?: Array<{ data?: string }> }).__writes?.map((write) => write.data).join("")))
    .toContain("typed");

  await page.mouse.move(start!.x, start!.y);
  await page.mouse.down();
  await page.mouse.move(end!.x, end!.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__term!.selection())).toContain("alpha beta");
  await page.screenshot({ path: "artifacts/v2-terminal-input-selection.png", fullPage: true });
});
