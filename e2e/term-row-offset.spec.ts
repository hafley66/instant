import { expect, test } from "@playwright/test";

// tmux attaches xterm to the alternate screen and turns on DECSET 1000/1002/
// 1006, which is the exact state a codex pane runs in and the only state the
// pinned overlay paints for.
const TMUX_PANE = "\x1b[?1049h\x1b[?1006h\x1b[?1000h\x1b[?1002h";

/// xterm's DOM renderer emits one div per viewport row under .xterm-rows, so
/// that div's box is ground truth for where a row is drawn. Everything else in
/// the app derives a row from `.xterm-screen`'s height divided by `term.rows`,
/// and the two only agree while that division is exact.
async function domRowBox(page: import("@playwright/test").Page, row: number) {
  return page.evaluate((r) => {
    const node = document.querySelectorAll(".xterm-rows > div")[r] as HTMLElement | undefined;
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, mid: box.top + box.height / 2, height: box.height };
  }, row);
}

async function openFilledPane(page: import("@playwright/test").Page) {
  await page.goto("/e2e-term.html?e2e=1&noHarness=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible();
  const rows = (await page.evaluate(() => window.__term!.dims()))!.rows;
  const lines = Array.from({ length: rows }, (_, i) => `ROW${String(i).padStart(3, "0")}-payload`);
  await page.evaluate(([prelude, body]) => {
    window.__term!.write(`${prelude}\x1b[2J\x1b[H${body}`);
  }, [TMUX_PANE, lines.join("\r\n")]);
  await expect.poll(() => page.evaluate(() => window.__term!.mouseMode())).toBe("drag");
  return rows;
}

test("a drag lands on the row the reader sees, at the top and at the bottom", async ({ page }) => {
  const rows = await openFilledPane(page);
  // Sample the first row, the middle, and the last two. A cell height that is
  // an average rather than the real one drifts with the row index, so an error
  // shows up at the bottom of the pane long before the top.
  const targets = [0, 1, Math.floor(rows / 2), rows - 2, rows - 1];
  const seen: Record<number, string> = {};
  for (const row of targets) {
    const box = (await domRowBox(page, row))!;
    expect(box, `row ${row} has no DOM row`).not.toBeNull();
    const left = (await page.evaluate(() => window.__term!.point(0, 0)))!;
    const right = (await page.evaluate(() => window.__term!.point(0, 9)))!;
    await page.mouse.move(left.x, box.mid);
    await page.mouse.down();
    await page.mouse.move(right.x, box.mid, { steps: 6 });
    await page.mouse.up();
    seen[row] = await page.evaluate(() => window.__term!.pinned());
    await page.mouse.click(left.x, box.mid); // drop the pin before the next drag
  }
  // The drag covers columns 0..9, so each row yields its first ten characters.
  const expected = Object.fromEntries(
    targets.map((row) => [row, `ROW${String(row).padStart(3, "0")}-pay`]),
  );
  expect(seen).toEqual(expected);
});

test("the app's cell geometry matches the row boxes xterm actually drew", async ({ page }) => {
  const rows = await openFilledPane(page);
  const drift: { row: number; appTop: number; domTop: number; delta: number }[] = [];
  for (let row = 0; row < rows; row++) {
    const box = (await domRowBox(page, row))!;
    const point = (await page.evaluate((r) => window.__term!.point(r, 0), row))!;
    // `point` returns the cell centre, so back out to the row top.
    const appTop = point.y - box.height / 2;
    drift.push({ row, appTop, domTop: box.top, delta: appTop - box.top });
  }
  const worst = drift.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a));
  const cellHeight = drift[1].domTop - drift[0].domTop;
  // Half a cell is the point where a click at a row's centre crosses into its
  // neighbour, which is the off-by-one a reader sees.
  expect(
    Math.abs(worst.delta),
    `worst drift ${worst.delta.toFixed(3)}px at row ${worst.row} of ${rows}, cell ${cellHeight.toFixed(3)}px`,
  ).toBeLessThan(cellHeight / 2);
});
