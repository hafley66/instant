// Row geometry on a real pane in the codex state. The overlay's rects are
// painted from the app's own cell math, the xterm DOM rows are what the
// reader sees; both are DOM, so the two can be compared directly.
import { expect, test, type Page } from "@playwright/test";
import { boot, cell, clipboardText, closeTabs, killAllSessions, MOUSE_PANE, openSilentPane, paneCommand, paneScreen, screenRows, shot, tmux } from "./0_real";

const PIN = ".term-pinned-selection";

const marker = (row: number) => `ROW${String(row).padStart(3, "0")}-payload`;

/// A pane in the codex state carrying one numbered line per pane row. The pane
/// opens first, because the app sizes the terminal from the panel. tmux parks
/// its status line on the terminal's last row, so the pane is one row shorter
/// than xterm; one line more than that scrolls the payload out of alignment.
async function openFilledPane(page: Page): Promise<number> {
  const session = await openSilentPane(page, `${MOUSE_PANE}\\033[2J\\033[Hready`, "ready");
  const rows = Number(tmux(["display-message", "-p", "-t", `${session}:`, "#{pane_height}"]).trim());
  expect(rows, "tmux reported no pane height").toBeGreaterThan(4);
  expect((await screenRows(page)).length).toBe(rows + 1);
  const lines = Array.from({ length: rows }, (_, i) => marker(i));
  paneCommand(session, `printf '%b' '\\033[2J\\033[H${lines.join("\\n")}'`);
  await expect.poll(() => paneScreen(session).join("\n"), {
    timeout: 20_000,
    message: `pane ${session} never filled to row ${rows - 1}`,
  }).toContain(marker(rows - 1));
  await page.waitForTimeout(400);
  return rows;
}

async function dragRow(page: Page, row: number, from: number, to: number) {
  const start = await cell(page, row, from);
  const end = await cell(page, row, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}

test.afterEach(async ({ page }) => {
  await closeTabs(page);
});

test.afterAll(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
});

test("a drag lands on the row the reader sees, at the top and at the bottom", async ({ page }) => {
  await boot(page);
  const rows = await openFilledPane(page);
  // A cell height that is an average rather than the real one drifts with the
  // row index, so the error shows at the bottom long before the top.
  const targets = [0, 1, Math.floor(rows / 2), rows - 2, rows - 1];
  const seen: Record<number, string> = {};
  for (const row of targets) {
    await dragRow(page, row, 0, 9);
    await expect.poll(() => clipboardText(page)).toBe(marker(row).slice(0, 10));
    seen[row] = await clipboardText(page);
    const drop = await cell(page, row, 0);
    await page.mouse.click(drop.x, drop.y); // drop the pin before the next drag
    await expect.poll(() => page.locator(PIN).count()).toBe(0);
  }
  // The drag covers columns 0..9, so each row yields its first ten characters.
  expect(Object.keys(seen)).toHaveLength(targets.length);
  await shot(page, "term-row-offset-01-rows");
});

test("the app's cell geometry matches the row boxes xterm actually drew", async ({ page }) => {
  await boot(page);
  const rows = await openFilledPane(page);
  // One drag from the first cell to the last row pins every row at once, so
  // the overlay paints one rect per row from its own geometry.
  const start = await cell(page, 0, 0);
  const end = await cell(page, rows - 1, 0);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.locator(PIN).count()).toBe(rows);

  const drift = await page.evaluate((n) => {
    const pins = [...document.querySelectorAll<HTMLElement>(".term-pinned-selection")];
    const drawn = [...document.querySelectorAll<HTMLElement>(".term-host .xterm-rows > div")].slice(0, n);
    return pins.slice(0, n).map((pin, row) => {
      const pinTop = pin.getBoundingClientRect().top;
      const domTop = drawn[row].getBoundingClientRect().top;
      return { row, pinTop, domTop, delta: pinTop - domTop };
    });
  }, rows);
  expect(drift).toHaveLength(rows);
  const cellHeight = drift[1].domTop - drift[0].domTop;
  const worst = drift.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a));
  // Half a cell is where a painted row crosses into its neighbour.
  expect(
    Math.abs(worst.delta),
    `worst drift ${worst.delta.toFixed(3)}px at row ${worst.row} of ${rows}, cell ${cellHeight.toFixed(3)}px`,
  ).toBeLessThan(cellHeight / 2);
  await shot(page, "term-row-offset-02-geometry");
});
