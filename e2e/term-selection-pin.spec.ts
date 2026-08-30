import { expect, test } from "@playwright/test";

// tmux attaches xterm to the alternate screen and turns on DECSET 1000/1002/
// 1006, which is the exact state a codex pane runs in.
const TMUX_PANE = "\x1b[?1049h\x1b[?1006h\x1b[?1000h\x1b[?1002h";

async function openPane(page: import("@playwright/test").Page) {
  await page.goto("/e2e-term.html?e2e=1&noHarness=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible();
  await page.evaluate((prelude) => {
    window.__term!.write(`${prelude}\x1b[2J\x1b[Halpha beta gamma\r\nsecond line\r\nthird line`);
  }, TMUX_PANE);
  await expect.poll(() => page.evaluate(() => window.__term!.mouseMode())).toBe("drag");
}

async function dragCells(page: import("@playwright/test").Page, row: number, from: number, to: number) {
  const start = (await page.evaluate(([r, c]) => window.__term!.point(r, c), [row, from]))!;
  const end = (await page.evaluate(([r, c]) => window.__term!.point(r, c), [row, to]))!;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}

test("a drag on a pane whose app owns the mouse selects, copies, and stays lit", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openPane(page);
  await dragCells(page, 0, 0, 9);
  await expect.poll(() => page.evaluate(() => window.__term!.pinned())).toBe("alpha beta");
  await expect.poll(() => page.evaluate(() => window.__term!.pinnedRects())).toBe(1);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("alpha beta");
  await page.screenshot({ path: "artifacts/terminal-pinned-selection.png", fullPage: true });
});

test("a pinned selection survives a terminal write that leaves its cells alone", async ({ page }) => {
  await openPane(page);
  await dragCells(page, 0, 0, 9);
  await expect.poll(() => page.evaluate(() => window.__term!.pinned())).toBe("alpha beta");
  await page.evaluate(() => window.__term!.write("\x1b[3;1H\x1b[Kthird line rewritten by the agent"));
  await page.evaluate(() => window.__term!.write("\x1b[2;1H\x1b[Ksecond line rewritten too"));
  await expect.poll(() => page.evaluate(() => window.__term!.pinned())).toBe("alpha beta");
  await expect.poll(() => page.evaluate(() => window.__term!.pinnedRects())).toBe(1);
});

test("a pinned selection drops when the next click lands or its own cells change", async ({ page }) => {
  await openPane(page);
  await dragCells(page, 0, 0, 9);
  await expect.poll(() => page.evaluate(() => window.__term!.pinned())).toBe("alpha beta");
  const point = (await page.evaluate(() => window.__term!.point(2, 2)))!;
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => page.evaluate(() => window.__term!.pinnedRects())).toBe(0);

  await dragCells(page, 0, 0, 9);
  await expect.poll(() => page.evaluate(() => window.__term!.pinned())).toBe("alpha beta");
  await page.evaluate(() => window.__term!.write("\x1b[H\x1b[Kdelta epsilon zeta"));
  await expect.poll(() => page.evaluate(() => window.__term!.pinnedRects())).toBe(0);
});

test("a pane with no mouse tracking keeps xterm's own selection and paints no pin", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1&noHarness=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible();
  await page.evaluate(() => window.__term!.write("\x1b[2J\x1b[Halpha beta gamma\r\nsecond line"));
  await dragCells(page, 0, 0, 9);
  await expect.poll(() => page.evaluate(() => window.__term!.selection())).toContain("alpha bet");
  await expect.poll(() => page.evaluate(() => window.__term!.pinnedRects())).toBe(0);
});
